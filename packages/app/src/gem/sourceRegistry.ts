// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/sourceRegistry.ts
//
// The AGENT_SOURCES DI extension point: the inbound agent vocabulary (built-ins + plugin-
// contributed sources) resolved through the container. Mirrors GEM_TYPES exactly. The pure
// SourceSpec + built-ins live in @agentgem/insight; this is the DI wiring.
import { extensionPoint, extensions, extensionFor, Binding, type Component } from "@agentback/core";
import { BUILTIN_SOURCES, type SourceSpec } from "@agentgem/insight";

export const AGENT_SOURCES = "agentgem.agentSources";

@extensionPoint(AGENT_SOURCES)
export class SourceRegistry {
  // `@extensions.list` injects a SNAPSHOT of the registered sources at construction time,
  // so a plugin must register its source at startup (before first use), not lazily.
  constructor(@extensions.list(AGENT_SOURCES) private specs: SourceSpec[]) {}
  all(): SourceSpec[] { return [...this.specs]; }
  byId(id: string): SourceSpec | undefined { return this.specs.find((s) => s.id === id); }
}

// Register the built-in sources as constant-value extensions + the registry service.
// A plugin contributes a source the same way: a constant binding tagged extensionFor(AGENT_SOURCES).
// Plain class (no decorator) — app.component() instantiates it directly, mirroring GemTypesComponent.
export class AgentSourcesComponent implements Component {
  bindings = BUILTIN_SOURCES.map((spec) =>
    Binding.bind(`agentSources.${spec.id}`).to(spec).apply(extensionFor(AGENT_SOURCES)));
  services = [SourceRegistry];
}

// The non-DI fallback for callers that aren't container-resolved (tests; defensive
// default elsewhere). Built directly from the built-ins.
export const defaultSourceRegistry = new SourceRegistry(BUILTIN_SOURCES);
