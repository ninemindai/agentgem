// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Channel declarations (docs/proposals/message-fabric.md §Channels). Channels are
// declared, not ad-hoc: class (stream = ephemeral, feed = durable log), the kinds
// they may carry, and their zone reach. Feeds declare bounded retention by default;
// unbounded requires a written justification. A cursor that falls behind the horizon
// gets an explicit GAP_KIND event — never a silent hole.
import { z } from "zod";
import { KIND_RE } from "./envelope.js";
import { zoneSchema } from "./zone.js";

export const GAP_KIND = "fabric.gap";

const boundedRetention = z
    .object({ maxAgeMs: z.number().int().positive().optional(), maxEntries: z.number().int().positive().optional() })
    .strict()
    .refine((r) => r.maxAgeMs !== undefined || r.maxEntries !== undefined, {
        message: "bounded retention needs maxAgeMs and/or maxEntries",
    });
const unboundedRetention = z.object({ unbounded: z.string().min(1) }).strict();
export const feedRetentionSchema = z.union([boundedRetention, unboundedRetention]);
export type FeedRetention = z.infer<typeof feedRetentionSchema>;

const channelBase = {
    id: z.string().min(1),
    kinds: z.array(z.string().regex(KIND_RE)).nonempty(),
    zones: z.array(zoneSchema).nonempty(),
};

export const channelSchema = z.discriminatedUnion("class", [
    z.object({ ...channelBase, class: z.literal("stream") }).strict(),
    z.object({ ...channelBase, class: z.literal("feed"), retention: feedRetentionSchema }).strict(),
]);
export type ChannelDeclaration = z.infer<typeof channelSchema>;
