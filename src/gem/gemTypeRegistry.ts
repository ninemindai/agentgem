// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/gemTypeRegistry.ts
//
// The GEM_TYPES DI extension point: the cut vocabulary (built-ins + any plugin-
// contributed cuts) resolved through the container. The pure spec data + classifier
// live in @agentgem/model; this is the DI wiring. The publish handlers inject the
// registry to derive + validate a gem's cut at publish; non-DI callers (tests) use
// defaultGemTypeRegistry. First app-level extension point in the repo (see spec).
import { extensionPoint, extensions, extensionFor, Binding, type Component } from "@agentback/core";
import { BUILTIN_CUTS, deriveCut, type GemTypeSpec, InvalidInputError } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

export const GEM_TYPES = "agentgem.gemTypes";

@extensionPoint(GEM_TYPES)
export class GemTypeRegistry {
  constructor(@extensions.list(GEM_TYPES) private specs: GemTypeSpec[]) {}
  all(): GemTypeSpec[] { return [...this.specs].sort((a, b) => a.order - b.order); }
  byId(id: string): GemTypeSpec | undefined { return this.specs.find((s) => s.id === id); }
  derive(gem: Gem): string { return deriveCut(this.specs, gem); }
}

// Register the built-in cuts as constant-value extensions + the registry service.
// A plugin contributes a cut the same way: a constant binding tagged extensionFor(GEM_TYPES).
// Plain class (no decorator) — app.component() instantiates it directly, mirroring MCPComponent.
export class GemTypesComponent implements Component {
  bindings = BUILTIN_CUTS.map((spec) =>
    Binding.bind(`gemTypes.cut.${spec.id}`).to(spec).apply(extensionFor(GEM_TYPES)));
  services = [GemTypeRegistry];
}

// The non-DI fallback for callers that aren't container-resolved (tests; defensive
// default in the publish handlers). Built directly from the built-ins.
export const defaultGemTypeRegistry = new GemTypeRegistry(BUILTIN_CUTS);

/** Derive-or-accept the gem type, then validate it against the registry.
 *  A missing `supplied` is defaulted via derive(gem); an unknown id throws 400. */
export function resolvePublishType(registry: GemTypeRegistry, supplied: string | undefined, gem: Gem): string {
  const type = supplied ?? registry.derive(gem);
  if (!registry.byId(type)) throw new InvalidInputError(`unknown gem type '${type}'`);
  return type;
}
