// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/curatedSources.ts
//
// A curated list of external repos AgentGem can import from to bootstrap the Gem registry.
// Each entry is a trusted, license-clear repo of persona/skill markdown; the console/agent
// browses it and imports selected items as skill artifacts. Two adapters exist today:
// agency-layout (agencyAgents.ts, one repo of persona `.md` files) and skills-layout
// (skillsLayout.ts, many repos of canonical `SKILL.md` files). Adding a same-layout source is
// one more entry here; a differently shaped repo needs its own adapter + a new `kind`.
import type { GithubCfg } from "./registryGithub.js";

// The on-disk layout a source uses, which selects the import adapter (see sourceImport.ts).
export type CuratedSourceKind = "agency-layout" | "skills-layout";

export interface CuratedSource {
  id: string;            // stable slug, e.g. "agency-agents"
  label: string;         // display name
  description: string;   // one-line for the picker
  repo: string;          // GitHub "owner/name"
  ref: string;           // branch/tag/sha
  kind: CuratedSourceKind;
  license?: string;      // SPDX-ish, e.g. "MIT"
  homepage?: string;     // canonical URL for attribution
}

export const CURATED_SOURCES: CuratedSource[] = [
  {
    id: "agency-agents",
    label: "The Agency",
    description:
      "232 curated role personas across 16 divisions (engineering, design, marketing, security…) by @msitarzewski.",
    repo: "msitarzewski/agency-agents",
    ref: "main",
    kind: "agency-layout",
    license: "MIT",
    homepage: "https://github.com/msitarzewski/agency-agents",
  },
  {
    id: "thedotmack-claude-mem",
    label: "thedotmack/claude-mem",
    description:
      "Persistent Context Across Sessions for Every Agent –  Captures everything your agent does during sessions, compresses it with AI, and inj… (20 skills)",
    repo: "thedotmack/claude-mem",
    ref: "main",
    kind: "skills-layout",
    license: "Apache-2.0",
    homepage: "https://github.com/thedotmack/claude-mem",
  },
  {
    id: "dietrichgebert-ponytail",
    label: "dietrichgebert/ponytail",
    description:
      "Makes your AI agent think like the laziest senior dev in the room. The best code is the code you never wrote. (13 skills)",
    repo: "dietrichgebert/ponytail",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/dietrichgebert/ponytail",
  },
  {
    id: "addyosmani-agent-skills",
    label: "addyosmani/agent-skills",
    description:
      "Production-grade engineering skills for AI coding agents. (24 skills)",
    repo: "addyosmani/agent-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/addyosmani/agent-skills",
  },
  {
    id: "heygen-com-hyperframes",
    label: "heygen-com/hyperframes",
    description:
      "Write HTML. Render video. Built for agents. (21 skills)",
    repo: "heygen-com/hyperframes",
    ref: "main",
    kind: "skills-layout",
    license: "Apache-2.0",
    homepage: "https://github.com/heygen-com/hyperframes",
  },
  {
    id: "anthropics-claude-plugins-official",
    label: "anthropics/claude-plugins-official",
    description:
      "Official, Anthropic-managed directory of high quality Claude Code Plugins. (29 skills)",
    repo: "anthropics/claude-plugins-official",
    ref: "main",
    kind: "skills-layout",
    license: "Apache-2.0",
    homepage: "https://github.com/anthropics/claude-plugins-official",
  },
  {
    id: "blader-humanizer",
    label: "blader/humanizer",
    description:
      "Claude Code skill that removes signs of AI-generated writing from text (1 skill)",
    repo: "blader/humanizer",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/blader/humanizer",
  },
  {
    id: "othmanadi-planning-with-files",
    label: "othmanadi/planning-with-files",
    description:
      "Persistent file-based planning for AI coding agents and long-running agentic tasks. Crash-proof markdown plans that survive context loss… (17 skills)",
    repo: "othmanadi/planning-with-files",
    ref: "master",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/othmanadi/planning-with-files",
  },
  {
    id: "jimliu-baoyu-skills",
    label: "jimliu/baoyu-skills",
    description:
      "Agent Skills by @jimliu. (22 skills)",
    repo: "jimliu/baoyu-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/jimliu/baoyu-skills",
  },
  {
    id: "google-skills",
    label: "google/skills",
    description:
      "Agent Skills for Google products and technologies (69 skills)",
    repo: "google/skills",
    ref: "main",
    kind: "skills-layout",
    license: "Apache-2.0",
    homepage: "https://github.com/google/skills",
  },
  {
    id: "jeffallan-claude-skills",
    label: "jeffallan/claude-skills",
    description:
      "66 Specialized Skills for Full-Stack Developers. Transform Claude Code into your expert pair programmer. (66 skills)",
    repo: "jeffallan/claude-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/jeffallan/claude-skills",
  },
  {
    id: "czlonkowski-n8n-skills",
    label: "czlonkowski/n8n-skills",
    description:
      "n8n skillset for Claude Code to build flawless n8n workflows (15 skills)",
    repo: "czlonkowski/n8n-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/czlonkowski/n8n-skills",
  },
  {
    id: "antfu-skills",
    label: "antfu/skills",
    description:
      "Anthony Fu's curated collection of agent skills. (19 skills)",
    repo: "antfu/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/antfu/skills",
  },
  {
    id: "emilkowalski-skills",
    label: "emilkowalski/skills",
    description:
      "Skills for Design Engineers. (3 skills)",
    repo: "emilkowalski/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/emilkowalski/skills",
  },
  {
    id: "mvanhorn-cli-printing-press",
    label: "mvanhorn/cli-printing-press",
    description:
      "Every API has a secret identity. This finds it, absorbs every feature from every competing tool, then builds the GOAT CLI — designed for… (20 skills)",
    repo: "mvanhorn/cli-printing-press",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/mvanhorn/cli-printing-press",
  },
  {
    id: "dimillian-skills",
    label: "dimillian/skills",
    description:
      "My Codex Skills (16 skills)",
    repo: "dimillian/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/dimillian/skills",
  },
  {
    id: "lackeyjb-playwright-skill",
    label: "lackeyjb/playwright-skill",
    description:
      "Claude Code Skill for browser automation with Playwright. Model-invoked - Claude autonomously writes and executes custom automation for t… (1 skill)",
    repo: "lackeyjb/playwright-skill",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/lackeyjb/playwright-skill",
  },
  {
    id: "ljagiello-ctf-skills",
    label: "ljagiello/ctf-skills",
    description:
      "Agent skills for solving CTF challenges - web exploitation, binary pwn, crypto, reverse engineering, forensics, OSINT, and more (11 skills)",
    repo: "ljagiello/ctf-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/ljagiello/ctf-skills",
  },
  {
    id: "expo-skills",
    label: "expo/skills",
    description:
      "A collection of AI agent skills for working with Expo projects and Expo Application Services (19 skills)",
    repo: "expo/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/expo/skills",
  },
  {
    id: "wondelai-skills",
    label: "wondelai/skills",
    description:
      "Agent skills for Claude, Claude Code, Claude Cowork, Codex, Cursor, OpenClaw, Hermes Agent and other agentskills.io-compatible agents. Se… (50 skills)",
    repo: "wondelai/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/wondelai/skills",
  },
  {
    id: "paramchoudhary-resumeskills",
    label: "paramchoudhary/resumeskills",
    description:
      "A collection of AI agent skills focused on resume optimization, job applications, and career development. Built for job seekers, career c… (29 skills)",
    repo: "paramchoudhary/resumeskills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/paramchoudhary/resumeskills",
  },
  {
    id: "kulaxyz-self-learning-skills",
    label: "kulaxyz/self-learning-skills",
    description:
      "A self-improving skill for AI coding agents (Claude Code, Cursor, AGENTS.md): recognize a hard-won golden path in a session and harvest i… (1 skill)",
    repo: "kulaxyz/self-learning-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/kulaxyz/self-learning-skills",
  },
  {
    id: "feicaiclub-video-spec-builder",
    label: "feicaiclub/video-spec-builder",
    description:
      "video-spec-builder —— 把我想做个视频逼成一份精确到秒的分镜脚本 video-spec.md,交给 HyperFrames 渲染。一条命令装到 Claude Code / Cursor / Codex:npx skills add feicaiclub/… (1 skill)",
    repo: "feicaiclub/video-spec-builder",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/feicaiclub/video-spec-builder",
  },
  {
    id: "clickhouse-agent-skills",
    label: "clickhouse/agent-skills",
    description:
      "The official Agent Skills for ClickHouse and ClickHouse Cloud (10 skills)",
    repo: "clickhouse/agent-skills",
    ref: "main",
    kind: "skills-layout",
    license: "Apache-2.0",
    homepage: "https://github.com/clickhouse/agent-skills",
  },
  {
    id: "tavily-ai-skills",
    label: "tavily-ai/skills",
    description:
      "Agent Skills by @tavily-ai. (8 skills)",
    repo: "tavily-ai/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/tavily-ai/skills",
  },
  {
    id: "antvis-chart-visualization-skills",
    label: "antvis/chart-visualization-skills",
    description:
      "⛏️ Turning data into a visual language for better thinking with Skills. (9 skills)",
    repo: "antvis/chart-visualization-skills",
    ref: "master",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/antvis/chart-visualization-skills",
  },
  {
    id: "elevenlabs-skills",
    label: "elevenlabs/skills",
    description:
      "Collections of skills for building with ElevenLabs (10 skills)",
    repo: "elevenlabs/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/elevenlabs/skills",
  },
  {
    id: "gmgnai-gmgn-skills",
    label: "gmgnai/gmgn-skills",
    description:
      "GMGN OpenAPI skills for AI Agent — query tokens, wallets, and market data, and execute on-chain trades across Solana, BSC, and Base. (6 skills)",
    repo: "gmgnai/gmgn-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/gmgnai/gmgn-skills",
  },
  {
    id: "testdino-hq-playwright-skill",
    label: "testdino-hq/playwright-skill",
    description:
      "TestDino Playwright Skill: AI-powered guides for Playwright best practices, made by testdino.com. (6 skills)",
    repo: "testdino-hq/playwright-skill",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/testdino-hq/playwright-skill",
  },
  {
    id: "bahayonghang-drawio-skills",
    label: "bahayonghang/drawio-skills",
    description:
      "drawio skills for cc,codex (2 skills)",
    repo: "bahayonghang/drawio-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/bahayonghang/drawio-skills",
  },
  {
    id: "unnoo-zsxq-skill",
    label: "unnoo/zsxq-skill",
    description:
      "Agent Skills by @unnoo. (5 skills)",
    repo: "unnoo/zsxq-skill",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/unnoo/zsxq-skill",
  },
  {
    id: "grafana-skills",
    label: "grafana/skills",
    description:
      "Agent Skills by @grafana. (44 skills)",
    repo: "grafana/skills",
    ref: "main",
    kind: "skills-layout",
    license: "Apache-2.0",
    homepage: "https://github.com/grafana/skills",
  },
  {
    id: "resend-resend-skills",
    label: "resend/resend-skills",
    description:
      "Agent Skills for working with Resend to send and receive emails. (5 skills)",
    repo: "resend/resend-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/resend/resend-skills",
  },
  {
    id: "coderabbitai-skills",
    label: "coderabbitai/skills",
    description:
      "Agent Skills by @coderabbitai. (2 skills)",
    repo: "coderabbitai/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/coderabbitai/skills",
  },
  {
    id: "juliusbrussee-skills",
    label: "juliusbrussee/skills",
    description:
      "Agent Skills by @juliusbrussee. (7 skills)",
    repo: "juliusbrussee/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/juliusbrussee/skills",
  },
  {
    id: "parallel-web-parallel-agent-skills",
    label: "parallel-web/parallel-agent-skills",
    description:
      "Agent Skills by @parallel-web. (9 skills)",
    repo: "parallel-web/parallel-agent-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/parallel-web/parallel-agent-skills",
  },
  {
    id: "vyralcontent-content-skills",
    label: "vyralcontent/content-skills",
    description:
      "A free Agent Skill for writing short-form hooks, scripts, and carousels for TikTok, Reels, and YouTube Shorts. (7 skills)",
    repo: "vyralcontent/content-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/vyralcontent/content-skills",
  },
  {
    id: "prisma-skills",
    label: "prisma/skills",
    description:
      "Agent Skills by @prisma. (8 skills)",
    repo: "prisma/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/prisma/skills",
  },
  {
    id: "nrwl-nx-ai-agents-config",
    label: "nrwl/nx-ai-agents-config",
    description:
      "Agent Skills by @nrwl. (35 skills)",
    repo: "nrwl/nx-ai-agents-config",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/nrwl/nx-ai-agents-config",
  },
  {
    id: "5dive-ai-skills",
    label: "5dive-ai/skills",
    description:
      "Skills published by 5dive — drop-in SKILL.md bundles for Claude Code, openclaw, hermes, and any harness that loads skills.sh-format prompts. (8 skills)",
    repo: "5dive-ai/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/5dive-ai/skills",
  },
  {
    id: "catalyst-cooperative-agent-skills",
    label: "catalyst-cooperative/agent-skills",
    description:
      "Coding agent skills designed to help users work with PUDL data and the PUDL data processing pipeline codebase. (3 skills)",
    repo: "catalyst-cooperative/agent-skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/catalyst-cooperative/agent-skills",
  },
  {
    id: "mattpocock-skills",
    label: "mattpocock/skills",
    description:
      "Skills for Real Engineers. Straight from my .claude directory. (38 skills)",
    repo: "mattpocock/skills",
    ref: "main",
    kind: "skills-layout",
    license: "MIT",
    homepage: "https://github.com/mattpocock/skills",
  },
];

export function curatedSourceById(id: string): CuratedSource | undefined {
  return CURATED_SOURCES.find((s) => s.id === id);
}

// GitHub client config for a curated source. Token-optional: public repos resolve anonymously;
// GITHUB_TOKEN (when present) only lifts the 60/hr unauthenticated rate limit.
export function cfgForCuratedSource(source: CuratedSource): GithubCfg {
  return { repo: source.repo, ref: source.ref, token: process.env.GITHUB_TOKEN };
}
