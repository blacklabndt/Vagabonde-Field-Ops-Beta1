// What the office needs to be told, worked out from what the database
// already records.
//
// A failed backup, a drive whose consent lapsed, a schedule nothing is
// picking up and a run of background errors are all written down the
// moment they happen — in backup_runs, in app_settings and in
// function_errors — and all four are then only visible to somebody who
// opens the Admin screen and looks. For a one-person office that can be
// weeks. This is the reading of those records, kept pure so both the
// people who need it can share the wording: Home's attention strip calls
// it in the browser, and the admin-digest function repeats it in
// TypeScript to decide whether there is an email to send.
//
// Every item is a fact and a next step, deliberately in two halves: the
// fact belongs on the strip whatever screen you are on, and the step has
// to name where to look, because Home has no way to switch tabs for you.

// The error log's window. A day, so "since yesterday" means the same
// thing at 06:00 and at 23:00 — a window pinned to midnight would go
// quiet every morning with the night's failures still unread.
export const ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000;

// How late a backup has to be before lateness is news. The tick runs every
// five minutes and moves next_run_at the moment a run STARTS, so a due
// date still in the past hours later means nothing is picking it up at
// all — a slow run has already moved the date. Six hours is short enough
// to catch a night that never happened and long enough that a paused
// project or a clock a little out does not cry wolf.
export const OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000;

// backup_runs holds restores as well as backups, and "Last backup failed"
// is the wrong sentence for a restore that died. Same kinds the panel
// names, same words.
const KIND_WORDS = {
  backup: "backup",
  before_restore: "safety backup",
  restore_all: "restore",
  restore_jobs: "job restore"
};

// Plain distance in the past. Hours below a day because "0 days ago" is
// not English, and a failure an hour old reads very differently from one
// three days old — which is the whole point of putting it on the strip.
export function agoPhrase(ms) {
  const d = Math.max(0, Number(ms) || 0);
  if (d < 3600000) return "less than an hour ago";
  if (d < 86400000) {
    const hours = Math.floor(d / 3600000);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(d / 86400000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Which functions have been failing, busiest first, so the line names the
// one worth opening rather than listing the log alphabetically.
function byFunction(rows) {
  const counts = new Map();
  for (const r of rows) {
    const name = String((r && r.function_name) || "unknown");
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} (${n})`);
}

// backupState is backup_state()'s answer (or nothing, if the read was
// refused or never made); errors is the most recent function_errors rows;
// now is a millisecond clock. Returns [] when there is nothing to say,
// which is what keeps the strip off the board on an ordinary morning.
export function attentionItems(backupState, errors, now) {
  const at = Number(now) || Date.now();
  const s = backupState || {};
  const items = [];

  // First, because it is the one that stops everything else: an expired
  // consent means no backup will run at all until somebody reconnects.
  const connectionError = String(s.connection_error || "").trim();
  if (connectionError) {
    items.push({
      key: "connection",
      text: `The backup drive needs reconnecting — ${connectionError}`,
      where: "Open the Admin screen, Automatic backup, and connect the drive again. Backups are not running until you do."
    });
  }

  const last = s.last_run || null;
  if (last && last.status === "failed") {
    const word = KIND_WORDS[last.kind] || "backup";
    const finished = Date.parse(last.finished_at || last.started_at || "");
    const ago = Number.isFinite(finished) ? ` ${agoPhrase(at - finished)}` : "";
    const why = String(last.error || "").trim();
    items.push({
      key: "failed-run",
      text: `Last ${word} failed${ago}${why ? ` — ${why}` : ""}`,
      where: "Open the Admin screen, Automatic backup, to read what it says and start another."
    });
  }

  // Nothing has picked the schedule up. Only worth saying when a drive is
  // connected and answering: with no connection there is no schedule to be
  // late for, and with a lapsed one the line above already names the cause
  // and the fix — two lines about one broken drive is noise, and the
  // second of them would send Kyle to a button that cannot work yet.
  const due = Date.parse(s.next_run_at || "");
  if (s.connected && !connectionError && Number.isFinite(due) && at - due > OVERDUE_GRACE_MS) {
    items.push({
      key: "overdue",
      text: `A backup was due ${agoPhrase(at - due)} and has not started`,
      where: "Open the Admin screen, Automatic backup, and press Back up now."
    });
  }

  // A row stamped a moment ahead of this device's clock is still one of
  // today's — a tablet a minute fast must not hide the error it just
  // caused — so only the far side of the window is tested.
  const recent = (errors || []).filter(e => {
    const t = Date.parse((e && e.created_at) || "");
    return Number.isFinite(t) && at - t <= ERRORS_WINDOW_MS;
  });
  if (recent.length) {
    items.push({
      key: "errors",
      text: `${recent.length} background error${recent.length === 1 ? "" : "s"} since yesterday — ${byFunction(recent).join(", ")}`,
      where: "Open the Admin screen, Recent background errors."
    });
  }

  return items;
}
