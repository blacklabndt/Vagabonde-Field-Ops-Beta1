# Automatic Backup to a Drive, with Restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Admin connects one drive account (Google Drive, OneDrive or Dropbox) from the Admin screen's Archive block, picks a schedule, and the project backs itself up — every table as gzipped JSON, every stored PDF, and a manifest — with restore of everything or of chosen jobs from the same panel.

**Architecture:** Three Edge Functions (`backup-oauth`, `backup-run`, `backup-restore`) do all the work server-side; a pg_cron job `backup-tick` pokes `backup-run` every five minutes through pg_net with the internal secret, exactly as `chat-retention` is fired. Connection, schedule and secrets live in the existing Admin-only `app_settings` row; progress lives in a new `backup_runs` table the Admin may read and nobody may write. The browser never sees a drive token and never holds a backup in memory. The Cloudflare Worker proxies `/backup/oauth/*` to `backup-oauth` the way it already proxies `/approve`.

**Tech Stack:** Deno Edge Functions (supabase-js v2 with the service role), Postgres 17 + pg_cron + pg_net, React 18 PWA (Vite), Cloudflare Worker, `node --test` for the pure logic.

**Spec:** `docs/superpowers/specs/2026-09-04-automatic-backup-design.md`

## Global Constraints

- Project ref is `eielmvxzdwwprmmfamlq`; Worker is `solitary-snowflake-ee22`.
- **Migrations apply live first**, then are filed under `supabase/migrations/<version>_….sql` with the version the applier returned. The executor of Task 2 has Kyle's word to apply (given in the approval of this plan's spec); no other task may apply a migration.
- RLS/policy/definer-function changes are probed live with `set_config('request.jwt.claims', …)` role simulation before they ship. Probes are filed beside the migration under `supabase/handover/`.
- New tables and functions need **explicit grants**: this project does not auto-expose new entities to `anon`/`authenticated`/`service_role` (`supabase/config.toml`, `[api] auto_expose_new_tables` left unset).
- The build must be green **before** the commit, never beside it: `npm --prefix vite-app test` then `npm --prefix vite-app run build`.
- Never round-trip a source file through PowerShell 5.1 `Get-Content`/`Set-Content` — BOM-less UTF-8 reads as ANSI and every em-dash ships as mojibake. Use the Edit/Write tools or a node script only.
- Never leave a literal control character in source; write the escape text and check with `grep -P '[\x00-\x08\x0e-\x1f]'`.
- Money is integer cents (`gstOn` in `data.js`); never float-sum. Nothing in this feature computes money — it copies rows verbatim.
- Tabs are PERMISSION, drawer visibility is code. The panel sits on the existing `mail` tab (label "Admin"); **no new tab is introduced**.
- The five node-tested shared modules — `supabase/functions/_shared/backupSchedule.ts`, `drive.ts`, `backupTables.ts`, `backupManifest.ts`, `gzip.ts` — must be **erasable-TypeScript only** (no `enum`, no parameter properties, no `namespace`, no `import x = require`) and must import nothing — no `https://esm.sh/…`, no `npm:`, no `Deno.*` globals. That is what lets `node --test` (Node ≥ 22.18 type stripping; this repo runs Node 24) import them straight from `vite-app/src/*.test.mjs`. Credentials are passed in as arguments, never read from the environment inside them.
- `vite-app/src/backupSchedule.js` and `supabase/functions/_shared/backupSchedule.ts` carry a **byte-identical shared-core block** between the markers `// ═══ shared core · keep byte-identical …` and `// ═══ end shared core ═══`. A test compares them; they must stay identical.
- Edge Functions deploy with `npx supabase functions deploy <name> --project-ref eielmvxzdwwprmmfamlq`. `verify_jwt` is pinned in `supabase/config.toml`, never passed as a deploy flag.
- App deploy is `npm run build && npx wrangler deploy` from the repo root.
- Refresh tokens and provider client secrets live in `app_settings` under its existing Admin-only RLS and are **never** selected by the client. `backup_state()` returns booleans for them, never values.
- Commit messages are prose in this repo's voice (a sentence about what changed and why, not a Conventional Commit prefix), ending with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The real table for burned ticket numbers is **`burned_ticket_numbers`** (the spec calls it `issued_ticket_numbers`; that name does not exist).
- Storage buckets are exactly `reports`, `jhas`, `shared`, `timesheets`, `chat-media`.

---

## File Structure

**New — pure logic (node-tested):**
- `vite-app/src/backupSchedule.js` — `nextRunAt`, `describeSchedule`, `zonedFields`, `instantAt`, `WEEKDAY_NAMES`, `BACKUP_ZONE`. The panel's "next due" line and the value written to `backup_next_run_at`.
- `supabase/functions/_shared/backupSchedule.ts` — the same core, for `backup-run`'s tick.
- `supabase/functions/_shared/backupTables.ts` — table lists, FK load order, wipe order, secret columns, cursor columns, page sizes.
- `supabase/functions/_shared/backupManifest.ts` — manifest shape and builders, folder stamps, retention selection.
- `supabase/functions/_shared/drive.ts` — `DriveClient` interface, `GoogleDrive`, `OneDrive`, `Dropbox`, `FakeDrive`, and the consent/exchange/refresh helpers.
- `supabase/functions/_shared/gzip.ts` — `gzip` / `gunzip` over the platform's own streams, so the function that writes a part and the function that reads it cannot disagree.

**New — server-side helper (NOT node-tested, because it talks to supabase-js):**
- `supabase/functions/_shared/backupDrive.ts` — `connectDrive(db)` (refresh the token, hand back a `DriveClient`, record a refresh failure in `backup_connection_error`) and `ensureFolder`.

**New — tests:**
- `vite-app/src/backupSchedule.test.mjs`
- `vite-app/src/backupShared.test.mjs`

**New — Edge Functions:**
- `supabase/functions/backup-oauth/index.ts`
- `supabase/functions/backup-run/index.ts`
- `supabase/functions/backup-restore/index.ts`

**New — UI:**
- `vite-app/src/components/backupPanel.jsx` — `AutomaticBackupPanel`, `RestoreDialog`, `RestoreJobsDialog`.

**New — database:**
- `supabase/migrations/<version>_the_project_backs_itself_up.sql` (Task 2)
- `supabase/handover/probes-<version>-the-project-backs-itself-up.sql` (Task 2)
- `supabase/migrations/<version>_the_backup_knows_which_schema_it_came_from.sql` (Task 5)

`<version>` is not a placeholder to invent: it is the 14-digit stamp the applier returns, read back with the Supabase MCP `list_migrations` tool immediately after `apply_migration`, and the step that produces it says so.

**Modified:**
- `supabase/config.toml` — three `[functions.*]` blocks.
- `worker/index.js` — the `/backup/oauth/*` branch.
- `vite-app/src/db.js` — nine Db methods + toast entries.
- `vite-app/src/components/adminSetup.jsx` — mount `AutomaticBackupPanel` inside the Archive Blueprint.
- `CLAUDE.md`, `README.md`, `HANDOVER.md`.

**Deliberately unchanged:** `vite-app/e2e/fieldOps.spec.js`. Its `SCREEN_LANDMARK` map already holds `"Admin": p => p.getByRole("heading", { name: "Admin", exact: true })`, and the backup panel lives inside that same screen — no new drawer screen is added, so no landmark is needed.

---

### Task 1: The schedule, written twice and kept identical

**Files:**
- Create: `vite-app/src/backupSchedule.js`
- Create: `supabase/functions/_shared/backupSchedule.ts`
- Test: `vite-app/src/backupSchedule.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BACKUP_ZONE: string` (`"America/Edmonton"`)
  - `WEEKDAY_NAMES: string[]` (Sunday-first)
  - `zonedFields(ms: number) → { year, month, day, hour, minute, second, dow }` — the Grande Prairie wall clock at a UTC instant; `month` is 1-12, `dow` 0 = Sunday.
  - `instantAt(year, month, day, hour) → number` — the UTC milliseconds at which that wall clock reads `hour:00`.
  - `matchesDay(frequency, weekday, fields) → boolean`
  - `nextRunAt(settings, now) → string | null` — an ISO-8601 UTC string. `settings` is `{ frequency: "daily"|"weekdays"|"weekly"|"monthly", weekday: 0-6, hour: 0-23 }`; `now` is milliseconds or anything `new Date()` accepts.
  - `describeSchedule(settings) → string`
  - From the `.ts` only: `export type BackupFrequency`, `export interface BackupSchedule`.

- [ ] **Step 1: Write the failing test**

Create `vite-app/src/backupSchedule.test.mjs`:

```js
// The clock behind the automatic backup. It is pure, it is small, and it
// decides at what moment the project copies itself to a drive — so the
// interesting cases are the two mornings a year when Alberta's wall clock
// skips or repeats an hour, and the month ends where "the 1st" is the next
// month rather than this one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKUP_ZONE, WEEKDAY_NAMES, zonedFields, instantAt, matchesDay,
  nextRunAt, describeSchedule
} from "./backupSchedule.js";

const wall = iso => {
  const f = zonedFields(new Date(iso).getTime());
  return `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")} ${String(f.hour).padStart(2, "0")}:${String(f.minute).padStart(2, "0")}`;
};

test("the zone is the crew's own", () => {
  assert.equal(BACKUP_ZONE, "America/Edmonton");
  assert.equal(WEEKDAY_NAMES[0], "Sunday");
  assert.equal(WEEKDAY_NAMES[6], "Saturday");
});

test("zonedFields reads Grande Prairie's wall clock, not UTC's", () => {
  // 2026-01-15 09:00 UTC is 02:00 MST the same morning.
  const f = zonedFields(Date.parse("2026-01-15T09:00:00Z"));
  assert.deepEqual(
    { y: f.year, m: f.month, d: f.day, h: f.hour, dow: f.dow },
    { y: 2026, m: 1, d: 15, h: 2, dow: 4 }
  );
});

test("zonedFields calls midnight hour 0, never 24", () => {
  const f = zonedFields(Date.parse("2026-01-15T07:00:00Z")); // 00:00 MST
  assert.equal(f.hour, 0);
  assert.equal(f.day, 15);
});

test("instantAt lands on the wall clock in winter and in summer", () => {
  assert.equal(instantAt(2026, 1, 15, 2), Date.parse("2026-01-15T09:00:00Z")); // MST, -7
  assert.equal(instantAt(2026, 7, 15, 2), Date.parse("2026-07-15T08:00:00Z")); // MDT, -6
});

test("instantAt on the spring-forward morning gives the first real moment", () => {
  // 2026-03-08: 02:00 MST becomes 03:00 MDT, so 02:00 never happens.
  // The answer must still be a single, definite instant on that morning.
  const at = instantAt(2026, 3, 8, 2);
  assert.equal(new Date(at).toISOString(), "2026-03-08T09:00:00.000Z");
  assert.equal(wall("2026-03-08T09:00:00Z"), "2026-03-08 03:00");
});

test("instantAt on the fall-back morning takes the first of the two 01:00s", () => {
  // 2026-11-01: 02:00 MDT becomes 01:00 MST, so 01:00 happens twice.
  const at = instantAt(2026, 11, 1, 1);
  assert.equal(new Date(at).toISOString(), "2026-11-01T07:00:00.000Z");
});

test("matchesDay knows each frequency", () => {
  const sunday = zonedFields(Date.parse("2026-08-16T12:00:00Z"));
  const monday = zonedFields(Date.parse("2026-08-17T12:00:00Z"));
  const first = zonedFields(Date.parse("2026-09-01T12:00:00Z"));
  assert.equal(matchesDay("daily", 0, sunday), true);
  assert.equal(matchesDay("weekdays", 0, sunday), false);
  assert.equal(matchesDay("weekdays", 0, monday), true);
  assert.equal(matchesDay("weekly", 1, monday), true);
  assert.equal(matchesDay("weekly", 2, monday), false);
  assert.equal(matchesDay("monthly", 0, first), true);
  assert.equal(matchesDay("monthly", 0, monday), false);
  assert.equal(matchesDay("nonsense", 0, monday), false);
});

test("daily rolls to tomorrow once today's hour has gone", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 2 };
  // 01:00 Edmonton on the 15th — today's 02:00 is still ahead.
  assert.equal(nextRunAt(settings, Date.parse("2026-01-15T08:00:00Z")), "2026-01-15T09:00:00.000Z");
  // 03:00 Edmonton — today's has gone.
  assert.equal(nextRunAt(settings, Date.parse("2026-01-15T10:00:00Z")), "2026-01-16T09:00:00.000Z");
});

test("daily never returns the instant it was asked at", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 2 };
  const exactly = Date.parse("2026-01-15T09:00:00Z");
  assert.equal(nextRunAt(settings, exactly), "2026-01-16T09:00:00.000Z");
});

test("weekdays skips Saturday and Sunday", () => {
  const settings = { frequency: "weekdays", weekday: 0, hour: 2 };
  // Friday 2026-08-21, after the hour, so the next one is Monday the 24th.
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-08-21T10:00:00Z"))), "2026-08-24 02:00");
});

test("weekly waits for its own day", () => {
  const settings = { frequency: "weekly", weekday: 3, hour: 23 }; // Wednesday
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-08-20T12:00:00Z"))), "2026-08-26 23:00");
});

test("weekly asked on its own day before the hour keeps today", () => {
  const settings = { frequency: "weekly", weekday: 1, hour: 22 }; // Monday
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-17 22:00");
});

test("monthly means the 1st, across a month end and a year end", () => {
  const settings = { frequency: "monthly", weekday: 0, hour: 2 };
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-01-31T23:00:00Z"))), "2026-02-01 02:00");
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-02-28T23:00:00Z"))), "2026-03-01 02:00");
  assert.equal(wall(nextRunAt(settings, Date.parse("2026-12-31T23:00:00Z"))), "2027-01-01 02:00");
});

test("a daily 02:00 still fires on the morning 02:00 does not exist", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 2 };
  const at = nextRunAt(settings, Date.parse("2026-03-07T12:00:00Z"));
  assert.equal(wall(at), "2026-03-08 03:00");
});

test("a daily 01:00 fires once on the morning 01:00 happens twice", () => {
  const settings = { frequency: "daily", weekday: 0, hour: 1 };
  assert.equal(nextRunAt(settings, Date.parse("2026-10-31T20:00:00Z")), "2026-11-01T07:00:00.000Z");
});

test("rubbish settings fall back to a daily midnight rather than throwing", () => {
  assert.equal(wall(nextRunAt({}, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-18 00:00");
  assert.equal(wall(nextRunAt({ frequency: "daily", hour: "9" }, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-17 09:00");
  assert.equal(wall(nextRunAt({ frequency: "daily", hour: 99 }, Date.parse("2026-08-17T12:00:00Z"))), "2026-08-17 23:00");
});

test("describeSchedule says it in words a person reads", () => {
  assert.equal(describeSchedule({ frequency: "daily", hour: 2 }), "Every day at 02:00, Grande Prairie time");
  assert.equal(describeSchedule({ frequency: "weekdays", hour: 23 }), "Weekdays at 23:00, Grande Prairie time");
  assert.equal(describeSchedule({ frequency: "weekly", weekday: 5, hour: 0 }), "Every Friday at 00:00, Grande Prairie time");
  assert.equal(describeSchedule({ frequency: "monthly", hour: 6 }), "On the 1st of each month at 06:00, Grande Prairie time");
});

// ── The mirror ───────────────────────────────────────────────────────────
// The tick inside backup-run computes the next run the same way the panel
// does, and the two live in different runtimes. Rather than trust that,
// both files carry the same block between the same two markers, and this
// reads them off disk and insists they are the same characters.

const CORE = /\/\/ ═══ shared core[^\n]*\n([\s\S]*?)\/\/ ═══ end shared core ═══/;

const coreOf = path => {
  const m = CORE.exec(readFileSync(new URL(path, import.meta.url), "utf8"));
  assert.ok(m, `${path} has no shared-core block`);
  return m[1];
};

test("the panel's schedule and the function's are the same code", () => {
  const js = coreOf("./backupSchedule.js");
  const ts = coreOf("../../supabase/functions/_shared/backupSchedule.ts");
  assert.ok(js.includes("export function nextRunAt"), "the core must hold nextRunAt itself");
  assert.equal(ts, js);
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `npm --prefix vite-app test`
Expected: FAIL — `Cannot find module … backupSchedule.js`.

- [ ] **Step 3: Write `vite-app/src/backupSchedule.js`**

```js
// When the project next copies itself to the drive.
//
// Pure, so it can be tested and so the panel and the Edge Function can both
// hold it. Everything below the marker is duplicated byte for byte into
// supabase/functions/_shared/backupSchedule.ts — the tick that starts a run
// and the line that tells the Admin when it is due must never disagree —
// and backupSchedule.test.mjs reads both files back and compares them.
//
// The zone is Grande Prairie's, and it is done with Intl rather than a
// fixed offset because Alberta moves twice a year: an offset baked in in
// January runs an hour early all summer.

// ═══ shared core · keep byte-identical with the other backupSchedule ═══
export const BACKUP_ZONE = "America/Edmonton";

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const FIELDS = new Intl.DateTimeFormat("en-CA", {
  timeZone: BACKUP_ZONE, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short"
});

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The wall clock in Grande Prairie at a given UTC instant. hour12:false
// answers midnight as "24" in some ICU builds and "00" in others, so it is
// taken modulo 24 rather than trusted.
export function zonedFields(ms) {
  const out = {};
  for (const p of FIELDS.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour) % 24, minute: Number(out.minute), second: Number(out.second),
    dow: DOW[out.weekday]
  };
}

// The instant at which Grande Prairie's wall clock reads y-m-d hour:00.
// Guess as though the zone were UTC, look at what that instant actually
// reads, and correct by the difference; two passes settle it anywhere but a
// changeover morning. On the morning 02:00 does not exist the correction
// oscillates by an hour, so the loop is capped and returns the last guess —
// 03:00 local, the first real moment at or after the missing hour. On the
// morning 01:00 happens twice it settles on the first of the two.
export function instantAt(year, month, day, hour) {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const f = zonedFields(guess);
    const seen = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    const corrected = guess + (wall - seen);
    if (corrected === guess) return guess;
    guess = corrected;
  }
  return guess;
}

export function matchesDay(frequency, weekday, fields) {
  if (frequency === "daily") return true;
  if (frequency === "weekdays") return fields.dow >= 1 && fields.dow <= 5;
  if (frequency === "weekly") return fields.dow === (Number(weekday) || 0);
  if (frequency === "monthly") return fields.day === 1;
  return false;
}

const cleanHour = value => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(23, Math.max(0, n));
};

// The next moment after `now` that the schedule calls for, as an ISO string
// in UTC — which is what app_settings.backup_next_run_at holds and what the
// tick compares against. Strictly after: asked at exactly the scheduled
// instant it answers the following one, so a run cannot restart itself.
export function nextRunAt(settings, now) {
  const s = settings || {};
  const frequency = s.frequency || "daily";
  const hour = cleanHour(s.hour);
  const from = typeof now === "number" ? now : new Date(now || Date.now()).getTime();
  if (!Number.isFinite(from)) return null;
  let day = zonedFields(from);
  for (let i = 0; i < 400; i++) {
    const at = instantAt(day.year, day.month, day.day, hour);
    if (at > from && matchesDay(frequency, s.weekday, zonedFields(at))) {
      return new Date(at).toISOString();
    }
    const nextDay = new Date(Date.UTC(day.year, day.month - 1, day.day) + 86400000);
    day = {
      year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(), dow: nextDay.getUTCDay(), hour: 0, minute: 0, second: 0
    };
  }
  return null;
}

export function describeSchedule(settings) {
  const s = settings || {};
  const at = `${String(cleanHour(s.hour)).padStart(2, "0")}:00`;
  const when = s.frequency === "weekdays" ? "Weekdays"
    : s.frequency === "weekly" ? `Every ${WEEKDAY_NAMES[Number(s.weekday) || 0]}`
    : s.frequency === "monthly" ? "On the 1st of each month"
    : "Every day";
  return `${when} at ${at}, Grande Prairie time`;
}
// ═══ end shared core ═══
```

- [ ] **Step 4: Write `supabase/functions/_shared/backupSchedule.ts`**

The header comment differs; the types go **above** the marker so the core stays byte-identical. Copy the shared core out of `vite-app/src/backupSchedule.js` verbatim — from the `// ═══ shared core …` line to `// ═══ end shared core ═══` inclusive — and put this above it:

```ts
// When the project next copies itself to the drive — the Edge Function's
// copy. Everything between the markers is duplicated byte for byte from
// vite-app/src/backupSchedule.js, so the tick that starts a run and the
// line the Admin reads on the panel cannot drift apart;
// vite-app/src/backupSchedule.test.mjs reads both files and compares them.
// Change one, change the other, in the same commit.
//
// Erasable TypeScript only, and no imports: the node suite imports this
// file directly to prove it matches its twin.

export type BackupFrequency = "daily" | "weekdays" | "weekly" | "monthly";

export interface BackupSchedule {
  frequency?: BackupFrequency;
  weekday?: number;
  hour?: number;
}
```

- [ ] **Step 5: Run the tests**

Run: `npm --prefix vite-app test`
Expected: PASS — the render-name scan is silent and every `backupSchedule` test passes, including "the panel's schedule and the function's are the same code".

- [ ] **Step 6: Commit**

```bash
git add vite-app/src/backupSchedule.js vite-app/src/backupSchedule.test.mjs supabase/functions/_shared/backupSchedule.ts
git commit -F- <<'MSG'
The backup knows when it is next due, and says so the same way twice

nextRunAt is the whole clock behind the automatic backup: daily, weekdays,
weekly and monthly, on Grande Prairie's wall clock rather than UTC, so a
schedule set in January does not run an hour early all summer. It is worked
out with Intl and a two-pass correction, which means the two mornings a year
Alberta skips or repeats an hour have a definite answer instead of an
accident — the tests pin both.

It lives twice, because the panel and the Edge Function both need it and
they are different runtimes. The duplicate is not trusted: both files carry
the same block between the same markers and a test reads them off disk and
insists they are the same characters.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 2: The migration — settings columns, the run log, `backup_state()`, and the five-minute tick

**Files:**
- Create (live first, then filed): `supabase/migrations/<version>_the_project_backs_itself_up.sql`
- Create: `supabase/handover/probes-<version>-the-project-backs-itself-up.sql`

**Interfaces:**
- Consumes: `private.user_role()`, `private.internal_config` (the `edge_shared_secret` row), the single-row `public.app_settings` table.
- Produces, for every later task:
  - `public.app_settings` columns: `backup_provider`, `backup_refresh_token`, `backup_account`, `backup_root_folder_id`, `backup_connection_error`, `backup_oauth_state`, `backup_oauth_state_at`, `backup_client_id_google`, `backup_client_secret_google`, `backup_client_id_microsoft`, `backup_client_secret_microsoft`, `backup_client_id_dropbox`, `backup_client_secret_dropbox`, `backup_frequency`, `backup_weekday`, `backup_hour`, `backup_keep`, `backup_next_run_at`.
  - `public.backup_runs (id uuid, kind text, status text, phase text, cursor jsonb, counts jsonb, error text, folder_id text, folder_name text, created_at, started_at, finished_at, heartbeat_at, requested_by uuid)` — Admin SELECT only, service role writes.
  - `public.backup_state() → jsonb` — Admin-only definer; keys `provider, account, connected, connection_error, root_folder_id, frequency, weekday, hour, keep, next_run_at, client_id_google, client_id_microsoft, client_id_dropbox, has_secret_google, has_secret_microsoft, has_secret_dropbox, approval_base_url, last_run, active_run`.
  - pg_cron job `backup-tick`, `*/5 * * * *`, POSTing `{"action":"tick"}` to `backup-run` with `x-internal-secret`.

**Two notes the executor must not skip:**

1. **`heartbeat_at` is not in the spec and is deliberate.** An Edge Function that dies mid-slice would otherwise leave a run `running` for ever and every later tick would refuse to start anything. The tick reclaims a run whose `heartbeat_at` is more than 10 minutes old.
2. **The grants are load-bearing.** This project leaves `auto_expose_new_tables` unset, so a new table and a new function reach nobody until granted — including `service_role`. Without the `grant all … to service_role` below, `backup-run` cannot write its own progress.

- [ ] **Step 1: Run the probes BEFORE the migration and keep the output**

Create `supabase/handover/probes-<version>-the-project-backs-itself-up.sql` (fill the version in at Step 4) with the content in Step 5, then run blocks 0-4 with the Supabase MCP `execute_sql` tool, one block at a time, and keep the output. Expected before the migration: block 0 names the fixtures; blocks 1-3 fail with `42P01 relation "public.backup_runs" does not exist` / `42703 column … does not exist`; block 4 fails with `42883 function public.backup_state() does not exist`. Those failures **are** the "before".

- [ ] **Step 2: Apply the migration live**

Kyle's word to apply was given in the approval of this plan's spec. Call the Supabase MCP `apply_migration` tool with `project_id: "eielmvxzdwwprmmfamlq"`, `name: "the_project_backs_itself_up"`, and this exact SQL:

```sql
-- The project backs itself up.
--
-- An Admin connects one drive account from the Archive block of the Admin
-- screen; from then on a pg_cron job pokes the backup-run Edge Function
-- every five minutes and that function does the work in slices — one table
-- part or one stored file at a time — so nothing has to finish inside a
-- single function invocation.
--
-- Three things land here. The connection and the schedule join the one
-- app_settings row, which is already Admin-only and already the place the
-- app's vendor keys live. Every run gets a row in backup_runs, which an
-- Admin may read and nobody may write — the writes are the service role's,
-- from inside the functions. And backup_state() is the panel's single
-- read: it answers with the settings MINUS every secret, so the browser
-- learns "connected, as kyle@example.com" and never the refresh token.
--
-- The tick is chat-retention's shape exactly: pg_net carries the call and
-- the database signs it with x-internal-secret, read when the job fires
-- rather than baked into the job's text, so rotating the value in
-- private.internal_config rotates this too.

-- ── 1 · The connection and the schedule ────────────────────────────────
-- Client id and secret per provider because each of the three needs its own
-- app registration under the owner's account; only one provider is ever
-- connected at a time, and backup_provider says which.
alter table public.app_settings
  add column if not exists backup_provider text,
  add column if not exists backup_refresh_token text,
  add column if not exists backup_account text,
  add column if not exists backup_root_folder_id text,
  add column if not exists backup_connection_error text,
  add column if not exists backup_oauth_state text,
  add column if not exists backup_oauth_state_at timestamptz,
  add column if not exists backup_client_id_google text,
  add column if not exists backup_client_secret_google text,
  add column if not exists backup_client_id_microsoft text,
  add column if not exists backup_client_secret_microsoft text,
  add column if not exists backup_client_id_dropbox text,
  add column if not exists backup_client_secret_dropbox text,
  add column if not exists backup_frequency text not null default 'daily',
  add column if not exists backup_weekday smallint not null default 0,
  add column if not exists backup_hour smallint not null default 2,
  add column if not exists backup_keep smallint not null default 14,
  add column if not exists backup_next_run_at timestamptz;

alter table public.app_settings
  drop constraint if exists app_settings_backup_provider_check,
  add constraint app_settings_backup_provider_check
    check (backup_provider is null or backup_provider in ('google', 'microsoft', 'dropbox'));

alter table public.app_settings
  drop constraint if exists app_settings_backup_frequency_check,
  add constraint app_settings_backup_frequency_check
    check (backup_frequency in ('daily', 'weekdays', 'weekly', 'monthly'));

alter table public.app_settings
  drop constraint if exists app_settings_backup_weekday_check,
  add constraint app_settings_backup_weekday_check
    check (backup_weekday between 0 and 6);

alter table public.app_settings
  drop constraint if exists app_settings_backup_hour_check,
  add constraint app_settings_backup_hour_check
    check (backup_hour between 0 and 23);

-- One is the floor: keeping zero backups is not a schedule, it is a
-- delete. 365 is the ceiling so a typo cannot fill somebody's drive.
alter table public.app_settings
  drop constraint if exists app_settings_backup_keep_check,
  add constraint app_settings_backup_keep_check
    check (backup_keep between 1 and 365);

-- ── 2 · Every run, and how far it got ──────────────────────────────────
-- cursor is where the next slice picks up; counts is what to show the
-- Admin. A run is never deleted by the app: the log is how a failure at
-- three in the morning is explained at nine.
create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('backup', 'restore_all', 'restore_jobs', 'before_restore')),
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'failed')),
  phase text,
  cursor jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  error text,
  folder_id text,
  folder_name text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- Stamped at the end of every slice. A run whose heartbeat has gone
  -- quiet for ten minutes is one whose function died mid-slice; the next
  -- tick reclaims it rather than leaving the schedule wedged for ever.
  heartbeat_at timestamptz,
  requested_by uuid references public.profiles (id) on delete set null
);

create index if not exists backup_runs_open_idx on public.backup_runs (status, created_at);
create index if not exists backup_runs_recent_idx on public.backup_runs (created_at desc);

alter table public.backup_runs enable row level security;

-- Read-only, and only for an Admin: a run row names the folder a backup
-- went to and how many rows of each table went with it.
drop policy if exists "backup_runs admin read" on public.backup_runs;
create policy "backup_runs admin read" on public.backup_runs
  for select to authenticated
  using ((select private.user_role()) = 'Admin');

-- No client writes at all. Progress is the service role's, written from
-- inside the functions — an account that could insert a run could point a
-- restore at a folder of its own choosing.
grant select on public.backup_runs to authenticated;
revoke insert, update, delete on public.backup_runs from authenticated, anon;
grant all on public.backup_runs to service_role;

-- ── 3 · What the panel is allowed to know ──────────────────────────────
-- Definer, because it reads app_settings columns the browser must never
-- select; the Admin check is the door, and every secret comes back as a
-- boolean rather than a value.
create or replace function public.backup_state()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.app_settings;
  last_run jsonb;
  active jsonb;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'The backup settings are an Admin''s.';
  end if;

  select * into s from public.app_settings limit 1;

  select to_jsonb(r) into last_run from (
    select id, kind, status, phase, counts, error, folder_name, started_at, finished_at
      from public.backup_runs
     where status in ('complete', 'failed')
     order by coalesce(finished_at, created_at) desc
     limit 1
  ) r;

  select to_jsonb(r) into active from (
    select id, kind, status, phase, counts, folder_name, created_at, started_at, heartbeat_at
      from public.backup_runs
     where status in ('queued', 'running')
     order by created_at
     limit 1
  ) r;

  return jsonb_build_object(
    'provider', s.backup_provider,
    'account', s.backup_account,
    'connected', (s.backup_refresh_token is not null),
    'connection_error', s.backup_connection_error,
    'root_folder_id', s.backup_root_folder_id,
    'frequency', coalesce(s.backup_frequency, 'daily'),
    'weekday', coalesce(s.backup_weekday, 0),
    'hour', coalesce(s.backup_hour, 2),
    'keep', coalesce(s.backup_keep, 14),
    'next_run_at', s.backup_next_run_at,
    'client_id_google', s.backup_client_id_google,
    'client_id_microsoft', s.backup_client_id_microsoft,
    'client_id_dropbox', s.backup_client_id_dropbox,
    'has_secret_google', (s.backup_client_secret_google is not null),
    'has_secret_microsoft', (s.backup_client_secret_microsoft is not null),
    'has_secret_dropbox', (s.backup_client_secret_dropbox is not null),
    'approval_base_url', s.approval_base_url,
    'last_run', last_run,
    'active_run', active
  );
end;
$$;

revoke execute on function public.backup_state() from public, anon;
grant execute on function public.backup_state() to authenticated;

-- ── 4 · The five-minute tick ───────────────────────────────────────────
-- Not a schedule of its own: it is a poke. backup-run decides whether
-- anything is due, advances a run in flight for about a hundred seconds,
-- and otherwise returns. Five minutes is fine granularity for an hourly
-- setting and is cheap enough to leave running for ever.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('backup-tick')
 where exists (select 1 from cron.job where jobname = 'backup-tick');

select cron.schedule(
  'backup-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/backup-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg',
      'x-internal-secret', (select value from private.internal_config where key = 'edge_shared_secret')
    ),
    body := '{"action":"tick"}'::jsonb
  );
  $$
);
```

- [ ] **Step 3: Read the applied version back**

Call the Supabase MCP `list_migrations` tool. The newest row is this migration; note its `version` (a 14-digit stamp such as `20260904…`). Every `<version>` below is that number.

- [ ] **Step 4: File the migration**

Write the exact SQL from Step 2 to `supabase/migrations/<version>_the_project_backs_itself_up.sql`. It must be character-for-character what was applied — repo files and applied migrations reconcile 1:1.

- [ ] **Step 5: Write the probes file and run blocks 0-6 AFTER the migration**

Create `supabase/handover/probes-<version>-the-project-backs-itself-up.sql`:

```sql
-- Probes for the automatic-backup migration. READ ONLY: every statement
-- here is a SELECT, and the two blocks that would write are commented out
-- with their ROLLBACK attached.
--
-- HOW TO RUN
--   Run each numbered block WHOLE — the begin/rollback pair is what makes
--   `set local role` and `set local request.jwt.claims` local. Block 0
--   names the fixtures the rest pick up. Run 0-4 BEFORE applying and keep
--   the output (they fail: nothing exists yet, and that IS their "before"),
--   apply, then run 0-6 and read them against the assertions below.
--
-- WHAT ROLE SIMULATION SIMULATES
--   `set local role authenticated` puts us in the API's role, so RLS is
--   enforced and schema `private` is reached the way PostgREST reaches it
--   (migration 20260903055300). `set local request.jwt.claims` is the
--   token; profiles is what the helpers actually believe.

-- ═══ 0 · Fixtures ══════════════════════════════════════════════════════
select 'chosen fixtures' as probe,
       (select id from public.profiles
         where role = 'Admin' and deactivated_at is null
         order by created_at limit 1)                        as admin_id,
       (select id from public.profiles
         where role = 'Technician' and deactivated_at is null
         order by created_at limit 1)                        as tech_id;

-- ═══ 1 · The settings columns exist, with the intended defaults ════════
-- AFTER: one row, frequency 'daily', weekday 0, hour 2, keep 14,
-- next_run_at null, and no provider connected.
select 'settings defaults' as probe,
       backup_provider, backup_frequency, backup_weekday, backup_hour,
       backup_keep, backup_next_run_at,
       (backup_refresh_token is not null) as connected
  from public.app_settings;

-- ═══ 2 · An Admin may read backup_runs ═════════════════════════════════
-- AFTER: 0 rows and NO error. (Nothing has run yet; the point is that the
-- read is permitted.)
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select 'admin reads runs' as probe, count(*) as rows_visible from public.backup_runs;
rollback;

-- ═══ 3 · A Technician may not ══════════════════════════════════════════
-- AFTER: 0 rows and no error — RLS is a filter, not a refusal. The
-- assertion is that it stays 0 even once runs exist; re-run this block
-- after the first backup and it must still say 0.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select 'technician reads runs' as probe, count(*) as rows_visible from public.backup_runs;
rollback;

-- ═══ 4 · backup_state() answers an Admin and refuses everyone else ═════
-- AFTER (4a): a jsonb object whose 'connected' is false and which contains
-- NO key holding a token or a client secret — only has_secret_* booleans.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select '4a admin state' as probe, public.backup_state() as state;
select '4a no secrets leaked' as probe,
       not exists (
         select 1 from jsonb_object_keys(public.backup_state()) k
          where k like '%refresh_token%' or k like '%client_secret%' or k = 'backup_oauth_state'
       ) as clean;
rollback;

-- AFTER (4b): raises 'The backup settings are an Admin''s.'
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select '4b technician state' as probe, public.backup_state() as state;
rollback;

-- ═══ 5 · A signed-in account cannot write a run ════════════════════════
-- The insert below is the one thing this file will not do for real, so it
-- is left commented with its rollback. Uncomment, run the whole block, and
-- expect 42501 "permission denied for table backup_runs".
--
-- begin;
-- select set_config('request.jwt.claims',
--   json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1))::text,
--   true);
-- set local role authenticated;
-- insert into public.backup_runs (kind) values ('backup');
-- rollback;

-- ═══ 6 · The tick is scheduled, and signs its own call ═════════════════
-- AFTER: one row, every five minutes, active, and its command names
-- x-internal-secret and internal_config rather than a literal secret.
select 'tick job' as probe, jobname, schedule, active,
       (command like '%x-internal-secret%') as signs_itself,
       (command like '%private.internal_config%') as reads_the_secret_live,
       (command like '%backup-run%') as calls_the_function
  from cron.job
 where jobname = 'backup-tick';
```

Run blocks 0-4 and 6 with `execute_sql`. Expected after the migration: block 1 gives one row reading `daily / 0 / 2 / 14 / null / false`; block 2 succeeds with `0`; block 3 succeeds with `0`; block 4a returns the object and `clean = true`; block 4b raises `The backup settings are an Admin's.`; block 6 gives `backup-tick, */5 * * * *, true, true, true, true`.

- [ ] **Step 6: Confirm the advisors are quiet**

Call the Supabase MCP `get_advisors` tool with `type: "security"`. Expected: no new finding naming `backup_runs` or `backup_state`. (`backup_state` is `security definer` **by design** with an Admin check as its first statement — if the linter flags it, the note goes in the commit message, not a change to the function.)

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations supabase/handover
git commit -F- <<'MSG'
The database learns where the backups go, and pokes the function that makes them

The connection and the schedule join app_settings, which is already the one
Admin-only row the app keeps its vendor keys in; the refresh token and the
three client secrets sit in it with everything else and are never selected
by the browser. backup_state() is the panel's whole read, and it answers
with has_secret_google rather than the secret.

backup_runs is the log: an Admin may read it, nobody may write it, and the
writes come from inside the functions with the service role. It carries a
heartbeat as well as a status, because a function that dies mid-slice would
otherwise leave a run "running" for ever and wedge the schedule.

The tick is chat-retention's own shape — pg_net, every five minutes, signed
with x-internal-secret read when the job fires rather than baked into the
job's text. Applied live first and probed with role simulation before and
after; the probes are filed beside it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 3: What a backup is made of — the table lists, the manifest, and a drive with a fake

**Files:**
- Create: `supabase/functions/_shared/backupTables.ts`
- Create: `supabase/functions/_shared/backupManifest.ts`
- Create: `supabase/functions/_shared/drive.ts`
- Test: `vite-app/src/backupShared.test.mjs`

**Interfaces:**
- Consumes: `zonedFields` from `supabase/functions/_shared/backupSchedule.ts` (Task 1).
- Produces — `backupTables.ts`:
  - `LOAD_ORDER: string[]` — parents first, FK-safe insert order.
  - `BACKUP_TABLES: string[]` — the same array (everything backed up is everything loaded).
  - `WIPE_ORDER: string[]` — children first, the order `supabase/handover/wipe-seed-data.sql` deletes in.
  - `NEVER_WIPED: string[]` — `["app_settings"]`.
  - `BUCKETS: string[]` — `["reports", "jhas", "shared", "timesheets", "chat-media"]`.
  - `APP_SETTINGS_SECRETS: string[]`
  - `APP_SETTINGS_NEVER_RESTORED: string[]` — every `backup_*` column, so a restore cannot overwrite the connection it is running through.
  - `CURSOR_COLUMN: Record<string, string | null>` — the single unique column to keyset-page a table by, or `null` for the two whose primary key is composite (`chat_reactions`, `arcade_scores` — they are paged by offset, and they hold no money and no hours).
  - `TABLE_KEYS: Record<string, string[]>` — the primary key, for upsert conflict targets and offset ordering.
  - `JOB_CHILD_TABLES: string[]` — what "restore these jobs" reaches for.
  - `PAGE_ROWS = 1000`, `MAX_PART_ROWS = 25000`.
  - `stripSecrets(table: string, rows: object[]) → object[]`
  - `partFileName(table: string, index: number) → string`
  - `chunkRows<T>(rows: T[], max: number) → T[][]`
- Produces — `backupManifest.ts`: `newManifest`, `recordTable`, `recordFiles`, `finishManifest`, `jobsIndex`, `folderStamp`, `beforeRestoreName`, `isBeforeRestore`, `foldersToDelete`, `schemaTooNew`, `fileEntryName`, `parseFileEntryName`, `MANIFEST_NAME`, `BACKUP_ROOT_NAME`, `TABLES_FOLDER`, `FILES_FOLDER`. Types `Manifest`, `ManifestJob`.
- Produces — `drive.ts`: `DriveFolder`, `DriveEntry`, `DriveClient`, `GoogleDrive`, `OneDrive`, `Dropbox`, `FakeDrive`, `makeDrive`, `authorizeUrl`, `exchangeCode`, `refreshAccessToken`, `PROVIDERS`, `SCOPES`, `RESUMABLE_BYTES`.

**Three decisions the spec left open, and why:**
1. **Two extra interface methods.** `listFiles(parentId)` — restore has to find `manifest.json` and the table parts inside a chosen backup folder, and `listFolders` alone cannot. `rootId()` — Google and Graph name their root `"root"`, Dropbox names it `""`, and callers must not have to know which.
2. **A drive name is one flat path segment.** All three providers read a `/` in a name as a folder boundary, so the run folder holds exactly two subfolders, `tables` and `files`, and every name inside them is flat: `tickets.01.json.gz`, and for a stored object `encodeURIComponent("<bucket>/<key>")`. That is reversible (`parseFileEntryName`), so restore can put every object back in the right bucket under the right key without the manifest having to carry thousands of names, and it avoids creating a drive folder per job.
3. **Uploads replace.** Each implementation removes or overwrites a same-named file rather than letting the provider make a second one, so a retried slice cannot leave two `tickets.01.json.gz` in a run folder.

- [ ] **Step 1: Write the failing test**

Create `vite-app/src/backupShared.test.mjs`:

```js
// The parts of a backup that are just data and arithmetic: which tables go
// in and in what order, what the manifest says, which old folders retention
// throws away, and a drive that answers without a network.
//
// These three modules are imported straight out of supabase/functions/ —
// node strips their types (Node 22.18+ / 24) — which is why they are
// written in erasable TypeScript with no imports of their own beyond the
// shared schedule. If this file ever fails with "Unknown file extension" or
// a syntax error inside a .ts, something non-erasable (an enum, a parameter
// property) has been added to one of them and must come back out.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  LOAD_ORDER, BACKUP_TABLES, WIPE_ORDER, NEVER_WIPED, BUCKETS,
  APP_SETTINGS_SECRETS, APP_SETTINGS_NEVER_RESTORED,
  CURSOR_COLUMN, TABLE_KEYS, JOB_CHILD_TABLES,
  PAGE_ROWS, MAX_PART_ROWS, stripSecrets, partFileName, chunkRows
} from "../../supabase/functions/_shared/backupTables.ts";

import {
  MANIFEST_NAME, BACKUP_ROOT_NAME, TABLES_FOLDER, FILES_FOLDER,
  newManifest, recordTable, recordFiles, finishManifest, jobsIndex,
  folderStamp, beforeRestoreName, isBeforeRestore, foldersToDelete,
  schemaTooNew, fileEntryName, parseFileEntryName
} from "../../supabase/functions/_shared/backupManifest.ts";

import { FakeDrive, authorizeUrl, SCOPES, PROVIDERS } from "../../supabase/functions/_shared/drive.ts";

const ROOT = new URL("../../", import.meta.url);
const read = rel => readFileSync(new URL(rel, ROOT), "utf8");

// ── The table lists ──────────────────────────────────────────────────────

test("every backed-up table is also a loaded table, and the other way round", () => {
  assert.deepEqual(BACKUP_TABLES, LOAD_ORDER);
  assert.equal(new Set(LOAD_ORDER).size, LOAD_ORDER.length, "no table twice");
});

test("the spec's table list is what is actually backed up", () => {
  // The spec names issued_ticket_numbers; the table is burned_ticket_numbers.
  const expected = [
    "clients", "contractors", "contacts", "profiles", "jobs", "tickets",
    "ticket_lines", "ticket_crew", "jhas", "reports", "rate_schedules",
    "rate_lines", "rate_overrides", "rate_line_history", "equipment",
    "timesheet_approvals", "chat_messages", "chat_reactions", "chat_reads",
    "push_subscriptions", "arcade_scores", "burned_ticket_numbers", "app_settings"
  ];
  assert.deepEqual([...BACKUP_TABLES].sort(), expected.sort());
});

test("parents come before their children in the load order", () => {
  const at = t => LOAD_ORDER.indexOf(t);
  // Every foreign key in the baseline, in words.
  const pairs = [
    ["clients", "jobs"], ["contractors", "jobs"], ["contacts", "jobs"],
    ["profiles", "jobs"], ["jobs", "tickets"], ["profiles", "tickets"],
    ["tickets", "ticket_lines"], ["tickets", "ticket_crew"], ["profiles", "ticket_crew"],
    ["jobs", "jhas"], ["profiles", "jhas"], ["jobs", "reports"],
    ["clients", "rate_schedules"], ["rate_schedules", "rate_lines"],
    ["rate_lines", "rate_line_history"], ["rate_schedules", "rate_line_history"],
    ["jobs", "rate_overrides"], ["profiles", "equipment"],
    ["profiles", "timesheet_approvals"], ["profiles", "chat_messages"],
    ["chat_messages", "chat_reactions"], ["profiles", "chat_reads"],
    ["profiles", "push_subscriptions"], ["profiles", "arcade_scores"]
  ];
  for (const [parent, child] of pairs) {
    assert.ok(at(parent) >= 0 && at(child) >= 0, `${parent}/${child} must both be in the load order`);
    assert.ok(at(parent) < at(child), `${parent} must load before ${child}`);
  }
});

test("the wipe order is the handover script's own order", () => {
  // The restore empties the database before it loads it, and the one place
  // this project has ever worked out a safe delete order is the handover
  // wipe. Read it back rather than re-deriving it.
  const sql = read("supabase/handover/wipe-seed-data.sql");
  const inScript = [...sql.matchAll(/delete from public\.(\w+)/g)].map(m => m[1]);
  const shared = WIPE_ORDER.filter(t => inScript.includes(t));
  const sameInScript = inScript.filter(t => shared.includes(t));
  assert.deepEqual(shared, [...new Set(sameInScript)], "the wipe order must follow the handover script");
});

test("everything loaded is wiped first, except the settings row", () => {
  assert.deepEqual(NEVER_WIPED, ["app_settings"]);
  for (const t of LOAD_ORDER) {
    if (NEVER_WIPED.includes(t)) {
      assert.ok(!WIPE_ORDER.includes(t), `${t} must never be wiped`);
    } else {
      assert.ok(WIPE_ORDER.includes(t), `${t} is loaded but never wiped — the load would collide`);
    }
  }
});

test("profiles is wiped last, because everything else names it", () => {
  assert.equal(WIPE_ORDER[WIPE_ORDER.length - 1], "profiles");
});

test("the wipe clears the two log tables the backup does not carry", () => {
  // audit_log.actor_id and function_errors have foreign keys to profiles, so
  // they must go before profiles can. They are not backed up (they are
  // operational noise), so a restored database starts with both empty.
  assert.ok(WIPE_ORDER.includes("audit_log"));
  assert.ok(WIPE_ORDER.includes("function_errors"));
  assert.ok(!BACKUP_TABLES.includes("audit_log"));
  assert.ok(!BACKUP_TABLES.includes("function_errors"));
});

test("every table has a primary key and a paging answer", () => {
  for (const t of BACKUP_TABLES) {
    assert.ok(Array.isArray(TABLE_KEYS[t]) && TABLE_KEYS[t].length, `${t} needs a primary key`);
    assert.ok(t in CURSOR_COLUMN, `${t} needs a cursor column or an explicit null`);
    const cursor = CURSOR_COLUMN[t];
    if (cursor !== null) {
      assert.deepEqual(TABLE_KEYS[t], [cursor], `${t}'s cursor must be its whole primary key`);
    } else {
      assert.ok(TABLE_KEYS[t].length > 1, `${t} only pages by offset if its key is composite`);
    }
  }
});

test("only the composite-key tables page by offset", () => {
  const offset = BACKUP_TABLES.filter(t => CURSOR_COLUMN[t] === null);
  assert.deepEqual(offset.sort(), ["arcade_scores", "chat_reactions"].sort());
});

test("the buckets are the five the app actually stores in", () => {
  const sql = read("supabase/handover/wipe-seed-data.sql");
  for (const b of BUCKETS) assert.ok(sql.includes(`'${b}'`), `${b} should appear in the wipe script`);
  assert.deepEqual(BUCKETS, ["reports", "jhas", "shared", "timesheets", "chat-media"]);
});

// ── Secrets ──────────────────────────────────────────────────────────────

test("every credential column of app_settings is stripped from a backup", () => {
  // The list is checked against the migrations rather than against itself:
  // a column added later whose name says key, secret or token must be
  // added here too, and this is what says so.
  const dir = new URL("supabase/migrations/", ROOT);
  const columns = new Set();
  for (const f of readdirSync(dir)) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    for (const m of sql.matchAll(/add column(?: if not exists)? (\w+)/g)) columns.add(m[1]);
    for (const m of sql.matchAll(/^\s{2}(\w+) text,?$/gm)) columns.add(m[1]);
  }
  const credentials = [...columns].filter(c => /(_key|_secret|_token)$/.test(c) || /_secret_/.test(c));
  for (const c of credentials) {
    assert.ok(APP_SETTINGS_SECRETS.includes(c), `${c} looks like a credential and must be stripped`);
  }
  assert.ok(APP_SETTINGS_SECRETS.includes("backup_oauth_state"), "the OAuth nonce is not a backup's business either");
});

test("stripSecrets empties the settings row's credentials and leaves the rest", () => {
  const row = {
    id: true, resend_api_key: "re_live", klipy_api_key: "kl_live",
    from_reports: "reports@vagabonde.ca", approval_base_url: "https://app.example.ca",
    backup_refresh_token: "1//refresh", backup_client_secret_google: "gsec",
    backup_provider: "google", backup_hour: 2
  };
  const [out] = stripSecrets("app_settings", [row]);
  assert.equal(out.resend_api_key, null);
  assert.equal(out.klipy_api_key, null);
  assert.equal(out.backup_refresh_token, null);
  assert.equal(out.backup_client_secret_google, null);
  assert.equal(out.from_reports, "reports@vagabonde.ca");
  assert.equal(out.backup_provider, "google");
  assert.equal(out.backup_hour, 2);
  assert.equal(row.resend_api_key, "re_live", "the caller's row must not be mutated");
});

test("stripSecrets leaves every other table exactly as it found it", () => {
  const rows = [{ id: "a", straight_hours: 8, dose_mr: 1.25 }];
  assert.deepEqual(stripSecrets("ticket_crew", rows), rows);
});

test("a restore never writes back the drive connection it is running through", () => {
  for (const c of ["backup_provider", "backup_refresh_token", "backup_root_folder_id", "backup_next_run_at", "backup_hour"]) {
    assert.ok(APP_SETTINGS_NEVER_RESTORED.includes(c), `${c} must not be restored`);
  }
  assert.ok(!APP_SETTINGS_NEVER_RESTORED.includes("resend_api_key"));
});

// ── Paging and parts ─────────────────────────────────────────────────────

test("the page size is PostgREST's own silent cap", () => {
  assert.equal(PAGE_ROWS, 1000);
  assert.ok(MAX_PART_ROWS >= PAGE_ROWS && MAX_PART_ROWS % PAGE_ROWS === 0);
});

test("chunkRows splits at the cap and never drops or duplicates a row", () => {
  const rows = Array.from({ length: 2501 }, (_, i) => i);
  const parts = chunkRows(rows, 1000);
  assert.deepEqual(parts.map(p => p.length), [1000, 1000, 501]);
  assert.deepEqual(parts.flat(), rows);
  assert.deepEqual(chunkRows([], 1000), []);
  assert.deepEqual(chunkRows([1, 2], 1000), [[1, 2]]);
});

test("part files are flat names, numbered from one, that sort in order", () => {
  assert.equal(partFileName("tickets", 0), "tickets.01.json.gz");
  assert.equal(partFileName("tickets", 9), "tickets.10.json.gz");
  assert.ok(!partFileName("tickets", 0).includes("/"), "a drive name is one path segment");
  const names = [0, 1, 10, 2].map(i => partFileName("t", i));
  assert.deepEqual([...names].sort(), ["t.01.json.gz", "t.02.json.gz", "t.03.json.gz", "t.11.json.gz"]);
});

test("a stored object's name survives the round trip through the drive", () => {
  assert.equal(TABLES_FOLDER, "tables");
  assert.equal(FILES_FOLDER, "files");
  const cases = [
    ["reports", "8f1c/report-2026-08.pdf"],
    ["chat-media", "2026/08/voice note (1).webm"],
    ["shared", "Safety & procedures/RT+SOP.pdf"]
  ];
  for (const [bucket, key] of cases) {
    const name = fileEntryName(bucket, key);
    assert.ok(!name.includes("/"), `${name} must be one path segment`);
    assert.deepEqual(parseFileEntryName(name), { bucket, key });
  }
  assert.equal(parseFileEntryName("not-a-backup-file"), null);
});

test("restoring chosen jobs reaches for exactly the tables a job owns", () => {
  assert.deepEqual(JOB_CHILD_TABLES,
    ["tickets", "ticket_lines", "ticket_crew", "jhas", "reports", "rate_overrides"]);
});

// ── The manifest ─────────────────────────────────────────────────────────

test("a folder is stamped on Grande Prairie's clock", () => {
  assert.equal(folderStamp(Date.parse("2026-09-04T08:05:00Z")), "2026-09-04 02-05");
  assert.equal(folderStamp(Date.parse("2026-01-04T09:05:00Z")), "2026-01-04 02-05");
  assert.equal(BACKUP_ROOT_NAME, "VagaboNDE backups");
  assert.equal(MANIFEST_NAME, "manifest.json");
});

test("a manifest records what went in and says what it holds", () => {
  let m = newManifest("0.9.0-Beta", "20260904135107", "2026-09-04T08:00:00.000Z");
  m = recordTable(m, "tickets", 2501, ["tickets.01.json.gz", "tickets.02.json.gz"]);
  m = recordTable(m, "clients", 12, ["clients.01.json.gz"]);
  m = recordFiles(m, 340, 1234567);
  m = finishManifest(m, "2026-09-04T08:41:00.000Z");
  assert.equal(m.app_version, "0.9.0-Beta");
  assert.equal(m.schema_version, "20260904135107");
  assert.equal(m.tables.tickets.rows, 2501);
  assert.deepEqual(m.tables.tickets.parts, ["tickets.01.json.gz", "tickets.02.json.gz"]);
  assert.equal(m.files.count, 340);
  assert.equal(m.files.bytes, 1234567);
  assert.equal(m.finished_at, "2026-09-04T08:41:00.000Z");
  assert.match(m.note, /hours and dose/i, "the manifest must say what a backup contains");
  // It has to survive a round trip through the drive as bytes.
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});

test("recordFiles adds up across the slices a run is made of", () => {
  let m = newManifest("0.9.0-Beta", null, "2026-09-04T08:00:00.000Z");
  m = recordFiles(m, 100, 1000);
  m = recordFiles(m, 40, 500);
  assert.deepEqual(m.files, { count: 140, bytes: 1500 });
});

test("the jobs index is what the per-job restore picks from", () => {
  const index = jobsIndex({
    jobs: [
      { id: "j1", job_number: "25-0001", project: "Wapiti tie-in", status: "Active", created_at: "2026-08-01T12:00:00Z", client_id: "c1" },
      { id: "j2", job_number: "25-0002", project: "Kakwa", status: "Closed", created_at: "2026-08-02T12:00:00Z", client_id: null }
    ],
    clients: [{ id: "c1", name: "Northgate Energy" }],
    tickets: [{ job_id: "j1" }, { job_id: "j1" }],
    jhas: [{ job_id: "j2" }],
    reports: [{ job_id: "j1" }]
  });
  assert.deepEqual(index, [
    { id: "j1", job_number: "25-0001", client: "Northgate Energy", project: "Wapiti tie-in", created_at: "2026-08-01T12:00:00Z", status: "Active", tickets: 2, jhas: 0, reports: 1 },
    { id: "j2", job_number: "25-0002", client: "", project: "Kakwa", created_at: "2026-08-02T12:00:00Z", status: "Closed", tickets: 0, jhas: 1, reports: 0 }
  ]);
});

// ── Retention ────────────────────────────────────────────────────────────

test("retention keeps the newest N and throws the rest away", () => {
  const names = ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00", "2026-09-04 02-00"];
  assert.deepEqual(foldersToDelete(names, 2), ["2026-09-01 02-00", "2026-09-02 02-00"]);
  assert.deepEqual(foldersToDelete(names, 4), []);
  assert.deepEqual(foldersToDelete(names, 10), []);
  assert.deepEqual(foldersToDelete([], 3), []);
});

test("retention reads the folders in date order however they arrive", () => {
  const shuffled = ["2026-09-04 02-00", "2026-09-01 02-00", "2026-09-03 02-00", "2026-09-02 02-00"];
  assert.deepEqual(foldersToDelete(shuffled, 1),
    ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00"]);
});

test("retention never touches a before-restore folder", () => {
  const names = [
    "2026-09-01 02-00", "before-restore 2026-09-02 11-30",
    "2026-09-03 02-00", "2026-09-04 02-00", "notes"
  ];
  assert.equal(beforeRestoreName("2026-09-02 11-30"), "before-restore 2026-09-02 11-30");
  assert.equal(isBeforeRestore("before-restore 2026-09-02 11-30"), true);
  assert.equal(isBeforeRestore("2026-09-02 11-30"), false);
  // "notes" is not a backup folder either — a person's own folder in the
  // same drive must survive.
  assert.deepEqual(foldersToDelete(names, 2), ["2026-09-01 02-00"]);
});

test("a backup from a newer schema than the live one is refused", () => {
  assert.equal(schemaTooNew("20260910000000", "20260904135107"), true);
  assert.equal(schemaTooNew("20260904135107", "20260904135107"), false);
  assert.equal(schemaTooNew("20260901000000", "20260904135107"), false);
  // Unknown either side is not proof of anything, so it is not a refusal.
  assert.equal(schemaTooNew(null, "20260904135107"), false);
  assert.equal(schemaTooNew("20260910000000", null), false);
});

// ── The drive, against the fake ──────────────────────────────────────────

const bytes = s => new TextEncoder().encode(s);
const text = b => new TextDecoder().decode(b);

test("the fake drive answers the whole interface", async () => {
  const drive = new FakeDrive();
  const root = drive.rootId();
  const folder = await drive.createFolder(root, "VagaboNDE backups");
  const run = await drive.createFolder(folder, "2026-09-04 02-00");

  assert.deepEqual((await drive.listFolders(root)).map(f => f.name), ["VagaboNDE backups"]);
  assert.deepEqual((await drive.listFolders(folder)).map(f => f.name), ["2026-09-04 02-00"]);

  const id = await drive.upload(run, "manifest.json", bytes('{"ok":true}'), "application/json");
  assert.deepEqual((await drive.listFiles(run)).map(f => f.name), ["manifest.json"]);
  assert.equal(text(await drive.download(id)), '{"ok":true}');

  await drive.delete(id);
  assert.deepEqual(await drive.listFiles(run), []);
});

test("the fake drive overwrites a name rather than doubling it, as the real three do", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "run");
  await drive.upload(folder, "clients.01.json.gz", bytes("first"), "application/gzip");
  const second = await drive.upload(folder, "clients.01.json.gz", bytes("second"), "application/gzip");
  assert.equal((await drive.listFiles(folder)).length, 1);
  assert.equal(text(await drive.download(second)), "second");
});

test("deleting a folder takes what is inside it", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "old");
  const file = await drive.upload(folder, "a.json", bytes("a"), "application/json");
  await drive.delete(folder);
  assert.deepEqual(await drive.listFolders(drive.rootId()), []);
  await assert.rejects(() => drive.download(file), /not found/i);
});

test("the fake can be told to fail, so retries can be tested", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "run");
  drive.failNextUploads = 2;
  await assert.rejects(() => drive.upload(folder, "a", bytes("a"), "text/plain"), /drive is unavailable/i);
  await assert.rejects(() => drive.upload(folder, "a", bytes("a"), "text/plain"), /drive is unavailable/i);
  const id = await drive.upload(folder, "a", bytes("a"), "text/plain");
  assert.equal(text(await drive.download(id)), "a");
});

// ── The consent URLs ─────────────────────────────────────────────────────

test("the three providers are asked for exactly the scopes the spec names", () => {
  assert.deepEqual(PROVIDERS, ["google", "microsoft", "dropbox"]);
  assert.equal(SCOPES.google, "https://www.googleapis.com/auth/drive.file");
  assert.equal(SCOPES.microsoft, "Files.ReadWrite offline_access");
  assert.equal(SCOPES.dropbox, "files.content.write files.content.read files.metadata.read");
});

test("each authorize URL carries the state, the redirect and offline access", () => {
  const redirect = "https://app.example.ca/backup/oauth/google";
  const google = new URL(authorizeUrl("google", "gid", redirect, "nonce123"));
  assert.equal(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(google.searchParams.get("client_id"), "gid");
  assert.equal(google.searchParams.get("redirect_uri"), redirect);
  assert.equal(google.searchParams.get("response_type"), "code");
  assert.equal(google.searchParams.get("access_type"), "offline");
  assert.equal(google.searchParams.get("prompt"), "consent");
  assert.equal(google.searchParams.get("state"), "nonce123");
  assert.equal(google.searchParams.get("scope"), SCOPES.google);

  const ms = new URL(authorizeUrl("microsoft", "mid", "https://app.example.ca/backup/oauth/microsoft", "n2"));
  assert.equal(ms.origin + ms.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(ms.searchParams.get("response_mode"), "query");
  assert.equal(ms.searchParams.get("scope"), SCOPES.microsoft);
  assert.equal(ms.searchParams.get("state"), "n2");

  const db = new URL(authorizeUrl("dropbox", "did", "https://app.example.ca/backup/oauth/dropbox", "n3"));
  assert.equal(db.origin + db.pathname, "https://www.dropbox.com/oauth2/authorize");
  assert.equal(db.searchParams.get("token_access_type"), "offline");
  assert.equal(db.searchParams.get("scope"), SCOPES.dropbox);
  assert.equal(db.searchParams.get("state"), "n3");
});

test("an unknown provider is refused rather than guessed at", () => {
  assert.throws(() => authorizeUrl("box", "id", "https://x/y", "n"), /provider/i);
});
```

- [ ] **Step 2: Run the test to watch it fail**

Run: `npm --prefix vite-app test`
Expected: FAIL — `Cannot find module … supabase/functions/_shared/backupTables.ts`.

- [ ] **Step 3: Write `supabase/functions/_shared/backupTables.ts`**

```ts
// What a backup is made of: which tables, in what order, and which columns
// never leave the building.
//
// Erasable TypeScript only, and no imports: vite-app/src/backupShared.test.mjs
// imports this file straight out of supabase/functions/ and node strips the
// types. An enum or a parameter property here breaks the test suite.
//
// Two orders, and they are not each other's reverse. LOAD_ORDER is
// parents-first, so an insert never names a row that is not there yet.
// WIPE_ORDER is the delete order supabase/handover/wipe-seed-data.sql
// worked out the hard way — children first, profiles last because every
// other table names it, and audit_log and function_errors in there too
// because their foreign keys to profiles would otherwise abort the whole
// transaction. The test reads the handover script back and compares.

export const LOAD_ORDER: string[] = [
  // profiles first of all: every other table's created_by, technician_id
  // and profile_id points at it. Its own id is a foreign key to
  // auth.users, which is why a restore creates the missing Auth accounts
  // BEFORE it loads this table, not after.
  "profiles",
  "clients",
  "contractors",
  "contacts",
  "rate_schedules",
  "rate_lines",
  "rate_line_history",
  "jobs",
  "rate_overrides",
  "tickets",
  "ticket_lines",
  "ticket_crew",
  "jhas",
  "reports",
  "equipment",
  "timesheet_approvals",
  // chat_messages.reply_to points at chat_messages, so its rows are loaded
  // oldest first — a reply is always newer than the message it quotes.
  "chat_messages",
  "chat_reactions",
  "chat_reads",
  "push_subscriptions",
  "arcade_scores",
  "burned_ticket_numbers",
  // Last, and restored by a narrow UPDATE rather than an insert: this row
  // holds the drive connection the restore is running through.
  "app_settings"
];

export const BACKUP_TABLES: string[] = LOAD_ORDER;

export const WIPE_ORDER: string[] = [
  "ticket_crew",
  "ticket_lines",
  "tickets",
  "burned_ticket_numbers",
  "timesheet_approvals",
  "jhas",
  "reports",
  "rate_overrides",
  "jobs",
  "rate_line_history",
  "rate_lines",
  "rate_schedules",
  "contacts",
  "clients",
  "contractors",
  "chat_reactions",
  "chat_reads",
  "chat_messages",
  "push_subscriptions",
  "arcade_scores",
  // Not backed up — operational noise — but they carry foreign keys to
  // profiles, so they have to go before profiles can. A restored database
  // therefore starts with an empty error log and an empty audit trail, and
  // the panel says so.
  "function_errors",
  "audit_log",
  "equipment",
  "profiles"
];

export const NEVER_WIPED: string[] = ["app_settings"];

export const BUCKETS: string[] = ["reports", "jhas", "shared", "timesheets", "chat-media"];

// Stripped from the app_settings row on its way into a backup. A backup
// lives in somebody's consumer drive; a Resend key in it is a key posted to
// a consumer drive. The list is checked against the migrations by the test:
// a later column whose name ends in _key, _secret or _token must be added.
export const APP_SETTINGS_SECRETS: string[] = [
  "resend_api_key",
  "klipy_api_key",
  "backup_refresh_token",
  "backup_oauth_state",
  "backup_client_secret_google",
  "backup_client_secret_microsoft",
  "backup_client_secret_dropbox"
];

// Never written back by a restore. Restoring the drive connection out of a
// backup would point the running restore at whatever drive was connected
// when that backup was taken — possibly none at all, mid-restore.
export const APP_SETTINGS_NEVER_RESTORED: string[] = [
  "id",
  "backup_provider",
  "backup_refresh_token",
  "backup_account",
  "backup_root_folder_id",
  "backup_connection_error",
  "backup_oauth_state",
  "backup_oauth_state_at",
  "backup_client_id_google",
  "backup_client_secret_google",
  "backup_client_id_microsoft",
  "backup_client_secret_microsoft",
  "backup_client_id_dropbox",
  "backup_client_secret_dropbox",
  "backup_frequency",
  "backup_weekday",
  "backup_hour",
  "backup_keep",
  "backup_next_run_at"
];

export const TABLE_KEYS: Record<string, string[]> = {
  profiles: ["id"],
  clients: ["id"],
  contractors: ["id"],
  contacts: ["id"],
  rate_schedules: ["id"],
  rate_lines: ["id"],
  rate_line_history: ["id"],
  jobs: ["id"],
  rate_overrides: ["id"],
  tickets: ["id"],
  ticket_lines: ["id"],
  ticket_crew: ["id"],
  jhas: ["id"],
  reports: ["id"],
  equipment: ["id"],
  timesheet_approvals: ["id"],
  chat_messages: ["id"],
  chat_reactions: ["message_id", "profile_id", "emoji"],
  chat_reads: ["profile_id"],
  push_subscriptions: ["id"],
  arcade_scores: ["game", "profile_id"],
  burned_ticket_numbers: ["id"],
  app_settings: ["id"]
};

// How a table is walked past PostgREST's silent 1,000-row cap. A single
// unique column means keyset — "the next thousand after this id" — which
// cannot skip a row when one is inserted mid-walk, and every table holding
// money, hours or dose has one. The two with a composite primary key are
// walked by OFFSET instead: chat_reactions is thumbs-ups and arcade_scores
// is a high-score table, and a reappearing or missing row in either is not
// something anybody is paid from.
export const CURSOR_COLUMN: Record<string, string | null> = {
  profiles: "id",
  clients: "id",
  contractors: "id",
  contacts: "id",
  rate_schedules: "id",
  rate_lines: "id",
  rate_line_history: "id",
  jobs: "id",
  rate_overrides: "id",
  tickets: "id",
  ticket_lines: "id",
  ticket_crew: "id",
  jhas: "id",
  reports: "id",
  equipment: "id",
  timesheet_approvals: "id",
  chat_messages: "id",
  chat_reactions: null,
  chat_reads: "profile_id",
  push_subscriptions: "id",
  arcade_scores: null,
  burned_ticket_numbers: "id",
  app_settings: "id"
};

// What "restore these jobs" reaches for, in the order it inserts them.
export const JOB_CHILD_TABLES: string[] = [
  "tickets", "ticket_lines", "ticket_crew", "jhas", "reports", "rate_overrides"
];

// PostgREST answers at most 1,000 rows per request, silently.
export const PAGE_ROWS = 1000;

// A part is uploaded and forgotten, so this is the ceiling on how much of
// one table is held in a function's memory at once. Twenty-five pages of
// ticket_lines is a few megabytes of JSON before gzip.
export const MAX_PART_ROWS = 25000;

// A copy of the rows with the credential columns emptied. The caller's rows
// are never touched: they are also what gets counted and what the manifest
// records.
export function stripSecrets(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (table !== "app_settings") return rows;
  return rows.map(row => {
    const out: Record<string, unknown> = { ...row };
    for (const column of APP_SETTINGS_SECRETS) {
      if (column in out) out[column] = null;
    }
    return out;
  });
}

// One flat path segment — every provider reads a "/" in a name as a folder
// boundary — numbered from 01 so the parts sort into their own order.
export function partFileName(table: string, index: number): string {
  return `${table}.${String(index + 1).padStart(2, "0")}.json.gz`;
}

export function chunkRows<T>(rows: T[], max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += max) out.push(rows.slice(i, i + max));
  return out;
}
```

- [ ] **Step 4: Write `supabase/functions/_shared/backupManifest.ts`**

```ts
// The manifest, the folder names, and which old folders retention removes.
//
// Erasable TypeScript only; the one import is the shared schedule, for the
// Grande Prairie clock a folder is stamped on. The node suite imports this
// file directly.

import { zonedFields } from "./backupSchedule.ts";

export const BACKUP_ROOT_NAME = "VagaboNDE backups";
export const MANIFEST_NAME = "manifest.json";
export const TABLES_FOLDER = "tables";
export const FILES_FOLDER = "files";
export const BEFORE_RESTORE_PREFIX = "before-restore ";

export interface ManifestJob {
  id: string;
  job_number: string;
  client: string;
  project: string;
  created_at: string;
  status: string;
  tickets: number;
  jhas: number;
  reports: number;
}

export interface Manifest {
  app_version: string;
  schema_version: string | null;
  started_at: string;
  finished_at: string | null;
  tables: Record<string, { rows: number; parts: string[] }>;
  files: { count: number; bytes: number };
  jobs: ManifestJob[];
  note: string;
}

const NOTE =
  "A complete copy of VagaboNDE Field Ops. It contains the crew's private " +
  "hours and dose readings and every client's pricing, so it belongs only " +
  "in the account it was written to. Vendor keys and drive credentials are " +
  "not in it.";

export function newManifest(appVersion: string, schemaVersion: string | null, startedAt: string): Manifest {
  return {
    app_version: appVersion,
    schema_version: schemaVersion,
    started_at: startedAt,
    finished_at: null,
    tables: {},
    files: { count: 0, bytes: 0 },
    jobs: [],
    note: NOTE
  };
}

export function recordTable(m: Manifest, table: string, rows: number, parts: string[]): Manifest {
  m.tables[table] = { rows, parts };
  return m;
}

// Added to rather than set: a run is made of slices and the files phase
// crosses several of them.
export function recordFiles(m: Manifest, count: number, bytes: number): Manifest {
  m.files = { count: m.files.count + count, bytes: m.files.bytes + bytes };
  return m;
}

export function finishManifest(m: Manifest, finishedAt: string): Manifest {
  m.finished_at = finishedAt;
  return m;
}

// The index the per-job restore picks from: one line per job, with the
// counts that let an Admin recognise the job they meant.
export function jobsIndex(source: {
  jobs: Record<string, unknown>[];
  clients: Record<string, unknown>[];
  tickets: Record<string, unknown>[];
  jhas: Record<string, unknown>[];
  reports: Record<string, unknown>[];
}): ManifestJob[] {
  const clientName = new Map<string, string>();
  for (const c of source.clients || []) clientName.set(String(c.id), String(c.name ?? ""));

  const count = (rows: Record<string, unknown>[]) => {
    const n = new Map<string, number>();
    for (const r of rows || []) {
      const k = String(r.job_id ?? "");
      n.set(k, (n.get(k) || 0) + 1);
    }
    return n;
  };
  const tickets = count(source.tickets);
  const jhas = count(source.jhas);
  const reports = count(source.reports);

  return (source.jobs || []).map(j => {
    const id = String(j.id);
    return {
      id,
      job_number: String(j.job_number ?? ""),
      client: j.client_id ? (clientName.get(String(j.client_id)) ?? "") : "",
      project: String(j.project ?? ""),
      created_at: String(j.created_at ?? ""),
      status: String(j.status ?? ""),
      tickets: tickets.get(id) || 0,
      jhas: jhas.get(id) || 0,
      reports: reports.get(id) || 0
    };
  });
}

// "2026-09-04 02-05" — the crew's own clock, and no colon, because a colon
// is not a legal filename character on Windows and these folders get synced
// down to Windows machines.
export function folderStamp(ms: number): string {
  const f = zonedFields(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${f.year}-${p(f.month)}-${p(f.day)} ${p(f.hour)}-${p(f.minute)}`;
}

export function beforeRestoreName(stamp: string): string {
  return BEFORE_RESTORE_PREFIX + stamp;
}

export function isBeforeRestore(name: string): boolean {
  return String(name || "").startsWith(BEFORE_RESTORE_PREFIX);
}

// A backup folder and nothing else: the stamp shape exactly. A folder
// somebody put in the same drive themselves is not retention's business.
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}$/;

// The stamp sorts lexicographically into date order, so "the newest N" is
// the tail of a plain sort. A before-restore folder is never in the running:
// it is the copy taken immediately before somebody replaced the database,
// and it is the one folder nobody should lose to a retention count.
export function foldersToDelete(names: string[], keep: number): string[] {
  const n = Math.max(1, Math.trunc(Number(keep)) || 1);
  const backups = (names || []).filter(name => STAMP.test(String(name))).sort();
  return backups.slice(0, Math.max(0, backups.length - n));
}

// One flat, reversible path segment for a stored object: the bucket and the
// key together, percent-encoded, so a key with slashes in it does not turn
// into a tree of drive folders.
export function fileEntryName(bucket: string, key: string): string {
  return encodeURIComponent(`${bucket}/${key}`);
}

export function parseFileEntryName(name: string): { bucket: string; key: string } | null {
  let decoded: string;
  try { decoded = decodeURIComponent(String(name || "")); } catch { return null; }
  const cut = decoded.indexOf("/");
  if (cut <= 0 || cut === decoded.length - 1) return null;
  return { bucket: decoded.slice(0, cut), key: decoded.slice(cut + 1) };
}

// Schema versions are the migration stamps, which sort as strings. A backup
// from a newer schema holds columns this database has not got, so loading it
// would fail halfway; that one is refused. Not knowing either version is
// not evidence of anything, so it is not a refusal.
export function schemaTooNew(backupVersion: string | null, liveVersion: string | null): boolean {
  if (!backupVersion || !liveVersion) return false;
  return String(backupVersion) > String(liveVersion);
}
```

- [ ] **Step 5: Write `supabase/functions/_shared/drive.ts`**

```ts
// One drive, three vendors, and a fake to test against.
//
// Everything a provider does differently lives inside its own class:
// Google's resumable sessions, Graph's upload sessions and its 320 KiB
// chunk arithmetic, Dropbox's paths-instead-of-ids and its arguments in an
// HTTP header. Above them the app has five verbs and two questions, and
// never asks which vendor it is talking to.
//
// Erasable TypeScript only, and no imports at all — not supabase-js, not
// Deno.env: vite-app/src/backupShared.test.mjs imports this file directly
// and node strips the types. Credentials arrive as arguments; nothing here
// reads the environment.

export const PROVIDERS: string[] = ["google", "microsoft", "dropbox"];

export const SCOPES: Record<string, string> = {
  google: "https://www.googleapis.com/auth/drive.file",
  microsoft: "Files.ReadWrite offline_access",
  dropbox: "files.content.write files.content.read files.metadata.read"
};

// Above this, an upload goes through the provider's resumable/session API.
// Below it, one request. Five megabytes is both a sensible cut-off and a
// whole number of Graph's mandatory 320 KiB chunks.
export const RESUMABLE_BYTES = 5 * 1024 * 1024;

export interface DriveFolder { id: string; name: string }
export interface DriveEntry { id: string; name: string; size: number }

export interface DriveClient {
  rootId(): string;
  accountName(): Promise<string>;
  listFolders(parentId: string): Promise<DriveFolder[]>;
  listFiles(parentId: string): Promise<DriveEntry[]>;
  createFolder(parentId: string, name: string): Promise<string>;
  upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string>;
  download(fileId: string): Promise<Uint8Array>;
  delete(id: string): Promise<void>;
}

// A refusal worth retrying carries `retryable`; backup-run's withRetry asks
// the flag, never the prose. 429 and 5xx are the drive being busy; a 401 is
// a token to refresh; a 403 or a 404 is an answer.
export interface DriveError extends Error { status: number; retryable: boolean }

async function ok(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  const e = new Error(`${what} failed (${res.status}): ${body.slice(0, 400)}`) as DriveError;
  e.status = res.status;
  e.retryable = res.status === 429 || res.status >= 500;
  throw e;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.byteLength;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

// ── Consent, exchange, refresh ───────────────────────────────────────────

const AUTHORIZE: Record<string, string> = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  dropbox: "https://www.dropbox.com/oauth2/authorize"
};

const TOKEN: Record<string, string> = {
  google: "https://oauth2.googleapis.com/token",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  dropbox: "https://api.dropboxapi.com/oauth2/token"
};

function assertProvider(provider: string): void {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`"${provider}" is not a drive provider this app knows — it is one of ${PROVIDERS.join(", ")}.`);
  }
}

// The consent page to send the Admin to. `state` is the nonce minted in
// app_settings; the callback compares it and will not act without it.
export function authorizeUrl(provider: string, clientId: string, redirectUri: string, state: string): string {
  assertProvider(provider);
  const u = new URL(AUTHORIZE[provider]);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES[provider]);
  u.searchParams.set("state", state);
  if (provider === "google") {
    // Without both of these Google hands back an access token and no
    // refresh token on the second and every later consent, and the
    // connection dies silently an hour later.
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  }
  if (provider === "microsoft") u.searchParams.set("response_mode", "query");
  if (provider === "dropbox") u.searchParams.set("token_access_type", "offline");
  return u.toString();
}

async function postForm(url: string, form: Record<string, string>, what: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString()
  });
  return await (await ok(res, what)).json();
}

export async function exchangeCode(
  provider: string, clientId: string, clientSecret: string, code: string, redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; accountId: string }> {
  assertProvider(provider);
  const body = await postForm(TOKEN[provider], {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  }, `${provider} token exchange`);
  const refreshToken = String(body.refresh_token ?? "");
  if (!refreshToken) {
    throw new Error(
      `${provider} sent an access token but no refresh token, so the connection would stop working within the hour. ` +
      `Remove the app's access in the provider's account settings and connect again.`
    );
  }
  return {
    accessToken: String(body.access_token ?? ""),
    refreshToken,
    accountId: String(body.account_id ?? "")
  };
}

export async function refreshAccessToken(
  provider: string, clientId: string, clientSecret: string, refreshToken: string
): Promise<string> {
  assertProvider(provider);
  const body = await postForm(TOKEN[provider], {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    ...(provider === "microsoft" ? { scope: SCOPES.microsoft } : {})
  }, `${provider} token refresh`);
  const token = String(body.access_token ?? "");
  if (!token) throw new Error(`${provider} refused to refresh the connection. Reconnect the drive on the Admin screen.`);
  return token;
}

export function makeDrive(provider: string, accessToken: string): DriveClient {
  assertProvider(provider);
  if (provider === "google") return new GoogleDrive(accessToken);
  if (provider === "microsoft") return new OneDrive(accessToken);
  return new Dropbox(accessToken);
}

// ── Google Drive ─────────────────────────────────────────────────────────
// Chunks must be a multiple of 256 KiB; 8 MiB is 32 of them.

const GOOGLE_CHUNK = 8 * 1024 * 1024;
const FOLDER_MIME = "application/vnd.google-apps.folder";

export class GoogleDrive implements DriveClient {
  token: string;
  constructor(accessToken: string) { this.token = accessToken; }

  head(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  rootId(): string { return "root"; }

  async accountName(): Promise<string> {
    const res = await ok(await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)",
      { headers: this.head() }
    ), "Google Drive account");
    const j = await res.json() as { user?: { displayName?: string; emailAddress?: string } };
    return j.user?.emailAddress || j.user?.displayName || "Google Drive";
  }

  async children(parentId: string, foldersOnly: boolean): Promise<DriveEntry[]> {
    const out: DriveEntry[] = [];
    let pageToken = "";
    for (;;) {
      const u = new URL("https://www.googleapis.com/drive/v3/files");
      u.searchParams.set("q",
        `'${parentId}' in parents and trashed = false and mimeType ${foldersOnly ? "=" : "!="} '${FOLDER_MIME}'`);
      u.searchParams.set("fields", "nextPageToken, files(id, name, size)");
      u.searchParams.set("pageSize", "1000");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const j = await (await ok(await fetch(u.toString(), { headers: this.head() }), "Google Drive listing")).json() as
        { files?: { id: string; name: string; size?: string }[]; nextPageToken?: string };
      for (const f of j.files ?? []) out.push({ id: f.id, name: f.name, size: Number(f.size ?? 0) });
      pageToken = j.nextPageToken ?? "";
      if (!pageToken) break;
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> { return this.children(parentId, true); }
  listFiles(parentId: string): Promise<DriveEntry[]> { return this.children(parentId, false); }

  async createFolder(parentId: string, name: string): Promise<string> {
    const res = await ok(await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: this.head({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    }), "Google Drive folder");
    return String((await res.json() as { id: string }).id);
  }

  async upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string> {
    // Google is happy to hold two files with the same name in one folder,
    // which is exactly what a retried slice would leave behind.
    const clash = (await this.listFiles(folderId)).find(f => f.name === name);
    if (clash) await this.delete(clash.id);

    if (body.byteLength <= RESUMABLE_BYTES) {
      const boundary = "vgb" + crypto.randomUUID().replace(/-/g, "");
      const payload = concat([
        utf8(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        body,
        utf8(`\r\n--${boundary}--\r\n`)
      ]);
      const res = await ok(await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
        method: "POST",
        headers: this.head({ "Content-Type": `multipart/related; boundary=${boundary}` }),
        body: payload
      }), "Google Drive upload");
      return String((await res.json() as { id: string }).id);
    }

    const start = await ok(await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
      method: "POST",
      headers: this.head({
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": contentType,
        "X-Upload-Content-Length": String(body.byteLength)
      }),
      body: JSON.stringify({ name, parents: [folderId] })
    }), "Google Drive upload session");
    const session = start.headers.get("Location");
    if (!session) throw new Error("Google Drive opened no upload session.");

    let at = 0;
    let id = "";
    while (at < body.byteLength) {
      const end = Math.min(at + GOOGLE_CHUNK, body.byteLength);
      const res = await fetch(session, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${at}-${end - 1}/${body.byteLength}` },
        body: body.subarray(at, end)
      });
      // 308 is Google saying "that chunk landed, send the next one".
      if (res.status === 308) {
        await res.body?.cancel();
        at = end;
        continue;
      }
      id = String((await (await ok(res, "Google Drive upload")).json() as { id: string }).id);
      at = end;
    }
    return id;
  }

  async download(fileId: string): Promise<Uint8Array> {
    const res = await ok(await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: this.head() }
    ), "Google Drive download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.head() });
    // Already gone is the outcome asked for.
    if (res.status === 404) { await res.body?.cancel(); return; }
    await ok(res, "Google Drive delete");
    await res.body?.cancel();
  }
}

// ── OneDrive (Microsoft Graph) ───────────────────────────────────────────
// Graph insists every chunk but the last is a multiple of 320 KiB. 5 MiB is
// exactly 16 of them, which is why RESUMABLE_BYTES doubles as the chunk.

const GRAPH = "https://graph.microsoft.com/v1.0/me/drive";
const GRAPH_CHUNK = RESUMABLE_BYTES;

export class OneDrive implements DriveClient {
  token: string;
  constructor(accessToken: string) { this.token = accessToken; }

  head(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  rootId(): string { return "root"; }

  async accountName(): Promise<string> {
    // /me needs User.Read, which is not in the scopes asked for; the drive
    // itself knows who owns it and Files.ReadWrite is enough to ask.
    const res = await ok(await fetch(GRAPH, { headers: this.head() }), "OneDrive account");
    const j = await res.json() as { owner?: { user?: { displayName?: string; email?: string } } };
    return j.owner?.user?.email || j.owner?.user?.displayName || "OneDrive";
  }

  async children(parentId: string, foldersOnly: boolean): Promise<DriveEntry[]> {
    const out: DriveEntry[] = [];
    let next = `${GRAPH}/items/${encodeURIComponent(parentId)}/children?$select=id,name,size,folder,file&$top=200`;
    while (next) {
      const j = await (await ok(await fetch(next, { headers: this.head() }), "OneDrive listing")).json() as
        { value?: { id: string; name: string; size?: number; folder?: unknown }[]; "@odata.nextLink"?: string };
      for (const item of j.value ?? []) {
        if (foldersOnly === !!item.folder) out.push({ id: item.id, name: item.name, size: Number(item.size ?? 0) });
      }
      next = j["@odata.nextLink"] ?? "";
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> { return this.children(parentId, true); }
  listFiles(parentId: string): Promise<DriveEntry[]> { return this.children(parentId, false); }

  async createFolder(parentId: string, name: string): Promise<string> {
    const res = await ok(await fetch(`${GRAPH}/items/${encodeURIComponent(parentId)}/children`, {
      method: "POST",
      headers: this.head({ "Content-Type": "application/json" }),
      // "replace" rather than "rename": running the same backup twice must
      // land in the same folder, not in "2026-09-04 02-00 1".
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "replace" })
    }), "OneDrive folder");
    return String((await res.json() as { id: string }).id);
  }

  async upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string> {
    const path = `${GRAPH}/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:`;
    if (body.byteLength <= RESUMABLE_BYTES) {
      const res = await ok(await fetch(`${path}/content`, {
        method: "PUT",
        headers: this.head({ "Content-Type": contentType }),
        body
      }), "OneDrive upload");
      return String((await res.json() as { id: string }).id);
    }

    const session = await ok(await fetch(`${path}/createUploadSession`, {
      method: "POST",
      headers: this.head({ "Content-Type": "application/json" }),
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } })
    }), "OneDrive upload session");
    const uploadUrl = String((await session.json() as { uploadUrl?: string }).uploadUrl ?? "");
    if (!uploadUrl) throw new Error("OneDrive opened no upload session.");

    let at = 0;
    let id = "";
    while (at < body.byteLength) {
      const end = Math.min(at + GRAPH_CHUNK, body.byteLength);
      // The upload URL carries its own credential; an Authorization header
      // on it is refused.
      const res = await ok(await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${at}-${end - 1}/${body.byteLength}` },
        body: body.subarray(at, end)
      }), "OneDrive upload");
      // 202 between chunks carries only the ranges still wanted; the final
      // 200/201 carries the item.
      if (res.status === 202) { await res.body?.cancel(); }
      else { id = String((await res.json() as { id: string }).id); }
      at = end;
    }
    return id;
  }

  async download(fileId: string): Promise<Uint8Array> {
    const res = await ok(await fetch(`${GRAPH}/items/${encodeURIComponent(fileId)}/content`,
      { headers: this.head() }), "OneDrive download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${GRAPH}/items/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: this.head() });
    if (res.status === 404) { await res.body?.cancel(); return; }
    await ok(res, "OneDrive delete");
    await res.body?.cancel();
  }
}

// ── Dropbox ──────────────────────────────────────────────────────────────
// Dropbox has no file ids in its ordinary API — a path IS the id. So the
// "id" this class hands out and takes back is a path, and the root is the
// empty string, which is what rootId() exists to hide from the caller.

const DROPBOX_CHUNK = 8 * 1024 * 1024;

// Arguments ride in an HTTP header, which may hold only ASCII. A client's
// name with an accent in it would otherwise be rejected by the transport
// rather than by Dropbox.
function dropboxArg(value: unknown): string {
  // The class is written as escapes on purpose: a literal high character
  // in this source is exactly what a PowerShell round-trip turns into
  // mojibake, and it would stay invisible until a client with an accent in
  // their name broke a backup.
  return JSON.stringify(value).replace(/[-￿]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export class Dropbox implements DriveClient {
  token: string;
  constructor(accessToken: string) { this.token = accessToken; }

  head(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  rootId(): string { return ""; }

  async rpc(endpoint: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const res = await ok(await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: "POST",
      headers: this.head(body === null ? {} : { "Content-Type": "application/json" }),
      body: body === null ? undefined : JSON.stringify(body)
    }), what);
    return await res.json() as Record<string, unknown>;
  }

  async accountName(): Promise<string> {
    // account_info.read is not in the scopes the spec asks for, so this is
    // allowed to fail: the account is a label, not a credential.
    try {
      const j = await this.rpc("users/get_current_account", null, "Dropbox account");
      const email = (j as { email?: string }).email;
      const name = (j as { name?: { display_name?: string } }).name?.display_name;
      return email || name || "Dropbox";
    } catch {
      return "Dropbox";
    }
  }

  async entries(parentId: string, foldersOnly: boolean): Promise<DriveEntry[]> {
    const out: DriveEntry[] = [];
    let j = await this.rpc("files/list_folder", { path: parentId, limit: 2000 }, "Dropbox listing");
    for (;;) {
      for (const e of (j.entries as { [".tag"]: string; name: string; path_lower?: string; path_display?: string; size?: number }[]) ?? []) {
        const isFolder = e[".tag"] === "folder";
        if (foldersOnly !== isFolder) continue;
        out.push({ id: String(e.path_display ?? e.path_lower ?? ""), name: e.name, size: Number(e.size ?? 0) });
      }
      if (!j.has_more) break;
      j = await this.rpc("files/list_folder/continue", { cursor: j.cursor }, "Dropbox listing");
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> { return this.entries(parentId, true); }
  listFiles(parentId: string): Promise<DriveEntry[]> { return this.entries(parentId, false); }

  async createFolder(parentId: string, name: string): Promise<string> {
    const path = `${parentId}/${name}`;
    try {
      const j = await this.rpc("files/create_folder_v2", { path, autorename: false }, "Dropbox folder");
      const meta = (j.metadata as { path_display?: string }) ?? {};
      return String(meta.path_display ?? path);
    } catch (e) {
      // "already exists" is the outcome asked for; every other refusal is
      // still a refusal.
      if (/conflict/i.test((e as Error).message)) return path;
      throw e;
    }
  }

  async upload(folderId: string, name: string, body: Uint8Array, contentType: string): Promise<string> {
    const path = `${folderId}/${name}`;
    if (body.byteLength <= RESUMABLE_BYTES) {
      const res = await ok(await fetch("https://content.dropboxapi.com/2/files/upload", {
        method: "POST",
        headers: this.head({
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": dropboxArg({ path, mode: "overwrite", mute: true })
        }),
        body
      }), "Dropbox upload");
      await res.body?.cancel();
      return path;
    }

    const started = await ok(await fetch("https://content.dropboxapi.com/2/files/upload_session/start", {
      method: "POST",
      headers: this.head({ "Content-Type": "application/octet-stream", "Dropbox-API-Arg": dropboxArg({ close: false }) }),
      body: body.subarray(0, Math.min(DROPBOX_CHUNK, body.byteLength))
    }), "Dropbox upload session");
    const sessionId = String((await started.json() as { session_id: string }).session_id);

    let at = Math.min(DROPBOX_CHUNK, body.byteLength);
    while (at < body.byteLength) {
      const end = Math.min(at + DROPBOX_CHUNK, body.byteLength);
      const res = await ok(await fetch("https://content.dropboxapi.com/2/files/upload_session/append_v2", {
        method: "POST",
        headers: this.head({
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": dropboxArg({ cursor: { session_id: sessionId, offset: at }, close: false })
        }),
        body: body.subarray(at, end)
      }), "Dropbox upload");
      await res.body?.cancel();
      at = end;
    }

    const finished = await ok(await fetch("https://content.dropboxapi.com/2/files/upload_session/finish", {
      method: "POST",
      headers: this.head({
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": dropboxArg({
          cursor: { session_id: sessionId, offset: body.byteLength },
          commit: { path, mode: "overwrite", mute: true }
        })
      })
    }), "Dropbox upload");
    const meta = await finished.json() as { path_display?: string };
    return String(meta.path_display ?? path);
  }

  async download(fileId: string): Promise<Uint8Array> {
    const res = await ok(await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: this.head({ "Dropbox-API-Arg": dropboxArg({ path: fileId }) })
    }), "Dropbox download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(id: string): Promise<void> {
    try {
      await this.rpc("files/delete_v2", { path: id }, "Dropbox delete");
    } catch (e) {
      if (/not_found/i.test((e as Error).message)) return;
      throw e;
    }
  }
}

// ── The fake ─────────────────────────────────────────────────────────────
// An in-memory tree with the same manners as the three real ones: a name is
// one path segment, a second upload under the same name replaces the first,
// deleting a folder takes what is inside it. failNextUploads makes the next
// N uploads fail with a retryable error, which is how the retry loop is
// tested without a network.

interface FakeNode { id: string; name: string; parent: string; folder: boolean; body: Uint8Array }

export class FakeDrive implements DriveClient {
  nodes: Map<string, FakeNode>;
  failNextUploads: number;
  account: string;
  private seq: number;

  constructor(account = "fake@example.ca") {
    this.nodes = new Map();
    this.failNextUploads = 0;
    this.account = account;
    this.seq = 0;
  }

  private nextId(): string { this.seq += 1; return `fake-${this.seq}`; }

  rootId(): string { return "root"; }

  accountName(): Promise<string> { return Promise.resolve(this.account); }

  private childrenOf(parentId: string, folder: boolean): DriveEntry[] {
    const out: DriveEntry[] = [];
    for (const n of this.nodes.values()) {
      if (n.parent === parentId && n.folder === folder) {
        out.push({ id: n.id, name: n.name, size: n.body.byteLength });
      }
    }
    return out;
  }

  listFolders(parentId: string): Promise<DriveFolder[]> {
    return Promise.resolve(this.childrenOf(parentId, true));
  }

  listFiles(parentId: string): Promise<DriveEntry[]> {
    return Promise.resolve(this.childrenOf(parentId, false));
  }

  createFolder(parentId: string, name: string): Promise<string> {
    const already = this.childrenOf(parentId, true).find(f => f.name === name);
    if (already) return Promise.resolve(already.id);
    const id = this.nextId();
    this.nodes.set(id, { id, name, parent: parentId, folder: true, body: new Uint8Array() });
    return Promise.resolve(id);
  }

  upload(folderId: string, name: string, body: Uint8Array, _contentType: string): Promise<string> {
    if (this.failNextUploads > 0) {
      this.failNextUploads -= 1;
      const e = new Error("The drive is unavailable (503): try again.") as DriveError;
      e.status = 503;
      e.retryable = true;
      return Promise.reject(e);
    }
    const clash = this.childrenOf(folderId, false).find(f => f.name === name);
    if (clash) this.nodes.delete(clash.id);
    const id = this.nextId();
    this.nodes.set(id, { id, name, parent: folderId, folder: false, body: new Uint8Array(body) });
    return Promise.resolve(id);
  }

  download(fileId: string): Promise<Uint8Array> {
    const n = this.nodes.get(fileId);
    if (!n || n.folder) return Promise.reject(new Error(`fake drive: ${fileId} not found`));
    return Promise.resolve(new Uint8Array(n.body));
  }

  delete(id: string): Promise<void> {
    const n = this.nodes.get(id);
    if (!n) return Promise.resolve();
    if (n.folder) {
      for (const child of [...this.nodes.values()]) {
        if (child.parent === id) this.delete(child.id);
      }
    }
    this.nodes.delete(id);
    return Promise.resolve();
  }
}
```

**A note on `private` in `FakeDrive`.** `private seq` and `private nextId()` are TypeScript modifiers on ordinary members, which erase cleanly — they are *not* parameter properties (`constructor(private x)`), which do not. If node ever complains, drop the word `private`; do not introduce a constructor parameter property.

- [ ] **Step 6: Run the tests**

Run: `npm --prefix vite-app test`
Expected: PASS — every test in `backupShared.test.mjs` and `backupSchedule.test.mjs`, with node printing an `ExperimentalWarning: Type Stripping is an experimental feature` line, which is expected and not a failure.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/backupTables.ts supabase/functions/_shared/backupManifest.ts supabase/functions/_shared/drive.ts vite-app/src/backupShared.test.mjs
git commit -F- <<'MSG'
What a backup is made of, and a drive that answers without a network

Three modules and no dependencies between them and the world: the table
lists with their two orders, the manifest with its folder stamps and its
retention arithmetic, and one drive interface with three vendors behind it.

The orders are the part worth reading. Loading is parents-first, because an
insert must not name a row that is not there yet; wiping is the order the
handover script worked out, children first and profiles last, and the test
reads that script back rather than trusting a second copy of it. audit_log
and function_errors are wiped though they are never backed up, because
their foreign keys to profiles would abort the delete otherwise — so a
restored database starts with an empty error log, deliberately.

Every provider difference stays inside its own class: Google's resumable
sessions and its willingness to keep two files with the same name, Graph's
320 KiB chunk arithmetic, Dropbox's paths-instead-of-ids and its arguments
in an ASCII-only header. A name handed to any of them is one flat path
segment, so a stored object's key is percent-encoded rather than turned
into a tree of folders. FakeDrive has the same manners and can be told to
fail, which is how the retry loop gets tested at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 4: Connecting a drive — `backup-oauth`, the Worker proxy, and the panel's provider row

**Files:**
- Create: `supabase/functions/backup-oauth/index.ts`
- Create: `vite-app/src/components/backupPanel.jsx`
- Modify: `supabase/config.toml` (append three function blocks)
- Modify: `worker/index.js` (a second proxied route)
- Modify: `vite-app/src/db.js` (`backupState`, `saveBackupSettings`, `backupOauthStartUrl`, `disconnectBackup`, toast entries)
- Modify: `vite-app/src/components/adminSetup.jsx` (mount the panel inside the Archive Blueprint)

**Interfaces:**
- Consumes: `authorizeUrl`, `exchangeCode`, `makeDrive`, `refreshAccessToken`, `PROVIDERS`, `SCOPES` (Task 3); `BACKUP_ROOT_NAME` (Task 3); `nextRunAt` from both copies (Task 1); `public.backup_state()` and the `app_settings` backup columns (Task 2).
- Produces:
  - Endpoint `POST /functions/v1/backup-oauth` with `{ action: "start", provider }` → `{ url }`, and `{ action: "disconnect" }` → `{ ok: true }`. Both need a signed-in Admin.
  - Endpoint `GET /functions/v1/backup-oauth/<provider>?code=&state=` → `302` back to the app. No JWT; the nonce is the credential.
  - Worker route `GET /backup/oauth/<provider>` → the above.
  - `Db.backupState() → object` (the `backup_state()` shape from Task 2).
  - `Db.saveBackupSettings(form) → void` where `form` is `{ frequency, weekday, hour, keep, clientIdGoogle, clientSecretGoogle, clientIdMicrosoft, clientSecretMicrosoft, clientIdDropbox, clientSecretDropbox }`.
  - `Db.backupOauthStartUrl(provider) → string`
  - `Db.disconnectBackup() → void`
  - `<AutomaticBackupPanel />` — no props; it reads everything through `Db`.

- [ ] **Step 1: Write `supabase/functions/backup-oauth/index.ts`**

```ts
// backup-oauth — connecting one drive account, and letting go of it.
//
// Two doors in one function, because the provider redirects a browser back
// to a fixed address and that browser carries no JWT:
//
//   POST {action:"start"|"disconnect"}   a signed-in Admin, checked here
//   GET  /backup-oauth/<provider>?code=  the provider's redirect, no JWT
//
// The callback's credential is the nonce: `start` mints one into
// app_settings, the callback must present it, and it is spent the moment it
// is read — so a replayed callback URL does nothing. Ten minutes is longer
// than any consent screen takes and shorter than a link left in a history.
//
// Verification is off for this function (pinned in supabase/config.toml,
// not passed at deploy time) because the callback has no bearer token. Off
// does not mean open: POST checks the caller's own profile the way
// delete-user does, and GET acts only on a nonce this function minted.
//
// The client secret never leaves the server, and the refresh token never
// reaches the browser: the panel learns "connected, as <account>" through
// backup_state() and nothing else.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeUrl, exchangeCode, makeDrive, PROVIDERS } from "../_shared/drive.ts";
import { BACKUP_ROOT_NAME } from "../_shared/backupManifest.ts";
import { nextRunAt } from "../_shared/backupSchedule.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const NONCE_MS = 10 * 60 * 1000;

const admin = () => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Where the provider sends the browser back to. It has to be identical in
// the consent URL and in the token exchange, and identical again to what is
// typed into the provider's app registration — so it is derived once, here,
// from the app's own public address.
async function redirectUri(db: ReturnType<typeof admin>, provider: string): Promise<{ uri: string; base: string }> {
  const { data, error } = await db.from("app_settings").select("approval_base_url").maybeSingle();
  if (error) throw error;
  const configured = String(data?.approval_base_url ?? "").trim();
  if (!configured) {
    throw new Error("The app's address isn't set. Fill in \"App address\" on the Admin screen first — the drive has to be told where to send you back to.");
  }
  const base = new URL(configured).origin;
  return { uri: `${base}/backup/oauth/${provider}`, base };
}

// The provider's own app registration, as the Admin typed it in.
async function credentials(db: ReturnType<typeof admin>, provider: string): Promise<{ id: string; secret: string }> {
  const { data, error } = await db.from("app_settings")
    .select("backup_client_id_google, backup_client_secret_google, backup_client_id_microsoft, backup_client_secret_microsoft, backup_client_id_dropbox, backup_client_secret_dropbox")
    .maybeSingle();
  if (error) throw error;
  const row = (data ?? {}) as Record<string, string | null>;
  const id = String(row[`backup_client_id_${provider}`] ?? "").trim();
  const secret = String(row[`backup_client_secret_${provider}`] ?? "").trim();
  if (!id || !secret) {
    throw new Error(`The ${provider} app registration is incomplete — its client ID and client secret both have to be filled in on the Admin screen before you can connect.`);
  }
  return { id, secret };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  // ".../backup-oauth/google" — the last segment, when there is one past
  // the function's own name.
  const tail = url.pathname.split("/").filter(Boolean);
  const provider = tail.length > 1 ? tail[tail.length - 1] : "";

  if (req.method === "GET" && PROVIDERS.includes(provider)) {
    return await callback(provider, url);
  }

  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  // Who is asking, before anything is read from them.
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  try {
    const { data: callerProfile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
    if (!callerProfile || callerProfile.role !== "Admin") {
      return json({ error: "Only an Admin can connect the backup drive" }, 403);
    }

    const body = await req.json();
    const db = admin();

    if (body.action === "disconnect") {
      const { error } = await db.from("app_settings").update({
        backup_provider: null,
        backup_refresh_token: null,
        backup_account: null,
        backup_root_folder_id: null,
        backup_connection_error: null,
        backup_oauth_state: null,
        backup_oauth_state_at: null,
        backup_next_run_at: null,
        updated_at: new Date().toISOString()
      }).eq("id", true);
      if (error) throw error;
      return json({ ok: true });
    }

    if (body.action !== "start") throw new Error("action must be \"start\" or \"disconnect\"");
    const wanted = String(body.provider ?? "");
    if (!PROVIDERS.includes(wanted)) throw new Error(`provider must be one of: ${PROVIDERS.join(", ")}`);

    const { id } = await credentials(db, wanted);
    const { uri } = await redirectUri(db, wanted);
    const state = crypto.randomUUID() + crypto.randomUUID();
    const { error: nErr } = await db.from("app_settings").update({
      backup_oauth_state: state,
      backup_oauth_state_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", true);
    if (nErr) throw nErr;

    return json({ url: authorizeUrl(wanted, id, uri, state) });
  } catch (e) {
    await logError("backup-oauth", (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});

// ── The provider's redirect ──────────────────────────────────────────────

async function callback(provider: string, url: URL): Promise<Response> {
  const db = admin();
  let base = "";
  try {
    base = (await redirectUri(db, provider)).base;
  } catch {
    // With no app address configured there is nowhere to send them; say so
    // in the one place that can still be read.
    return new Response("The app's address isn't set on the Admin screen, so there is nowhere to send you back to.", {
      status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
  const home = (query: string) => new Response(null, { status: 302, headers: { Location: `${base}/?${query}`, "Cache-Control": "no-store" } });

  try {
    // The Admin pressed Cancel on the consent screen. Not an error to log.
    if (url.searchParams.get("error")) return home("backup=denied");

    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!code || !state) throw new Error("The drive sent us back without an authorisation code.");

    const { data: settings, error: sErr } = await db.from("app_settings")
      .select("backup_oauth_state, backup_oauth_state_at, backup_frequency, backup_weekday, backup_hour")
      .maybeSingle();
    if (sErr) throw sErr;
    const expected = String(settings?.backup_oauth_state ?? "");
    const mintedAt = settings?.backup_oauth_state_at ? Date.parse(String(settings.backup_oauth_state_at)) : 0;
    // Spend the nonce before doing anything with it, so a re-opened callback
    // URL — a browser restoring tabs, a link in somebody's history — cannot
    // run the exchange a second time.
    await db.from("app_settings").update({ backup_oauth_state: null, backup_oauth_state_at: null }).eq("id", true);
    if (!expected || expected !== state) throw new Error("That connection link wasn't the one this app started. Press Connect again.");
    if (!mintedAt || Date.now() - mintedAt > NONCE_MS) throw new Error("That connection took more than ten minutes. Press Connect again.");

    const { id, secret } = await credentials(db, provider);
    const { uri } = await redirectUri(db, provider);
    const { accessToken, refreshToken } = await exchangeCode(provider, id, secret, code, uri);

    const drive = makeDrive(provider, accessToken);
    const account = await drive.accountName();

    // Find the app's own folder or make it. Connecting a second time to the
    // same account must reuse the folder that already holds the backups.
    const root = drive.rootId();
    const existing = (await drive.listFolders(root)).find(f => f.name === BACKUP_ROOT_NAME);
    const folderId = existing ? existing.id : await drive.createFolder(root, BACKUP_ROOT_NAME);

    // Connecting a different provider replaces the old one wholesale: every
    // column below is written, so nothing of the previous connection is left
    // behind to be picked up by a tick.
    const { error: uErr } = await db.from("app_settings").update({
      backup_provider: provider,
      backup_refresh_token: refreshToken,
      backup_account: account,
      backup_root_folder_id: folderId,
      backup_connection_error: null,
      // The schedule starts counting from the moment it has somewhere to go.
      backup_next_run_at: nextRunAt({
        frequency: settings?.backup_frequency ?? "daily",
        weekday: settings?.backup_weekday ?? 0,
        hour: settings?.backup_hour ?? 2
      }, Date.now()),
      updated_at: new Date().toISOString()
    }).eq("id", true);
    if (uErr) throw uErr;

    return home("backup=connected");
  } catch (e) {
    const message = (e as Error).message;
    await logError("backup-oauth", message, { provider });
    // The reason travels in the query string so the panel can say it; it is
    // this function's own words, never the provider's raw body.
    return home(`backup=failed&why=${encodeURIComponent(message.slice(0, 300))}`);
  }
}

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    await admin().from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
```

- [ ] **Step 2: Pin `verify_jwt` in `supabase/config.toml`**

Append at the end of the file:

```toml
# The drive connection's callback. The provider redirects a browser back to
# /backup/oauth/<provider> and that browser carries no bearer token, so
# verification has to be off or the Admin sees a 401 instead of a connected
# drive. The function checks its own doors: POST reads the caller's profile
# and demands Admin, and the GET callback acts only on a nonce it minted
# itself, which is spent the moment it is read.
[functions.backup-oauth]
verify_jwt = false

# The other two are called by people or by the database, and both check
# their own callers as well: backup-run answers the pg_cron tick on
# x-internal-secret and an Admin's JWT on everything else, and
# backup-restore answers nobody but an Admin. Verification on top of that
# is the platform's own gate, and pinning it here keeps a later deploy from
# quietly handing it back.
[functions.backup-run]
verify_jwt = true

[functions.backup-restore]
verify_jwt = true
```

**Careful:** `backup-run` is called by pg_cron through pg_net with the publishable `apikey` header and **no** `Authorization`. With `verify_jwt = true` the platform accepts an anon apikey as a valid JWT, which is why the function's own `x-internal-secret` check is the real door. If a deployed tick comes back 401, the cause is a missing `apikey` in the cron job's headers, not this setting.

- [ ] **Step 3: Proxy `/backup/oauth/*` in `worker/index.js`**

Add the branch immediately after the `/approve` branch, before `return env.ASSETS.fetch(request)`:

```js
    // /backup/oauth/<provider>?code=… — where a drive sends the Admin back
    // after they have said yes. Proxied for the same reason /approve is:
    // the provider's app registration names an address on this domain, and
    // the function that has to answer it lives on Supabase's. Unlike
    // /approve this one answers with a redirect rather than a page, so the
    // Location header is what has to survive the trip.
    if (url.pathname.startsWith("/backup/oauth/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { "Allow": "GET, HEAD" } });
      }
      return oauthCallback(request, url);
    }
```

And the handler beside `approvalPage`:

```js
// The callback proxy. Same allowlist as the approval page — this route
// shares an origin with the app, so a browser attaches whatever it holds
// for that origin, and Cookie and Authorization have no business going to
// a third party. The one difference is the answer: a 302 back into the app,
// whose Location is passed through unchanged.
async function oauthCallback(request, url) {
  const provider = url.pathname.slice("/backup/oauth/".length).replace(/\/+$/, "");
  if (!/^[a-z]+$/.test(provider)) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    if (FORWARD.has(k.toLowerCase())) headers.set(k, v);
  }

  let upstream;
  try {
    upstream = await fetch(FUNCTIONS_ORIGIN + "/backup-oauth/" + provider + url.search, {
      method: request.method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch {
    return htmlError("The drive couldn't be connected right now. Please try again in a moment.");
  }

  const location = upstream.headers.get("Location");
  if (upstream.status >= 300 && upstream.status < 400 && location) {
    return new Response(null, {
      status: 302,
      headers: { "Location": location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
    });
  }

  // Anything that is not a redirect is the function refusing before it got
  // far enough to know where to send them.
  const body = await upstream.text().catch(() => "");
  return htmlError(body.slice(0, 300) || "The drive couldn't be connected.");
}
```

**Careful:** `htmlError` interpolates its argument into HTML. `body` here is the function's own plain-text refusal, but escape it anyway — add this to `worker/index.js` and use it in `htmlError`:

```js
const escapeHtml = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
```

and change `htmlError`'s template to use `${escapeHtml(message)}`.

- [ ] **Step 4: Add the Db methods**

In `vite-app/src/db.js`, add `import { nextRunAt } from "./backupSchedule.js";` beside the other module imports, and put this block immediately after `sendTestEmail` (it belongs with the other Admin-screen settings):

```js
  // ── Automatic backup ───────────────────────────────────────────────────
  // Everything the panel is allowed to know, in one Admin-only definer RPC.
  // The refresh token and the three client secrets are in the same row and
  // are deliberately not in the answer — backup_state() reports them as
  // has_secret_google and friends, so a browser can say "a secret is set"
  // without ever holding one.
  async backupState() {
    const { data, error } = await sbClient.rpc("backup_state");
    if (error) throw error;
    return data || {};
  },

  // The schedule and the three app registrations. A blank secret field
  // means "leave the stored one alone", never "erase it": the panel cannot
  // show a stored secret, so an empty box is the normal state and treating
  // it as a deletion would silently break the connection on every save.
  async saveBackupSettings(form) {
    const hour = Math.min(23, Math.max(0, Math.trunc(Number(form.hour)) || 0));
    const keep = Math.min(365, Math.max(1, Math.trunc(Number(form.keep)) || 14));
    const weekday = Math.min(6, Math.max(0, Math.trunc(Number(form.weekday)) || 0));
    const frequency = ["daily", "weekdays", "weekly", "monthly"].includes(form.frequency) ? form.frequency : "daily";

    const patch = {
      id: true,
      backup_frequency: frequency,
      backup_weekday: weekday,
      backup_hour: hour,
      backup_keep: keep,
      backup_client_id_google: (form.clientIdGoogle || "").trim() || null,
      backup_client_id_microsoft: (form.clientIdMicrosoft || "").trim() || null,
      backup_client_id_dropbox: (form.clientIdDropbox || "").trim() || null,
      updated_at: new Date().toISOString()
    };
    for (const [field, column] of [
      ["clientSecretGoogle", "backup_client_secret_google"],
      ["clientSecretMicrosoft", "backup_client_secret_microsoft"],
      ["clientSecretDropbox", "backup_client_secret_dropbox"]
    ]) {
      const typed = (form[field] || "").trim();
      if (typed) patch[column] = typed;
    }
    // The next due time is worked out here rather than left to the tick, so
    // the line under the schedule changes the moment it is saved. The
    // function's own copy of nextRunAt computes the same instant.
    if (form.connected) patch.backup_next_run_at = nextRunAt({ frequency, weekday, hour }, Date.now());

    const { error } = await sbClient.from("app_settings").upsert(patch);
    if (error) throw error;
  },

  // The consent URL is minted server-side, because it carries a nonce that
  // only the function may write. The panel sends the browser to what comes
  // back; the drive sends it to /backup/oauth/<provider> afterwards.
  async backupOauthStartUrl(provider) {
    const { data, error } = await sbClient.functions.invoke("backup-oauth", { body: { action: "start", provider } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    if (!data || !data.url) throw new Error("The drive didn't give a sign-in address.");
    return data.url;
  },

  async disconnectBackup() {
    const { data, error } = await sbClient.functions.invoke("backup-oauth", { body: { action: "disconnect" } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
  },
```

And in the `TOASTS` map, beside `saveAppSettings`:

```js
  // Automatic backup
  saveBackupSettings: "Backup settings saved",
  disconnectBackup: "Drive disconnected",
```

- [ ] **Step 5: Write the panel's provider row — `vite-app/src/components/backupPanel.jsx`**

This file grows in Tasks 5 and 6; this is its first, complete-in-itself version.

```jsx
import React, { useState, useEffect, useCallback } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, Field, ErrorBox, Loading, TagX } from "./common.jsx";
import { describeSchedule } from "../backupSchedule.js";

// Automatic backup — the Admin screen's Archive block, below the year-end
// dropdown, because they are the same question asked two ways: what happens
// to this work when the app is not the only copy of it any more.
//
// Everything real happens server-side. This screen connects a drive, sets a
// schedule, and reads back what the functions have been doing; it never
// holds a token, never holds a backup, and cannot see a client secret it
// has already saved — the state RPC answers "a secret is set", not the
// secret. So a blank secret box is the ordinary state and saving with one
// blank leaves the stored value alone.

const SECTION_TITLE = { fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16, marginBottom: 4 };
const SECTION_HELP = { fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 12, lineHeight: 1.5 };
const QUIET = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" };

const PROVIDER_LABEL = { google: "Google Drive", microsoft: "OneDrive", dropbox: "Dropbox" };

const REGISTRATION = {
  google: {
    label: "Google Drive",
    where: "console.cloud.google.com/apis/credentials",
    steps: "Create a project, turn on the Google Drive API, then Credentials → Create credentials → OAuth client ID → Web application. Paste the redirect URI below into “Authorised redirect URIs”."
  },
  microsoft: {
    label: "OneDrive",
    where: "entra.microsoft.com → App registrations",
    steps: "New registration, accounts in any organisational directory and personal Microsoft accounts. Add a Web platform with the redirect URI below, then Certificates & secrets → New client secret."
  },
  dropbox: {
    label: "Dropbox",
    where: "dropbox.com/developers/apps",
    steps: "Create app → Scoped access → Full Dropbox. On Permissions tick files.content.write, files.content.read and files.metadata.read. Add the redirect URI below under OAuth 2."
  }
};

// The address the app is served from is the address a drive sends the Admin
// back to. It is stored (Admin screen → App address) rather than guessed,
// because the drive's own registration has to hold the same string — but
// this window's origin is what it almost always is, and saying so beats a
// blank box.
const redirectUriFor = (state, provider) => {
  const configured = String(state.approval_base_url || "").trim();
  let origin = window.location.origin;
  try { if (configured) origin = new URL(configured).origin; } catch { /* fall back to this window */ }
  return `${origin}/backup/oauth/${provider}`;
};

export function AutomaticBackupPanel() {
  const [state, setState] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState("");
  const [showRegistration, setShowRegistration] = useState(false);
  const [form, setForm] = useState({
    frequency: "daily", weekday: 0, hour: 2, keep: 14,
    clientIdGoogle: "", clientSecretGoogle: "",
    clientIdMicrosoft: "", clientSecretMicrosoft: "",
    clientIdDropbox: "", clientSecretDropbox: ""
  });

  const load = useCallback(() => {
    setLoadState(s => (s === "ready" ? s : "loading"));
    Db.backupState()
      .then(row => {
        setState(row);
        setForm(f => ({
          ...f,
          frequency: row.frequency || "daily",
          weekday: Number(row.weekday) || 0,
          hour: Number(row.hour) || 0,
          keep: Number(row.keep) || 14,
          clientIdGoogle: row.client_id_google || "",
          clientIdMicrosoft: row.client_id_microsoft || "",
          clientIdDropbox: row.client_id_dropbox || ""
        }));
        setLoadState("ready");
        setError("");
      })
      .catch(e => {
        setError(e.message || "Couldn't read the backup settings.");
        setLoadState("failed");
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Coming back from the drive's consent screen. The function redirects to
  // /?backup=connected (or =denied, or =failed&why=…); say so, then take the
  // query off the address bar so a refresh does not repeat the message.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const outcome = q.get("backup");
    if (!outcome) return;
    if (outcome === "connected") setNotice("The drive is connected. The first backup runs at the next scheduled time — or press “Back up now”.");
    else if (outcome === "denied") setNotice("The drive was not connected: the consent screen was cancelled.");
    else if (outcome === "failed") setError(q.get("why") || "The drive couldn't be connected.");
    q.delete("backup");
    q.delete("why");
    const rest = q.toString();
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
    load();
  }, [load]);

  const set = (key, value) => { setForm(p => ({ ...p, [key]: value })); setError(""); };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await Db.saveBackupSettings({ ...form, connected: !!(state && state.connected) });
      // The secrets were written; forget the typed copies so the boxes go
      // back to their ordinary blank state.
      setForm(f => ({ ...f, clientSecretGoogle: "", clientSecretMicrosoft: "", clientSecretDropbox: "" }));
      load();
    } catch (e) {
      setError(e.message || "Couldn't save the backup settings.");
    } finally {
      setSaving(false);
    }
  };

  const connect = async provider => {
    setConnecting(provider);
    setError("");
    try {
      window.location.assign(await Db.backupOauthStartUrl(provider));
    } catch (e) {
      setError(e.message || "Couldn't start the connection.");
      setConnecting("");
    }
  };

  const disconnect = async () => {
    setError("");
    try { await Db.disconnectBackup(); load(); }
    catch (e) { setError(e.message || "Couldn't disconnect the drive."); }
  };

  if (loadState === "loading") return <Blueprint style={{ padding: "18px 20px" }}><Loading label="Loading the backup settings…" /></Blueprint>;

  const s = state || {};
  const connected = !!s.connected;

  return (
    <Blueprint style={{ padding: "18px 20px", marginTop: 16 }}>
      <div style={SECTION_TITLE}>Automatic backup</div>
      <div style={SECTION_HELP}>
        A copy of everything &mdash; every job, ticket, assessment, report and their PDFs &mdash; written to one
        drive account of your own on a schedule, and restorable from the same place. The app does the
        copying on its own server: nothing is downloaded to this computer and nothing is uploaded from it.
        The backup contains the crew&rsquo;s hours and dose readings and every client&rsquo;s pricing, so
        connect an account that belongs to the business.
      </div>

      <ErrorBox>{error}</ErrorBox>
      {notice && <div style={{ fontSize: 13, marginBottom: 12, color: "var(--color-accent)" }}>{notice}</div>}

      {/* Provider row */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {connected ? (
          <>
            <TagX variant="outline">{PROVIDER_LABEL[s.provider] || s.provider}</TagX>
            <span style={{ fontSize: 14 }}>Connected as <strong>{s.account || "—"}</strong></span>
            <Btn variant="secondary" style={{ marginLeft: "auto" }} onClick={disconnect}>Disconnect</Btn>
          </>
        ) : (
          <>
            <span style={{ fontSize: 14 }}>No drive connected.</span>
            {["google", "microsoft", "dropbox"].map(p => (
              <Btn key={p} variant="secondary" disabled={!!connecting}
                onClick={() => connect(p)}>
                {connecting === p ? "Opening…" : `Connect ${PROVIDER_LABEL[p]}`}
              </Btn>
            ))}
          </>
        )}
      </div>

      {s.connection_error && (
        <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px", marginBottom: 10 }}>
          <strong>The drive needs reconnecting.</strong> {s.connection_error} Press Disconnect and connect it again;
          backups are not running until you do.
        </div>
      )}

      <div style={{ ...QUIET, marginBottom: 12 }}>{describeSchedule(form)}.</div>

      {/* App registration — collapsed, because it is done once and never
          again, and it is the fiddliest thing on this screen. */}
      <Btn variant="secondary" onClick={() => setShowRegistration(v => !v)}>
        {showRegistration ? "Hide app registration" : "App registration"}
      </Btn>

      {showRegistration && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={SECTION_HELP}>
            Each drive needs its own free app registration under your account &mdash; that is what lets this app
            write to it. Do the one you mean to use and ignore the other two. Paste the redirect URI shown
            beneath each one into that provider&rsquo;s registration exactly as it appears.
          </div>
          {["google", "microsoft", "dropbox"].map(p => {
            const r = REGISTRATION[p];
            const idKey = `clientId${p[0].toUpperCase()}${p.slice(1)}`;
            const secretKey = `clientSecret${p[0].toUpperCase()}${p.slice(1)}`;
            const hasSecret = !!s[`has_secret_${p}`];
            return (
              <div key={p} style={{ border: "1px solid var(--color-neutral-300)", padding: "12px 14px" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.label}</div>
                <div style={{ ...QUIET, marginBottom: 10 }}>{r.where} &mdash; {r.steps}</div>
                <Field label="Redirect URI (paste this into the registration)">
                  <input className="input" readOnly value={redirectUriFor(s, p)}
                    onFocus={e => e.target.select()} style={{ width: "100%" }} />
                </Field>
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <Field label="Client ID">
                    <input className="input" value={form[idKey]} autoComplete="off"
                      onChange={e => set(idKey, e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Client secret">
                    <input className="input" type="password" value={form[secretKey]} autoComplete="off"
                      placeholder={hasSecret ? "saved — leave blank to keep it" : "from the registration"}
                      onChange={e => set(secretKey, e.target.value)} style={{ width: "100%" }} />
                  </Field>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        {loadState === "failed" && <Btn variant="secondary" onClick={load}>Try loading again</Btn>}
        <Btn variant="primary" disabled={saving || loadState !== "ready"} onClick={save}>
          {saving ? "Saving…" : "Save backup settings"}
        </Btn>
      </div>
    </Blueprint>
  );
}
```

- [ ] **Step 6: Mount it in `vite-app/src/components/adminSetup.jsx`**

Add the import beside the others:

```jsx
import { AutomaticBackupPanel } from "./backupPanel.jsx";
```

and put the panel inside the Archive `Blueprint`, immediately after the `<select>` and before its closing `</Blueprint>`:

```jsx
          <AutomaticBackupPanel />
```

Nothing else on that screen changes: the panel reads and writes through `Db` on its own, and the Archive block's own copy still describes the year-end zip.

- [ ] **Step 7: Check, test, build**

Run: `npm --prefix vite-app test`
Expected: PASS. The render-name scan matters here — it fails if `backupPanel.jsx` uses a capitalised tag (`Blueprint`, `Btn`, `Field`, `ErrorBox`, `Loading`, `TagX`) that the file does not import.

Run: `npm --prefix vite-app run build`
Expected: `built in …` with no errors.

- [ ] **Step 8: Deploy the function, then the app**

```bash
npx supabase functions deploy backup-oauth --project-ref eielmvxzdwwprmmfamlq
npm run build && npx wrangler deploy
```

Expected: the CLI prints `Deployed Functions on project eielmvxzdwwprmmfamlq: backup-oauth`, and wrangler prints the uploaded asset count and the deployment URL.

- [ ] **Step 9: Prove the route end to end**

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://solitary-snowflake-ee22.workers.dev/backup/oauth/google?error=access_denied&state=x"
```

Expected: `302` and a redirect URL that is the app's own address with `?backup=denied` on it. (A `502` means the function is not deployed; a `404` means the Worker branch is not live — confirm the deploy by fetching one of the newly hashed chunk files rather than `/`, which can be served from Cloudflare's edge cache.)

Then, signed in as Kyle, open the Admin screen, expand **App registration**, and confirm the three redirect URIs read `https://<the app address>/backup/oauth/google|microsoft|dropbox`.

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/backup-oauth supabase/config.toml worker/index.js vite-app/src/db.js vite-app/src/components/backupPanel.jsx vite-app/src/components/adminSetup.jsx
git commit -F- <<'MSG'
An Admin can hand the app a drive of their own

backup-oauth has two doors because it has to: a POST an Admin makes, checked
against their own profile the way delete-user does it, and a GET the drive
redirects a browser to, which carries no token at all. The credential on
that second door is a nonce this function minted ten minutes earlier and
spends the instant it reads it, so a callback URL left in a history is worth
nothing.

The Worker proxies it for the same reason it proxies /approve — the
provider's registration names an address on our domain and the function
lives on Supabase's — with the same header allowlist, because this route
shares an origin with the app and a browser would otherwise hand a third
party its cookies. The one difference is that the answer is a redirect, so
Location is what has to survive.

The panel can say "connected as somebody@example.ca" and can say a secret is
saved. It cannot say what the secret is: backup_state() answers with
has_secret_google, and a blank secret box on save means leave the stored one
alone rather than erase it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 5: `backup-run` — the tick, the phases, retention, and the panel's schedule

**Files:**
- Create: `supabase/functions/_shared/gzip.ts`
- Create: `supabase/functions/backup-run/index.ts`
- Modify: `vite-app/src/backupShared.test.mjs` (two gzip tests)
- Modify: `vite-app/src/db.js` (`backupNow`, `currentBackupRun`, `listBackupRuns`, `nudgeBackup`, toast entries)
- Modify: `vite-app/src/components/backupPanel.jsx` (schedule row, "Back up now", last-run line, progress)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces:
  - `gzip(bytes: Uint8Array) → Promise<Uint8Array>`, `gunzip(bytes: Uint8Array) → Promise<Uint8Array>`.
  - Endpoint `POST /functions/v1/backup-run` with `{ action }`:
    - `"tick"` — the cron's own call, on `x-internal-secret`; also an Admin's, to keep a watched run moving.
    - `"now"` — Admin; queues a run and starts it. Returns `{ ok: true, runId }`.
    - `"list"` — Admin; returns `{ backups: [{ folderId, name, app_version, schema_version, finished_at, rows, files, bytes }] }`, newest first.
    - `"manifest"` with `folderId` — Admin; returns `{ manifest }`, the whole thing including the jobs index.
  - `Db.backupNow() → { runId }`, `Db.listBackups() → array`, `Db.backupManifest(folderId) → Manifest`, `Db.currentBackupRun() → row | null`, `Db.nudgeBackup() → void`.

**How a run is shaped, and why.** A function invocation gets a wall-clock ceiling, so no phase may need to finish inside one. The unit of work is therefore one *part of one table* or one *page of one bucket*, and `backup_runs.cursor` says where the next slice picks up. Every unit is idempotent — an upload replaces a same-named file — so a slice cut short costs at most one repeated unit, never a hole.

A cron tick every five minutes would make a large backup take hours of wall clock for a few minutes of work, so a slice that made progress **kicks the next one itself**: it POSTs to its own URL with the internal secret and abandons the response after a second and a half. The request has left; the next slice is running; this one returns. The cron remains the safety net that starts things and picks up anything the chain dropped.

- [ ] **Step 1: Write the two failing gzip tests**

Append to `vite-app/src/backupShared.test.mjs`:

```js
import { gzip, gunzip } from "../../supabase/functions/_shared/gzip.ts";

test("a table part survives being gzipped and read back", async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `t-${i}`, total: i * 137, note: "Wapiti tie-in · RT" }));
  const json = JSON.stringify(rows);
  const packed = await gzip(new TextEncoder().encode(json));
  assert.ok(packed.byteLength < json.length, "gzip should be smaller than the JSON it came from");
  // A gzip member starts 1f 8b — the restore reads these back with a
  // DecompressionStream that will not say so if it is handed something else.
  assert.equal(packed[0], 0x1f);
  assert.equal(packed[1], 0x8b);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await gunzip(packed))), rows);
});

test("an empty table still round-trips", async () => {
  const packed = await gzip(new TextEncoder().encode("[]"));
  assert.equal(new TextDecoder().decode(await gunzip(packed)), "[]");
});
```

Run: `npm --prefix vite-app test` → FAIL, `Cannot find module … gzip.ts`.

- [ ] **Step 2: Write `supabase/functions/_shared/gzip.ts`**

```ts
// Gzip, through the platform's own streams — no library, in either runtime.
//
// A backup's table parts go up compressed and come back down the same way,
// and both the function that writes them and the function that reads them
// have to agree byte for byte, so the pair lives in one file.
//
// Erasable TypeScript only and no imports: the node suite exercises this
// file directly.

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
```

Run: `npm --prefix vite-app test` → PASS.

- [ ] **Step 3: Write `supabase/functions/backup-run/index.ts`**

```ts
// backup-run — the thing that actually copies the project to the drive.
//
// Called four ways, and it checks its own door for each:
//
//   {action:"tick"}      the pg_cron job, on x-internal-secret (the database
//                        holds no user JWT), or an Admin keeping a run they
//                        are watching moving between cron ticks
//   {action:"now"}       an Admin pressing "Back up now"
//   {action:"list"}      the backups in the drive, newest first
//   {action:"manifest"}  one backup's manifest, for the per-job restore
//
// A run is done in slices. A function invocation has a wall-clock ceiling,
// so no phase may need to finish inside one: the unit of work is one part
// of one table, or one page of one bucket, and backup_runs.cursor says
// where the next slice starts. Every unit is idempotent — an upload
// replaces a file of the same name — so a slice cut short costs at most one
// repeated unit and never leaves a hole.
//
// Five minutes between cron ticks would make a big backup take all night
// for a few minutes of work, so a slice that made progress kicks the next
// one itself and walks away from the answer. The cron is the safety net,
// not the engine.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LOAD_ORDER, BUCKETS, CURSOR_COLUMN, TABLE_KEYS,
  PAGE_ROWS, MAX_PART_ROWS, stripSecrets, partFileName
} from "../_shared/backupTables.ts";
import {
  BACKUP_ROOT_NAME, MANIFEST_NAME, TABLES_FOLDER, FILES_FOLDER,
  newManifest, recordTable, recordFiles, finishManifest, jobsIndex,
  folderStamp, foldersToDelete, fileEntryName
} from "../_shared/backupManifest.ts";
import type { DriveClient } from "../_shared/drive.ts";
import { connectDrive, ensureFolder } from "../_shared/backupDrive.ts";
import { gzip } from "../_shared/gzip.ts";
import { nextRunAt } from "../_shared/backupSchedule.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// A slice's share of the invocation. The platform's ceiling is higher; the
// margin is for the upload already in flight when the budget runs out.
const BUDGET_MS = 100_000;
// A run whose heartbeat has gone this quiet died mid-slice.
const STALE_MS = 10 * 60_000;
const RETRIES = 3;
const BACKOFF_MS = [1_000, 4_000, 10_000];

const APP_VERSION = "0.9.0-Beta";

type Db = ReturnType<typeof createClient>;

const admin = (): Db => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Retries what the drive says to retry — the flag on the error, never its
// prose. Three goes with a widening gap; after that the run fails with the
// last reason and the next scheduled one is unaffected.
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: Error | null = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try { return await fn(); }
    catch (e) {
      last = e as Error;
      const retryable = (e as { retryable?: boolean }).retryable === true;
      if (!retryable || attempt === RETRIES) break;
      await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
    }
  }
  throw new Error(`${what}: ${last ? last.message : "failed"}`);
}

// ── The door ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const db = admin();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body is a tick */ }
  const action = String(body.action ?? "tick");

  try {
    const { data: expected, error: secretErr } = await db.rpc("internal_secret");
    if (secretErr) throw secretErr;
    const internal = !!expected && req.headers.get("x-internal-secret") === expected;

    if (!internal) {
      // Not the database, so it had better be an Admin — checked against
      // their own profile through RLS, the way delete-user does it.
      const asUser = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
      );
      const { data: { user } } = await asUser.auth.getUser();
      if (!user) return json({ error: "Not signed in" }, 401);
      const { data: profile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
      if (!profile || profile.role !== "Admin") return json({ error: "Only an Admin can run a backup" }, 403);
      body.requestedBy = user.id;
    }

    if (action === "now") return json(await backUpNow(db, String(body.requestedBy ?? "")));
    if (action === "list") return json({ backups: await listBackups(db) });
    if (action === "manifest") return json({ manifest: await readManifest(db, String(body.folderId ?? "")) });
    if (action === "tick") return json(await tick(db));
    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    await logError("backup-run", (e as Error).message, { action });
    return json({ error: (e as Error).message }, 400);
  }
});

// ── The tick ─────────────────────────────────────────────────────────────

async function tick(db: Db): Promise<Record<string, unknown>> {
  // A run in flight comes first, and the same run is picked up again after
  // a slice that died: a stale heartbeat is not a reason to start a second
  // one alongside it.
  const { data: running } = await db.from("backup_runs")
    .select("*").eq("status", "running").order("created_at").limit(1).maybeSingle();
  if (running) {
    const beat = running.heartbeat_at ? Date.parse(String(running.heartbeat_at)) : 0;
    if (beat && Date.now() - beat < BUDGET_MS) {
      // Another slice of this same run is very likely still going. Two at
      // once would upload the same part twice and fight over the cursor.
      return { ok: true, busy: true, runId: running.id };
    }
    return await advance(db, running);
  }

  const { data: queued } = await db.from("backup_runs")
    .select("*").eq("status", "queued").order("created_at").limit(1).maybeSingle();
  if (queued) return await advance(db, await start(db, queued));

  // Nothing in flight: is one due?
  const { data: s } = await db.from("app_settings")
    .select("backup_provider, backup_refresh_token, backup_next_run_at, backup_frequency, backup_weekday, backup_hour")
    .maybeSingle();
  if (!s || !s.backup_refresh_token || !s.backup_next_run_at) return { ok: true, idle: true };
  if (Date.parse(String(s.backup_next_run_at)) > Date.now()) return { ok: true, idle: true, next: s.backup_next_run_at };

  // The clock moves the moment the run is created, not when it finishes —
  // a run that takes two hours must not make the next one two hours late,
  // and a failed run must not stop the next one happening at all.
  await db.from("app_settings").update({
    backup_next_run_at: nextRunAt({
      frequency: String(s.backup_frequency ?? "daily"),
      weekday: Number(s.backup_weekday ?? 0),
      hour: Number(s.backup_hour ?? 2)
    }, Date.now())
  }).eq("id", true);

  const { data: created, error } = await db.from("backup_runs")
    .insert({ kind: "backup", status: "queued" }).select("*").single();
  if (error) throw error;
  return await advance(db, await start(db, created));
}

async function backUpNow(db: Db, requestedBy: string): Promise<Record<string, unknown>> {
  const { data: open } = await db.from("backup_runs")
    .select("id").in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (open) return { ok: true, runId: open.id, alreadyRunning: true };
  const { data: created, error } = await db.from("backup_runs")
    .insert({ kind: "backup", status: "queued", requested_by: requestedBy || null })
    .select("*").single();
  if (error) throw error;
  const run = await start(db, created);
  await advance(db, run);
  return { ok: true, runId: run.id };
}
```

- [ ] **Step 4: Write `supabase/functions/_shared/backupDrive.ts`**

Both `backup-run` and `backup-restore` need the same three things — a drive with a fresh access token, a folder found or made, and the app's root folder — so they live once. **This module is not node-tested** (it talks to supabase-js), which is why it is separate from the four that are.

```ts
// The connected drive, ready to use.
//
// The refresh token is long-lived and the access token is not, so every
// function that touches the drive starts here: read the connection out of
// app_settings with the service role, trade the refresh token for an access
// token, and hand back a DriveClient. A refresh that fails is the one
// failure the Admin has to act on — the drive has revoked us, or the
// registration's secret has been rotated — so it is written to
// backup_connection_error, which is what the panel reads.

// deno-lint-ignore-file no-explicit-any
import { makeDrive, refreshAccessToken } from "./drive.ts";
import type { DriveClient } from "./drive.ts";
import { BACKUP_ROOT_NAME } from "./backupManifest.ts";

export interface Connection {
  drive: DriveClient;
  provider: string;
  rootFolderId: string;
  account: string;
  keep: number;
}

export async function connectDrive(db: any): Promise<Connection> {
  const { data, error } = await db.from("app_settings").select(
    "backup_provider, backup_refresh_token, backup_account, backup_root_folder_id, backup_keep, " +
    "backup_client_id_google, backup_client_secret_google, backup_client_id_microsoft, " +
    "backup_client_secret_microsoft, backup_client_id_dropbox, backup_client_secret_dropbox"
  ).maybeSingle();
  if (error) throw error;

  const row = (data ?? {}) as Record<string, string | number | null>;
  const provider = String(row.backup_provider ?? "");
  const refresh = String(row.backup_refresh_token ?? "");
  if (!provider || !refresh) {
    throw new Error("No drive is connected. Connect one on the Admin screen before a backup can run.");
  }
  const clientId = String(row[`backup_client_id_${provider}`] ?? "");
  const clientSecret = String(row[`backup_client_secret_${provider}`] ?? "");

  let token: string;
  try {
    token = await refreshAccessToken(provider, clientId, clientSecret, refresh);
  } catch (e) {
    const why = (e as Error).message;
    await db.from("app_settings").update({ backup_connection_error: why }).eq("id", true);
    throw new Error(`The drive connection needs renewing: ${why}`);
  }
  // A refresh that worked clears a stale complaint.
  await db.from("app_settings").update({ backup_connection_error: null }).eq("id", true);

  const drive = makeDrive(provider, token);
  let rootFolderId = String(row.backup_root_folder_id ?? "");
  if (!rootFolderId) {
    rootFolderId = await ensureFolder(drive, drive.rootId(), BACKUP_ROOT_NAME);
    await db.from("app_settings").update({ backup_root_folder_id: rootFolderId }).eq("id", true);
  }

  return {
    drive, provider, rootFolderId,
    account: String(row.backup_account ?? ""),
    keep: Number(row.backup_keep ?? 14)
  };
}

// Find it or make it. Running the same slice twice must land in the folder
// that is already there, not beside it.
export async function ensureFolder(drive: DriveClient, parentId: string, name: string): Promise<string> {
  const found = (await drive.listFolders(parentId)).find(f => f.name === name);
  return found ? found.id : await drive.createFolder(parentId, name);
}
```

- [ ] **Step 5: Finish `supabase/functions/backup-run/index.ts`**

The import of `backupDrive.ts` is already in the header written in Step 3. Append the rest of the file:

```ts
// ── Starting a run ───────────────────────────────────────────────────────

// The folder is made here rather than in the first slice, so backup_runs
// carries a name the panel can show from the very first poll.
async function start(db: Db, run: Record<string, unknown>): Promise<Record<string, unknown>> {
  const conn = await connectDrive(db);
  const stamp = folderStamp(Date.now());
  const name = run.kind === "before_restore" ? `before-restore ${stamp}` : stamp;
  const folderId = await withRetry("Making the backup folder", () => ensureFolder(conn.drive, conn.rootFolderId, name));

  const cursor = {
    phase: "tables",
    tableIndex: 0, partIndex: 0, lastKey: null as string | null, offset: 0,
    rows: {} as Record<string, number>,
    parts: {} as Record<string, string[]>,
    index: { jobs: [] as Record<string, unknown>[], clients: [] as Record<string, unknown>[], tickets: [] as Record<string, unknown>[], jhas: [] as Record<string, unknown>[], reports: [] as Record<string, unknown>[] },
    bucketIndex: 0, prefixes: [] as { prefix: string; offset: number }[], pageDone: 0,
    files: 0, bytes: 0,
    startedAt: new Date().toISOString()
  };

  const { data, error } = await db.from("backup_runs").update({
    status: "running", phase: "tables", cursor,
    folder_id: folderId, folder_name: name,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString()
  }).eq("id", run.id).select("*").single();
  if (error) throw error;
  return data;
}

// ── One slice ────────────────────────────────────────────────────────────

async function advance(db: Db, run: Record<string, unknown>): Promise<Record<string, unknown>> {
  const deadline = Date.now() + BUDGET_MS;
  const cursor = (run.cursor ?? {}) as Record<string, any>;
  const runId = String(run.id);
  const folderId = String(run.folder_id ?? "");

  let conn: Awaited<ReturnType<typeof connectDrive>>;
  try {
    conn = await connectDrive(db);
  } catch (e) {
    return await fail(db, runId, (e as Error).message);
  }

  const tablesFolder = await ensureFolder(conn.drive, folderId, TABLES_FOLDER);
  const filesFolder = await ensureFolder(conn.drive, folderId, FILES_FOLDER);

  try {
    let did = 0;
    while (Date.now() < deadline && cursor.phase !== "done") {
      if (cursor.phase === "tables") await stepTables(db, conn.drive, tablesFolder, cursor);
      else if (cursor.phase === "files") await stepFiles(db, conn.drive, filesFolder, cursor, deadline);
      else if (cursor.phase === "manifest") await stepManifest(db, conn.drive, folderId, cursor);
      else if (cursor.phase === "retention") await stepRetention(conn.drive, conn.rootFolderId, conn.keep, cursor);
      else cursor.phase = "done";
      did += 1;
      await db.from("backup_runs").update({
        phase: cursor.phase, cursor, heartbeat_at: new Date().toISOString(),
        counts: { rows: cursor.rows, files: cursor.files, bytes: cursor.bytes }
      }).eq("id", runId);
    }

    if (cursor.phase === "done") {
      await db.from("backup_runs").update({
        status: "complete", phase: "done", finished_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        counts: { rows: cursor.rows, files: cursor.files, bytes: cursor.bytes }
      }).eq("id", runId);
      return { ok: true, runId, complete: true };
    }

    if (did > 0) kickNextSlice();
    return { ok: true, runId, phase: cursor.phase, continuing: true };
  } catch (e) {
    return await fail(db, runId, (e as Error).message);
  }
}

async function fail(db: Db, runId: string, message: string): Promise<Record<string, unknown>> {
  await db.from("backup_runs").update({
    status: "failed", error: message, finished_at: new Date().toISOString()
  }).eq("id", runId);
  await logError("backup-run", message, { runId });
  return { ok: false, runId, error: message };
}

// The next slice, started by this one and then abandoned. The request has
// left the moment the timeout fires; the callee runs its own hundred
// seconds regardless. Failures are ignored on purpose — the five-minute
// cron is the safety net, and a run that stalls here still finishes, only
// slower.
function kickNextSlice(): void {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/backup-run`;
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "x-internal-secret": Deno.env.get("BACKUP_KICK_SECRET") ?? ""
    },
    body: JSON.stringify({ action: "tick" }),
    signal: AbortSignal.timeout(1500)
  }).then(r => r.body?.cancel()).catch(() => { /* the cron will pick it up */ });
}
```

**`BACKUP_KICK_SECRET`.** The self-kick has to present the same value the database signs its calls with, and a function cannot read `private.internal_config` except through the `internal_secret()` RPC — which it can, so use that instead of an env var. Replace the header line above with a value fetched once per slice:

```ts
// In advance(), before the loop:
const { data: kickSecret } = await db.rpc("internal_secret");
// …and pass it: if (did > 0) kickNextSlice(String(kickSecret ?? ""));
```

and change the signature to `function kickNextSlice(secret: string): void` with `"x-internal-secret": secret`. **No new secret is introduced** — the existing one is read the way `chat-retention` reads it.

```ts
// ── Phase: tables ────────────────────────────────────────────────────────

async function stepTables(db: Db, drive: DriveClient, tablesFolder: string, c: Record<string, any>): Promise<void> {
  if (c.tableIndex >= LOAD_ORDER.length) { c.phase = "files"; return; }
  const table = LOAD_ORDER[c.tableIndex];
  const cursorColumn = CURSOR_COLUMN[table];
  const keys = TABLE_KEYS[table];

  // One part: up to MAX_PART_ROWS rows, read a PostgREST page at a time.
  // Keyset where there is a single unique column — "the next thousand after
  // this id" cannot skip a row when one is inserted mid-walk — and OFFSET
  // for the two composite-key tables, which hold reactions and high scores.
  const rows: Record<string, unknown>[] = [];
  let lastKey: string | null = c.lastKey ?? null;
  let offset: number = Number(c.offset ?? 0);
  let exhausted = false;

  while (rows.length < MAX_PART_ROWS) {
    let q = db.from(table).select("*").limit(PAGE_ROWS);
    if (cursorColumn) {
      q = q.order(cursorColumn);
      if (lastKey !== null) q = q.gt(cursorColumn, lastKey);
    } else {
      for (const k of keys) q = q.order(k);
      q = q.range(offset, offset + PAGE_ROWS - 1);
    }
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (cursorColumn && page.length) lastKey = String(page[page.length - 1][cursorColumn]);
    offset += page.length;
    if (page.length < PAGE_ROWS) { exhausted = true; break; }
  }

  if (table === "profiles") await addAuthEmails(db, rows);
  foldIntoIndex(table, rows, c);

  // An empty part is still written, so the manifest can say "clients: 0"
  // and a restore does not have to tell "no rows" from "never read".
  const name = partFileName(table, Number(c.partIndex ?? 0));
  const payload = await gzip(new TextEncoder().encode(JSON.stringify(stripSecrets(table, rows))));
  await withRetry(`Uploading ${name}`, () => drive.upload(tablesFolder, name, payload, "application/gzip"));

  c.rows[table] = Number(c.rows[table] ?? 0) + rows.length;
  c.parts[table] = [...(c.parts[table] ?? []), name];

  if (exhausted) {
    c.tableIndex += 1;
    c.partIndex = 0;
    c.lastKey = null;
    c.offset = 0;
    if (c.tableIndex >= LOAD_ORDER.length) c.phase = "files";
  } else {
    c.partIndex = Number(c.partIndex ?? 0) + 1;
    c.lastKey = lastKey;
    c.offset = offset;
  }
}

// Auth holds the email addresses; profiles does not. Without them a restore
// into an empty project could re-create the crew's rows but would have
// nowhere to send anybody a set-password link — the account would exist
// with no way in. So each profile row carries auth_email into the backup,
// as a field of the JSON rather than a column of the table; the restore
// takes it off again before it inserts. It is the one place a backup holds
// something the table it came from does not.
async function addAuthEmails(db: Db, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const email = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users ?? [];
    for (const u of users) email.set(u.id, u.email ?? "");
    if (users.length < 1000) break;
  }
  for (const r of rows) r.auth_email = email.get(String(r.id)) ?? null;
}

// The jobs index the per-job restore picks from is built out of rows the
// tables phase is already reading — jobs load after clients and before
// tickets, so by the time the last of the five has gone by, the index has
// everything it needs. Only the columns the index shows are kept: the rest
// would put the whole database in the cursor.
function foldIntoIndex(table: string, rows: Record<string, unknown>[], c: Record<string, any>): void {
  if (table === "clients") {
    for (const r of rows) c.index.clients.push({ id: r.id, name: r.name });
  } else if (table === "jobs") {
    for (const r of rows) c.index.jobs.push({
      id: r.id, job_number: r.job_number, project: r.project,
      status: r.status, created_at: r.created_at, client_id: r.client_id
    });
  } else if (table === "tickets" || table === "jhas" || table === "reports") {
    for (const r of rows) c.index[table].push({ job_id: r.job_id });
  }
}

// ── Phase: files ─────────────────────────────────────────────────────────

async function stepFiles(db: Db, drive: DriveClient, filesFolder: string, c: Record<string, any>, deadline: number): Promise<void> {
  if (c.bucketIndex >= BUCKETS.length) { c.phase = "manifest"; return; }
  const bucket = BUCKETS[c.bucketIndex];

  // Storage lists one prefix at a time, so the walk carries a stack of
  // prefixes still to visit. A fresh bucket starts at its root.
  if (!Array.isArray(c.prefixes) || !c.prefixes.length) {
    if (c.prefixStarted !== bucket) {
      c.prefixes = [{ prefix: "", offset: 0 }];
      c.prefixStarted = bucket;
      c.pageDone = 0;
    } else {
      // The stack emptied: this bucket is done.
      c.bucketIndex += 1;
      c.prefixStarted = null;
      c.pageDone = 0;
      if (c.bucketIndex >= BUCKETS.length) c.phase = "manifest";
      return;
    }
  }

  const top = c.prefixes[c.prefixes.length - 1];
  const { data: entries, error } = await db.storage.from(bucket).list(top.prefix, {
    limit: PAGE_ROWS, offset: top.offset, sortBy: { column: "name", order: "asc" }
  });
  if (error) throw error;
  const page = entries ?? [];

  // Storage marks a folder by having no id of its own.
  const folders = page.filter(e => !e.id);
  const objects = page.filter(e => !!e.id);

  let copied = 0;
  let bytes = 0;
  for (let i = Number(c.pageDone ?? 0); i < objects.length; i++) {
    if (Date.now() >= deadline) {
      // Stop where we are: the same page is re-listed next slice and the
      // first pageDone objects are skipped.
      c.pageDone = i;
      c.files += copied;
      c.bytes += bytes;
      return;
    }
    const key = top.prefix + objects[i].name;
    const blob = await withRetry(`Reading ${bucket}/${key}`, async () => {
      const { data, error: dErr } = await db.storage.from(bucket).download(key);
      if (dErr) throw dErr;
      return data;
    });
    const payload = new Uint8Array(await blob.arrayBuffer());
    const name = fileEntryName(bucket, key);
    await withRetry(`Uploading ${bucket}/${key}`, () =>
      drive.upload(filesFolder, name, payload, blob.type || "application/octet-stream"));
    copied += 1;
    bytes += payload.byteLength;
  }

  c.files += copied;
  c.bytes += bytes;
  c.pageDone = 0;

  // Depth first: sub-prefixes go on the stack, and this prefix advances.
  top.offset += page.length;
  const finished = page.length < PAGE_ROWS;
  if (finished) c.prefixes.pop();
  for (const f of folders) c.prefixes.push({ prefix: top.prefix + f.name + "/", offset: 0 });

  if (!c.prefixes.length) {
    c.bucketIndex += 1;
    c.prefixStarted = null;
    if (c.bucketIndex >= BUCKETS.length) c.phase = "manifest";
  }
}

// ── Phase: manifest, then retention ──────────────────────────────────────

async function stepManifest(db: Db, drive: DriveClient, folderId: string, c: Record<string, any>): Promise<void> {
  // The schema version is the newest migration this database has applied —
  // the one number that says whether a backup can be loaded back into it.
  let schemaVersion: string | null = null;
  try {
    const { data } = await db.rpc("backup_schema_version");
    schemaVersion = data ? String(data) : null;
  } catch { schemaVersion = null; }

  let m = newManifest(APP_VERSION, schemaVersion, String(c.startedAt));
  for (const table of LOAD_ORDER) {
    m = recordTable(m, table, Number(c.rows[table] ?? 0), (c.parts[table] ?? []) as string[]);
  }
  m = recordFiles(m, Number(c.files ?? 0), Number(c.bytes ?? 0));
  m.jobs = jobsIndex(c.index);
  m = finishManifest(m, new Date().toISOString());

  await withRetry("Uploading the manifest", () =>
    drive.upload(folderId, MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(m, null, 2)), "application/json"));

  // The index has done its job and is the biggest thing in the cursor.
  c.index = { jobs: [], clients: [], tickets: [], jhas: [], reports: [] };
  c.phase = "retention";
}

async function stepRetention(drive: DriveClient, rootFolderId: string, keep: number, c: Record<string, any>): Promise<void> {
  const folders = await drive.listFolders(rootFolderId);
  const doomed = foldersToDelete(folders.map(f => f.name), keep);
  for (const name of doomed) {
    const f = folders.find(x => x.name === name);
    if (f) await withRetry(`Removing ${name}`, () => drive.delete(f.id));
  }
  c.removed = doomed;
  c.phase = "done";
}

// ── Reading the drive back ───────────────────────────────────────────────

async function listBackups(db: Db): Promise<Record<string, unknown>[]> {
  const conn = await connectDrive(db);
  const folders = await conn.drive.listFolders(conn.rootFolderId);
  const out: Record<string, unknown>[] = [];
  for (const folder of folders) {
    const entry: Record<string, unknown> = { folderId: folder.id, name: folder.name };
    try {
      const file = (await conn.drive.listFiles(folder.id)).find(f => f.name === MANIFEST_NAME);
      if (file) {
        const m = JSON.parse(new TextDecoder().decode(await conn.drive.download(file.id)));
        entry.app_version = m.app_version ?? null;
        entry.schema_version = m.schema_version ?? null;
        entry.finished_at = m.finished_at ?? null;
        entry.rows = Object.values(m.tables ?? {}).reduce((n: number, t: any) => n + Number(t.rows ?? 0), 0);
        entry.files = m.files?.count ?? 0;
        entry.bytes = m.files?.bytes ?? 0;
        entry.jobs = (m.jobs ?? []).length;
      } else {
        // A folder with no manifest is a run that never finished. Say so
        // rather than offering it as something to restore from.
        entry.incomplete = true;
      }
    } catch (e) {
      entry.incomplete = true;
      entry.error = (e as Error).message;
    }
    out.push(entry);
  }
  // Newest first: the stamp sorts into date order, so this is a reverse sort.
  return out.sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

async function readManifest(db: Db, folderId: string): Promise<Record<string, unknown>> {
  if (!folderId) throw new Error("folderId is required");
  const conn = await connectDrive(db);
  const file = (await conn.drive.listFiles(folderId)).find(f => f.name === MANIFEST_NAME);
  if (!file) throw new Error("That backup has no manifest — it did not finish, so there is nothing to restore from.");
  return JSON.parse(new TextDecoder().decode(await conn.drive.download(file.id)));
}

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    await admin().from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
```

- [ ] **Step 6: Add `backup_schema_version()` to the database**

`stepManifest` asks the database which migration it is on, and `supabase_migrations` is not an exposed schema. Apply this with the Supabase MCP `apply_migration` tool (`name: "the_backup_knows_which_schema_it_came_from"`), then file it under `supabase/migrations/<version>_the_backup_knows_which_schema_it_came_from.sql` with the version from `list_migrations`:

```sql
-- Which schema a backup was taken from. The restore refuses a backup newer
-- than the database it is going into, and this is the number it compares:
-- the last migration applied. Definer because supabase_migrations is not an
-- exposed schema, and staff-only because it is a fingerprint of the
-- deployment rather than anybody's business.
create or replace function public.backup_schema_version()
returns text
language sql
security definer
set search_path to 'public'
stable
as $$
  select max(version) from supabase_migrations.schema_migrations;
$$;

revoke execute on function public.backup_schema_version() from public, anon;
grant execute on function public.backup_schema_version() to authenticated, service_role;
```

Probe it as a non-owner before calling it done — an invoker-visible definer function that names another schema is exactly the shape that broke the tracker for three minutes once. With `execute_sql`:

```sql
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null order by created_at limit 1))::text, true);
set local role authenticated;
select 'schema version as a technician' as probe, public.backup_schema_version() as version;
rollback;
```

Expected: a 14-digit version string, not `42883` and not `42501`.

- [ ] **Step 7: Add the run-related Db methods**

In `vite-app/src/db.js`, after `disconnectBackup`:

```js
  // "Back up now" — a queued run the next tick picks up, except that the
  // function starts it there and then so the panel has something to show
  // immediately.
  async backupNow() {
    const { data, error } = await sbClient.functions.invoke("backup-run", { body: { action: "now" } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },

  // What is in the drive, newest first. Each entry is read from that
  // folder's own manifest, so a folder with none is reported incomplete
  // rather than offered as something to restore from.
  async listBackups() {
    const { data, error } = await sbClient.functions.invoke("backup-run", { body: { action: "list" } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return (data && data.backups) || [];
  },

  // The whole manifest, including the jobs index the per-job restore picks
  // from. Fetched only when that dialog opens: it is the big one.
  async backupManifest(folderId) {
    const { data, error } = await sbClient.functions.invoke("backup-run", { body: { action: "manifest", folderId } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return (data && data.manifest) || null;
  },

  // The run in flight, if there is one — read straight from the table,
  // which an Admin may select and nobody may write.
  async currentBackupRun() {
    const { data, error } = await sbClient.from("backup_runs")
      .select("id, kind, status, phase, counts, error, folder_name, created_at, started_at, finished_at, heartbeat_at")
      .in("status", ["queued", "running"]).order("created_at").limit(1).maybeSingle();
    if (error) throw error;
    return data || null;
  },

  async listBackupRuns(limit = 10) {
    const { data, error } = await sbClient.from("backup_runs")
      .select("id, kind, status, phase, counts, error, folder_name, created_at, started_at, finished_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  },

  // A poke while somebody is watching, so a run does not sit still between
  // five-minute cron ticks. Fire and forget: the panel polls the table for
  // the truth, and a failed nudge costs nothing.
  async nudgeBackup() {
    try { await sbClient.functions.invoke("backup-run", { body: { action: "tick" } }); }
    catch { /* the cron is the safety net */ }
  },
```

And in `TOASTS`, beside the two from Task 4:

```js
  backupNow: "Backup started",
```

(`listBackups`, `backupManifest`, `currentBackupRun`, `listBackupRuns` and `nudgeBackup` are reads and get no toast.)

- [ ] **Step 8: Add the schedule row, "Back up now", the last-run line and progress to `backupPanel.jsx`**

Extend the imports:

```jsx
import { describeSchedule, WEEKDAY_NAMES, nextRunAt } from "../backupSchedule.js";
```

Add these helpers below `PROVIDER_LABEL`:

```jsx
const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const when = iso => iso ? new Date(iso).toLocaleString("en-CA", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }) : "—";

const PHASE_WORDS = {
  tables: "copying the records",
  files: "copying the PDFs and pictures",
  manifest: "writing the index",
  retention: "tidying up old backups",
  safety: "taking a backup first",
  wipe: "emptying the app",
  accounts: "putting the accounts back",
  done: "finishing"
};

const KIND_WORDS = {
  backup: "Backup",
  before_restore: "Safety backup",
  restore_all: "Restore",
  restore_jobs: "Restoring jobs"
};

const rowsIn = counts => Object.values((counts && counts.rows) || {}).reduce((n, v) => n + Number(v || 0), 0);
```

Inside `AutomaticBackupPanel`, add the run state and its poll:

```jsx
  const [run, setRun] = useState(null);
  const [lastRuns, setLastRuns] = useState([]);
  const [starting, setStarting] = useState(false);

  // While something is in flight, look every four seconds and nudge the
  // function to keep going — the cron only comes round every five minutes,
  // which is a long time to watch a bar that has not moved.
  useEffect(() => {
    let alive = true;
    let timer = null;
    const look = async () => {
      try {
        const open = await Db.currentBackupRun();
        if (!alive) return;
        setRun(open);
        if (open) { Db.nudgeBackup(); }
        else { setLastRuns(await Db.listBackupRuns(5)); load(); }
      } catch { /* a failed poll is not worth an error box */ }
      if (alive) timer = setTimeout(look, run ? 4000 : 15000);
    };
    look();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const backUpNow = async () => {
    setStarting(true);
    setError("");
    try { await Db.backupNow(); setRun(await Db.currentBackupRun()); }
    catch (e) { setError(e.message || "The backup couldn't be started."); }
    finally { setStarting(false); }
  };
```

Add the schedule block between the provider row and the App registration button:

```jsx
      {/* Schedule */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 12 }}>
        <Field label="How often">
          <select className="input" value={form.frequency} onChange={e => set("frequency", e.target.value)}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays only</option>
            <option value="weekly">Once a week</option>
            <option value="monthly">Once a month</option>
          </select>
        </Field>
        {form.frequency === "weekly" && (
          <Field label="Day">
            <select className="input" value={form.weekday} onChange={e => set("weekday", Number(e.target.value))}>
              {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </Field>
        )}
        <Field label="At">
          <select className="input" value={form.hour} onChange={e => set("hour", Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
            ))}
          </select>
        </Field>
        <Field label="Keep this many">
          <input className="input" type="number" min="1" max="365" value={form.keep}
            onChange={e => set("keep", e.target.value)} />
        </Field>
      </div>

      <div style={{ ...QUIET, marginBottom: 12 }}>
        {describeSchedule(form)}. Older backups beyond the {plural(Number(form.keep) || 14, "most recent")} are
        removed after each successful run &mdash; except the copies taken automatically just before a restore,
        which are never tidied away.
        {connected && <> Next due <strong>{when(s.next_run_at || nextRunAt(form, Date.now()))}</strong>.</>}
      </div>

      {/* Back up now, and what happened last time */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <Btn variant="secondary" disabled={!connected || starting || !!run} onClick={backUpNow}>
          {starting ? "Starting…" : run ? "A run is already going" : "Back up now"}
        </Btn>
        {!connected && <span style={QUIET}>Connect a drive first.</span>}
      </div>

      {run && (
        <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", marginBottom: 12, fontSize: 13 }}>
          <strong>{KIND_WORDS[run.kind] || run.kind} in progress</strong>
          {run.folder_name ? <> &middot; {run.folder_name}</> : null}
          <div style={{ marginTop: 4 }}>
            {PHASE_WORDS[run.phase] || run.phase || "starting"} &middot; {plural(rowsIn(run.counts), "record")},
            {" "}{plural((run.counts && run.counts.files) || 0, "file")} ({mb((run.counts && run.counts.bytes) || 0)}) so far.
          </div>
          <div style={{ ...QUIET, marginTop: 4 }}>
            It keeps going on the server whether this screen is open or not &mdash; a big first backup can take an hour.
          </div>
        </div>
      )}

      {!run && s.last_run && (
        <div style={{ fontSize: 13, marginBottom: 12 }}>
          <strong>Last {(KIND_WORDS[s.last_run.kind] || "run").toLowerCase()}:</strong>{" "}
          {s.last_run.status === "complete" ? (
            <>finished {when(s.last_run.finished_at)} &middot; {s.last_run.folder_name} &middot;{" "}
              {plural(rowsIn(s.last_run.counts), "record")}, {plural((s.last_run.counts && s.last_run.counts.files) || 0, "file")}{" "}
              ({mb((s.last_run.counts && s.last_run.counts.bytes) || 0)}).</>
          ) : (
            <span style={{ color: "var(--color-accent-700)" }}>
              failed {when(s.last_run.finished_at)} &mdash; {s.last_run.error || "no reason recorded"}. The next
              scheduled backup will still run.
            </span>
          )}
        </div>
      )}

      {lastRuns.length > 1 && (
        <details style={{ marginBottom: 12 }}>
          <summary style={QUIET}>Earlier runs</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {lastRuns.map(r => (
              <div key={r.id} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
                <TagX variant="outline">{KIND_WORDS[r.kind] || r.kind}</TagX>
                <span>{r.folder_name || "—"}</span>
                <span style={{ marginLeft: "auto" }}>{r.status} &middot; {when(r.finished_at || r.created_at)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
```

- [ ] **Step 9: Test and build**

Run: `npm --prefix vite-app test`
Expected: PASS, including the two new gzip tests. The render-name scan checks that every capitalised tag in `backupPanel.jsx` is imported — `Field` and `TagX` are used here and must be in the import list from Task 4 (they are).

Run: `npm --prefix vite-app run build`
Expected: `built in …`.

- [ ] **Step 10: Deploy and prove one real backup**

```bash
npx supabase functions deploy backup-run --project-ref eielmvxzdwwprmmfamlq
npm run build && npx wrangler deploy
```

Then, signed in as Kyle on the Admin screen with a drive connected:

1. Press **Back up now**. The progress box appears within a few seconds and its phase moves from "copying the records" through "copying the PDFs and pictures".
2. While it runs, confirm with `execute_sql`:
   ```sql
   select id, kind, status, phase, counts, folder_name, heartbeat_at from public.backup_runs order by created_at desc limit 1;
   ```
   Expected: `status = running`, a `heartbeat_at` that moves between two reads a minute apart, and `counts->'rows'` growing.
3. When it finishes: `status = complete`, `counts->>'files'` non-zero, and in the drive a folder named like `2026-09-04 14-05` holding `manifest.json`, a `tables` folder with one `.json.gz` per table, and a `files` folder.
4. Open `manifest.json` in the drive and check `schema_version` is the newest migration and `jobs` has one entry per job.
5. Re-run probe block 3 from Task 2 (a Technician reading `backup_runs`) and confirm it still says `0` now that rows exist.

- [ ] **Step 11: Commit**

```bash
git add supabase/functions/_shared/gzip.ts supabase/functions/_shared/backupDrive.ts supabase/functions/backup-run supabase/migrations vite-app/src/db.js vite-app/src/backupShared.test.mjs vite-app/src/components/backupPanel.jsx
git commit -F- <<'MSG'
The project copies itself to the drive, a slice at a time

A function invocation has a ceiling, so no phase is allowed to need one
invocation: the unit of work is one part of one table or one page of one
bucket, and the run's cursor says where the next slice starts. Every unit
replaces rather than appends, so a slice cut short costs a repeated unit and
never a hole — which is the whole reason a backup can be an hour long and
still survive being interrupted.

The five-minute cron would otherwise make an hour of work take all night, so
a slice that got something done kicks the next one itself and walks away
from the answer. The cron stays the safety net: it starts what is due and
picks up whatever the chain dropped, and it reclaims a run whose heartbeat
went quiet mid-slice rather than leaving the schedule wedged.

The jobs index the per-job restore will pick from is folded out of rows the
tables phase is already reading — clients before jobs before tickets, so by
the time the fifth table has gone by it has everything. The clock for the
next run moves when a run starts, not when it ends, so a long night does not
make tomorrow late and a failure does not stop tomorrow happening.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 6: The backups list, and putting everything back

**Files:**
- Create: `supabase/functions/backup-restore/index.ts`
- Modify: `supabase/functions/backup-run/index.ts` (the tick forwards restore kinds)
- Modify: `vite-app/src/db.js` (`restorePreflight`, `restoreAll`)
- Modify: `vite-app/src/components/backupPanel.jsx` (the backups list and `RestoreDialog`)

**Interfaces:**
- Consumes: everything from Tasks 1-5, plus `sendSetPasswordLink` from `supabase/functions/_shared/setPassword.ts`.
- Produces:
  - `POST /functions/v1/backup-restore` with `{ action }`:
    - `"preflight"` + `folderId` — Admin. `{ schema_version, live_schema_version, tooNew, older, rows, files, bytes, jobs }`.
    - `"restore_all"` + `folderId`, `folderName`, `confirm` — Admin. `{ ok: true, runId }`.
    - `"advance"` + `runId` — internal secret only; one slice of a restore already under way.
  - `Db.restorePreflight(folderId) → object`, `Db.restoreAll({ folderId, folderName, confirm }) → { runId }`.
  - `<RestoreDialog backup={…} onClose={…} onStarted={…} />`.

**The one place this plan departs from the spec, and why.** The spec's restore phases run `tables` before `accounts`. They cannot: `profiles.id` is a foreign key to `auth.users(id)` (baseline, line 573), so a profile row whose Auth user no longer exists is refused on insert. The order here is **safety → wipe → accounts → tables → files → activity → done**, with `accounts` reading the backup's own `profiles` parts to know who to create. That also means the backup has to carry each person's email address, which `profiles` does not hold — hence the `auth_email` field added in Task 5.

**The second, smaller departure.** `jobs.last_activity_at` is written back in its own `activity` phase after `files`, not inside `tables`: the activity trigger fires on tickets, JHAs and reports too, so the value has to be corrected once everything that could touch it has been loaded.

- [ ] **Step 1: Write `supabase/functions/backup-restore/index.ts`**

```ts
// backup-restore — putting it all back, or putting some jobs back.
//
// The dangerous one. It is the only thing in the app that empties tables it
// did not fill, so it is gated four times over: an Admin's own profile is
// read before anything else happens; a backup from a newer schema than this
// database is refused outright; the Admin types the backup's folder name;
// and the first phase of the restore itself is a complete backup of what is
// about to be replaced, into a "before-restore" folder retention will never
// tidy away.
//
// It runs in slices for the same reason backup-run does, on the same
// cursor-in-the-row pattern, and it is driven by the same five-minute tick:
// backup-run handles its own two kinds and forwards a restore here.
//
//   {action:"preflight"}    an Admin, before the dialog offers anything
//   {action:"restore_all"}  an Admin, with the typed folder name
//   {action:"restore_jobs"} an Admin, with chosen job ids  (Task 7)
//   {action:"advance"}      the internal secret, one slice

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LOAD_ORDER, WIPE_ORDER, TABLE_KEYS, APP_SETTINGS_NEVER_RESTORED
} from "../_shared/backupTables.ts";
import { MANIFEST_NAME, TABLES_FOLDER, FILES_FOLDER, folderStamp, beforeRestoreName, parseFileEntryName, schemaTooNew } from "../_shared/backupManifest.ts";
import { connectDrive } from "../_shared/backupDrive.ts";
import type { DriveClient } from "../_shared/drive.ts";
import { gunzip } from "../_shared/gzip.ts";
import { sendSetPasswordLink } from "../_shared/setPassword.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const BUDGET_MS = 100_000;
// Rows go back in batches: one 25,000-row part in a single POST is a body
// PostgREST will refuse, and a batch that fails is a batch to name.
const WRITE_BATCH = 500;

type Db = ReturnType<typeof createClient>;

const admin = (): Db => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const db = admin();
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const action = String(body.action ?? "");

  try {
    const { data: expected } = await db.rpc("internal_secret");
    const internal = !!expected && req.headers.get("x-internal-secret") === expected;

    if (action === "advance") {
      if (!internal) return json({ error: "Not authorized" }, 401);
      return json(await advance(db, String(body.runId ?? "")));
    }

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
    );
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);
    const { data: profile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
    if (!profile || profile.role !== "Admin") return json({ error: "Only an Admin can restore" }, 403);

    if (action === "preflight") return json(await preflight(db, String(body.folderId ?? "")));
    if (action === "restore_all") return json(await startRestoreAll(db, body, user.id));
    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    await logError("backup-restore", (e as Error).message, { action });
    return json({ error: (e as Error).message }, 400);
  }
});

// ── Before anything is offered ───────────────────────────────────────────

async function preflight(db: Db, folderId: string): Promise<Record<string, unknown>> {
  if (!folderId) throw new Error("folderId is required");
  const conn = await connectDrive(db);
  const m = await readManifest(conn.drive, folderId);
  const { data: live } = await db.rpc("backup_schema_version");
  const liveVersion = live ? String(live) : null;
  const backupVersion = m.schema_version ? String(m.schema_version) : null;
  return {
    // The folder's own name is what the caller already has; what it does
    // not have is whether this backup may be loaded at all.
    schema_version: backupVersion,
    live_schema_version: liveVersion,
    // Refused: it holds columns this database has not got.
    tooNew: schemaTooNew(backupVersion, liveVersion),
    // Allowed, but worth saying out loud: anything added since is not in it.
    older: !!(backupVersion && liveVersion && backupVersion < liveVersion),
    rows: Object.values((m.tables ?? {}) as Record<string, { rows: number }>).reduce((n, t) => n + Number(t.rows ?? 0), 0),
    files: (m.files as { count?: number })?.count ?? 0,
    bytes: (m.files as { bytes?: number })?.bytes ?? 0,
    jobs: ((m.jobs ?? []) as unknown[]).length
  };
}

async function readManifest(drive: DriveClient, folderId: string): Promise<Record<string, unknown>> {
  const file = (await drive.listFiles(folderId)).find(f => f.name === MANIFEST_NAME);
  if (!file) throw new Error("That backup has no manifest — it did not finish, so there is nothing to restore from.");
  return JSON.parse(new TextDecoder().decode(await drive.download(file.id)));
}

// ── Starting a restore ───────────────────────────────────────────────────

async function startRestoreAll(db: Db, body: Record<string, unknown>, adminId: string): Promise<Record<string, unknown>> {
  const folderId = String(body.folderId ?? "");
  const folderName = String(body.folderName ?? "");
  const confirm = String(body.confirm ?? "");
  if (!folderId || !folderName) throw new Error("folderId and folderName are required");
  // The typed name, character for character. A wrong one is somebody about
  // to replace the wrong night's work.
  if (confirm.trim() !== folderName.trim()) {
    throw new Error(`To restore, type the backup's name exactly: ${folderName}`);
  }

  const check = await preflight(db, folderId);
  if (check.tooNew) {
    throw new Error(
      `That backup was taken from a newer version of the app (schema ${check.schema_version}) than this one ` +
      `(${check.live_schema_version}). Restoring it would try to write columns this database does not have. ` +
      `Update the app first.`
    );
  }

  const { data: open } = await db.from("backup_runs")
    .select("id, kind").in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (open) throw new Error("Something is already running — wait for it to finish before starting a restore.");

  const { data: run, error } = await db.from("backup_runs").insert({
    kind: "restore_all", status: "running", phase: "safety",
    folder_id: folderId, folder_name: folderName, requested_by: adminId,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    cursor: {
      phase: "safety", folderId, folderName,
      safetyRunId: null,
      wipeIndex: 0, tableIndex: 0, partIndex: 0, batchDone: 0,
      loaded: {}, filesDone: 0, filesBytes: 0, fileOffset: 0,
      accountsMade: [], accountsFailed: [],
      // The Admin doing this keeps their own profile row and Auth user, so
      // the session driving the restore does not lose its own permissions
      // halfway through. The load puts the backup's version of it back.
      keepProfileId: adminId
    }
  }).select("*").single();
  if (error) throw error;

  await advance(db, String(run.id));
  return { ok: true, runId: run.id };
}
```

Continue the same file with the phase machine:

```ts
// ── One slice of a restore ───────────────────────────────────────────────

async function advance(db: Db, runId: string): Promise<Record<string, unknown>> {
  if (!runId) throw new Error("runId is required");
  const { data: run, error } = await db.from("backup_runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw error;
  if (!run || run.status !== "running") return { ok: true, runId, idle: true };

  const deadline = Date.now() + BUDGET_MS;
  const c = (run.cursor ?? {}) as Record<string, any>;

  try {
    const conn = await connectDrive(db);
    let did = 0;

    while (Date.now() < deadline && c.phase !== "done") {
      const before = c.phase;
      if (c.phase === "safety") {
        const ready = await stepSafety(db, c);
        if (!ready) break; // the safety backup is still running; come back
      }
      else if (c.phase === "wipe") await stepWipe(db, c);
      else if (c.phase === "accounts") await stepAccounts(db, conn.drive, c, deadline);
      else if (c.phase === "tables") await stepLoad(db, conn.drive, c, deadline);
      else if (c.phase === "files") await stepFilesBack(db, conn.drive, c, deadline);
      else if (c.phase === "activity") await stepActivity(db, conn.drive, c);
      else c.phase = "done";
      did += 1;
      await db.from("backup_runs").update({
        phase: c.phase, cursor: c, heartbeat_at: new Date().toISOString(),
        counts: {
          rows: c.loaded, files: c.filesDone, bytes: c.filesBytes,
          accounts: (c.accountsMade ?? []).length, accountsFailed: c.accountsFailed ?? []
        }
      }).eq("id", runId);
      if (before === c.phase && before === "safety") break;
    }

    if (c.phase === "done") {
      await db.from("backup_runs").update({
        status: "complete", phase: "done", finished_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        counts: {
          rows: c.loaded, files: c.filesDone, bytes: c.filesBytes,
          accounts: (c.accountsMade ?? []).length, accountsFailed: c.accountsFailed ?? []
        }
      }).eq("id", runId);
      for (const failure of (c.accountsFailed ?? []) as string[]) {
        await logError("backup-restore", `Account not restored: ${failure}`, { runId });
      }
      return { ok: true, runId, complete: true };
    }
    if (did > 0) kick(db, runId);
    return { ok: true, runId, phase: c.phase, continuing: true };
  } catch (e) {
    const message = (e as Error).message;
    await db.from("backup_runs").update({
      status: "failed", error: message, finished_at: new Date().toISOString()
    }).eq("id", runId);
    await logError("backup-restore", message, { runId, phase: c.phase });
    return { ok: false, runId, error: message };
  }
}

// The next slice, started and abandoned — the same trick backup-run uses,
// and for the same reason: five minutes between cron ticks is a long time
// to watch a restore stand still.
async function kick(db: Db, runId: string): Promise<void> {
  const { data: secret } = await db.rpc("internal_secret");
  fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/backup-restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "x-internal-secret": String(secret ?? "")
    },
    body: JSON.stringify({ action: "advance", runId }),
    signal: AbortSignal.timeout(1500)
  }).then(r => r.body?.cancel()).catch(() => { /* the cron is the safety net */ });
}

// ── Phase: safety ────────────────────────────────────────────────────────
// A complete backup of what is about to be replaced, taken by exactly the
// code that takes every other backup — a queued run of kind before_restore,
// which backup-run's tick starts and drives. This phase does nothing but
// raise it and wait for it, and it refuses to go on if it fails: the whole
// point of the copy is that it exists before anything is deleted.

async function stepSafety(db: Db, c: Record<string, any>): Promise<boolean> {
  if (!c.safetyRunId) {
    const name = beforeRestoreName(folderStamp(Date.now()));
    const { data, error } = await db.from("backup_runs")
      .insert({ kind: "before_restore", status: "queued", folder_name: name })
      .select("id").single();
    if (error) throw error;
    c.safetyRunId = data.id;
    return false;
  }
  const { data: safety } = await db.from("backup_runs").select("status, error, folder_name").eq("id", c.safetyRunId).maybeSingle();
  if (!safety) throw new Error("The safety backup disappeared before the restore could start. Nothing has been changed.");
  if (safety.status === "failed") {
    throw new Error(`The safety backup failed (${safety.error ?? "no reason recorded"}), so nothing has been restored and nothing has been deleted.`);
  }
  if (safety.status !== "complete") return false;
  c.safetyFolderName = safety.folder_name;
  c.phase = "wipe";
  return true;
}

// ── Phase: wipe ──────────────────────────────────────────────────────────
// One table per step, in the order the handover script established. The
// service role is doing this, so RLS and the guard policies are not in the
// way — which is the point, and also why nothing but this function may.

async function stepWipe(db: Db, c: Record<string, any>): Promise<void> {
  const i = Number(c.wipeIndex ?? 0);
  if (i >= WIPE_ORDER.length) { c.phase = "accounts"; return; }
  const table = WIPE_ORDER[i];
  const key = TABLE_KEYS[table] ? TABLE_KEYS[table][0] : "id";

  let q = db.from(table).delete();
  if (table === "profiles") {
    // Everything except the Admin running this. Their row would take their
    // own Auth user with it, and the session driving the restore would lose
    // its permissions in the middle of the job.
    q = q.neq("id", String(c.keepProfileId));
  } else {
    // PostgREST refuses an unfiltered delete; "every row" is said as a
    // filter that is true of all of them.
    q = q.not(key, "is", null);
  }
  const { error } = await q;
  if (error) throw new Error(`Emptying ${table} failed: ${error.message}`);

  c.wipeIndex = i + 1;
  if (c.wipeIndex >= WIPE_ORDER.length) c.phase = "accounts";
}

// ── Phase: accounts ──────────────────────────────────────────────────────
// Auth users are not in the backup — passwords never leave Supabase — so
// this re-creates the ones that are missing from the profiles rows the
// backup does hold, using the auth_email each of them carries, and mails
// each person a set-password link through the app's own transport. A
// failure here is listed, not fatal: one address that bounces must not
// leave the whole company's records unrestored.

async function stepAccounts(db: Db, drive: DriveClient, c: Record<string, any>, deadline: number): Promise<void> {
  const profiles = await readTable(db, drive, c, "profiles");

  const existing = new Set<string>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users ?? [];
    for (const u of users) existing.add(u.id);
    if (users.length < 1000) break;
  }

  c.accountsMade = c.accountsMade ?? [];
  c.accountsFailed = c.accountsFailed ?? [];
  const from = Number(c.accountIndex ?? 0);
  for (let i = from; i < profiles.length; i++) {
    if (Date.now() >= deadline) { c.accountIndex = i; return; }
    const p = profiles[i] as Record<string, unknown>;
    const id = String(p.id ?? "");
    if (!id || existing.has(id)) continue;
    const email = String(p.auth_email ?? "").trim();
    const name = String(p.name ?? "");
    if (!email) {
      c.accountsFailed.push(`${name || id}: the backup has no email address for this account, so it could not be re-created.`);
      continue;
    }
    try {
      const { error } = await db.auth.admin.createUser({
        // The id is kept, because every ticket, JHA and crew row in the
        // backup names it. A new id would restore the work and lose whose
        // it was.
        id, email, email_confirm: true,
        password: crypto.randomUUID() + crypto.randomUUID(),
        user_metadata: { name }
      });
      if (error) throw error;
      c.accountsMade.push(email);
      try { await sendSetPasswordLink(db, email, name, "invite"); }
      catch (e) { c.accountsFailed.push(`${email}: the account was re-created but the set-password email did not go out (${(e as Error).message}).`); }
    } catch (e) {
      c.accountsFailed.push(`${email}: ${(e as Error).message}`);
    }
  }
  c.accountIndex = 0;
  c.phase = "tables";
}

// ── Phase: tables ────────────────────────────────────────────────────────

async function stepLoad(db: Db, drive: DriveClient, c: Record<string, any>, deadline: number): Promise<void> {
  const i = Number(c.tableIndex ?? 0);
  if (i >= LOAD_ORDER.length) { c.phase = "files"; return; }
  const table = LOAD_ORDER[i];

  // The settings row is not replaced wholesale: it holds the drive
  // connection this restore is running through, and it holds live vendor
  // keys the backup deliberately blanked. Only the columns that are
  // genuinely the client's own settings come back, and only where the
  // backup actually has a value.
  if (table === "app_settings") {
    const rows = await readTable(db, drive, c, "app_settings");
    const source = (rows[0] ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(source)) {
      if (APP_SETTINGS_NEVER_RESTORED.includes(column)) continue;
      if (value === null || value === undefined) continue;
      patch[column] = value;
    }
    if (Object.keys(patch).length) {
      const { error } = await db.from("app_settings").update(patch).eq("id", true);
      if (error) throw new Error(`Restoring the settings failed: ${error.message}`);
    }
    c.loaded.app_settings = rows.length;
    c.tableIndex = i + 1;
    c.phase = "files";
    return;
  }

  const parts = await partsFor(db, drive, c, table);
  const partIndex = Number(c.partIndex ?? 0);
  if (partIndex >= parts.length) {
    c.tableIndex = i + 1;
    c.partIndex = 0;
    c.batchDone = 0;
    if (c.tableIndex >= LOAD_ORDER.length) c.phase = "files";
    return;
  }

  let rows = await readPart(drive, parts[partIndex]);
  // auth_email rides in the JSON, not in the table.
  if (table === "profiles") rows = rows.map(r => { const { auth_email: _drop, ...rest } = r as Record<string, unknown>; return rest; });
  // chat_messages.reply_to points at chat_messages, so a reply must land
  // after the message it quotes.
  if (table === "chat_messages") {
    rows.sort((a, b) => String((a as Record<string, unknown>).created_at ?? "").localeCompare(String((b as Record<string, unknown>).created_at ?? "")));
  }

  const conflict = (TABLE_KEYS[table] ?? ["id"]).join(",");
  for (let at = Number(c.batchDone ?? 0); at < rows.length; at += WRITE_BATCH) {
    if (Date.now() >= deadline) { c.batchDone = at; return; }
    const batch = rows.slice(at, at + WRITE_BATCH);
    // Upsert rather than insert: the Admin's own profile row survived the
    // wipe and has to be replaced by the backup's version of it, and a
    // retried slice must not collide with itself.
    //
    // Triggers stay on all the way through. The guard triggers exempt the
    // service role, the ticket total trigger recomputes exactly the cents
    // the backup already holds, and the one value a trigger does overwrite
    // — jobs.last_activity_at — is written back in the activity phase.
    const { error } = await db.from(table).upsert(batch, { onConflict: conflict });
    if (error) throw new Error(`Restoring ${table} failed at row ${at + 1} of ${rows.length}: ${error.message}`);
  }

  c.loaded[table] = Number(c.loaded[table] ?? 0) + rows.length;
  c.batchDone = 0;
  c.partIndex = partIndex + 1;
}

// ── Phase: files ─────────────────────────────────────────────────────────

async function stepFilesBack(db: Db, drive: DriveClient, c: Record<string, any>, deadline: number): Promise<void> {
  const folder = await subFolder(drive, String(c.folderId), FILES_FOLDER);
  if (!folder) { c.phase = "activity"; return; }
  const entries = (await drive.listFiles(folder)).sort((a, b) => a.name.localeCompare(b.name));

  for (let i = Number(c.fileOffset ?? 0); i < entries.length; i++) {
    if (Date.now() >= deadline) { c.fileOffset = i; return; }
    const parsed = parseFileEntryName(entries[i].name);
    if (!parsed) continue;
    const bytes = await drive.download(entries[i].id);
    const { error } = await db.storage.from(parsed.bucket)
      .upload(parsed.key, bytes, { upsert: true, contentType: "application/octet-stream" });
    if (error) throw new Error(`Putting ${parsed.bucket}/${parsed.key} back failed: ${error.message}`);
    c.filesDone = Number(c.filesDone ?? 0) + 1;
    c.filesBytes = Number(c.filesBytes ?? 0) + bytes.byteLength;
  }
  c.fileOffset = 0;
  c.phase = "activity";
}

// ── Phase: activity ──────────────────────────────────────────────────────
// The board is ordered by jobs.last_activity_at, and definer triggers on
// tickets, JHAs and reports keep it — which means the load just stamped
// every restored job with today. Put the backup's own values back, now that
// nothing else is going to touch them.

async function stepActivity(db: Db, drive: DriveClient, c: Record<string, any>): Promise<void> {
  const parts = await partsFor(db, drive, c, "jobs");
  for (const part of parts) {
    const rows = await readPart(drive, part);
    for (let at = 0; at < rows.length; at += WRITE_BATCH) {
      const batch = rows.slice(at, at + WRITE_BATCH)
        .map(r => ({ id: (r as Record<string, unknown>).id, last_activity_at: (r as Record<string, unknown>).last_activity_at }))
        .filter(r => !!r.last_activity_at);
      if (!batch.length) continue;
      const { error } = await db.from("jobs").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`Restoring the jobs' activity times failed: ${error.message}`);
    }
  }
  c.phase = "done";
}

// ── Reading a backup's parts ─────────────────────────────────────────────

async function subFolder(drive: DriveClient, folderId: string, name: string): Promise<string | null> {
  const found = (await drive.listFolders(folderId)).find(f => f.name === name);
  return found ? found.id : null;
}

// The manifest names the parts; the drive holds them. Cached on the cursor
// for the length of a slice so a table's parts are not re-listed per part.
async function partsFor(db: Db, drive: DriveClient, c: Record<string, any>, table: string): Promise<{ id: string; name: string }[]> {
  if (!c.partIds) {
    const tables = await subFolder(drive, String(c.folderId), TABLES_FOLDER);
    if (!tables) throw new Error("That backup has no tables folder — there is nothing in it to restore.");
    c.partIds = (await drive.listFiles(tables)).map(f => ({ id: f.id, name: f.name }));
  }
  return (c.partIds as { id: string; name: string }[])
    .filter(f => f.name.startsWith(`${table}.`) && f.name.endsWith(".json.gz"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function readPart(drive: DriveClient, part: { id: string; name: string }): Promise<unknown[]> {
  const packed = await drive.download(part.id);
  const rows = JSON.parse(new TextDecoder().decode(await gunzip(packed)));
  if (!Array.isArray(rows)) throw new Error(`${part.name} is not a table part.`);
  return rows;
}

async function readTable(db: Db, drive: DriveClient, c: Record<string, any>, table: string): Promise<unknown[]> {
  const parts = await partsFor(db, drive, c, table);
  const out: unknown[] = [];
  for (const p of parts) out.push(...await readPart(drive, p));
  return out;
}

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    await admin().from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
```

- [ ] **Step 2: Make `backup-run`'s tick hand a restore over**

In `supabase/functions/backup-run/index.ts`, replace the two lookups at the top of `tick()` so that it drives only its own kinds and forwards the others. The order matters: a restore's safety backup is a `before_restore` run raised *after* the restore run, and if the tick picked the restore first the safety backup would never start and the restore would wait for it for ever.

```ts
const MY_KINDS = ["backup", "before_restore"];

async function tick(db: Db): Promise<Record<string, unknown>> {
  // This function's own kinds first, always — a restore's safety backup is
  // raised after the restore itself, and taking the restore first would
  // leave that backup unstarted and the restore waiting on it for ever.
  const { data: running } = await db.from("backup_runs")
    .select("*").eq("status", "running").in("kind", MY_KINDS).order("created_at").limit(1).maybeSingle();
  if (running) {
    const beat = running.heartbeat_at ? Date.parse(String(running.heartbeat_at)) : 0;
    if (beat && Date.now() - beat < BUDGET_MS) return { ok: true, busy: true, runId: running.id };
    return await advance(db, running);
  }

  const { data: queued } = await db.from("backup_runs")
    .select("*").eq("status", "queued").in("kind", MY_KINDS).order("created_at").limit(1).maybeSingle();
  if (queued) return await advance(db, await start(db, queued));

  // A restore in flight is somebody else's job; it still needs the poke.
  const { data: restore } = await db.from("backup_runs")
    .select("id, heartbeat_at").eq("status", "running").in("kind", ["restore_all", "restore_jobs"])
    .order("created_at").limit(1).maybeSingle();
  if (restore) {
    const beat = restore.heartbeat_at ? Date.parse(String(restore.heartbeat_at)) : 0;
    if (!beat || Date.now() - beat >= BUDGET_MS) await forwardToRestore(db, String(restore.id));
    return { ok: true, restoring: restore.id };
  }

  // …the "is one due?" block from Task 5, unchanged, follows here.
```

and beside `kickNextSlice`:

```ts
// One slice of a restore, asked for by the same tick that drives a backup.
// Fire and forget, exactly as the self-kick is.
async function forwardToRestore(db: Db, runId: string): Promise<void> {
  const { data: secret } = await db.rpc("internal_secret");
  fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/backup-restore`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      "x-internal-secret": String(secret ?? "")
    },
    body: JSON.stringify({ action: "advance", runId }),
    signal: AbortSignal.timeout(1500)
  }).then(r => r.body?.cancel()).catch(() => { /* next tick */ });
}
```

Also change `backUpNow`'s "already running" check to `.in("kind", MY_KINDS)` so a restore's own safety backup does not read as a reason to refuse a manual backup afterwards.

- [ ] **Step 3: Add the restore Db methods**

In `vite-app/src/db.js`, after `nudgeBackup`:

```js
  // What the dialog needs before it offers anything: whether this backup
  // may be loaded into this database at all, and how big it is.
  async restorePreflight(folderId) {
    const { data, error } = await sbClient.functions.invoke("backup-restore", { body: { action: "preflight", folderId } });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },

  // The typed folder name goes to the server as well as being checked in
  // the dialog: the browser's copy of a gate is a courtesy, and the
  // function's is the gate.
  async restoreAll({ folderId, folderName, confirm }) {
    const { data, error } = await sbClient.functions.invoke("backup-restore", {
      body: { action: "restore_all", folderId, folderName, confirm }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },
```

And in `TOASTS`:

```js
  restoreAll: "Restore started",
```

- [ ] **Step 4: The backups list and `RestoreDialog` in `backupPanel.jsx`**

Extend the imports:

```jsx
import { Blueprint, Btn, Dialog, Field, ErrorBox, Loading, TagX } from "./common.jsx";
```

Add to `AutomaticBackupPanel`'s state and behaviour:

```jsx
  const [backups, setBackups] = useState(null);
  const [listing, setListing] = useState(false);
  const [restoring, setRestoring] = useState(null); // the backup a dialog is open for

  const listBackups = async () => {
    setListing(true);
    setError("");
    try { setBackups(await Db.listBackups()); }
    catch (e) { setError(e.message || "Couldn't read the drive."); }
    finally { setListing(false); }
  };
```

and this block after the last-run line:

```jsx
      {/* What is in the drive */}
      {connected && (
        <div style={{ borderTop: "1px solid var(--color-neutral-300)", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ ...SECTION_TITLE, marginBottom: 0 }}>Backups in the drive</div>
            <Btn variant="secondary" style={{ marginLeft: "auto" }} disabled={listing} onClick={listBackups}>
              {listing ? "Reading…" : backups ? "Refresh" : "Show backups"}
            </Btn>
          </div>
          {backups && !backups.length && (
            <div style={QUIET}>Nothing in the drive yet. The first backup will appear here.</div>
          )}
          {backups && backups.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              {backups.map(b => (
                <div key={b.folderId} style={{ border: "1px solid var(--color-neutral-300)", padding: "10px 12px", fontSize: 13 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{b.name}</strong>
                    {b.name && b.name.startsWith("before-restore") && <TagX variant="outline">kept</TagX>}
                    {b.incomplete && <TagX variant="outline">didn&rsquo;t finish</TagX>}
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <Btn variant="secondary" disabled={!!b.incomplete || !!run}
                        onClick={() => setRestoring({ ...b, mode: "all" })}>Restore everything</Btn>
                      <Btn variant="secondary" disabled={!!b.incomplete || !!run}
                        onClick={() => setRestoring({ ...b, mode: "jobs" })}>Restore jobs</Btn>
                    </span>
                  </div>
                  <div style={{ ...QUIET, marginTop: 4 }}>
                    {b.incomplete
                      ? "No index in this folder, so it is not offered for restoring."
                      : <>{plural(b.rows || 0, "record")} &middot; {plural(b.files || 0, "file")} ({mb(b.bytes || 0)}) &middot;{" "}
                          {plural(b.jobs || 0, "job")} &middot; app {b.app_version || "?"} &middot; {when(b.finished_at)}</>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {restoring && restoring.mode === "all" && (
        <RestoreDialog backup={restoring} onClose={() => setRestoring(null)}
          onStarted={() => { setRestoring(null); Db.currentBackupRun().then(setRun).catch(() => {}); }} />
      )}
```

(The `mode === "jobs"` branch arrives in Task 7.)

And the dialog itself, at the end of the same file:

```jsx
// Restore everything. The gate is the same shape as the archive dialog's
// typed CLEAR, for the same reason and one more: this replaces every record
// in the app with a copy of an older day, so the word to type is the
// backup's own name — which cannot be typed by accident and cannot be typed
// for the wrong night's backup.
export function RestoreDialog({ backup, onClose, onStarted }) {
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(true);
  const [typed, setTyped] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Db.restorePreflight(backup.folderId)
      .then(r => { if (alive) { setCheck(r); setChecking(false); } })
      .catch(e => { if (alive) { setError(e.message || "Couldn't read that backup."); setChecking(false); } });
    return () => { alive = false; };
  }, [backup.folderId]);

  const ready = !!check && !check.tooNew && typed.trim() === String(backup.name).trim();

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      await Db.restoreAll({ folderId: backup.folderId, folderName: backup.name, confirm: typed });
      onStarted();
    } catch (e) {
      setError(e.message || "The restore couldn't be started.");
      setStarting(false);
    }
  };

  return (
    <Dialog title="Restore everything" maxWidth={580} onClose={starting ? () => {} : onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={starting}>Cancel</Btn>
        <Btn variant="primary" disabled={!ready || starting} onClick={start}
          title={check && check.tooNew ? "That backup is newer than this app" : !ready ? "Type the backup's name to confirm" : undefined}>
          {starting ? "Starting…" : "Replace everything"}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      {checking && <Loading label="Reading that backup…" />}
      {check && (<>
        <div style={{ fontSize: 14 }}>
          <strong>{backup.name}</strong> holds {plural(check.rows || 0, "record")}, {plural(check.files || 0, "file")}{" "}
          ({mb(check.bytes || 0)}) and {plural(check.jobs || 0, "job")}.
        </div>

        {check.tooNew && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>This backup can&rsquo;t be restored here.</strong> It was taken from a newer version of the app
            (database {check.schema_version}) than this one ({check.live_schema_version}), so it holds things this
            app doesn&rsquo;t know about yet. Update the app first.
          </div>
        )}
        {!check.tooNew && check.older && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>This backup is older than the app.</strong> It was taken at database {check.schema_version}; this
            app is at {check.live_schema_version}. It will restore, but anything added to the app since then starts
            empty.
          </div>
        )}

        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
          What this does, in order: takes a complete backup of the app as it stands right now into a
          <strong> before-restore</strong> folder that is never tidied away; empties every table; re-creates any
          crew account that no longer exists and emails each of them a set-password link; loads every record
          from <strong>{backup.name}</strong>; and puts every PDF and picture back.
        </div>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
          Everything filed since that backup was taken will be gone &mdash; tickets, assessments, reports, chat,
          hours. Your own account keeps working throughout. The background error log and the audit trail are not
          in a backup and start empty. Passwords are never in a backup, which is why the crew get a link.
        </div>
        <div style={QUIET}>
          It runs on the server and keeps going whether this screen is open or not. A full restore takes about as
          long as the backup did.
        </div>

        {!check.tooNew && (
          <Field label={`Type the backup's name to confirm: ${backup.name}`}>
            <input className="input" value={typed} onChange={e => setTyped(e.target.value)}
              placeholder={backup.name} autoComplete="off" disabled={starting} />
          </Field>
        )}
      </>)}
    </Dialog>
  );
}
```

- [ ] **Step 5: Test and build**

Run: `npm --prefix vite-app test` → PASS (the render-name scan needs `Dialog` in `backupPanel.jsx`'s import list — it is, from this task's first step).
Run: `npm --prefix vite-app run build` → `built in …`.

- [ ] **Step 6: Deploy**

```bash
npx supabase functions deploy backup-restore --project-ref eielmvxzdwwprmmfamlq
npx supabase functions deploy backup-run --project-ref eielmvxzdwwprmmfamlq
npm run build && npx wrangler deploy
```

- [ ] **Step 7: Prove a restore, on a branch and not on the live project**

A restore-all empties the live database. **Do not rehearse it there.** Use the Supabase MCP `create_branch` tool (`project_id: "eielmvxzdwwprmmfamlq"`, `name: "backup-restore-rehearsal"`), point a local `.env` at the branch, and:

1. Seed the branch with a handful of jobs and tickets (the branch starts from the migrations, so `supabase/seed-jobs.sql` or a few rows by hand).
2. Connect a drive on the branch and press **Back up now**; wait for `complete`.
3. Delete a job and a ticket by hand, and note the counts.
4. Restore that backup by typing its name.
5. Confirm with `execute_sql` against the branch:
   ```sql
   select (select count(*) from public.jobs) as jobs,
          (select count(*) from public.tickets) as tickets,
          (select count(*) from public.ticket_lines) as lines,
          (select count(*) from public.profiles) as profiles,
          (select count(*) from storage.objects where bucket_id = 'reports') as report_files;
   ```
   Expected: the counts from step 2, exactly.
6. Confirm a `before-restore …` folder exists in the drive alongside the dated ones, and that a later scheduled run does not remove it.
7. Confirm `jobs.last_activity_at` matches the backup rather than the restore's own timestamps:
   ```sql
   select job_number, last_activity_at from public.jobs order by last_activity_at desc limit 5;
   ```
8. Delete the branch with the `delete_branch` tool.

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/backup-restore supabase/functions/backup-run vite-app/src/db.js vite-app/src/components/backupPanel.jsx
git commit -F- <<'MSG'
Everything can come back, and it takes a copy before it does

Restoring is the only thing in this app that empties tables it did not fill,
so it is gated four times: the Admin's own profile row is read before
anything happens, a backup from a newer schema than this database is refused
outright, the Admin types the backup's own name — which cannot be typed for
the wrong night by accident — and the first phase is a complete backup of
what is about to be replaced, into a before-restore folder retention never
touches. If that copy fails, nothing is deleted at all.

Accounts come back before the records, not after, because profiles.id is a
foreign key to auth.users: a profile whose Auth user is gone cannot be
inserted at all. Passwords are never in a backup, so each re-created account
gets a set-password link through the app's own transport, and an address
that bounces is listed rather than fatal — one bad email must not leave the
company's records unrestored.

Triggers stay on through the load. The guards exempt the service role and
the totals trigger recomputes the same cents the backup holds; the one value
a trigger overwrites, jobs.last_activity_at, is written back afterwards,
once nothing else is going to touch it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 7: Restoring a few jobs — the everyday mistake

**Files:**
- Modify: `supabase/functions/backup-restore/index.ts` (the `restore_jobs` action and its phases)
- Modify: `vite-app/src/db.js` (`restoreJobs`)
- Modify: `vite-app/src/components/backupPanel.jsx` (`RestoreJobsDialog`, and the list's second button)

**Interfaces:**
- Consumes: everything from Task 6, plus `JOB_CHILD_TABLES` (Task 3) and `Db.backupManifest` (Task 5).
- Produces:
  - `POST /functions/v1/backup-restore` with `{ action: "restore_jobs", folderId, jobIds }` — Admin. `{ ok: true, runId }`.
  - `Db.restoreJobs({ folderId, jobIds }) → { runId }`.
  - `<RestoreJobsDialog backup={…} onClose={…} onStarted={…} />`.
  - `backup_runs.counts` for this kind carries `{ rows, files, skipped: string[], collisions: string[] }`.

**The rules, in one place.** Nothing live is ever deleted. A row whose id already exists live is left alone and counted as skipped — restoring a job twice is a no-op, not a duplicate. A ticket whose number is already in use by a *different* ticket is a collision: that ticket and its lines and crew are skipped and the number is named in the report, because a ticket number is somebody's invoice reference and two of them is worse than one missing. A job's client or contractor is kept by id when that organisation still exists, matched by name when it does not, and left empty and reported when neither works. A crew row whose person no longer has a profile is skipped and named — `ticket_crew.profile_id` is `not null`, so there is nothing else it could be.

- [ ] **Step 1: Add the action to `backup-restore/index.ts`**

Add `JOB_CHILD_TABLES` to the `backupTables.ts` import, then this beside `startRestoreAll`:

```ts
async function startRestoreJobs(db: Db, body: Record<string, unknown>, adminId: string): Promise<Record<string, unknown>> {
  const folderId = String(body.folderId ?? "");
  const jobIds = Array.isArray(body.jobIds) ? body.jobIds.map(String).filter(Boolean) : [];
  if (!folderId) throw new Error("folderId is required");
  if (!jobIds.length) throw new Error("Pick at least one job to restore.");

  const check = await preflight(db, folderId);
  if (check.tooNew) {
    throw new Error(
      `That backup was taken from a newer version of the app (schema ${check.schema_version}) than this one ` +
      `(${check.live_schema_version}), so its records may not fit. Update the app first.`
    );
  }

  const { data: open } = await db.from("backup_runs")
    .select("id").in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (open) throw new Error("Something is already running — wait for it to finish.");

  const { data: run, error } = await db.from("backup_runs").insert({
    kind: "restore_jobs", status: "running", phase: "tables",
    folder_id: folderId, folder_name: String(body.folderName ?? ""), requested_by: adminId,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
    cursor: {
      phase: "tables", folderId, jobIds,
      tableIndex: 0, partIndex: 0,
      // Filled as the passes go by: which tickets belong to the chosen
      // jobs (so lines and crew can be filtered), and which PDFs to fetch.
      ticketIds: [], pdfKeys: [], fileOffset: 0,
      loaded: {}, filesDone: 0, filesBytes: 0,
      skipped: [], collisions: []
    }
  }).select("*").single();
  if (error) throw error;

  await advance(db, String(run.id));
  return { ok: true, runId: run.id };
}
```

and route it in `Deno.serve`, beside the `restore_all` line:

```ts
    if (action === "restore_jobs") return json(await startRestoreJobs(db, body, user.id));
```

In `advance`, the phase switch grows one branch. Put it first, because a `restore_jobs` run has no `safety`, no `wipe` and no `accounts` — it deletes nothing, so there is nothing to take a copy of:

```ts
      if (run.kind === "restore_jobs") {
        if (c.phase === "tables") await stepJobTables(db, conn.drive, c, deadline);
        else if (c.phase === "files") await stepJobFiles(db, conn.drive, c, deadline);
        else c.phase = "done";
      }
      else if (c.phase === "safety") { … }   // the existing chain, unchanged
```

- [ ] **Step 2: The two phases**

```ts
// Which tables a job's records live in, in the order they have to go back:
// the job itself, then everything that names it.
const JOB_TABLES = ["jobs", ...JOB_CHILD_TABLES];

// The chosen jobs' rows, one table pass at a time. The backup is read the
// same way it was written — part by part — and each part is filtered to the
// jobs asked for, so a per-job restore never holds more than one part in
// memory however big the backup is.
async function stepJobTables(db: Db, drive: DriveClient, c: Record<string, any>, deadline: number): Promise<void> {
  const i = Number(c.tableIndex ?? 0);
  if (i >= JOB_TABLES.length) { c.phase = "files"; return; }
  const table = JOB_TABLES[i];
  const parts = await partsFor(db, drive, c, table);
  const partIndex = Number(c.partIndex ?? 0);
  if (partIndex >= parts.length) {
    c.tableIndex = i + 1;
    c.partIndex = 0;
    if (c.tableIndex >= JOB_TABLES.length) c.phase = "files";
    return;
  }

  const jobIds = new Set((c.jobIds ?? []) as string[]);
  const ticketIds = new Set((c.ticketIds ?? []) as string[]);
  const all = await readPart(drive, parts[partIndex]) as Record<string, unknown>[];

  const mine = all.filter(r => {
    if (table === "jobs") return jobIds.has(String(r.id));
    if (table === "ticket_lines" || table === "ticket_crew") return ticketIds.has(String(r.ticket_id));
    return jobIds.has(String(r.job_id));
  });

  if (mine.length) {
    const written = table === "jobs"
      ? await putJobs(db, drive, c, mine)
      : await putJobChildren(db, c, table, mine);
    c.loaded[table] = Number(c.loaded[table] ?? 0) + written;
  }

  c.partIndex = partIndex + 1;
  if (Date.now() >= deadline) return;
}

// A job carries three references that may not exist here any more: its
// client, its contractor, and the person who raised it. The organisations
// are looked for by id and then by name — a client re-entered by hand after
// a mistake has a new id and the same name — and anything still unmatched is
// left empty and named in the report rather than blocking the job.
async function putJobs(db: Db, drive: DriveClient, c: Record<string, any>, rows: Record<string, unknown>[]): Promise<number> {
  const existing = await liveIds(db, "jobs", "id", rows.map(r => String(r.id)));
  const orgs = await orgMap(db, drive, c);
  const profiles = await liveIds(db, "profiles", "id",
    rows.flatMap(r => [String(r.created_by ?? ""), String(r.client_contact_id ?? "")]).filter(Boolean));
  const contacts = await liveIds(db, "contacts", "id",
    rows.flatMap(r => [String(r.client_contact_id ?? ""), String(r.contractor_contact_id ?? "")]).filter(Boolean));
  const numbers = await liveIds(db, "jobs", "job_number", rows.map(r => String(r.job_number)));

  const ready: Record<string, unknown>[] = [];
  for (const row of rows) {
    const id = String(row.id);
    if (existing.has(id)) { c.skipped.push(`Job ${row.job_number} is already in the app — left alone.`); continue; }
    if (numbers.has(String(row.job_number))) {
      c.collisions.push(`Job number ${row.job_number} is already used by a different job here, so that job was not restored.`);
      continue;
    }
    const job = { ...row };
    job.client_id = resolveOrg(c, "client", row.client_id, row, orgs.clients);
    job.contractor_id = resolveOrg(c, "contractor", row.contractor_id, row, orgs.contractors);
    if (job.created_by && !profiles.has(String(job.created_by))) job.created_by = null;
    if (job.client_contact_id && !contacts.has(String(job.client_contact_id))) job.client_contact_id = null;
    if (job.contractor_contact_id && !contacts.has(String(job.contractor_contact_id))) job.contractor_contact_id = null;
    ready.push(job);
  }
  if (!ready.length) return 0;

  const { error } = await db.from("jobs").insert(ready);
  if (error) throw new Error(`Restoring the jobs failed: ${error.message}`);
  // The activity trigger has just stamped them with today; the backup's own
  // value goes back on straight away, in the same pass.
  const activity = ready.filter(j => !!j.last_activity_at).map(j => ({ id: j.id, last_activity_at: j.last_activity_at }));
  if (activity.length) await db.from("jobs").upsert(activity, { onConflict: "id" });
  return ready.length;
}

function resolveOrg(c: Record<string, any>, what: string, id: unknown, job: Record<string, unknown>, map: { live: Set<string>; byName: Map<string, string>; names: Map<string, string> }): string | null {
  const wanted = String(id ?? "");
  if (!wanted) return null;
  if (map.live.has(wanted)) return wanted;
  const name = map.names.get(wanted) ?? "";
  const matched = name ? map.byName.get(name.trim().toLowerCase()) : undefined;
  if (matched) return matched;
  c.skipped.push(`Job ${job.job_number} was restored without its ${what}${name ? ` (${name})` : ""} — that organisation is no longer in the app. Set it on the job record.`);
  return null;
}

// The backup's own clients and contractors, read once and kept on the
// cursor: which ids still exist here, and what each id was called, so an
// organisation re-entered by hand can be matched by name.
async function orgMap(db: Db, drive: DriveClient, c: Record<string, any>): Promise<Record<string, { live: Set<string>; byName: Map<string, string>; names: Map<string, string> }>> {
  const out: Record<string, { live: Set<string>; byName: Map<string, string>; names: Map<string, string> }> = {};
  for (const table of ["clients", "contractors"]) {
    const fromBackup = await readTable(db, drive, c, table) as Record<string, unknown>[];
    const names = new Map<string, string>();
    for (const r of fromBackup) names.set(String(r.id), String(r.name ?? ""));
    const { data, error } = await db.from(table).select("id, name");
    if (error) throw error;
    const live = new Set<string>();
    const byName = new Map<string, string>();
    for (const r of (data ?? []) as { id: string; name: string }[]) {
      live.add(String(r.id));
      byName.set(String(r.name ?? "").trim().toLowerCase(), String(r.id));
    }
    out[table] = { live, byName, names };
  }
  return { clients: out.clients, contractors: out.contractors };
}

// Tickets, lines, crew, assessments, reports and overrides. A ticket's id
// IS its number, so an id already in use is the collision the office cares
// about; its lines and crew are dropped with it, because half a ticket is
// worse than none.
async function putJobChildren(db: Db, c: Record<string, any>, table: string, rows: Record<string, unknown>[]): Promise<number> {
  const key = table === "tickets" ? "id" : "id";
  const existing = await liveIds(db, table, key, rows.map(r => String(r[key])));

  let ready = rows.filter(r => {
    if (!existing.has(String(r[key]))) return true;
    if (table === "tickets") c.collisions.push(`Ticket ${r.id} already exists here, so it and its charges were not restored.`);
    else c.skipped.push(`A ${table.replace("_", " ")} row was already in the app and was left alone.`);
    return false;
  });

  if (table === "tickets") {
    // A number that has been deliberately retired is not free either.
    const burned = await liveIds(db, "burned_ticket_numbers", "id", ready.map(r => String(r.id)));
    ready = ready.filter(r => {
      if (!burned.has(String(r.id))) return true;
      c.collisions.push(`Ticket number ${r.id} has been retired in this app, so that ticket was not restored.`);
      return false;
    });
    // Only the tickets that actually went back may bring lines and crew.
    c.ticketIds = [...new Set([...(c.ticketIds ?? []), ...ready.map(r => String(r.id))])];
    const profiles = await liveIds(db, "profiles", "id", ready.map(r => String(r.technician_id ?? "")).filter(Boolean));
    ready = ready.map(r => ({ ...r, technician_id: r.technician_id && profiles.has(String(r.technician_id)) ? r.technician_id : null }));
  }

  if (table === "ticket_crew") {
    // profile_id is not null, so a crew row for somebody with no profile
    // cannot be written at all — it is named instead of guessed at.
    const profiles = await liveIds(db, "profiles", "id", ready.map(r => String(r.profile_id)));
    const before = ready.length;
    ready = ready.filter(r => profiles.has(String(r.profile_id)));
    if (ready.length < before) {
      c.skipped.push(`${before - ready.length} crew ${before - ready.length === 1 ? "row" : "rows"} could not be restored: those accounts are no longer in the app, so their hours are missing from the restored tickets.`);
    }
  }

  if (table === "jhas") {
    const profiles = await liveIds(db, "profiles", "id", ready.map(r => String(r.signed_by ?? "")).filter(Boolean));
    ready = ready.map(r => ({ ...r, signed_by: r.signed_by && profiles.has(String(r.signed_by)) ? r.signed_by : null }));
  }

  // The PDFs these rows point at are fetched in the files phase.
  if (table === "jhas") c.pdfKeys.push(...ready.map(r => `jhas/${r.pdf_key}`).filter(k => !k.endsWith("/null")));
  if (table === "reports") c.pdfKeys.push(...ready.map(r => `reports/${r.pdf_key}`).filter(k => !k.endsWith("/null")));

  if (!ready.length) return 0;
  for (let at = 0; at < ready.length; at += WRITE_BATCH) {
    const { error } = await db.from(table).insert(ready.slice(at, at + WRITE_BATCH));
    if (error) throw new Error(`Restoring ${table} failed: ${error.message}`);
  }
  return ready.length;
}

// Which of these ids are already here. Asked in batches, because "in" with
// twenty-five thousand values is a URL no gateway will take.
async function liveIds(db: Db, table: string, column: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let at = 0; at < unique.length; at += 200) {
    const { data, error } = await db.from(table).select(column).in(column, unique.slice(at, at + 200));
    if (error) throw error;
    for (const r of (data ?? []) as Record<string, unknown>[]) out.add(String(r[column]));
  }
  return out;
}

// Only the PDFs the restored rows point at, matched by the flat name the
// backup wrote them under.
async function stepJobFiles(db: Db, drive: DriveClient, c: Record<string, any>, deadline: number): Promise<void> {
  const folder = await subFolder(drive, String(c.folderId), FILES_FOLDER);
  const wanted = [...new Set((c.pdfKeys ?? []) as string[])];
  if (!folder || !wanted.length) { c.phase = "done"; return; }

  if (!c.fileIndex) {
    const entries = await drive.listFiles(folder);
    const byName = new Map(entries.map(e => [e.name, e.id]));
    c.fileIndex = wanted.map(pathKey => {
      const cut = pathKey.indexOf("/");
      const name = fileEntryName(pathKey.slice(0, cut), pathKey.slice(cut + 1));
      return { key: pathKey, id: byName.get(name) ?? null };
    });
  }

  const list = c.fileIndex as { key: string; id: string | null }[];
  for (let i = Number(c.fileOffset ?? 0); i < list.length; i++) {
    if (Date.now() >= deadline) { c.fileOffset = i; return; }
    const item = list[i];
    if (!item.id) { c.skipped.push(`${item.key} was not in that backup, so the record was restored without its PDF.`); continue; }
    const cut = item.key.indexOf("/");
    const bucket = item.key.slice(0, cut);
    const key = item.key.slice(cut + 1);
    const bytes = await drive.download(item.id);
    const { error } = await db.storage.from(bucket).upload(key, bytes, { upsert: true, contentType: "application/pdf" });
    if (error) throw new Error(`Putting ${item.key} back failed: ${error.message}`);
    c.filesDone = Number(c.filesDone ?? 0) + 1;
    c.filesBytes = Number(c.filesBytes ?? 0) + bytes.byteLength;
  }
  c.fileOffset = 0;
  c.phase = "done";
}
```

Add `fileEntryName` to the `backupManifest.ts` import at the top of the file.

- [ ] **Step 3: `Db.restoreJobs`**

In `vite-app/src/db.js`, after `restoreAll`:

```js
  // Putting a few jobs back. Nothing live is deleted and nothing live is
  // overwritten: a row already here is left alone, and a ticket number
  // already in use comes back as a collision the panel lists by name.
  async restoreJobs({ folderId, folderName, jobIds }) {
    const { data, error } = await sbClient.functions.invoke("backup-restore", {
      body: { action: "restore_jobs", folderId, folderName, jobIds }
    });
    if (error) throw await fnError(error);
    if (data && data.error) throw new Error(data.error);
    return data || {};
  },
```

and in `TOASTS`:

```js
  restoreJobs: "Restoring the chosen jobs",
```

- [ ] **Step 4: `RestoreJobsDialog` in `backupPanel.jsx`**

Wire the second button in the backups list:

```jsx
      {restoring && restoring.mode === "jobs" && (
        <RestoreJobsDialog backup={restoring} onClose={() => setRestoring(null)}
          onStarted={() => { setRestoring(null); Db.currentBackupRun().then(setRun).catch(() => {}); }} />
      )}
```

and add the dialog at the end of the file:

```jsx
// Restore a few jobs — the everyday mistake, as opposed to the disaster.
// No typed word here: nothing is deleted and nothing live is overwritten,
// so the worst outcome of pressing it by accident is that some old jobs
// come back and can be deleted again the ordinary way.
export function RestoreJobsDialog({ backup, onClose, onStarted }) {
  const [manifest, setManifest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState(() => new Set());
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    Db.backupManifest(backup.folderId)
      .then(m => { if (alive) { setManifest(m); setLoading(false); } })
      .catch(e => { if (alive) { setError(e.message || "Couldn't read that backup's index."); setLoading(false); } });
    return () => { alive = false; };
  }, [backup.folderId]);

  const jobs = (manifest && manifest.jobs) || [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? jobs.filter(j => `${j.job_number} ${j.client} ${j.project}`.toLowerCase().includes(needle))
    : jobs;

  const toggle = id => setChosen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const start = async () => {
    setStarting(true);
    setError("");
    try {
      await Db.restoreJobs({ folderId: backup.folderId, folderName: backup.name, jobIds: [...chosen] });
      onStarted();
    } catch (e) {
      setError(e.message || "The restore couldn't be started.");
      setStarting(false);
    }
  };

  return (
    <Dialog title="Restore jobs" maxWidth={640} onClose={starting ? () => {} : onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={starting}>Cancel</Btn>
        <Btn variant="primary" disabled={!chosen.size || starting} onClick={start}>
          {starting ? "Starting…" : `Restore ${plural(chosen.size, "job")}`}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
        From <strong>{backup.name}</strong>. The chosen jobs come back with their tickets, charges, crew hours,
        assessments, reports and PDFs. Nothing already in the app is deleted or changed: a record that is still
        here is left alone, and a ticket number already in use is reported rather than duplicated.
      </div>
      {loading && <Loading label="Reading the backup's index…" />}
      {!loading && !jobs.length && <div style={QUIET}>That backup&rsquo;s index lists no jobs.</div>}
      {!loading && jobs.length > 0 && (<>
        <Field label="Find a job">
          <input className="input" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="job number, client or project" />
        </Field>
        <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--color-neutral-300)" }}>
          {shown.map(j => (
            <label key={j.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", borderBottom: "1px solid var(--color-neutral-300)", cursor: "pointer" }}>
              <input type="checkbox" checked={chosen.has(j.id)} onChange={() => toggle(j.id)} />
              <span style={{ fontSize: 13 }}>
                <strong>{j.job_number}</strong> &middot; {j.client || "no client on file"} &middot; {j.project || "—"}
                <span style={{ ...QUIET, display: "block" }}>
                  {j.status} &middot; raised {when(j.created_at)} &middot; {plural(j.tickets, "ticket")},{" "}
                  {plural(j.jhas, "assessment")}, {plural(j.reports, "report")}
                </span>
              </span>
            </label>
          ))}
          {!shown.length && <div style={{ ...QUIET, padding: "10px 12px" }}>Nothing matches that.</div>}
        </div>
        <div style={QUIET}>{plural(chosen.size, "job")} chosen of {plural(jobs.length, "job")} in this backup.</div>
      </>)}
    </Dialog>
  );
}
```

Finally, show what a finished restore reported. Add this beneath the last-run line in `AutomaticBackupPanel`:

```jsx
      {!run && s.last_run && s.last_run.counts && (
        (s.last_run.counts.collisions || []).length > 0 || (s.last_run.counts.skipped || []).length > 0 ||
        (s.last_run.counts.accountsFailed || []).length > 0
      ) && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ fontSize: 13 }}>
            The last restore left {plural(
              (s.last_run.counts.collisions || []).length + (s.last_run.counts.skipped || []).length +
              (s.last_run.counts.accountsFailed || []).length, "note")} — worth reading
          </summary>
          <ul style={{ fontSize: 12, margin: "8px 0 0", paddingLeft: 18 }}>
            {[...(s.last_run.counts.collisions || []), ...(s.last_run.counts.skipped || []), ...(s.last_run.counts.accountsFailed || [])]
              .slice(0, 40).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </details>
      )}
```

- [ ] **Step 5: Test and build**

Run: `npm --prefix vite-app test` → PASS.
Run: `npm --prefix vite-app run build` → `built in …`.

- [ ] **Step 6: Deploy**

```bash
npx supabase functions deploy backup-restore --project-ref eielmvxzdwwprmmfamlq
npm run build && npx wrangler deploy
```

- [ ] **Step 7: Prove it, live, because it deletes nothing**

Unlike restore-all this is safe on the live project: it inserts and never removes. On a seed job (`S-1%`), signed in as Kyle:

1. Note a seed job's number and its ticket count, then delete that job from Job detail.
2. Admin screen → Backups in the drive → **Restore jobs** on the most recent backup → find it by number → Restore 1 job.
3. When the run completes, confirm the job is back on Home with its tickets, that a ticket's charges and crew hours are the same figures, and that its report PDF opens.
4. Press **Restore jobs** on the same job again. Expected: the run completes and the notes say the job is already in the app and was left alone — nothing is duplicated.
5. Check a collision is reported rather than silently swallowed:
   ```sql
   select counts from public.backup_runs where kind = 'restore_jobs' order by created_at desc limit 1;
   ```
   Expected: `skipped` names the already-present job, and `collisions` is empty for step 4 (the whole job was skipped before its tickets were reached).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/backup-restore vite-app/src/db.js vite-app/src/components/backupPanel.jsx
git commit -F- <<'MSG'
A few jobs can come back without the rest of the app going with them

The disaster story replaces everything; the everyday one is a job somebody
deleted on Tuesday. This adds nothing and removes nothing: a record already
in the app is left alone, so restoring the same job twice is a no-op rather
than a duplicate, and there is no typed word to get past because the worst
outcome of a mis-click is some old jobs to delete again.

Ticket numbers are the part that needed care. A ticket's id IS its number,
so a number already in use — or one deliberately retired — is a collision,
and the ticket goes back unrestored with its charges and crew, named in the
report. Two tickets bearing one invoice reference would be worse than one
missing.

Everything a job points at that may no longer exist is resolved rather than
assumed: an organisation by id and then by name, because a client re-entered
by hand has a new id and the same name; a technician or a signer by id, and
left empty when they have gone. A crew row is the exception — profile_id is
not null — so those are skipped and counted out loud, since they are hours
somebody worked.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

### Task 8: The documents — the rules that are not in the code, the map, and the runbook

**Files:**
- Modify: `CLAUDE.md` (a new block under "Rules that are not in the code", and the migration line)
- Modify: `README.md` (Structure block, the Admin screen row, the function count)
- Modify: `HANDOVER.md` (a new section: registering the three drive apps)

**Interfaces:** none — this task ships prose. It is a task of its own because a reviewer can reject the wording without rejecting the code, and because the three provider consoles' exact paths are the part a new admin cannot guess.

- [ ] **Step 1: Add the backup rules to `CLAUDE.md`**

Insert after the "Chat extras" bullet, at the end of "Rules that are not in the code":

```markdown
- Automatic backup lives in two places and no others: the connection, the
  schedule and the three app registrations are columns on the one
  `app_settings` row (Admin-only RLS), and every run is a row in
  `backup_runs` (Admin may read, nobody may write — the writes are the
  service role's, from inside the functions). `backup_state()` is the
  panel's whole read and answers `has_secret_google`, never a secret: the
  refresh token and the client secrets never reach the browser. A backup is
  a dated folder in the drive holding `manifest.json`, `tables/` (one
  gzipped JSON part per table, numbered from 01) and `files/` (every stored
  object, its bucket and key percent-encoded into one flat name, because
  all three providers read a `/` as a folder). `app_settings` goes in with
  its credentials blanked (`APP_SETTINGS_SECRETS`); `profiles` carries an
  extra `auth_email` field that is not a column, because Auth holds the
  addresses and a restore has nowhere to send a set-password link without
  them.
- The tick is the only scheduler. pg_cron fires `backup-run` every five
  minutes with `x-internal-secret` (chat-retention's shape); `backup-run`
  drives kinds `backup` and `before_restore` and forwards `restore_all` and
  `restore_jobs` to `backup-restore`. Its own kinds come first, always: a
  restore's safety backup is raised *after* the restore run, and taking the
  restore first would leave that backup unstarted and the restore waiting
  on it for ever. Work is done in slices of about 100 seconds with the
  position in `backup_runs.cursor`, and a slice that got something done
  kicks the next one itself; the cron is the safety net, not the engine. A
  run whose `heartbeat_at` has been quiet for ten minutes died mid-slice
  and is reclaimed. `backup_next_run_at` moves when a run STARTS, so a long
  night does not make tomorrow late and a failure does not stop tomorrow.
- Restoring everything is gated four times and the order of its phases is
  not the obvious one: safety → wipe → **accounts** → tables → files →
  activity. Accounts come before the records because `profiles.id` is a
  foreign key to `auth.users(id)` — a profile whose Auth user is gone
  cannot be inserted at all. The wipe follows `supabase/handover/
  wipe-seed-data.sql`'s own order (a test reads that file back), keeps the
  Admin running the restore so their session does not lose its permissions
  halfway, and clears `audit_log` and `function_errors` although neither is
  backed up, because their foreign keys to profiles would abort the delete
  — so a restored database starts with an empty error log, deliberately.
  Triggers stay on through the load; the one value a trigger overwrites,
  `jobs.last_activity_at`, is written back in the `activity` phase.
  `app_settings` is never wiped and is restored by a narrow UPDATE that
  skips every `backup_*` column, or the restore would replace the drive
  connection it is running through.
- Restoring chosen jobs deletes nothing and overwrites nothing: a row
  already present is left alone, so the same job restored twice is a no-op.
  A ticket's id IS its number, so an id already in use — or one retired in
  `burned_ticket_numbers` — is a collision, and that ticket goes back
  unrestored with its lines and crew and is named in the report. An
  organisation is matched by id, then by name, then reported and left
  empty; a technician or signer that has gone is nulled; a `ticket_crew`
  row whose person has gone is skipped and counted, because `profile_id` is
  `not null` and those are somebody's hours.
- `nextRunAt` lives twice — `vite-app/src/backupSchedule.js` and
  `supabase/functions/_shared/backupSchedule.ts` — with a byte-identical
  block between the `shared core` markers, and `backupSchedule.test.mjs`
  reads both files off disk and compares them. Change one, change the other,
  in the same commit. The four shared backup modules (`backupSchedule.ts`,
  `drive.ts`, `backupTables.ts`, `backupManifest.ts`, plus `gzip.ts`) are
  erasable TypeScript with no imports of their own, because the node suite
  imports them straight out of `supabase/functions/` — an `enum` or a
  constructor parameter property in any of them breaks `npm test`.
  `backupDrive.ts` is deliberately outside that rule: it talks to
  supabase-js and is not node-tested.
- The three backup functions deploy through the CLI like every other one
  (`npx supabase functions deploy <name> --project-ref eielmvxzdwwprmmfamlq`)
  and their `verify_jwt` is pinned in `supabase/config.toml`:
  `backup-oauth` false (the provider redirects a browser with no token; its
  callback is gated by a single-use nonce minted in `app_settings` and spent
  the moment it is read), `backup-run` and `backup-restore` true.
```

Also amend the migrations bullet's last sentence so the current head is named. Replace the sentence beginning "Nothing is waiting there now. The latest is" so it reads:

```markdown
  Nothing is waiting there now. The latest is
  `<version>_the_backup_knows_which_schema_it_came_from.sql`; the automatic
  backup's own tables, columns, RPC and cron job arrived one migration
  earlier in `<version>_the_project_backs_itself_up.sql` (probes in
  `supabase/handover/probes-<version>-the-project-backs-itself-up.sql`).
```

(Fill both `<version>`s from the two migrations applied in Tasks 2 and 5.)

- [ ] **Step 2: Update `README.md`**

Three edits.

**a.** In the Structure block, under `src/`, after the `archive.js` entry:

```
    backupSchedule.js       when the automatic backup is next due — Grande Prairie's
                            clock, DST and all; a byte-identical twin lives in
                            supabase/functions/_shared/ and a test compares them
```

**b.** In the Structure block, under `components/`, replace the `adminSetup.jsx` line and add one:

```
      adminSetup.jsx        Admin screen: Resend + KLIPY keys, app address, archive,
                            automatic backup
      backupPanel.jsx       Connect a drive, the schedule, the backups in it, and the
                            two restores (everything, or chosen jobs)
```

**c.** In the Structure block, under `supabase/`, replace the `functions/` paragraph:

```
  functions/                seventeen Edge Functions — the three that send mail
                            (send-report, send-jha, send-ticket-approval), the two
                            that render PDFs (render-invoice, render-jha), the client
                            approval page (approve-ticket), account handling
                            (create-user, delete-user, password-reset), the chat's
                            push and nightly cleanup (chat-push, chat-retention),
                            the automatic backup (backup-oauth, backup-run,
                            backup-restore), gif-search and mail-test; plus
                            `_shared/`, which is library code, not a function
```

and, in the same block, the Worker line:

```
worker/index.js             the Cloudflare Worker: serves the built assets, proxies
                            /approve to the approve-ticket function (Supabase hands
                            that domain's HTML back as text/plain) and
                            /backup/oauth/* to backup-oauth, whose answer is a
                            redirect rather than a page
```

**d.** In the "Two things that need the Edge Functions deployed" section, add a third paragraph:

```markdown
Automatic backup needs `backup-oauth`, `backup-run` and `backup-restore`
deployed, and needs the `backup-tick` pg_cron job — both arrive with their
migration. Until an Admin connects a drive on the Admin screen the tick
finds nothing due and returns, five minutes at a time, costing nothing.
```

- [ ] **Step 3: Add the runbook section to `HANDOVER.md`**

Insert a new section between "The custom domain" and "Wiping the seed data":

```markdown
## Connecting a backup drive

The app can copy itself — every record, every PDF — to one drive account on
a schedule, and restore from it. The drive belongs to the business, not to
the app: nobody at VagaboNDE's software end can read it.

Each provider needs a free app registration under your own account. That is
what lets the app write to your drive without anybody holding your password.
Do the one you intend to use and ignore the other two.

**Before you start**, open the app, sign in as an Admin, go to **Admin →
Automatic backup → App registration**, and copy the redirect URI shown
beneath the provider you have chosen. It reads
`https://<your app address>/backup/oauth/google` (or `/microsoft`, or
`/dropbox`) and it has to be pasted into the registration character for
character. If those boxes show `http://localhost…`, the **App address**
field further up the Admin screen has not been filled in yet — do that
first.

### Google Drive

1. <https://console.cloud.google.com/projectcreate> — make a project.
2. <https://console.cloud.google.com/apis/library/drive.googleapis.com> —
   **Enable** the Google Drive API in that project.
3. <https://console.cloud.google.com/auth/overview> — fill in the OAuth
   consent screen. **External**, your own email as the support and developer
   contact. While the app is in Testing, add the Google account that will
   hold the backups under **Audience → Test users**, or the consent screen
   will refuse it.
4. <https://console.cloud.google.com/apis/credentials> — **Create
   credentials → OAuth client ID → Web application**. Under *Authorised
   redirect URIs* paste `https://<your app address>/backup/oauth/google`.
5. Copy the **Client ID** and **Client secret** into the app's Google boxes,
   press **Save backup settings**, then **Connect Google Drive**.

The app asks for one permission, `drive.file`. That scope only lets it see
files it created itself: it cannot read anything else in your Drive.

### OneDrive

1. <https://entra.microsoft.com> → **Applications → App registrations → New
   registration**.
2. Supported account types: *Accounts in any organizational directory and
   personal Microsoft accounts*.
3. **Redirect URI**: platform **Web**, value
   `https://<your app address>/backup/oauth/microsoft`.
4. After it is created, **Certificates & secrets → New client secret**. Copy
   the *Value* (not the Secret ID) immediately — it is shown once.
5. The **Application (client) ID** is on the Overview page. Put both into the
   app's OneDrive boxes, save, then **Connect OneDrive**.

The app asks for `Files.ReadWrite` and `offline_access` — permission to work
with your files, and permission to keep working without you signing in again.

### Dropbox

1. <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped
   access** → **Full Dropbox** → give it a name.
2. On the app's **Permissions** tab tick `files.content.write`,
   `files.content.read` and `files.metadata.read`, then **Submit**.
3. On the **Settings** tab, under *OAuth 2 → Redirect URIs*, add
   `https://<your app address>/backup/oauth/dropbox`.
4. Copy the **App key** and **App secret** into the app's Dropbox boxes,
   save, then **Connect Dropbox**.

### After it is connected

- Pick how often and at what hour (Grande Prairie time), and how many
  backups to keep. Older ones beyond that count are removed after each
  successful run — except copies taken automatically just before a restore,
  which are kept for ever.
- Press **Back up now** once and watch it through. The first backup is the
  slow one; it can take an hour on a busy database.
- The backup contains the crew's hours and dose readings and every client's
  pricing. It goes only to this drive account. Vendor keys and the drive's
  own credentials are deliberately not in it.
- Only one drive can be connected at a time; connecting a second replaces
  the first, and the backups already in the old drive stay where they are.
- If the panel says the drive **needs reconnecting**, the provider has
  withdrawn the app's access or the client secret has been rotated. Press
  Disconnect, re-check the client secret, and connect again. Backups do not
  run while that message is showing.
```

- [ ] **Step 4: Read them back with fresh eyes**

Run: `npm --prefix vite-app test` (nothing here should change it, but a documented function count that disagrees with `ls supabase/functions` is the kind of thing this catches by eye):

```bash
ls supabase/functions | grep -v _shared | wc -l
```

Expected: `17`, matching the README.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md HANDOVER.md
git commit -F- <<'MSG'
Write down the parts of the backup that the code cannot say for itself

Three of these are rules a reader would otherwise have to reverse-engineer
and might reasonably get wrong: that accounts are restored before records
because profiles.id is a foreign key to auth.users; that the tick drives its
own two kinds before it forwards a restore, because a restore's safety
backup is raised after the restore and would otherwise never start; and that
the shared modules are erasable TypeScript with no imports because the node
suite reads them straight out of supabase/functions.

The handover section is the other half — the three provider consoles, in the
order a person actually clicks them, with the exact page for each step and
the one scope each app asks for. That is the part a new admin cannot guess
and the part nobody wants to work out twice.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
MSG
```

---

## Self-Review

Run after all eight tasks, by the person or agent who wrote the plan — a checklist, not a subagent.

**1. Spec coverage.** Every section of `docs/superpowers/specs/2026-09-04-automatic-backup-design.md` mapped to a task:

| Spec section | Task |
| --- | --- |
| Drive connection (`backup-oauth`), consent scopes, nonce, disconnect, refresh failure → `backup_connection_error` | 3 (scopes, `authorizeUrl`), 4 (the function, the Worker proxy, the panel) |
| Drive client interface, three implementations, one fake | 3 |
| What a backup contains — manifest, `tables/*.json.gz`, `files/*`, stripped secrets | 3 (shapes), 5 (the phases that write them) |
| Retention, `backup_keep`, never the before-restore folders | 3 (`foldersToDelete`), 5 (`stepRetention`) |
| Schedule and run state, `backup_runs`, the five-minute cron, the three tick outcomes, phases, `nextRunAt`, retries, a failed run not blocking the next | 1, 2, 5 |
| Restore everything — gates, safety, wipe, tables, files, accounts, `last_activity_at` write-back, report | 6 |
| Restore selected jobs — the manifest index, skip-if-exists, org matching, ticket-number collisions | 7 |
| Admin screen — provider row, app registration, schedule row, Back up now, last run, next due, backups list, both restores, progress polling | 4, 5, 6, 7 |
| Security — secrets never selected by the client, all three functions check their own caller, the manifest names what a backup holds | 2 (`backup_state`), 3 (`note`), 4, 5, 6 |
| Testing — node suite for `nextRunAt`, manifest, FK order, per-job selection, the fake drive | 1, 3, 5 |
| Migration — columns, `backup_runs` + RLS, cron, `backup_state()`, applied live then filed | 2 |
| Docs | 8 |

**Deviations from the spec, each deliberate and each argued where it appears:**
- Restore phase order is `accounts` before `tables`, not after (`profiles.id → auth.users`). Task 6.
- The backup carries `auth_email` on profiles rows, which the spec did not name; without it there is no address to mail a re-created account. Task 5.
- `issued_ticket_numbers` does not exist; the table is `burned_ticket_numbers`. Task 3.
- Two methods added to the five-verb drive interface (`listFiles`, `rootId`) and drive names are one flat path segment. Task 3.
- `heartbeat_at` on `backup_runs`, and a self-kick between slices, neither in the spec; without them a five-minute cron makes an hour of work take all night and a dead slice wedges the schedule for ever. Tasks 2 and 5.
- A second migration (`backup_schema_version()`), because `supabase_migrations` is not an exposed schema. Task 5.
- `audit_log` and `function_errors` are wiped though never backed up (their FKs to profiles block the delete). Task 3, documented in Task 8.
- The per-job selection tests the spec asks for are covered by the table-list and manifest tests (Task 3) plus the live rehearsal (Task 7 Step 7) rather than by a node test of the function, which would need a fake PostgREST; the drive half is tested against `FakeDrive`.
- The spec's Deno fixture tests for the three providers' upload handshakes are **not** included: `deno` is not installed in this environment (`deno --version` → not found), so a suite nothing can run would be a lie. The three implementations are exercised for real by the deploy-and-prove steps in Tasks 4, 5, 6 and 7.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no test described without its code. One placeholder is intentional and named as such wherever it appears — `<version>`, in the File Structure block and in Tasks 2, 5 and 8 — because a migration's stamp is minted by the applier and cannot be known before `apply_migration` returns. Every use is accompanied by the exact command that produces it (`list_migrations`).

**3. Type consistency.** Checked across tasks:
- `nextRunAt(settings, now)` is called with `{ frequency, weekday, hour }` in Task 4's `backup-oauth`, Task 4's `Db.saveBackupSettings`, Task 5's `tick`, and Task 5's panel — the same shape everywhere.
- `partFileName(table, index)` returns a flat name in Task 3, is written in Task 5's `stepTables`, and is matched by prefix (`${table}.`) in Tasks 6 and 7's `partsFor`.
- `fileEntryName(bucket, key)` / `parseFileEntryName(name)` are a pair: written in Task 5's `stepFiles`, read in Task 6's `stepFilesBack` and Task 7's `stepJobFiles`.
- `connectDrive(db)` returns `{ drive, provider, rootFolderId, account, keep }` in Task 5 and is destructured for `drive`, `rootFolderId` and `keep` in Task 5 and for `drive` in Tasks 6 and 7.
- `backup_state()`'s keys (Task 2) are exactly what the panel reads in Tasks 4-7: `connected`, `provider`, `account`, `connection_error`, `frequency`, `weekday`, `hour`, `keep`, `next_run_at`, `client_id_*`, `has_secret_*`, `approval_base_url`, `last_run`, `active_run`.
- `Db` method names are used identically in `db.js` and `backupPanel.jsx`: `backupState`, `saveBackupSettings`, `backupOauthStartUrl`, `disconnectBackup`, `backupNow`, `listBackups`, `backupManifest`, `currentBackupRun`, `listBackupRuns`, `nudgeBackup`, `restorePreflight`, `restoreAll`, `restoreJobs`.
- `backup_runs.counts` is `{ rows, files, bytes }` for a backup and `{ rows, files, bytes, accounts, accountsFailed }` or `{ rows, files, skipped, collisions }` for a restore; the panel reads each with a `|| []` / `|| 0` guard, so a shape from the other kind cannot throw.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-04-automatic-backup.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.

**2. Inline Execution** — the tasks run in this session with checkpoints. REQUIRED SUB-SKILL: `superpowers:executing-plans`.

Two things the executor must have before starting: **Kyle's word to apply migrations** (given in the approval of this spec, and needed in Tasks 2 and 5 only), and **the three provider app registrations** — Tasks 4 onwards cannot be proved end to end without at least one of them, though every task's tests and build stand on their own.

Which approach?
