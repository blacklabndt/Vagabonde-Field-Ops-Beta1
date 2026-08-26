# VagaboNDE Field Ops — Beta 1

The field operations app for VagaboNDE Full Service NDE, Grande Prairie:
jobs, JHAs, report uploads, billing tickets rendered as the client-facing
field invoice, timesheets with approval PDFs, equipment, rates, and an
offline-first field path — a React PWA over Supabase, deployed on a
Cloudflare Worker.

This folder is the Beta 1 cut: the same code that has been running live,
promoted to its own standalone repository. Nothing was rewritten for the
promotion — the source had already been through five lead-developer review
passes, and its correctness lives in details a rewrite would only re-risk.
What changed is the packaging: the Worker and its `wrangler.jsonc` moved
inside the project (they sat above it in the prototype workspace), the repo
root is the project root, and the version is stamped `1.0.0-beta.1`.

Screens: the nine from the original design handoff — dialogs, ticket
numbering, rate calculation, light/dark theme — plus six that grew out of
running it: Files, Contacts, Equipment, Timesheets, Open tickets, and the
admin billing tracker. And two easter eggs nobody should document further.

## Run it

```
cd vite-app
npm install
cp .env.example .env      # already has the public URL + publishable key
npm run dev
```

Opens at `http://localhost:5173`. `npm run build` produces `dist/`, a folder
of hashed, minified static files to host anywhere (Netlify, Vercel,
Cloudflare Pages) — React, ReactDOM and Supabase-js are bundled in, so there
is no CDN dependency at runtime.

## Deploying

Cloudflare Workers Builds runs `npm run build` from the repository root —
the root `package.json` reaches down into `vite-app`, because Workers Builds
has no root-directory setting the way Pages does. In Beta 1 the repo root is
the project root, so the reach-down is one level. `wrangler.jsonc` names the
output directory (`vite-app/dist`), routes `/approve` and `/approve-ticket`
through `worker/index.js` before the asset server, and sets
`not_found_handling` so a hard refresh on any path serves the app rather
than a 404. A manual deploy is:

```
npm run build
npx wrangler deploy
```

`wrangler.jsonc`'s `name` has to match the existing Worker. Change it and the
next deploy quietly creates a second Worker on a new URL, leaving the old
address serving whatever was last published to it.

There's no seeded login — see "You need to create the sign-in accounts" below
before the sign-in screen will accept anything.

## Backend: Supabase project `nde-field-ops`

A real Supabase project is provisioned and wired in (region `ca-central-1`,
free tier — see `VITE_SUPABASE_URL` / publishable key in `.env.example`, both
safe to be public). What's live there:

- **Full schema** for every table in the handoff's Suggested Data Model —
  `profiles`, `clients`, `contractors`, `contacts`, `jobs`, `jhas`,
  `reports`, `tickets`, `ticket_lines`, `ticket_crew`, `timesheet_approvals`,
  `equipment`, `rate_schedules`, `rate_lines`, `rate_line_history`,
  `rate_overrides`, `function_errors`, `audit_log`.
- **Row-level security on every table**, enforced in Postgres — not just
  hidden in the UI, per the handoff's own warning. Access is keyed off a
  `has_tab()` check against each signed-in user's `tab_access[]`. Tickets
  and rate overrides also lock at the database level once a ticket is
  client-approved (the handoff's "billing immutability" rule).
  > That last guarantee was briefly untrue and is worth understanding before
  > adding a policy. Permissive policies **OR** together, so a later
  > `FOR ALL` policy added to relax *tab* gating silently ORed away the
  > `approved_at is null` condition that made approved tickets immutable —
  > the app still refused to edit them, but the database no longer did. The
  > repair — one policy per command, each carrying its own conditions — is
  > baked into the baseline migration this repo starts from. When widening
  > access to a table, add a policy for the command you mean, never
  > `FOR ALL`.

#### Who owns what

Tab access answers "which screens", not "whose record". Three places now ask
the second question as well:

- **Tickets** are readable by everyone — crews are meant to see each other's —
  but writable only by the technician who raised one, plus Admins and
  Coordinators, who finish other people's drafts from the billing tracker.
- **Contacts** can be added and corrected by any staff account, because
  creating a job files its rep into the directory. Deleting one is an Admin's.
- **Certification numbers** (`id_code` — CEDO/CGSB) stay on the profile row and
  readable by any staff account, because the JHA prefills both nuclear energy
  workers from them and the printed form has a column for each. Only admins can
  change one: `profiles_update` requires the `users` tab, so a technician
  cannot alter anyone's certification record, including their own.
  > This field was briefly moved into a private table on the strength of its
  > own placeholder text, which said "NRCAN # or driver's licence #". It holds
  > a professional credential, not personal identification, and hiding it left
  > the helper's column blank on a regulatory document. The placeholder now
  > says what the field is for.

`profiles` itself stays readable by every signed-in account, and that is
deliberate rather than an oversight: PostgREST embeds `profiles(name)` into
tickets, JHAs, equipment, crew rows, timesheets and rate history, and the crew
pickers list every technician. Restricting the row blanks names across the app
and empties every crew dropdown. If it ever has to be locked down, the work is
a name-only view or an RPC for the pickers plus denormalised names on the six
join sites — not a policy change.

#### Writing a policy

Four rules, all learned the hard way, all costing more than they look:

0. **Replace a policy, never layer on top of one.** Permissive policies OR
   together, so the loosest one on a command decides — a new, careful policy
   sitting beside an old, broad one changes nothing at all. The storage
   buckets carried two generations of policy for months: `jhas_bucket_read`
   checked for the jha or job tab, while a first-generation `jhas read` said
   only `bucket_id = 'jhas'` and ORed that check away. Every signed-in
   account could list and download every JHA — crew names, signatures, cert
   numbers — whatever their tabs. `20260815202002` dropped the old set.
   When you add a policy, go and look at what is already on that command.

1. **Never `FOR ALL`.** The same trap by another route: a `FOR ALL` policy
   takes part in every command including `SELECT` — it quietly sets the floor
   for the whole table. This is not hypothetical here: a `FOR ALL` policy added
   to relax tab gating ORed away the `approved_at is null` condition that made
   approved tickets immutable. `20260814010000` fixed that table;
   `20260815191345` split the last six, one of which had let anyone with the
   timesheets tab rewrite crew hours on an already-approved ticket. Write a
   policy per command, even when the expression is identical.

2. **Wrap the helper in a subquery**: `(select private.has_any_tab('a','b'))`,
   never a bare `private.has_any_tab('a','b')`. A bare call becomes a per-row
   `Filter`; the subquery form becomes an `InitPlan` evaluated once per
   statement. The policies used to read `profiles` three times *per row* —
   which is why it was the busiest table in the database by tenfold — and
   fixing that took one `rate_lines` count from 4.9 ms to 1.6 ms on 152 rows,
   with the gap growing linearly. Same reason Supabase says to write
   `(select auth.uid())`.
3. **Ask once for several tabs**: `has_any_tab('a','b','c')` (one array
   overlap) rather than `has_tab('a') or has_tab('b') or has_tab('c')` (three
   separate lookups).

`private.tab_access()` is the single source: it reads the tab list from the
JWT when the access-token hook has put it there, and falls back to querying
`profiles` when it hasn't. That fallback is what makes the hook optional and
safe to toggle — see "Turning on the token hook" below.
- **Storage buckets** `reports`, `jhas` and `shared`, all private,
  readable/writable only through the same tab-based policies. PDFs get
  signed URLs, never public ones.
- **A trigger that provisions a profile automatically** when a new Supabase
  Auth user is created, seeding `tab_access` from `public.tabs_for_role()` —
  the database-side twin of `ROLE_PRESETS` in `data.js`. Keep the two in
  step: they drifted once, and a new Admin came out unable to write
  equipment because the preset had never granted them that tab.
- **Seed reference data**: the five clients, three contractors, their
  contacts, the seven sample jobs, and a published rate schedule per client
  (RT film/CR/DR × 5 size bands, the other test methods, time & expense).

> **On the migration history.** `supabase/migrations/` starts at
> `20260817040000_beta1_baseline.sql` — the whole schema as it stood at the
> Beta 1 cut, squashed into one file generated from the live catalogs. The
> 77 evolutionary migrations that built up to it stayed with the prototype
> archive and are deliberately not in this repository. Everything after the
> baseline is applied history: each file has already run against the live
> project, and the folder reconciles 1:1 with the project's migrations
> table. Two cautions follow: never apply the baseline to the live project
> (it is for fresh environments only), and treat a from-scratch rebuild as
> untested rather than guaranteed — the baseline has never been replayed
> against an empty project.

Every screen reads and writes Supabase. What's left is filling in real
behaviour behind a couple of buttons (see "Known gaps"), not wiring more
tables.

| Screen | What it does |
| --- | --- |
| Sign in | Real Supabase Auth (`signInWithPassword`); the session persists across reloads |
| Home / dispatch board | Paged, server-side job search (`search_jobs`) with a status filter and a per-column search |
| Job detail | JHAs, reports and tickets for the open job, each card reloading only itself after a mutation |
| JHA builder (mobile) | The FLHA as the crew fills it: site info, rated hazards, equipment record, both nuclear energy workers and their dosimetry. Files a real `jhas` row and renders a PDF. Carries an editable **date of the assessment**, so one missed on site can be written up afterwards for the day it actually covers. Hazard ratings start from what this person last gave each hazard, read back out of their own filed assessments — no preferences table to drift from what was actually filed |
| JHA close-out | End readings off each DRD at the end of the day; the dose is computed here, not trusted from the screen, and the PDF is redrawn |
| Report upload (mobile + dialog) | The PDF uploads to the private `reports` bucket, plus a `reports` row; emailing it is a separate, recoverable step |
| Billing ticket (mobile) | Prices every weld and charge line against the client's *published* rate schedule, and records the crew's hours, solo hours and dose |
| Open tickets | A technician's own unbilled tickets — drafts to finish, signatures to chase |
| Billing tracker | Every ticket across every job, paged server-side, with the four totals as one RPC rather than a full table scan in the browser |
| Rate admin | Rate lines write straight to `rate_lines` (debounced); "Fill from default" copies the house card into any rate still at zero; rate history is logged by a trigger |
| Files | A private `shared` bucket browsed directly; folders are path prefixes, not a table, so the listing can't drift from what's stored |
| Contacts | The directory of people at each client and contractor, one primary each — what every other screen pre-fills a rep from |
| Equipment | Exposure devices, survey meters, dosimeters and tools with calibration dates; the JHA pre-fills each worker's kit from what's assigned here |
| Timesheets | Hours, solo hours, dose and mileage per person per pay period, derived from ticket crew rows; admin approves a period, and "Export to Excel" builds a two-sheet workbook |
| Users & access | Accounts, tab permissions, role presets, and a panel of recent background errors from the Edge Functions |

### Offline

The app is a PWA: a service worker precaches the whole shell, including the
lazily-loaded office screens, so it starts with no connection at all and can
be installed to a phone's home screen.

Loading is only half of it — an app that opens to an empty jobs table is no
more use on a lease than one that doesn't open. `offlineCache.js` keeps the
last good copy of what the field path reads, in IndexedDB: the ten most recent
jobs, each of those jobs, the record and history of any job that has been
opened, the client's published rates, profiles, contacts, clients,
contractors and equipment. Every read still goes to Supabase first and only
falls back on a genuine connectivity failure — a permission error or a bad
request is a real answer and surfaces as one. Anything served from the cache
puts an **Offline** tag in the top bar and, on the board, a line saying what
was saved and when, because data that quietly looks live is worse than no
data. Writes are never cached; they queue (below). Signing out clears it, so
a shared tablet doesn't hand the next person the last crew's work.

Starting up with no signal is its own problem, handled in `session.js`.
Restoring a session touches the network twice — refreshing the access token
and reading the profile — and neither call was bounded, so with the radio off
the app sat on "Loading…" indefinitely. Worse, supabase-js reports a failed
request as `{ data: null, error }` rather than throwing, which made a network
failure indistinguishable from "this account has no profile" — the one case
the code answered by signing the user out. Going out of range logged people
out. Both steps are now bounded, a failed request is never read as an answer,
and the last signed-in identity is kept on the device so the app opens signed
in. `npm test` covers those paths, including promises that never settle.

The board doesn't just cache the ten jobs, it caches what's *on* them: after
the board loads, three batched queries pull every JHA, report and ticket for
all ten and file them per job, so any of them opens offline with its history
intact rather than three empty cards. Batched rather than per-job — thirty
requests to fill a cache would be a poor trade — and throttled to at most
once a minute, since the board refetches on every filter tap.

One thing still needs a connection the first time: a client's rate card is
cached when their ticket screen is first opened, so a client never billed
from this device can't have a ticket built offline. The screen says so rather
than failing blankly.

Jobs can be started on site. A job created with no signal mints its own uuid
on the device rather than waiting for Postgres to assign one — that is the
whole trick, because the JHA filed ten minutes later and the ticket raised
that evening both need a real `job_id` to point at, and letting the database
choose it at sync time would mean rewriting every queued item that referenced
the temporary one. The job appears on the board and opens immediately, and
the queue replays it ahead of anything raised against it. The one thing that
can't be settled in a truck is the job number: it is `UNIQUE` and nothing on
the device knows what the office has issued, so it is typed rather than
suggested, and a collision surfaces in the queue panel as a refusal to sync.

The three field screens (JHA builder, report upload, billing ticket) keep
working with no signal. A save that fails on connectivity — and only on
connectivity; a completed job or a missing rate schedule still surfaces
immediately — is written to IndexedDB with its attachments and replays
automatically when the browser comes back online.

The top bar shows what is still waiting, and distinguishes two states that
used to look identical: *queued* (waiting for signal, will go on its own) and
*won't sync* (the database refused it — a job completed while the crew was
out of range, say). Tapping either opens the reason, a retry, and the option
to discard an item that is never going to land. Ticket numbers are minted by
the database at save time rather than in the browser, so a ticket built
offline at 07:00 can't collide with one raised while it was waiting.

### Two things that need real accounts to work fully

- **Creating a user** (Users & access → "+ New user") calls
  `supabase.auth.signUp()` on a throwaway client instance, which creates a
  *real* Supabase Auth account — not just a `profiles` row — and the
  `on_auth_user_created` trigger provisions their profile from the role you
  picked. If this project has "Confirm email" turned on (the Supabase
  default), that new person has to click the confirmation email before
  they can sign in.
- **Removing a user** goes through the `delete-user` Edge Function, which
  holds the service-role key and deletes the profile row *and* the auth
  account behind it. Deploy that function or the button reports an error —
  nothing in a client app should ever hold that key.

### Turning on the token hook

`public.custom_access_token_hook` puts each account's `tab_access` and role
into their JWT, so RLS reads them from the token instead of querying
`profiles` at all. The function, its grants and the auth-admin read policy are
already deployed; the hook itself still needs enabling once, in
**Authentication → Hooks → Customize Access Token (JWT) Claims**, pointed at
`public.custom_access_token_hook`.

It is deliberately optional. `private.tab_access()` falls back to the table
whenever the claim is absent, so nothing breaks before it is enabled, and
sessions holding tokens minted beforehand keep working until they refresh.
Turning it off again is equally safe.

`config.toml` carries the setting under `[auth.hook.custom_access_token]`, but
**do not run `supabase config push` to apply it** — that file was generated by
`supabase init` with local defaults and would overwrite the project's live
auth settings (site URL, redirect URLs, email confirmation, JWT expiry) with
them. Either use the dashboard, or reconcile the whole file against the live
project first.

The trade this buys performance with: a permissions change now takes effect on
the user's next token refresh (default one hour) rather than their next
request. Removing a profile is still immediate, because sign-in checks for one.

### One low-priority item left as-is

**Leaked-password protection** is off by default on a new project — a
one-click toggle in Authentication → Policies, not something a migration can
set. Worth turning on before this goes further than a demo.

### You need to create the sign-in accounts

Seeding `auth.users` by hand with raw SQL is unreliable on a hosted project
(Supabase's own docs warn against it — the auth service owns that table). So,
in the [Supabase dashboard](https://supabase.com/dashboard/project/eielmvxzdwwprmmfamlq/auth/users):

1. **Authentication → Users → Add user**, for each person.
2. Check **Auto Confirm User** (so they can sign in immediately, no email step).
3. Under **User Metadata**, add JSON like:
   ```json
   { "name": "R. Vandenberg", "role": "Admin", "cert": "Lvl III · CGSB 48.9712" }
   ```
   `role` must be exactly `Admin`, `Coordinator`, `Technician` or `Helper` —
   the trigger uses it to set their tab access.

Or use the app's own **Users & access → + New user**, once one admin exists.

## Structure

```
vite-app/
  index.html                shell; the design system's CSS is linked from public/
  vite.config.js            React plugin, the PWA/service worker config, vendor chunk
  .env.example              VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
  public/_ds/industry-.../  the Industry design system (unmodified)
  public/icons/             app icons (192, 512, 512-maskable, 180 apple-touch)
  public/brand/wordmark.svg the logo, masked by .topbar-brand so it takes the theme colour
  src/
    main.jsx                ReactDOM mount, wrapped in the error boundary
    App.jsx                 auth, nav drawer, theme, screen switch, offline-queue replay
    app.css                 page layout, top bar, phone frame, tables etc.
    config.js               Supabase client (public URL + publishable key)
    data.js                 shared constants + pure helpers (money, dates, ticket #s, rate lines)
    db.js                   the whole data-access layer over Supabase — every screen goes through it
    offlineQueue.js         IndexedDB queue + auto-replay for the three field screens
    offlineCache.js         IndexedDB read-through cache — the jobs board and the
                            field path, kept usable with no signal
    session.js              sign-in restore: whose session it is, and what to do when
                            the network can't answer (unit-tested, no React)
    session.test.mjs        `npm test` — node --test, no browser needed
    components/
      common.jsx            Blueprint frame, Btn, TagX, Field, Dialog, Switch, ErrorBoundary…
      auth.jsx              Sign in
      home.jsx              Dispatch board + New job dialog
      jobDetail.jsx         Job detail (JHA/reports/billing cards, job record)
                            + Upload report / Create ticket / JHA close-out dialogs
      jhaMobile.jsx         JHA builder (phone)
      uploadMobile.jsx      Report upload (phone)
      ticketMobile.jsx      Billing ticket (phone) — typed weld/charge quantities, crew & dose
      openTickets.jsx       A technician's own unbilled tickets
      files.jsx             Shared files browser over the `shared` bucket
      contacts.jsx          Client/contractor directory, primary contact per org
      equipment.jsx         Equipment register + calibration due dates
      timesheets.jsx        Hours per person per pay period, + Excel export
      rateAdmin.jsx         Rate schedules, rate history + job-level overrides
      billingTracker.jsx    Unsigned-money tracker
      usersAccess.jsx       Accounts, tab permissions, background-error log
      queuePanel.jsx        The offline-queue badge and its what's-waiting panel
supabase/
  migrations/               schema, applied in filename order
  functions/                Edge Functions (report + ticket-approval email, JHA PDF render, user deletion)
  *.sql                     one-off operator runbooks, each idempotent — paste into the SQL editor
_ds/industry-.../styles.css the design system as handed off; the copy under
                            vite-app/public is what the app actually serves
```

The office-facing screens (Files, Contacts, Equipment, Timesheets, Rate
admin, Billing tracker, Users & access) are `React.lazy` chunks — a
technician who never opens Rate admin doesn't download it.

## Known gaps against the handoff (flagged, not hidden)

- Weld-level detail from radiographic reports (`W-041 → 044` style ranges)
  isn't cross-linked into the billing ticket's per-weld tally yet — the
  ticket screen bills by size/method quantity, as specced, but doesn't yet
  pull those quantities from uploaded report data.
- "Flag as chased" next to each ticket in the billing tracker is deliberately
  view-local bookkeeping: it sends nothing, and it doesn't survive a reload.
  "Chase all unsigned" beside it does really re-send.
- The mobile JHA builder collects no signature. The account filing the
  assessment is the record of who filed it, which is why the screen says so
  rather than drawing a signature box that means less than it looks like.
  It carries two dates for the same reason: `work_date` is the day the
  assessment covers and is editable, so a JHA missed on site can be written up
  later for the right day; `signed_at` is when the record was actually
  created and is not. The PDF prints them as **Date** and **Filed**. Back-
  dating the document is a real need; back-dating the claim about when it was
  written up would not be.
- The Excel export lazy-loads SheetJS from a CDN on first use — a 900 KB
  library behind one button, left as a runtime script tag rather than bundled
  into every page load. It is the app's only runtime CDN dependency, and the
  one thing in the app that does not work offline.
- Every signed-in account can read every row of `profiles`, including the
  `id_code` certification number. That is deliberate — the JHA prefills both
  workers from it and the printed form has a column for each — and only admins
  can change one. See the access-control notes above; narrowing the read
  further wants either column privileges or a view the crew pickers read from
  instead.
