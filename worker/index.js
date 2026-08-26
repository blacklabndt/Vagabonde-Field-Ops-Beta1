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
      return approvalPage(request, url);
    }

    return env.ASSETS.fetch(request);
  }
};

async function approvalPage(request, url) {
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

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch {
    return htmlError("This approval link couldn't be opened right now. Please try again in a moment.");
  }

  const body = await upstream.text();

  // Re-served as HTML. The upstream's own Content-Type is deliberately
  // discarded — it is the text/plain the platform forced on it, and it is the
  // whole reason this route exists.
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
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
