// What a ticket's editable content amounts to, as one comparable string.
//
// The outbox replays the whole ticket and the last write wins — that rule
// stays, because the payload is the day as the field left it and nothing on
// the device knows better. What was missing was the sentence: a truck coming
// back into signal at 18:00 wrote its copy over the office's correction with
// no trace anywhere, and nobody found out until the invoice.
//
// Fingerprinting the row as it stands now, and comparing it with the one the
// device took when it loaded the draft, is what tells the two cases apart:
// a ticket nobody else touched, or somebody else's work about to be replaced.
//
// Pure and dependency-free, so the replay's decision can be tested without a
// database. Both sides speak the same shape — the queued payload's lines are
// built as {kind, label, unit, quantity, unit_rate} and that is what the
// database hands back, and crew comes through shapeCrew either way.

// Money is compared in whole cents, and hours and dose in hundredths, the
// way the rest of the app counts: a float sum of the same figures can differ
// in the last place and that difference is not somebody's edit.
const cents = n => Math.round((Number(n) || 0) * 100);

// A quantity is not money — a weld count, a kilometre, a third of a metre —
// and the card prices some of them in thousandths (0.333 welds at $8). Three
// places is what the screen can enter, so three places is what is compared.
const qty = n => Math.round((Number(n) || 0) * 1000);

const text = s => (s === null || s === undefined ? "" : String(s));

// JSON rather than a joined string: a rate line's label is free text off the
// client's schedule, and any separator character picked here is a character
// somebody's label may contain — which would make two different tickets
// fingerprint the same.
const lineKey = l => JSON.stringify([
  text(l.kind), text(l.label), text(l.unit), qty(l.quantity), cents(l.unit_rate)
]);

// By profile id, never by name or row id: the row id changes every time the
// crew is written back, and a name is a display value.
const crewKey = c => JSON.stringify([
  text(c.profileId), text(c.role),
  cents(c.straight), cents(c.ot), cents(c.solo), cents(c.soloOt),
  cents(c.dose), cents(c.mileage)
]);

// Sorted, because the database hands rows over in whatever order it likes and
// a ticket whose lines only changed places is not a ticket somebody edited.
// Line order is real to the invoice, but it is not evidence of an edit, and a
// false accusation costs more here than a missed one.
export function ticketFingerprint(lines, crew, delays) {
  return JSON.stringify({
    lines: (lines || []).map(lineKey).sort(),
    crew: (crew || []).map(crewKey).sort(),
    // Trimmed: a trailing space somebody's keyboard added is not a change
    // worth telling a technician their save overwrote.
    delays: text(delays).trim()
  });
}

// Whether writing `mine` over the row as it stands (`current`) replaces work
// somebody else saved after this device went out of range (`base` is what it
// had when it loaded the draft).
//
// Everything unknown answers no. An item queued by a build that never took a
// base, or a read that failed on the way in, is not evidence of an overwrite,
// and this sentence is shown to a technician who then has to go and check
// figures — it has to be right when it appears.
//
// `current === mine` is the retry: this same item already wrote, the row is
// its own copy, and telling somebody a second time that they overwrote a save
// they overwrote hours ago is how a real warning gets swiped away unread.
export function replacedNewerWork(base, mine, current) {
  if (!base || !current) return false;
  return current !== base && current !== mine;
}
