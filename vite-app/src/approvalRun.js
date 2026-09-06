// The sequential runner behind "Approve N periods" on the Timesheets
// awaiting-approval tab, and the two sentences it says while and after it runs.
//
// One at a time on purpose, unlike the bulk chase next door: every approval
// renders a jsPDF document in the browser and uploads it, so the wait is the
// render rather than a round trip, and four of them building at once on the
// office laptop buys nothing and costs the memory.
//
// Deliberately pure — no db.js, no React, no jsPDF. What this module owns is
// the order, the stop and the words, which are the parts worth pinning down
// without a live storage bucket in the room.

// How many names a summary prints before it starts counting the rest. Long
// enough that a whole crew fits; short enough that it stays one line.
export const NAME_LIST_LIMIT = 8;

// Runs `work(item)` over `items`, in order, one at a time.
//
// Options:
//   shouldStop  asked before each item starts; true means start no more
//   onStart     (n, total, item) just before item n begins — the progress line
//
// Answers with { done, failed: [{ item, error }], stopped, notStarted }.
// It never throws for one item: signing off five people's hours must not be
// undone by the sixth person's upload failing, and the caller names whoever
// did not make it.
export async function runInOrder(items, work, opts = {}) {
  const list = Array.from(items || []);
  const shouldStop = opts.shouldStop || (() => false);
  const onStart = opts.onStart || (() => {});

  const done = [];
  const failed = [];
  let stopped = false;
  let i = 0;

  for (; i < list.length; i++) {
    // Asked before each one starts and never mid-flight: the person being
    // worked on has a PDF part-way to the bucket, and dropping that would
    // leave an approval row pointing at a document that is not there.
    if (shouldStop()) { stopped = true; break; }
    onStart(i + 1, list.length, list[i]);
    try {
      await work(list[i]);
      done.push(list[i]);
    } catch (e) {
      failed.push({ item: list[i], error: e });
    }
  }

  return { done, failed, stopped, notStarted: list.slice(i) };
}

// What the screen says while it runs: "3 of 6 · Jane Doe…". The name is the
// point — a bare "3 of 6" leaves the admin watching a number, with no way to
// tell which timesheet is being frozen at the moment it goes wrong.
export function approvalProgressLine(n, total, name) {
  return `${n} of ${total} · ${name || "Unnamed"}…`;
}

function nameList(items, nameOf, limit) {
  const names = items.map(x => nameOf(x) || "Unnamed");
  const shown = names.slice(0, limit).join(", ");
  const rest = names.length - limit;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

// What it says afterwards. Failures are named rather than counted: "2 failed"
// is a number the office can do nothing with, and the names are the people
// who still have to be signed off by hand.
export function approvalRunSummary({
  done = [], failed = [], notStarted = [], stopped = false,
  total, nameOf = x => x && x.name, limit = NAME_LIST_LIMIT
} = {}) {
  const n = total == null ? done.length + failed.length + notStarted.length : total;
  const parts = [`Approved ${done.length} of ${n}`];
  if (stopped && notStarted.length) parts.push(`stopped — ${notStarted.length} not started`);
  if (failed.length) {
    parts.push(`${failed.length} not approved — still ticked, so pressing again retries them: ${nameList(failed.map(f => f.item), nameOf, limit)}`);
  }
  return parts.join(" · ");
}
