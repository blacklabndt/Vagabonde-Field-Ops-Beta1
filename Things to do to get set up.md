# Things to do to get set up

Everything here is work that has to happen in someone else's dashboard —
Postmark, your DNS provider, Supabase — because it needs credentials or
domain ownership that code can't grant itself. Work top to bottom; each
section says what breaks if you skip it.

Times are rough. The whole list is about an hour of clicking, plus waiting
on DNS and on Postmark's account review.

---

## 1. Postmark account and sending domain  (~15 min + waiting)

Postmark sends the report emails and the billing approval links.

1. Create an account at https://postmarkapp.com — the free tier is 100
   emails/month, which is fine for testing. A paid plan starts at $15/month
   for 10,000, which is far more than this operation will send.
2. Create a **Server** (Postmark's word for a project). Call it
   `VagaboNDE Field Ops`. It gives you a **Server API Token** — copy it, you
   need it in step 3.
3. Go to **Sender Signatures → Add Domain** and enter `vagabonde.ca`.
4. Postmark shows you **DKIM** and **Return-Path** DNS records. Add them at
   whoever hosts your DNS (GoDaddy, Cloudflare, your web host). Also add an
   **SPF** record if you don't have one:
   ```
   v=spf1 include:spf.mtasv.net ~all
   ```
   If you already have an SPF record, add `include:spf.mtasv.net` to the
   existing one — **do not create a second SPF record**, that breaks both.
5. Wait for DNS to propagate (usually minutes, up to 24 h), then click
   **Verify** in Postmark.
6. Ask Postmark to **approve your account for production sending**. New
   accounts are sandboxed to your own verified addresses until you do. There
   is a short form; they usually reply within a business day.

**Skip this and:** emails either don't send at all, or land in your
contractors' spam folders. This is the step that decides whether the
whole feature is trusted.

### Decide your two sending addresses

Write these down, you need them in step 3:

- Reports come from `reports@vagabonde.ca`
- Billing comes from `billing@vagabonde.ca`

They don't need to be real mailboxes, but a **reply-to** that *is* a real
mailbox is worth setting so a contractor can just hit reply.

---

## 2. Supabase CLI on your computer  (~10 min)

The email functions run on Supabase's servers, not in the browser, because
they hold the Postmark token. Deploying them needs the CLI.

1. Install it: https://supabase.com/docs/guides/cli — on Mac
   `brew install supabase/tap/supabase`; on Windows use the Scoop or npm
   instructions on that page.
2. Sign in: `supabase login` (opens a browser).
3. In a terminal, `cd` into this project folder and link it to the Supabase
   project:
   ```
   supabase link --project-ref eielmvxzdwwprmmfamlq
   ```

**Skip this and:** there's no way to deploy the functions. Everything else
still works; email just stays a button that does nothing.

---

## 3. Store the secrets  (~2 min)

These live on Supabase's servers and are never sent to the browser. Run each
line, substituting your own values:

```
supabase secrets set POSTMARK_TOKEN=your-server-api-token
supabase secrets set MAIL_FROM_REPORTS=reports@vagabonde.ca
supabase secrets set MAIL_FROM_BILLING=billing@vagabonde.ca
supabase secrets set MAIL_REPLY_TO=office@vagabonde.ca
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions
automatically — you don't set those.

**Never put the Postmark token in `vite-app/src/config.js` or in a `VITE_`
environment variable.** Anything in either is
visible to anyone who opens the app. The Supabase URL and anon key in there
are fine — they're designed to be public and are backstopped by row-level
security. A Postmark token is not.

---

## 4. Deploy the database change and the functions  (~3 min)

From the project folder:

```
supabase db push

supabase functions deploy send-report
supabase functions deploy send-ticket-approval
supabase functions deploy render-jha
supabase functions deploy delete-user
supabase functions deploy approve-ticket --no-verify-jwt
```

`render-jha` draws the FLHA as a PDF into the private `jhas` bucket, and
`delete-user` is what makes **Remove account** delete the real Supabase Auth
user rather than only its profile row. Both are called from the app, so
skipping them leaves those two buttons reporting an error.

`db push` adds the approval-token columns to the tickets table, creates the
private `shared` storage bucket behind the **Files** tab (plus its access
policies), adds crew, dose and timesheet tables behind the **Timesheets**
tab, and turns the one-rep-per-company contact cache into the **Contacts**
directory — many people per client or contractor, one of them flagged
primary. It also backfills: existing accounts get first/last name fields split
out of their display name, every existing ticket gets a crew row for its
raiser carrying the hours already billed on it, the rep already on file for
each company becomes that company's primary contact, and every existing
account is granted the Contacts tab — so timesheets and the directory aren't
empty on day one.

**After running it**, open **Users & access** and check each person's **first
and last name**. The backfill can only split what was there, so an account
stored as "D. Kowalchuk" comes through with "D." as the first name — an
initial isn't a name, and guessing at "Dale" would be worse than leaving it
for you. Tick **Subcontractor** for anyone who invoices you rather than being
on payroll; their timesheet then carries a mileage column.

That **`--no-verify-jwt` on the last one is not optional**. The approval page
is opened by a client rep who has no account — the token in their link is the
credential. Without that flag Supabase demands a bearer token and your client
sees nothing but a 401.

Then test:

1. Open a job → **+ Upload report** → attach any PDF, put your own address in
   **To**, hit **Upload & send**. It should arrive in seconds, with the PDF
   attached *and* a download link.
2. Open the billing ticket screen → **Email for approval**, again to yourself.
   Click the link in that email, type a name, approve. The ticket should flip
   to **Approved** in the billing tracker, and the link should refuse to work
   a second time.

If something doesn't arrive, Postmark's **Activity** tab shows every attempt
and exactly why it failed — check there before assuming the app is at fault.

---

## 5. Turn on the account safeguards  (~5 min)

In the [Supabase dashboard](https://supabase.com/dashboard/project/eielmvxzdwwprmmfamlq):

1. **Authentication → Policies →** turn on **leaked-password protection**.
   It rejects passwords found in known breaches. Off by default.
2. **Authentication → Providers → Email →** decide about **Confirm email**.
   Leaving it on means every new user must click a confirmation link before
   they can sign in. Turning it off makes adding a technician instant. For a
   small crew where you're creating the accounts yourself, off is
   reasonable — you already know who they are.
3. Create the real user accounts (**Authentication → Users → Add user**),
   one per person. Check **Auto Confirm User**, and under **User Metadata**
   put:
   ```json
   { "name": "D. Kowalchuk", "role": "Technician", "cert": "Lvl II · RT" }
   ```
   `role` must be exactly `Admin`, `Coordinator`, `Technician` or `Helper` —
   it sets what tabs they can see. You can adjust individual tabs afterwards
   in the app's own **Users & access** screen.

---

## 6. Host the app somewhere  (~10 min)

To use it on a phone in the field it needs to be on the internet, over HTTPS.
Build it first — the app is a Vite project, so what gets hosted is the built
`dist/` folder, not the source:

```
cd vite-app
npm install
npm run build
```

Easiest path from there: **Netlify Drop** (https://app.netlify.com/drop) —
drag `vite-app/dist` onto the page, and you have a URL in about thirty
seconds. Vercel and Cloudflare Pages are equivalent. All have free tiers that
cover this.

Copy `vite-app/.env.example` to `vite-app/.env` first if you're pointing at a
different Supabase project than the one baked in as the default; the URL and
publishable key in there are safe to be public either way.

The approval page your clients see is served by Supabase, not from here, so
hosting the app isn't a prerequisite for email — it's what gets the app onto
your crews' phones.

---

## 7. Put in your real numbers  (~20 min, and only you can do it)

Every rate currently in the app is a plausible placeholder I invented. Before
anyone bills a real client, open **Rate admin** and replace, per client:

- RT per-weld rates for each size band, in all three columns (**Film / CR / DR**)
- The other methods (MT/MPI, PT, VT, hardness, UT)
- Time & expense: straight time, overtime, mileage, film & consumables, LOA
- Any job-level overrides for work that was bid at a different rate

Then hit **Publish schedule**. Tickets store the rate at the moment they're
raised, so publishing new rates never repricies a ticket that's already out.

Same for the client and contractor contacts — the seeded ones are invented.

---

## Where things stand

**Done and working:** sign-in, jobs, JHAs, report upload to private storage,
billing tickets and rate schedules, the billing tracker, user accounts and
per-tab permissions. All of it against a real database with row-level
security.

**Waiting on this checklist:** sending email (steps 1–4). The functions and
the public approval page are written and in `supabase/` — they just need your
Postmark token and a deploy.

**Built since:** the offline queue for the three field screens. A JHA, report
or ticket raised with no signal is stored in the browser's IndexedDB and
replays automatically the moment the device is back in range; the top bar
shows a count of anything still waiting. It only ever queues a genuine
connectivity failure — a real error (a completed job, a missing rate
schedule) still surfaces on the spot.
