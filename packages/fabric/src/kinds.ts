// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The kind registry (docs/proposals/message-fabric.md §Envelope). Kinds are a public
// API the moment they cross an install boundary: each has one owning package, a zod
// payload schema, and a version. The registry is what makes deprecation and
// compatibility governable — ad-hoc kind strings are how wire contracts rot.
import type { z } from "zod";
import { KIND_RE } from "./envelope.js";

export interface KindDeclaration<T = unknown> {
    kind: string;
    owner: string;
    version: number;
    payload: z.ZodType<T>;
}

export interface KindRegistry {
    register(declaration: KindDeclaration): void;
    get(kind: string): KindDeclaration | undefined;
    has(kind: string): boolean;
    list(): KindDeclaration[];
}

export function createKindRegistry(): KindRegistry {
    const kinds = new Map<string, KindDeclaration>();
    return {
        register(declaration) {
            if (!KIND_RE.test(declaration.kind)) {
                throw new TypeError(`malformed kind: ${JSON.stringify(declaration.kind)}`);
            }
            if (!Number.isInteger(declaration.version) || declaration.version < 1) {
                throw new TypeError(`kind ${declaration.kind}: version must be a positive integer`);
            }
            if (kinds.has(declaration.kind)) {
                throw new TypeError(`kind already registered: ${declaration.kind}`);
            }
            kinds.set(declaration.kind, declaration);
        },
        get: (kind) => kinds.get(kind),
        has: (kind) => kinds.has(kind),
        list: () => [...kinds.values()],
    };
}
