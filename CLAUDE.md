# VagaboNDE Field Ops — Beta 1

RT weld-inspection field app for a crew in Grande Prairie, AB. React PWA
(`vite-app/`) over Supabase (project `eielmvxzdwwprmmfamlq`), deployed as
Cloudflare Worker `solitary-snowflake-ee22` (assets + `/approve` proxy in
`worker/index.js`).

## Commands

- Test: `npm --prefix vite-app test` (render-name scan + node --test)
- Build: `npm --prefix vite-app run build`
- Deploy: `npm run build && npx wrangler deploy` (from repo root)
- Dev server: use the `.claude/launch.json` `beta1-dev` config, not Bash

## Rules that are not in the code

- The build must be green **before** the commit, never beside it.
- Migrations: apply live first (timestamps come from the applier), then
  write the matching file under `supabase/migrations/` with that version.
  Repo files and applied migrations must reconcile 1:1. The history starts
  at `20260817040000_beta1_baseline.sql` — the whole schema squashed into
  one file, generated from the live catalogs; the 77 evolutionary
  migrations it replaced live in the prototype archive. Never apply the
  baseline to the live project; it is for fresh environments. A DB fix that
  is written but not yet applied waits in
  `supabase/handover/PENDING-audit-migration.sql` (probes beside it) — it is
  a draft, not history, until it is applied and filed under migrations. It
  currently carries: tab_access()/user_role() reading profiles instead of
  the token claim, Admin-only profiles insert/delete, delete_job returning
  its PDF keys, guard_job_update's null-safe client gate (a null rank read
  as Coordinator), the equipment functions counting Edmonton days rather
  than UTC, public.dose_totals, and a `set local lock_timeout` because
  section 2 takes ACCESS EXCLUSIVE on profiles.
- RLS changes get probed live with `set_config('request.jwt.claims', …)`
  role simulation before they ship. Permissive policies OR together — a
  new `FOR ALL` policy can silently void an older condition.
- Money: integer-cents rounding (`gstOn` in `data.js`); never float-sum.
- Rates come from the Rate admin screen, never hardcoded. Billing is per
  truck, not per technician. PO = AFE. Hotel = subsistence. solo/soloOt
  are timesheet-only and never billed.
- The rate card IS the billing menu: the ticket screen's dropdowns, their
  order, and the invoice's line order all come from the client's published
  schedule (`getPublishedRatesForClient` → catalog). A client whose
  schedule has `follows_default` on prices from the house card, live.
  Publishing matters exactly once per card — after that, edits go live as
  they save — which is why the Publish button hides once pressed.
- A saved ticket can hold lines the card no longer offers. linesToForm
  returns them as `orphans`; the ticket screen lists them read-only under
  "No longer on the rate card" (× to drop one), buildLines writes them back
  verbatim — label, unit and the rate they were filed at — and their cents
  are in the total. Silently dropping them would rewrite somebody's bill.
- Crew hours are private: the ticket_crew read policy is own rows, Admin/
  Coordinator, or crewmates on a shared ticket (private.shares_ticket).
  Never widen it back to a tab check.
- The Timesheets dose ledger sums in the database: `dose_totals(start, end)`
  — SECURITY INVOKER on purpose, narrowed again to own rows or Admin — so a
  year is forty-odd numbers, not 30k crew rows over the wire. It lives in
  the PENDING migration, so until it is applied the screen falls back to
  the old row walk on PGRST202, or on an error whose message names dose_totals and says it
  could not be found, because older gateways only say it in words. Both
  halves of that test matter: no other code falls back, and no message
  falls back unless it names the function, so a permission refusal or a
  timeout still reaches the screen as itself.
- PostgREST silently caps responses at 1,000 rows. Anything that means
  "all of them" pages, and `paging.js` has two shapes: fetchAllPages
  (concurrent, by OFFSET) for the reference lists, where a row deleted
  mid-walk only costs a reappearance next load; fetchAllKeyset
  (sequential, "the next thousand after this id") for anything people are
  paid or billed from, where an OFFSET walk can skip a row silently.
  listTicketsForExport is the exception: search_tickets is an RPC with no
  cursor, so it pages by page_num and keeps that caveat.
- `Db.listJobs` is gone. A job picker is `SearchSelect` over `Db.searchJobs`
  (server-side, paged) — the delete-job transfer target and Rate admin's job
  override are the two. Never read every job to fill a dropdown; the
  archive's `listJobsCreatedBetween` is bounded by its date range.
- The offline queue is for work only — scores, telemetry and other
  nice-to-haves call the API directly and fail soft.
- The device cache has an owner (`cache.owner`, `OfflineCache.claimFor`):
  signing in — and a session restored at boot — empties the store first
  unless this same account already owns it, so a shared tablet never hands
  over the last crew's jobs, rates and half-entered tickets. Boot clears
  outright only on the server's `signedOut`; offline-with-no-identity and a
  merely lapsed session forget the identity and nothing else, so the same
  person's recovery copies survive going out of range or signing back in —
  `cache.owner` and `claimFor` are the gate that keeps a stranger from them,
  not a boot-time wipe. Sign-out clears everything, and
  still asks first when drafts or queued work would go with it.
- auth-js does not remove the stored session when `signOut` fails — offline
  it refreshes an expired token first and returns the failure, leaving the
  session on disk for the next reload to sign straight back in. Every
  sign-out path therefore checks the error and calls `forgetStoredSession()`
  (config.js; `AUTH_STORAGE_KEY` names the key supabase-js derives, so the
  two cannot drift). Keep new ones doing it.
- Tabs are PERMISSION; drawer visibility is code. The contextual screens
  (`CONTEXT_TABS`: job, jha, upload, ticket) never appear in anyone's
  menu — they open from a job's own page, per Kyle. Never "hide" a screen
  by removing its tab from a profile: that revokes RLS/storage access too,
  which is exactly the invisible breakage that rule replaced.
- Client-facing HTML: the invoice body is
  `supabase/functions/_shared/invoice.ts`; the approval page's own chrome
  (`page`, `signForm`, `queryForm`) is approve-ticket's. Both escape every
  interpolated value with `esc()`, which lives in `_shared/mail.ts`. The
  in-app viewer iframe stays sandboxed.
- Accounts are created by the create-user Edge Function (Admin-gated,
  service key, arrives email-confirmed), never by client signUp: the
  signup endpoint answers to anyone with the publishable key, so the
  provisioning trigger caps metadata roles to Technician/Helper and the
  function writes the real rank itself. Never widen the trigger's role
  allowlist back.
- Team chat forgets: unpinned messages expire after 30 days, deleted by
  the chat-retention Edge Function (it also removes their chat-media
  pictures), fired nightly by the pg_cron job `chat-retention-nightly`.
  Message bodies are immutable by column grant — only pin columns are
  updatable, Admin-only. GIF search is KLIPY (Tenor's API is dead);
  the key lives in app_settings (see below), handed out by gif-search.
- App configuration lives in the app_settings table (one enforced row,
  Admin-only RLS), edited from the Admin screen (tab key "mail", label
  "Admin"): Resend key + sending addresses, the approval-link base URL,
  the KLIPY key. Email rides Resend (shared module
  supabase/functions/_shared/mail.ts). The old env secrets
  (RESEND_API_KEY, MAIL_FROM_*, KLIPY_API_KEY, APPROVAL_BASE_URL) are
  FALLBACKS only — a table value wins, so rotating a secret does nothing
  while a table value exists. With a key but no verified sending address
  the transport is in testing mode: every send goes out under Resend's
  onboarding sender, which delivers only to the inbox the Resend account
  was created with — a send to anyone else is refused by Resend and
  mail.ts translates that refusal into a plain message naming the fix.
- Bulk sends go through `sendPool.js`, never a loop — "Chase all unsigned"
  is the caller, with thousands of emails to get out: 3 workers, a floor
  between starts, and a wait-and-retry for the two refusals mail.ts marks as
  transient (429 → "Resend is rate-limiting…", 5xx → "is unavailable…",
  carrying Resend's Retry-After, since only the message crosses the function
  boundary). It has a Stop button, and failures are named by ticket number
  rather than counted.
- Approval tokens are stored hashed (`sha256:` + hex, see
  `_shared/approvalToken.ts` and migration 20260902211209); the raw token
  exists only in the emailed link. The token is NOT single-use — signing
  does not null it, so the link stays the rep's way back to the read-only
  signed page until the 30-day expiry (a resend refuses an Approved
  ticket, so burning it left them with no copy). Re-signing is refused
  three ways over: the already-approved branch returns before the POST
  handler, the sign UPDATE carries `.is("approved_at", null)`, and
  `authenticated` has no grant on the column. Only a resend replaces a
  token, and `withdraw_ticket_approval` nulls one on purpose. Approving is
  the service role's act alone: the tickets UPDATE policy's WITH CHECK
  pins the approval columns, so no signed-in account can set Approved.
  Probe it with role simulation if you touch that policy.
- The role→tabs defaults live in TWO places that must move together:
  ROLE_PRESETS in vite-app/src/data.js and tabs_for_role() in the
  database (create-user provisions from the latter). data.test.mjs reads
  the migration back and fails on drift.
- Chat push: an insert trigger fires the chat-push function via pg_net;
  it sends Web Push (VAPID_* secrets) to push_subscriptions minus the
  sender and prunes endpoints answering 404/410. The handlers live in
  public/push-sw.js, importScripts'd by the generated sw.js. A push
  endpoint belongs to the DEVICE: claim_push_subscription (definer RPC)
  is how the next tech on a shared tablet takes it over.
- Chat extras: chat_reads + the chat_unread_count RPC power the drawer
  badge and the "new messages" line; replies are reply_to (quote goes
  null if the quoted message dies — the reply stands on its own words);
  voice notes are audio_key in chat-media, cleaned up by delete and
  retention like pictures; job numbers in message text linkify by
  MEMBERSHIP against listJobNumbers, never by pattern — they're freeform.

## Verification habits that caught real bugs

- "curl works" ≠ "a browser renders it": Supabase rewrites HTML to
  text/plain on the functions domain; the Worker exists because of this.
- The dev server hands out `?t=` module instances after edits — patching
  `import('/src/db.js')` reaches a different copy than the app holds.
  Spy-count before trusting a negative result.
- The browser pane suspends rAF when hidden: game/animation testing needs
  the preview panel visibly open.
- Verifying a deploy by fetching `/` can HIT Cloudflare's edge cache and
  show the previous index.html (query-string cache-busters don't help).
  Confirm instead that the newly hashed chunk files answer 200.
- Never round-trip a source file through PowerShell 5.1 Get-Content/
  Set-Content: BOM-less UTF-8 reads as ANSI and every em-dash, `·`, `…`
  and emoji ships as mojibake (it cost teamChat.jsx 71 characters once).
  Edit tool or a node script only.
- Never leave a literal control character in source (a `"\u0000"` join
  separator written as the byte itself): git then treats the file as
  binary — no diff, no blame, wholesale merge conflicts — and the review
  that should have read the tracker's changes couldn't. Write the escape
  text; the Write/Edit tools can turn an escape into the byte, so check
  with `grep -P '[\x00-\x08\x0e-\x1f]'` after writing one.

## Live data

The live project carries deliberate load-test seed data alongside Kyle's
real records: jobs `S-1%`, staff accounts `@seed.vagabonde.ca` (id_code
24400+), and generated orgs/contacts/tickets from 2026-08-18. It is all
identifiable by those markers when a cleanup is wanted:
`supabase/handover/wipe-seed-only.sql` removes exactly that, by marker.
`wipe-seed-data.sql` beside it is the handover reset — despite its name it
empties EVERYTHING except the owner account, and refuses to run until the
session has set `app.confirm_total_wipe = 'yes'`.

## Access rules the database enforces (probe with role simulation)

- `is_staff()` means at least one tab. Stripping every tab locks an
  account out of the API, not only the menu. delete-user locks (Auth ban +
  `profiles.deactivated_at` + no tabs) an account with work on file instead
  of deleting it, because the foreign keys keep history's names.
- A role change is an Admin's (`profiles_update` WITH CHECK); the users tab
  alone grants tabs, never rank.
- Signed-in accounts may update only a JHA's close-out columns (column
  grant); the functions write the rest with the service role.
- `jobs_guard_update` trigger: job_number/created_by/created_at are fixed,
  status changes are Admin-only, client changes Admin/Coordinator. There is
  no direct DELETE on jobs — `delete_job` is the only door, and a non-admin
  transfer may target only a job they raised.
- Prices are for Admins and Technicians (per Kyle): rate_lines,
  rate_overrides, rate_line_history and ticket_lines SELECT require the
  role as well as the tab — and so do the WRITES (ticket_lines insert/
  delete, every rate_lines/rate_overrides/rate_schedules write), because a
  role that cannot read a ticket's lines must never replace them (a
  Coordinator's save once read zero lines and deleted the real ones).
  `search_tickets` and `ticket_tracker_stats` hand other roles null money.
  `seesPrices(user)` in data.js is the one client-side answer; Job detail,
  Open tickets and the tracker all ask it. A Coordinator cannot price a
  ticket until the role is added to those policies.
- Money that leaves the building is read with the service role, not taken
  from the caller: send-ticket-approval builds the emailed summary from its
  own `loadInvoice` read, because the database hands a non-price role null
  totals and the browser's figures are whatever that role could see. Same
  reason the tracker's money buttons ("Chase all unsigned") sit behind
  `seesPrices` — one tap would otherwise mail every client a $0.00 approval.
- tickets has a column-level UPDATE grant: signed-in accounts write
  status, client_contact, contractor_contact, delays and chased_at, nothing
  else. The approval plumbing (approval_token/sent_at/expires_at/sent_to/
  sent_by) is the service role's alone — a policy can't pin a column it
  doesn't name, and an unpinned token column let a technician plant a hash
  and sign their own ticket from the link. Withdrawing an approval is the
  `withdraw_ticket_approval(id)` definer RPC. `total` is the trigger's.
- `updateTicket` refuses a Draft write over an Awaiting-approval ticket
  (plainError, flagged `sentForApproval`). "Draft" is the word every save
  sends — the editor hardcodes it and a queued replay carries it hours
  later — so letting it through replaces the lines and moves the money under
  a live approval link. A live save shows the refusal and stops. A queued
  replay saves what it still can and then parks: App.jsx catches the flag,
  writes the crew hours (they stay writable until the client signs, and they
  are the day's pay), skips the approval resend so the rep's token is not
  reset mid-signature, raises the forced toast once (checkpoint
  `refusalTold`), and re-throws the refusal so the item stays in the outbox
  with it as `lastError` — badge lit, the queue panel saying the hours are on
  the ticket and only the welds and charges were not. Retrying is safe (a
  refused update and a crew delete-then-insert, the same refusal again);
  discarding is how it ends. The one exception is this item's own send:
  `checkpoint({ sendAttempted: true })` is written before sendTicketApproval,
  so a refusal met with `sendAttempted` set is the row this same item moved
  to Awaiting approval — its lines are already there, and the replay
  completes quietly. `withdraw_ticket_approval` is the only way to re-price
  the ticket.
- Invoicing is `mark_tickets_invoiced(ids, invoiced)` (Admin, definer) —
  Approved ↔ Invoiced with `invoiced_at`; the approved-ticket immutability
  policies are untouched and this RPC is the only door.
- Idempotent saves: tickets.client_key / reports.client_key /
  jhas.client_key (unique). The ticket editor and the JHA builder mint a
  key per unsaved record (kept in the recovery copy and the outbox
  payload); createTicket/uploadReport/createJha return the existing row
  for a repeated key instead of inserting again — and a failed key lookup
  is the save's failure, never a green light. The queue's ticket replay
  passes the key too (it once didn't, on the one path that mattered).
- contacts, equipment, timesheet_approvals and arcade_scores reads need
  `is_staff()` too, so a locked account's unexpired token reads nothing.
- A client rep's "Query this ticket" (approval page) writes tickets.
  queried_at/query_text/query_by with the service role; the tracker shows
  it; send-ticket-approval clears it on resend. The rep's words always land:
  the write is unconditional bar `approved_at`, because a filter on
  `queried_at` once dropped a second — different — query inside the window
  while the page still told the rep it had been sent. Only the EMAIL is
  throttled, one per ticket per 15 minutes, off the `queried_at` that came
  back with THIS request's read, so two racing posts may each mail once:
  two mails carrying two real queries is the harmless side of that trade, a
  lost query was not. The page gives the same receipt either way, because
  the link is the whole credential and it gets forwarded.
  jobs.last_activity_at is kept by definer triggers on tickets/jhas/reports
  (private.touch_job_activity) and orders the board (search_jobs).
  search_tickets also returns filtered_total (null for non-price roles).
- Accounts: create-user with `invite: true` mints a password nobody knows
  and mails Auth's recovery link through Resend (_shared/setPassword.ts);
  password-reset (Admin-gated) mails the same link to an existing account.
  Both land on the app's own set-password screen. The link's redirect is
  the approval base URL's origin, else the Auth Site URL.
- Archive (the Admin screen's dropdown, deliberately not Home): every job
  raised in a year or date range, zipped in the browser
  (vite-app/src/archive.js), filed client → month raised → job, each job
  folder holding Job details.txt, JHAs/, Reports/, Invoices/ (HTML), plus
  Index.csv and README.txt at the top. The build keeps a manifest (name,
  size, CRC per entry); the dialog then makes the Admin pick the downloaded
  zip and verifyZip reads its central directory back against the manifest.
  Only a zip that checks out, from a build with nothing unretrieved,
  unlocks the clear — behind a typed CLEAR — which is
  `archive_clear_jobs(ids)` (Admin, definer): it deletes those jobs and
  everything under them, approved tickets included (delete_job refuses
  them), and the client removes the PDFs from the two buckets. Jobs are
  chosen by created_at on local days. It is the one bulk delete in the app;
  keep every one of those gates. The screen threads `onArchiveCleared`
  through to the dialog, so a clear also makes App let go of the job and
  ticket it was holding open and reload the drafts badge — the cleared job
  may be the one the drawer was pointing at.
- The clear re-checks before it deletes: immediately before
  `archive_clear_jobs`, inside `liveOnly`, every job's ticket/JHA/report
  counts are read again and compared with the build's (`archiveDrift`). Any
  drift — or a read that failed — refuses, because the build and the button
  can be hours apart and checking the zip cannot see work filed since.
- The build batches its per-ticket reads (`listTicketsForArchive`,
  `listCrewForTickets`, one call each per job) and renders the field
  invoices at concurrency 4 through `mapLimit` — each is an Edge Function
  call. A busy year is still thousands of files and can run to an hour;
  keep that expectation in the dialog's wording.
- The archive build reads inside `OfflineCache.liveOnly(fn)`: a remembered
  copy must never stand in for the server's answer when the clear behind it
  is a real delete. Inside it readThrough rethrows instead of falling back,
  and the failed read becomes a missing entry, which blocks the clear. The
  flag is module-wide and depth-counted, so nothing else may read from the
  cache while a build runs — keep the build's reads inside it.
- `authenticated` has USAGE on schema `private` (migration 20260903055300).
  A policy expression is stored resolved and never needed it; a SQL or
  plpgsql function that runs as the caller and names `private.user_role()`
  is parsed at call time and did — the tracker's stats and search failed
  for every account for three minutes after round three's migration until
  the live probe caught it. Probe every new invoker function as a
  non-owner before calling it done.
- Job detail's Create ticket dialog inserts nothing: it hands a seed (work
  date, this ticket's reps) to the editor, which saves — and queues — like
  a ticket started from Home.
- The new-work buttons carry the same gates as the screens behind them:
  Home's "+ Ticket" wants the ticket tab and `seesPrices`, exactly as Job
  detail's does, and "+ New JHA" waits on the job record the way Create
  ticket and Edit do — a JHA raised before the reps have been read is a form
  filled in with the client's usual contacts rather than this job's.

## People

Kyle Keith (blacklabndt@gmail.com) is the admin and owner. Technicians and
helpers see their own hours only; approval is Admin-role-gated in RLS, not
just in the UI.
