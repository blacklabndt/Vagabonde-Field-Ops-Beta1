// The connection's own doors, with the network and the database taken out.
//
// backup-oauth answers a browser the provider redirected, and that browser
// carries no token at all. What stands in for one is a nonce this app minted
// minutes earlier and spends the instant it reads it. The checks that door
// is made of are here rather than in the function, because they are pure and
// because getting one of them subtly wrong is how an OAuth callback becomes
// a way in: a mismatched state accepted, a stale nonce honoured, an empty
// string comparing equal to an empty string.
//
// Erasable TypeScript, no imports, nothing read from the environment —
// vite-app/src/backupShared.test.mjs imports this file straight and node
// strips the types.

export const NONCE_MS = 10 * 60 * 1000;

const PROVIDERS: string[] = ["google", "microsoft", "dropbox"];

// ".../backup-oauth/google" — the last segment, and only when it names a
// provider we know. The function's own name is not one, so a bare POST to
// /backup-oauth is not mistaken for a callback.
export function providerInPath(pathname: string): string {
  const parts = String(pathname || "").split("/").filter(Boolean);
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return PROVIDERS.includes(last) ? last : "";
}

// Where the provider sends the browser back to. It has to be identical in
// the consent URL, in the token exchange, and in what was typed into the
// provider's app registration — so it is derived once, here, from the app's
// own public address, and the panel derives its display copy the same way.
export function callbackUri(configuredBaseUrl: string, provider: string): { uri: string; base: string } {
  const configured = String(configuredBaseUrl ?? "").trim();
  let base = "";
  if (configured) {
    try { base = new URL(configured).origin; } catch { base = ""; }
  }
  if (!base || base === "null") {
    throw new Error(
      "The App address isn't set on the Admin screen. Fill it in first — the drive has to be told where to send you back to."
    );
  }
  return { uri: `${base}/backup/oauth/${provider}`, base };
}

// The provider's own app registration, as the Admin typed it in. Both halves
// or neither: a client ID with no secret gets as far as the consent screen
// and then fails at the exchange, which is a long way to walk for a message
// that could have been given here.
export function credentialsFrom(
  row: Record<string, string | null | undefined>, provider: string
): { id: string; secret: string } {
  const r = row ?? {};
  const id = String(r[`backup_client_id_${provider}`] ?? "").trim();
  const secret = String(r[`backup_client_secret_${provider}`] ?? "").trim();
  if (!id || !secret) {
    const missing = !id && !secret ? "client ID and client secret"
      : !id ? "client ID" : "client secret";
    throw new Error(
      `The ${provider} app registration is incomplete — its ${missing} has to be filled in on the Admin screen before you can connect.`
    );
  }
  return { id, secret };
}

// "" when the callback may proceed; otherwise the sentence the Admin sees.
// An absent expected value refuses, so a callback arriving out of nowhere —
// or a second one after the first spent the nonce — gets nothing.
export function nonceRefusal(
  expected: string | null | undefined, presented: string | null | undefined,
  mintedAtMs: number, nowMs: number
): string {
  const want = String(expected ?? "");
  const got = String(presented ?? "");
  if (!want || !got || want !== got) {
    return "That connection link wasn't the one this app started. Press Connect again.";
  }
  if (!Number.isFinite(mintedAtMs) || !mintedAtMs || nowMs - mintedAtMs > NONCE_MS) {
    return "That connection took more than ten minutes. Press Connect again.";
  }
  return "";
}
