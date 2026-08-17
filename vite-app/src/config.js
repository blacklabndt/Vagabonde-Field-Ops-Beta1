import { createClient } from "@supabase/supabase-js";

// Public project URL + publishable key. Both are meant to be exposed in a
// client app — access control is enforced by Postgres row-level security
// (see the migrations), never by keeping this key secret.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://eielmvxzdwwprmmfamlq.supabase.co";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg";

// Every request gets a ceiling.
//
// Without one, a request made after the access token has expired can hang
// indefinitely with no signal: supabase-js tries to refresh the token first
// and retries that refresh against a network that isn't answering. The call
// never settles, so the screen waiting on it never resolves either — which is
// how "Creating…" or "Loading rates…" turns into a permanent state rather
// than a failure the offline queue could catch.
//
// 30 seconds is deliberately generous: a report upload on a bad link is slow
// but legitimate, and killing it would be worse than waiting. Genuinely
// offline, fetch rejects immediately anyway — this ceiling is for the case
// where the radio is technically connected but nothing is getting through.
const REQUEST_TIMEOUT_MS = 30000;

function fetchWithCeiling(input, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Respect a caller's own signal as well as ours.
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return fetch(input, { ...init, signal: controller.signal })
    .catch(err => {
      // Reported as a network failure, not an abort, so the offline queue and
      // the read cache recognise it as "no connection" and do their job.
      if (err && err.name === "AbortError") throw new TypeError("Failed to fetch — the request timed out.");
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

export const sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: fetchWithCeiling }
});
