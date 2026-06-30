// src/transfer/mint.ts
import { createUser, fromSeed } from "@nats-io/nkeys";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { InvalidInputError } from "@agentgem/model";

export type TransferScope = "receive";

export interface MintOpts {
  accountSeed: string; // account signing nkey seed (e.g. "SA…")
  bucket?: string;
  scope: TransferScope;
  ttlSeconds?: number; // default 60
  issuedAt?: number;   // unix seconds; injectable for deterministic tests
}

export interface MintedCreds { creds: string; expiresAt: number } // expiresAt: unix seconds

const DEFAULT_BUCKET = "agentgem-transfer";
const DEFAULT_TTL_SECONDS = 60;

// Least-privilege subjects for a scope. An Object Store bucket <b> is JetStream
// stream OBJ_<b> over subjects $O.<b>.>; a get-and-burn needs the bucket subjects,
// a PER-MINT inbox for replies (NOT account-wide "_INBOX.>", which would let any
// minted user read every receiver's replies), and the bucket-scoped JS API (never
// a blanket $JS.API.>). The consuming client MUST connect with `inboxPrefix` set to
// the same value (derivable as `_INBOX.<user-public-key-from-creds>`).
export function scopeSubjects(bucket: string, _scope: TransferScope, inboxPrefix: string): { pub: string[]; sub: string[] } {
  const stream = `OBJ_${bucket}`;
  return {
    sub: [`$O.${bucket}.>`, `${inboxPrefix}.>`],
    pub: [
      `$O.${bucket}.>`,
      `$JS.API.STREAM.INFO.${stream}`,
      `$JS.API.STREAM.MSG.GET.${stream}`,
      `$JS.API.DIRECT.GET.${stream}`,
      `$JS.API.STREAM.MSG.DELETE.${stream}`,
      `$JS.API.STREAM.PURGE.${stream}`,
      `$JS.API.CONSUMER.CREATE.${stream}.>`,
      `$JS.API.CONSUMER.MSG.NEXT.${stream}.>`,
    ],
  };
}

export async function mintScopedCreds(opts: MintOpts): Promise<MintedCreds> {
  const bucket = opts.bucket ?? DEFAULT_BUCKET;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const iat = opts.issuedAt ?? Math.floor(Date.now() / 1000);
  const exp = iat + ttl;

  let account;
  try {
    account = fromSeed(new TextEncoder().encode(opts.accountSeed));
  } catch {
    // 400, not a masked 500. Never echo the seed value.
    throw new InvalidInputError("NATS_ACCOUNT_SEED is not a valid account nkey seed");
  }
  const user = createUser();
  // Per-mint inbox so a minted user can only receive its own replies.
  const inboxPrefix = `_INBOX.${user.getPublicKey()}`;
  const { pub, sub } = scopeSubjects(bucket, opts.scope, inboxPrefix);

  // exp is an absolute unix timestamp read from the encoding opts (5th param);
  // the encoder auto-stamps iat. See @nats-io/jwt encodeUser/opts. The early lib's
  // opts type omits exp, so cast narrowly (keeps a typo guard, unlike `as never`).
  const jwt = await encodeUser(
    "agentgem-transfer",
    user,
    account,
    { pub: { allow: pub }, sub: { allow: sub } },
    { exp } as { exp: number },
  );

  const creds = new TextDecoder().decode(fmtCreds(jwt, user));
  return { creds, expiresAt: exp };
}
