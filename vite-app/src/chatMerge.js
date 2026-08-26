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
