// The Worker that serves the app, plus the one route that cannot be a static
// file: the client's approval page.
//
// Why this exists at all. Supabase rewrites any HTML an edge function returns
// on the shared *.functions.supabase.co domain — Content-Type is forced to
// text/plain and a `default-src 'none'; sandbox` CSP is attached. That is an
// anti-phishing measure for a domain thousands of projects share, and it is
// not configurable. JSON passes through untouched; HTML does not. Measured:
//
//   send-report      → Content-Type: application/json          (untouched)
//   approve-ticket   → Content-Type: text/plain
//                      Content-Security-Policy: default-src 'none'; sandbox
//
// So a client rep opening the approval link was shown the page's source
// instead of the page. The function was always producing correct HTML; the
// platform was refusing to let a browser render it.
//
// Proxying it through this Worker fixes it, because the response is re-served
// from a domain we control with the Content-Type we choose. It also puts the
// approval page on the same host as the app, which reads better to a client
// than a supabase.co address.

const FUNCTIONS_ORIGIN = "https://eielmvxzdwwprmmfamlq.functions.supabase.co";

// An allowlist, not a denylist. The upstream function needs almost nothing
// from the caller — it reads its token from the query string and the signer's
// name from the form body — and this route shares an origin with the app, so
// a browser will attach whatever it holds for that origin. Forwarding
// everything by default would send Cookie and Authorization to a third party
// for no reason. Anything not named here does not leave.
const FORWARD = new Set(["content-type", "accept", "accept-language", "user-agent"]);

// The whole flow is: open the page, submit the form.
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

// A rep on a phone at a lease will wait a few seconds; nobody should be left
// holding an open socket because the function is wedged.
const UPSTREAM_TIMEOUT_MS = 15000;

// The form carries a typed name and a small PNG at most; the function caps
// the same. Refused here so an oversized body never reaches it.
const MAX_BODY_BYTES = 1_000_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /approve?t=… — the link that goes out in the approval email.
    if (url.pathname === "/approve" || url.pathname === "/approve-ticket") {
      if (!ALLOWED_METHODS.has(request.method)) {
        return new Response("Method not allowed", {
          status: 405, headers: { "Allow": "GET, HEAD, POST" }
        });
      }
      if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
        return new Response("Request too large", { status: 413 });
      }
      // The header is a claim; the bytes are the fact. A chunked POST carries
      // no Content-Length at all, and used to stream through unbounded.
      let payload;
      if (request.method === "POST") {
        payload = await readBounded(request, MAX_BODY_BYTES);
        if (payload === null) return new Response("Request too large", { status: 413 });
      }
      return approvalPage(request, url, payload);
    }

    return env.ASSETS.fetch(request);
  }
};

// The request body, read to the cap and no further: null past it. Small by
// design — a typed name and a signature PNG — so buffering it is nothing.
async function readBounded(request, max) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function approvalPage(request, url, payload) {
  const target = FUNCTIONS_ORIGIN + "/approve-ticket" + url.search;

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (FORWARD.has(k.toLowerCase())) headers.set(k, v);
  }
  // The signature records the rep's IP. Behind this proxy the function would
  // otherwise see Cloudflare's address, so pass the real one through in the
  // header it already reads.
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) headers.set("x-forwarded-for", clientIp);

  let upstream, body;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : payload,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    // Read inside the same try. The timeout covers the body as well as the
    // headers, so a response that stalls or resets part-way through throws
    // here — outside, that threw out of the handler entirely and the rep got
    // Cloudflare's raw error page instead of the one below.
    body = await upstream.text();
  } catch {
    return htmlError("This approval link couldn't be opened right now. Please try again in a moment.");
  }

  // Re-served as HTML. The upstream's own Content-Type is deliberately
  // discarded — it is the text/plain the platform forced on it, and it is the
  // whole reason this route exists.
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      // The signing page is never legitimately framed; a page that could be
      // is a page that could be clickjacked into approving.
      "Content-Security-Policy": "frame-ancestors 'none'"
    }
  });
}

const htmlError = message => new Response(
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket approval · VagaboNDE</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#d9dcde;
color:#1d1f20;font-family:Helvetica,Arial,sans-serif;padding:24px}
.c{max-width:460px;background:#fff;border:1px solid rgba(29,31,32,.55);padding:26px 24px}
h1{font-size:22px;margin:0 0 8px}p{color:#6b6d6e;font-size:14px;margin:0}</style></head>
<body><div class="c"><h1>Something went wrong</h1><p>${message}</p></div></body></html>`,
  { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } }
);
