// The team chat's merge: every path a message can arrive by — initial
// page, poll refresh, realtime event, optimistic send, correction fetch
// — funnels through mergeIn, so no path can double a message another
// already delivered, and a fuller copy always wins over a sparser one.
//
// Pulled out of the component because this is where the room's worst
// bug lived: a corrected quote (real name, real words) was being thrown
// away by a diff that only checked whether a quote existed. Pure
// functions, so the regression tests can hold the door.

// Messages sorted as the room reads them: oldest first, ties on the id
// so the order is stable however they arrived.
export const inOrder = (a, b) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

export const reactionsKey = arr => (arr || []).map(r => r.emoji + r.profileId).sort().join("|");

// Quotes compare by what they say, not whether they exist: the realtime
// path builds a provisional quote (sometimes before the sender's name is
// resolvable) and the follow-up fetch corrects it — a presence-only diff
// was throwing that correction away, leaving "Someone" on screen.
export const quotedKey = q => q ? `${q.name}|${q.body || q.label || ""}` : "";

export function mergeIn(prev, incoming) {
  const by = new Map(prev.map(m => [m.id, m]));
  let changed = false;
  for (const m of incoming) {
    const cur = by.get(m.id);
    if (!cur) { by.set(m.id, m); changed = true; continue; }
    // A realtime copy arrives without the joins — keep whatever name,
    // quote and reactions the row already resolved rather than blanking
    // them. Reactions: null means "this copy didn't carry them"; an
    // actual array (a poll row) is authoritative either way.
    const merged = {
      ...m,
      name: m.name || cur.name,
      // The quote, resolved the same way reactions are — an authoritative
      // copy wins, a partial one defers. A copy shaped from the reply_to
      // join (hasQuoteJoin) knows the truth: a null quote there means the
      // parent was deleted or aged out, so clear it — otherwise a deleted
      // quoted message keeps showing its text in the reply forever, on every
      // already-open client, defeating the deletion. A realtime copy has no
      // join, so its null means "didn't carry it": keep what we had, and let
      // a named provisional beat a nameless one.
      quoted: m.hasQuoteJoin
        ? m.quoted
        : (m.quoted && (m.quoted.name || !cur.quoted || !cur.quoted.name) ? m.quoted : cur.quoted),
      reactions: m.reactions != null ? m.reactions : cur.reactions
    };
    if (merged.name !== cur.name || merged.pinnedAt !== cur.pinnedAt ||
        quotedKey(merged.quoted) !== quotedKey(cur.quoted) ||
        reactionsKey(merged.reactions) !== reactionsKey(cur.reactions)) {
      by.set(m.id, merged);
      changed = true;
    }
  }
  return changed ? [...by.values()].sort(inOrder) : prev;
}

// Instants, never text. A message's createdAt is the database's ISO string
// ("…+00:00"), while readAt is an epoch from the tab's own clock; the two
// forms do not sort against each other as strings, and an unparseable stamp
// gives NaN, which fails every comparison below and so keeps the message.
const at = v => (typeof v === "number" ? v : Date.parse(v));

// What the refresh page says is GONE.
//
// mergeIn only ever adds, so a message deleted while the realtime channel
// was down stayed on screen for the life of the open room — and Reply on a
// row the server no longer has is refused by the reply_to foreign key. A
// page is authoritative about its own span: anything held inside that span
// which the page does not carry has been deleted, and goes with it.
//
// Both ends of the span are closed, because outside it the page is not
// evidence. Older than its oldest is the history "load more" fetched, which
// this page never asked about. Newer than its newest is the part of the room
// the page could not have carried: a send that landed after the fetch was
// asked for (readAt), and — since a poll that fails on a blip is answered
// from the read cache — everything realtime delivered after that cached copy
// was written. Removing those would delete live messages to tidy a stale
// one. The cost is that deleting the single newest message in the room isn't
// noticed here until another message follows it; the alternative loses work.
export function reconcileWindow(prev, page, readAt) {
  // No page, no evidence — an empty room stays whatever it already was.
  if (!page || !page.length) return prev;
  const ids = new Set(page.map(m => m.id));
  let oldest = Infinity, newest = -Infinity;
  for (const m of page) {
    const t = at(m.createdAt);
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }
  const ceiling = Math.min(newest, at(readAt));
  const kept = prev.filter(m => {
    if (ids.has(m.id)) return true;
    const t = at(m.createdAt);
    return !(t >= oldest && t <= ceiling);
  });
  // Identity matters: the rows are memoized, and an equal-but-new array
  // re-renders the whole room.
  return kept.length === prev.length ? prev : kept;
}
