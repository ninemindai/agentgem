// src/gem/channels.ts
// The single place that knows how each platform maps onto Eve's channel factories. Generalizes the
// old hard-coded eveChannelTs scaffold. Adding a platform = one entry here; the archive never changes.
//
// Eve factory signatures (confirmed from eve@0.15.0 dist/src/public/channels/*):
//   slackChannel(config?)    — optional; reads SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
//   telegramChannel(config?) — optional; reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET_TOKEN
//   discordChannel(config?)  — optional; reads DISCORD_BOT_TOKEN, DISCORD_PUBLIC_KEY, DISCORD_APPLICATION_ID
//   teamsChannel(config?)    — optional; reads MICROSOFT_APP_ID, MICROSOFT_APP_PASSWORD, MICROSOFT_TENANT_ID
//   twilioChannel(config)    — REQUIRED config (allowFrom is non-optional); reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   githubChannel(config?)   — optional; reads GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET
import type { ChannelArtifact, ChannelPlatform, SecretRef } from "./types.js";

export interface ChannelPlatformSpec {
  platform: ChannelPlatform;
  label: string;
  eveImport: string;   // e.g. "eve/channels/slack"
  factory: string;     // e.g. "slackChannel"
  secrets: string[];   // exact env-var names the Eve factory reads
}

export const CHANNEL_REGISTRY: Record<ChannelPlatform, ChannelPlatformSpec> = {
  slack:    { platform: "slack",    label: "Slack",          eveImport: "eve/channels/slack",    factory: "slackChannel",    secrets: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] },
  telegram: { platform: "telegram", label: "Telegram",       eveImport: "eve/channels/telegram", factory: "telegramChannel", secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET_TOKEN"] },
  discord:  { platform: "discord",  label: "Discord",        eveImport: "eve/channels/discord",  factory: "discordChannel",  secrets: ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID"] },
  teams:    { platform: "teams",    label: "Microsoft Teams", eveImport: "eve/channels/teams",    factory: "teamsChannel",    secrets: ["MICROSOFT_APP_ID", "MICROSOFT_APP_PASSWORD", "MICROSOFT_TENANT_ID"] },
  twilio:   { platform: "twilio",   label: "Twilio",         eveImport: "eve/channels/twilio",   factory: "twilioChannel",   secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] },
  github:   { platform: "github",   label: "GitHub",         eveImport: "eve/channels/github",   factory: "githubChannel",   secrets: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"] },
};

// The agent/channels/<name>.ts file Eve materialization emits. Eve channel factories read their
// secrets from the environment, so the scaffold is the import + a zero-arg factory default export.
// NOTE: twilioChannel() requires an `allowFrom` config; its scaffold includes the minimal required arg.
export function channelScaffold(platform: ChannelPlatform): string {
  const spec = CHANNEL_REGISTRY[platform];
  const envComment = `// Reads ${spec.secrets.join(", ")} from the environment (set them as project env vars).\n// See https://vercel.com/docs/eve/concepts#channels\n`;
  if (platform === "twilio") {
    return (
      `import { ${spec.factory} } from ${JSON.stringify(spec.eveImport)};\n\n` +
      envComment +
      `export default ${spec.factory}({\n  allowFrom: "*", // restrict to your Twilio numbers in production\n});\n`
    );
  }
  return (
    `import { ${spec.factory} } from ${JSON.stringify(spec.eveImport)};\n\n` +
    envComment +
    `export default ${spec.factory}();\n`
  );
}

// Build a neutral channel artifact, resolving the platform's env-var secrets into secretRefs.
export function makeChannelArtifact(platform: ChannelPlatform, name?: string): ChannelArtifact {
  const spec = CHANNEL_REGISTRY[platform];
  const secretRefs: SecretRef[] = spec.secrets.map((s) => ({ name: s, location: `env.${s}` }));
  return { type: "channel", name: name ?? platform, platform, secretRefs };
}
