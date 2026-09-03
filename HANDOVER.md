# Handing VagaboNDE Field Ops over

The setup document ("Things to do to get set up") is the installation
manual. This is the owner's manual: what the system is made of, how it
changes hands, and what the new owner's admin does on day one.

---

## What the system is made of

| Piece | What it does | Where it lives |
|---|---|---|
| The app | React PWA the crew installs on phones | Built from `vite-app/`, served by the Cloudflare Worker |
| The Worker | Serves the app + renders client approval pages at `/approve` | `worker/index.js`, deployed with `npx wrangler deploy` |
| Database, sign-in, files | Everything the app stores | Supabase project `eielmvxzdwwprmmfamlq` (Postgres + Auth + Storage) |
| Server functions | Email sending, approvals, user provisioning, chat push, nightly cleanup | `supabase/functions/`, deployed with the Supabase CLI |
| Email | Reports and billing approval links | Resend (key entered on the in-app **Admin** screen) |
| Chat GIFs | Team chat's GIF search | KLIPY (key on the **Admin** screen, optional) |

Everything an admin configures day-to-day lives **inside the app**:
drawer → **Admin** (Resend key and addresses, the app's public address for
approval links, the KLIPY key) and **Users & access**, **Rate admin**,
**Contacts**. Only two settings live in the Supabase dashboard because
they guard sign-in itself: the **Site URL** (Authentication → URL
Configuration — where password-reset links land) and **leaked-password
protection** (Authentication → Policies).

## Changing hands — two paths

**Path A — transfer (recommended): keep everything, move the accounts.**
1. The client makes free accounts at supabase.com and cloudflare.com.
2. Supabase: their account creates an organization, and the current owner
   transfers the project into it (Project Settings → General → Transfer
   project). Data, functions, secrets and URLs all move unchanged;
   nothing redeploys, nothing breaks, the app doesn't notice.
3. Cloudflare: the Worker is stateless, so it isn't "moved" — it's just
   deployed again from this repo while logged into their account
   (`npx wrangler login`, then `npm run build && npx wrangler deploy`).
   Their copy gets its own URL; update the **Site URL**, the Admin
   screen's **App address**, and have the crew reinstall the PWA from the
   new address. Doing this at the same time as a custom domain (below)
   means the crew only ever installs once.
4. Run the seed wipe (below) somewhere between transfer and go-live.

**Path B — fresh install: new project, empty history.**
The migration history is built for this — `supabase/migrations/` starts
with a baseline that recreates the whole schema in a fresh project (and
must never run against an existing one). The extra steps beyond the setup
doc: point the app at the new project (copy `vite-app/.env.example` to
`.env` with the new URL and publishable key), generate a fresh push
keypair (`npx web-push generate-vapid-keys` — public key into
`vite-app/src/config.js`, private key + subject into the function
secrets), then `supabase db push`, deploy all functions, set secrets, and
deploy the Worker. Path A avoids all of this.

## The custom domain

Client-facing links currently use the Worker's `workers.dev` address. A
custom domain (say `app.vagabonde.ca`) needs its DNS zone on Cloudflare —
vagabonde.ca is on GoDaddy today, so that's either moving nameservers or
living with workers.dev. **Decide before the crew installs the PWA
widely**: the old URL keeps working alongside a new domain (nothing sent
breaks), but installed PWAs and push subscriptions are bound to their
address — change it later and every device reinstalls and re-allows
notifications. Changing it early costs nothing.

## Wiping the seed data

Every job, ticket, client, contractor, contact and account in the system
today (except blacklabndt@gmail.com) is generated test data. The wipe is
staged, reviewed, and run by hand exactly once:

    supabase/handover/wipe-seed-data.sql

Read its header before running — it says what survives (the owner
account, the house rate card, the schema itself) and what to do about the
storage buckets afterwards. Despite its name it empties everything, not
only the seed rows, so it refuses to run until the session has said so:
`set app.confirm_total_wipe = 'yes';` first, in the same SQL session.
**It also retires the Playwright e2e suite**, which signs in as two of the
seed technicians; keep a pair of test accounts if the suite should outlive
handover.

To remove only the generated rows and keep real records, run
`supabase/handover/wipe-seed-only.sql` instead — it works by the seed
markers (S-1… jobs, @seed.vagabonde.ca accounts, organisations that only
ever appeared on seed jobs) and prints a preview of the organisations it
will remove before the deletes.

## Day one, for the new admin

1. **Admin screen** (drawer → Admin): Resend key, then the two sending
   addresses once the domain verifies; the app's public address; KLIPY
   key if the crew wants GIFs. Send the test email.
2. **Supabase dashboard**, five minutes: Site URL, leaked-password
   protection.
3. **Users & access**: create the crew's accounts — role sets the tabs,
   tabs can be tuned per person afterwards. Tick Subcontractor for anyone
   who invoices rather than draws payroll.
4. **Rate admin**: replace the house card's placeholder prices with real
   ones, per client add their card (or let it follow the house card), and
   **Publish schedule** once per card — after that, edits go live as they
   save. Tickets snapshot their rates when raised, so publishing never
   reprices anything already out.
5. **Contacts**: the real clients, contractors, and the people at each —
   the primary contact is what jobs, report emails and approvals pre-fill.

## When something looks wrong

- **"What version is everyone on?"** — bottom of the drawer, on every
  device: version, build, date. Updates announce themselves with a
  banner (Restart now / Postpone) within half an hour of a deploy.
- **"N queued" in the top bar** — work saved on a device that hasn't
  reached the database yet; it syncs itself when signal returns. **"N
  won't sync"** is different: tap it, read the reason, fix and retry.
- **An email didn't arrive** — Resend's dashboard → Emails shows every
  attempt and why it failed. The app-side reasons land in the
  `function_errors` table (Supabase → Table Editor).
- **An approval link opens as a plain text-looking page** — the Admin
  screen's App address is blank or wrong.
- **Chat push isn't arriving on one device** — notifications are allowed
  per device from Team chat; on shared tablets the next tech's sign-in
  claims the device's subscription automatically.
- **Chat history fades** — by design: unpinned messages expire after 30
  days, swept nightly.

## Support access

Keeping the developer's account (blacklabndt@gmail.com) as an Admin for
the first months means logs, settings and fixes stay one sign-in away.
Remove it any time from Users & access — the RLS rules make every screen
answer to roles, not to hard-coded names.
