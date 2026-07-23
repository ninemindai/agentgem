// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The kind registry (docs/proposals/message-fabric.md §Envelope). Kinds are a public
// API the moment they cross an install boundary: each has one owning package, a zod
// payload schema, and a version. The registry keys by (kind, version) so two payload
// versions of one kind can be registered side by side — feed replay validates old
// entries against their original schema while new traffic uses the latest.
import type { z } from "zod";
import { KIND_RE } from "./envelope.js";

export interface KindDeclaration<T = unknown> {
    kind: string;
    owner: string;
    version: number;
    /** Payload schema. Enforced at channel-open and zone crossings per the proposal's
     *  boundary-validation rule (docs/proposals/message-fabric.md §Envelope) — deliberately
     *  NOT enforced per in-proc publish/ask; do not depend on registered-kind meaning
     *  name-only, and do not add hot-path validation here. */
    payload: z.ZodType<T>;
}

export interface KindRegistry {
    register(declaration: KindDeclaration): void;
    /** Exact version when given; the highest registered version otherwise. */
    get(kind: string, version?: number): KindDeclaration | undefined;
    has(kind: string, version?: number): boolean;
    list(): KindDeclaration[];
}

export function createKindRegistry(): KindRegistry {
    // kind -> version -> declaration
    const kinds = new Map<string, Map<number, KindDeclaration>>();
    const lookup = (kind: string, version?: number): KindDeclaration | undefined => {
        const versions = kinds.get(kind);
        if (!versions) return undefined;
        if (version !== undefined) return versions.get(version);
        return versions.get(Math.max(...versions.keys()));
    };
    return {
        register(declaration) {
            if (!KIND_RE.test(declaration.kind)) {
                throw new TypeError(`malformed kind: ${JSON.stringify(declaration.kind)}`);
            }
            if (!Number.isInteger(declaration.version) || declaration.version < 1) {
                throw new TypeError(`kind ${declaration.kind}: version must be a positive integer`);
            }
            if (declaration.owner.trim() === "") {
                throw new TypeError(`kind ${declaration.kind}: owner must be a non-empty package name`);
            }
            if (typeof declaration.payload?.safeParse !== "function") {
                throw new TypeError(`kind ${declaration.kind}: payload must be a zod schema`);
            }
            const versions = kinds.get(declaration.kind) ?? new Map<number, KindDeclaration>();
            if (versions.has(declaration.version)) {
                throw new TypeError(`kind already registered: ${declaration.kind}@${declaration.version}`);
            }
            versions.set(declaration.version, declaration);
            kinds.set(declaration.kind, versions);
        },
        get: lookup,
        has: (kind, version) => lookup(kind, version) !== undefined,
        list: () => [...kinds.values()].flatMap((versions) => [...versions.values()]),
    };
}
