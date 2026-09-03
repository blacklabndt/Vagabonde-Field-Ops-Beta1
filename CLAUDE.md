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
  baseline to the live project; it is for fresh environments.
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
- Crew hours are private: the ticket_crew read policy is own rows, Admin/
  Coordinator, or crewmates on a shared ticket (private.shares_ticket).
  Never widen it back to a tab check.
- PostgREST silently caps responses at 1,000 rows. Anything that means
  "all of them" goes through fetchAllPages (the reference lists and the
  exports already do).
- The offline queue is for work only — scores, telemetry and other
  nice-to-haves call the API directly and fail soft.
- Tabs are PERMISSION; drawer visibility is code. The contextual screens
  (`CONTEXT_TABS`: job, jha, upload, ticket) never appear in anyone's
  menu — they open from a job's own page, per Kyle. Never "hide" a screen
  by removing its tab from a profile: that revokes RLS/storage access too,
  which is exactly the invisible breakage that rule replaced.
- Client-facing HTML is rendered by `supabase/functions/_shared/invoice.ts`
  and escaped with `esc()`; the in-app viewer iframe stays sandboxed.
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
- Approval tokens are stored hashed (`sha256:` + hex, see
  `_shared/approvalToken.ts` and migration 20260902211209); the raw token
  exists only in the emailed link. Approving is the service role's act
  alone: the tickets UPDATE policy's WITH CHECK pins the approval columns,
  so no signed-in account can set Approved. Probe it with role simulation
  if you touch that policy.
  The role→tabs defaults live in TWO places that must move together:
  ROLE_PRESETS in vite-app/src/data.js and tabs_for_role() in the
  database (create-user provisions from the latter).
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
  role as well as the tab. Job detail hides amounts and the invoice view
  from everyone else. A Coordinator cannot price a ticket until the role is
  added to those four policies.
- Invoicing is `mark_tickets_invoiced(ids, invoiced)` (Admin, definer) —
  Approved ↔ Invoiced with `invoiced_at`; the approved-ticket immutability
  policies are untouched and this RPC is the only door.
- Idempotent saves: tickets.client_key / reports.client_key (unique). The
  ticket editor mints a key per unsaved ticket (kept in its recovery copy
  and the outbox payload); createTicket/uploadReport return the existing
  row for a repeated key instead of inserting again.
- Job detail's Create ticket dialog inserts nothing: it hands a seed (work
  date, this ticket's reps) to the editor, which saves — and queues — like
  a ticket started from Home.

## People

Kyle Keith (blacklabndt@gmail.com) is the admin and owner. Technicians and
helpers see their own hours only; approval is Admin-role-gated in RLS, not
just in the UI.
