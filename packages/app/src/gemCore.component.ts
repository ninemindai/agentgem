// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The gem-core component: every shared REST controller, the gem MCP tools, the two
// cache-control dispatch hooks, and the gem-type / agent-source extension-point registries,
// bundled as one AgentBack Component so an entry point (or a downstream deployment) installs
// the whole local-first surface with a single app.component(GemCoreComponent) call.
// Registration through a component is behavior-identical to the previous imperative
// app.restController(...) list: controllers are discovered by tag at start(), so mount
// order never mattered — only membership does, and it now lives here.
import { Binding, type Component, type Constructor } from "@agentback/core";
import { REST_DISPATCH_HOOK_TAG } from "@agentback/rest";
import { GemTypesComponent } from "./gem/gemTypeRegistry.js";
import { AgentSourcesComponent } from "./gem/sourceRegistry.js";
import { GemController } from "./gem.controller.js";
import { HomeController } from "./home.controller.js";
import { RubricController } from "./rubric.controller.js";
import { ReviewController } from "./review.controller.js";
import { DreamController } from "./dream.controller.js";
import { ShareProxyController } from "./share.proxy.controller.js";
import { SourcesController } from "./sources.controller.js";
import { PlayController } from "./play.controller.js";
import { InsightsController } from "./insights.controller.js";
import { WorkflowController } from "./workflow.controller.js";
import { GemStreamController } from "./gem.stream.controller.js";
import { ScorecardController } from "./scorecard.stream.controller.js";
import { GemTools } from "./gem.tools.js";
import { playNoCache } from "./playCache.js";
import { gemNoCache } from "./gemCache.js";

export class GemCoreComponent implements Component {
  // The two extension-point registries (gem types, agent sources) ride along as nested
  // components, mounted recursively before this component's own artifacts.
  components: Constructor<Component>[] = [GemTypesComponent, AgentSourcesComponent];
  controllers = [
    GemController,
    HomeController,
    RubricController,
    ReviewController,
    DreamController,
    ShareProxyController,
    SourcesController,
    PlayController,
    InsightsController,
    WorkflowController,
    GemStreamController,
    ScorecardController,
  ];
  services = [GemTools];
  bindings = [
    // The Play registry reads and the inventory reads both serve mutable on-disk state;
    // without Cache-Control the browser heuristically caches them off the bare ETag. The
    // hooks key on the matched route and write through the neutral responseHeaders
    // collector, so they hold on the Web/edge pipeline too. Bound before start(): the
    // hook list is resolved once, on the first dispatched request, and cached.
    Binding.bind("hooks.playNoCache").to(playNoCache).tag(REST_DISPATCH_HOOK_TAG),
    Binding.bind("hooks.gemNoCache").to(gemNoCache).tag(REST_DISPATCH_HOOK_TAG),
  ];
}
