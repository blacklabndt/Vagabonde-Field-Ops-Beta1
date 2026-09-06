// Which screen you are on, written into the address bar.
//
// The app kept the open screen in one React state and nowhere else, which on
// an installed Android app is worse than it sounds: the system Back gesture
// is the most-used control on the device, and with no history entries to go
// back through it left the app altogether. A reload landed on Home wherever
// you had been, and a job number could not be pasted into chat as a link.
//
// This module is the pure half of the fix — the shell already knows which
// screen is open and which job is active, and all that is missing is a way to
// spell that pair as a URL and read it back. App.jsx does the pushing and the
// listening; everything here is a string in and a string out, so it can be
// tested without a browser.
//
// A hash, not a path. Two reasons. The Worker serves index.html for any path,
// so a path route would work, but the one URL this app already receives from
// outside is itself a hash — Supabase's password-reset landing,
// `#access_token=…&type=recovery`. Keeping our own routes in the hash means
// the two live in the same place and the rule that separates them is one
// character: ours always begin with a slash, and Auth's never do. The other
// reason is that a hash change costs no request, which matters on field data.
import { TABS, CONTEXT_TABS } from "./data.js";

const SCREEN_KEYS = new Set(TABS.map(t => t.key));
// The contextual screens that hang off a job in the URL. `job` itself is the
// parent they hang from, so it is not one of them.
const UNDER_JOB = CONTEXT_TABS.filter(k => k !== "job");

function decodeSafely(part) {
  try { return decodeURIComponent(part); }
  // A hand-edited address with a stray percent sign is not a route; the
  // caller lands on Home rather than the app throwing on the way in.
  catch { return null; }
}

// The screen a hash names, or null if it names nothing this app knows.
// Shapes:  #/board   #/chat   #/job/S-10113   #/job/S-10113/ticket
export function parseRoute(hash) {
  if (typeof hash !== "string") return null;
  const raw = hash.replace(/^#/, "");
  // Anything not starting with a slash is somebody else's hash — Auth's
  // recovery tokens and its refusals both arrive that way — and must never
  // be read as a screen.
  if (!raw.startsWith("/")) return null;
  const parts = raw.slice(1).split("/").filter(Boolean).map(decodeSafely);
  if (!parts.length || parts.some(p => p === null)) return null;
  const [head, ...rest] = parts;
  if (head === "job") {
    // A job screen is only ever a job screen with a job on it.
    const job = rest[0];
    if (!job || rest.length > 2) return null;
    const sub = rest[1];
    if (sub && !UNDER_JOB.includes(sub)) return null;
    return { screen: sub || "job", job };
  }
  // Every other screen is a plain section, and the contextual ones are not
  // reachable except through the job they belong to.
  if (rest.length || CONTEXT_TABS.includes(head) || !SCREEN_KEYS.has(head)) return null;
  return { screen: head, job: null };
}

// The address for a screen, or null when that screen has no address to give:
// a contextual screen with no job behind it is the "No job selected" panel,
// which is a state rather than a place.
export function formatRoute({ screen, job }) {
  if (!screen || !SCREEN_KEYS.has(screen)) return null;
  if (CONTEXT_TABS.includes(screen)) {
    if (!job) return null;
    const base = "#/job/" + encodeURIComponent(job);
    return screen === "job" ? base : base + "/" + screen;
  }
  return "#/" + screen;
}

// What an address can actually be opened as from cold — or gone back to,
// once the shell no longer holds what the screen was built from.
//
// A job is a real deep link: the number is the whole of it, and the same read
// that opens a job from Home opens it again. A ticket, an assessment or a
// report upload is not. Those screens are half-entered work living in the
// editor, and `#/job/S-10113/ticket` does not say which draft or what was
// typed into it — so the address degrades to the job it hangs off, which is
// the page those screens are opened from in the first place. That keeps the
// house rule intact as well: a contextual screen only ever opens with its
// job.
export function landingRoute(route) {
  if (!route) return null;
  if (route.screen !== "job" && CONTEXT_TABS.includes(route.screen)) {
    return { screen: "job", job: route.job };
  }
  return route;
}
