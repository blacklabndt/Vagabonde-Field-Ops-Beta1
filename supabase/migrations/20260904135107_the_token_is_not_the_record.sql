-- 20260904135107 · the token is not the record
-- Applied live 2026-09-04 (Kyle, via the audit loop); probes that were run
-- before and after are in supabase/handover/probes-20260904135107-the-token-is-not-the-record.sql.
--
-- Round six: three seams the fourth review found, three more that the hard
-- review of this draft found in the draft itself and beside it, and one the
-- adversarial-flow pass found in the two policies that let a report be filed.
--
-- 1 · The token is a copy of the record, not the record. tab_access() and
--     user_role() read the access token's app_metadata first and only asked
--     the table when the claim was missing, so for the hour a token stays
--     alive it, not profiles, decided everything. A locked account
--     (delete-user bans it in Auth, empties tab_access and stamps
--     deactivated_at) kept every permission it had until its token expired,
--     and so did a demoted Admin. Every Admin gate in the schema asks
--     user_role() and nothing else — app_settings, the rate card,
--     ticket_lines, timesheet_approvals, the deletes, and the definer RPCs
--     archive_clear_jobs, mark_tickets_invoiced and delete_job's admin
--     branch — so all of them answered to the claim. Proven read-only on
--     the live project: a Technician carrying an Admin claim selects the
--     app_settings row and reads the Resend key out of it. Where the row
--     also still holds the users tab (an Admin demoted by hand rather than
--     through the Users screen, which rewrites the tabs with the rank),
--     profiles_update's WITH CHECK asks user_role() too, and the account
--     can PATCH itself back to Admin — a permanent restore out of a token
--     that was supposed to be temporary.
--     Both functions now read profiles, and both answer as
--     though the account did not exist once deactivated_at is set. The
--     token hook stays exactly as it is, but not because anything still
--     needs it: the app draws its menu from the profiles row it fetches on
--     sign-in (session.js → tabList(profile.tab_access)), and nothing in
--     vite-app, the Worker or the Edge Functions reads app_metadata at
--     all. So after this migration the claim has no reader left on either
--     side. It is left in place only because removing an auth hook is its
--     own change with its own blast radius — a follow-up, once this has
--     been live long enough to be sure nothing was leaning on it.
--     Every policy already wraps these calls in (select …), so this
--     is still one InitPlan per statement, not one lookup per row.
-- 2 · Rank is an Admin's, on every verb. profiles_update has said so since
--     the beginning, but profiles_insert asked only for the users tab and
--     profiles_delete asked only for the users tab and "not me" — so a
--     users-tab holder could DELETE a fresh account's profile row and
--     INSERT it back as an Admin with every tab, and the WITH CHECK it
--     could not pass never came into it. The same DELETE would destroy a
--     colleague's record outright (chat cascades off it). Insert now needs
--     Admin unless the rank being written is Technician or Helper; delete
--     is an Admin's alone. Neither touches provisioning: handle_new_user
--     is a definer trigger and create-user/delete-user hold the service
--     key, and RLS is not forced on profiles, so both bypass these
--     policies entirely.
-- 3 · delete_job's discard branch left PDFs behind. It deletes the tickets
--     and overrides itself and lets the jobs FK cascade take the JHAs and
--     reports — which means their pdf_keys are gone before anyone can read
--     them, and the client had nothing to remove from the jhas and reports
--     buckets. archive_clear_jobs already collects its keys before it
--     deletes; delete_job now does the same, and returns them beside the
--     counts it already returned. Every existing key in that object stays
--     where it was, so a client that has not been taught to read the new
--     ones keeps working unchanged. The same function carried the one
--     Admin gate in the schema written as a boolean read out of the rank —
--     `is_admin := user_role() = 'Admin'`, then three `not is_admin`
--     branches — which section 1 turns from false into null for a locked
--     account, and null takes the false branch of every one of them. It
--     coalesces now, and asks is_staff() at the door before it asks
--     anything else. Section 4 is the same mistake in a trigger.
-- 4 · A missing rank read as a Coordinator. private.guard_job_update asks
--     user_role() into `who` and then tests
--     `who not in ('Admin','Coordinator')` — which is NULL, not true, when
--     who is null, so the branch never fired and the job moved to another
--     client. That decides the rate card every ticket on the job prices
--     from. Before section 1 a null rank needed a profiles row that had
--     somehow lost its role; after section 1 every deactivated account
--     answers null, so the very accounts section 1 is locking out would
--     have walked through this one gate. The status test beside it was
--     always safe — `is distinct from` is null-safe — so only the
--     client_id line changes.
-- 5 · The equipment screen disagreed with itself after six in the evening.
--     equipment_stats() and search_equipment() measure "overdue" and "due
--     soon" against current_date, which is UTC; the tag on the row itself
--     is computed in the browser, in Grande Prairie time. From 18:00 local
--     the two are a day apart, so a rig due tomorrow was tagged "due soon"
--     in its own row, counted as overdue in the tile above it, and
--     returned by the "Overdue" filter. Both functions now read
--     (now() at time zone 'America/Edmonton')::date — the crew's day. The
--     30-day window is the same 30 days, counted from the right morning.
-- 6 · The dose ledger added up 44 people's milliroentgens in the browser.
--     A "Year" view pulled every ticket_crew row of the year — 31,823 of
--     them this morning, about 17 MB over the wire, paged 1,000 at a time
--     — to print one line each. public.dose_totals(start, end) does the
--     summing in the database and returns one row per person, with the
--     days behind it and the four quarters beside the total. It is
--     SECURITY INVOKER on purpose: RLS is what keeps crew hours private,
--     and it must stay what keeps them private.
-- 7 · A Helper could file a radiographic report. reports_insert and the
--     storage policy `reports write` each took the job tab as well as the
--     upload tab, and the job tab is one a Helper holds — so an account
--     that is on site to assist could put a PDF in the reports bucket and
--     a row against any job, and the report screen would then mail that
--     interpretation to the contractor over the company's name. Tabs are
--     the permission, and the permission for filing a report is `upload`:
--     neither ROLE_PRESETS nor tabs_for_role() has ever given a Helper
--     that tab, which is exactly the promise these two policies weren't
--     keeping. The job arm comes off both WRITE predicates and stays on
--     both READ ones — anyone who can open a job may read what is filed
--     against it, which is how a Helper sees the reports for the day they
--     worked. Job detail's "+ Upload report" button asks the same question
--     of tabList in this round, but the button is the courtesy and this is
--     the gate: the API took the insert whether it was rendered or not.

-- The two policy drops in section 2 take an ACCESS EXCLUSIVE lock on
-- profiles — the table every single request reads through user_role(). If
-- something long is holding it at 6 a.m., wait three seconds and fail
-- rather than queue the whole app behind this migration; nothing here is
-- urgent enough to be worth a stall.
--
-- `set local`, so it belongs to the migration's own transaction and cannot
-- leak into the session. An applier that runs statements outside a
-- transaction answers this line with a WARNING and no timeout — that
-- warning is not a failure, but it does mean the lock wait is unbounded,
-- so read it before you walk away.
set local lock_timeout = '3s';

-- ── 1 · The record decides, not the token ───────────────────────────────
-- Both were plpgsql only to branch on the claim. With the claim gone they
-- are one select each, so they go back to sql. Security definer because
-- profiles' own read policy is not the question being asked here; stable
-- because a statement's answer must not change under it; search_path
-- pinned to public as everything else in this schema is.
--
-- tab_access() returns null for anyone without a profiles row — anon, the
-- service role, a token whose account has been hard-deleted — exactly as
-- the table branch always did. is_staff() and has_any_tab() coalesce that
-- to false, and '{}' for a deactivated account travels the same road.

create or replace function private.tab_access()
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when p.deactivated_at is null then p.tab_access else '{}'::text[] end
    from public.profiles p
   where p.id = (select auth.uid());
$$;

comment on function private.tab_access() is
  'The account''s tabs, from profiles — never from the access token. A '
  'deactivated account has none, the moment it is deactivated.';

create or replace function private.user_role()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select p.role
    from public.profiles p
   where p.id = (select auth.uid())
     and p.deactivated_at is null;
$$;

comment on function private.user_role() is
  'The account''s rank, from profiles — never from the access token. A '
  'deactivated account has no rank, so every role test fails closed.';

-- These two were the only functions in either schema that named auth.jwt(),
-- and no policy compares against the token directly. private.has_tab,
-- private.has_any_tab and public.is_staff are all tab_access() in a coat,
-- and private.stored_role and private.can_write_ticket already read the
-- table, so all five follow along for free.
--
-- One function still reads the claim after this, and section 4 leaves it
-- reading it: private.guard_job_update, through current_setting rather than
-- auth.jwt(). It asks the claim only for `role` — whether this is an API
-- call at all — never for a rank. Probe 9a searches for both spellings and
-- expects to find it and nothing else.

-- ── 2 · Rank is an Admin's, on insert and on delete too ─────────────────
-- Both policies were `to public`; they become `to authenticated`, which is
-- what profiles_update already says and what the anon key could never have
-- satisfied anyway.

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (
    (select private.has_any_tab('users'))
    and (
      (select private.user_role()) = 'Admin'
      or role = any (array['Technician'::text, 'Helper'::text])
    )
  );

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete to authenticated
  using (
    (select private.user_role()) = 'Admin'
    and (select private.has_any_tab('users'))
    and id <> (select auth.uid())
  );

-- ── 3 · delete_job hands back the keys it is about to orphan ────────────
-- Unchanged from the live body except for the two array_aggs before the
-- deletes, the two members added to the returned object, and the door test
-- at the top of the body that section 1 made necessary (see the comment
-- there). archive_clear_jobs and mark_tickets_invoiced ask the same
-- question as `is distinct from 'Admin'`, which is null-safe already, so
-- neither of them needs anything: this was the one Admin gate in the
-- schema written as a boolean read out of the rank.

create or replace function public.delete_job(
  p_job_id uuid,
  p_transfer_to uuid default null::uuid,
  p_discard boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n_jhas int; n_reports int; n_tickets int; n_overrides int;
  n_locked int; n_sent int;
  is_admin boolean;
  is_creator boolean;
  jha_keys text[] := '{}';
  report_keys text[] := '{}';
begin
  -- Section 1 gives a locked account a null rank, and null is not false:
  -- `not is_admin` on a null skips its branch, and all three of the gates
  -- below are spelled that way — so the account this migration is locking
  -- out would have walked past the creator test, past the admin-only
  -- discard, and past the sent-for-approval test, and discarded any job it
  -- knew the id of. coalesce first, and then ask whether the account is an
  -- account at all: is_staff() is the profiles row's own answer and never
  -- null, and nothing but a signed-in member of staff has any business in
  -- this function. Only the app calls it, always with a user's token.
  if not (select public.is_staff()) then
    raise exception 'Your account is no longer active. Ask an admin to restore it.'
      using errcode = '42501';
  end if;

  is_admin := coalesce((select private.user_role()) = 'Admin', false);

  select (created_by = (select auth.uid())) into is_creator
    from public.jobs where id = p_job_id;

  if is_creator is null then
    raise exception 'That job no longer exists — it may already have been deleted.';
  end if;

  if not is_admin and not is_creator then
    raise exception 'You can only delete a job you raised yourself. Ask an admin to remove this one.';
  end if;

  if p_discard and not is_admin then
    raise exception 'Deleting what is filed against a job is an admin''s. Transfer it to another job instead.';
  end if;

  select count(*) into n_jhas      from public.jhas           where job_id = p_job_id;
  select count(*) into n_reports   from public.reports        where job_id = p_job_id;
  select count(*) into n_tickets   from public.tickets        where job_id = p_job_id;
  select count(*) into n_overrides from public.rate_overrides where job_id = p_job_id;

  select count(*) into n_locked
    from public.tickets
   where job_id = p_job_id
     and (approved_at is not null or status in ('Approved', 'Invoiced'));

  if n_locked > 0 then
    raise exception
      'This job has % approved or invoiced ticket(s) on it. That billing is what the client agreed to pay and cannot be moved or deleted, so the job has to stay.', n_locked;
  end if;

  if not is_admin then
    select count(*) into n_sent
      from public.tickets
     where job_id = p_job_id and status = 'Awaiting approval';
    if n_sent > 0 then
      raise exception
        'A ticket from this job has already gone to the client for approval, so the job can''t be deleted. An admin can still remove it.';
    end if;
  end if;

  -- Nothing is transferring, so the JHAs and reports go down with the job
  -- on the jobs cascade. Read their PDF keys while the rows are still
  -- here — after the delete there is nothing left to read them from, and
  -- the two buckets would keep the files for ever.
  if p_transfer_to is null then
    select coalesce(array_agg(pdf_key), '{}') into jha_keys
      from public.jhas where job_id = p_job_id and pdf_key is not null;
    select coalesce(array_agg(pdf_key), '{}') into report_keys
      from public.reports where job_id = p_job_id and pdf_key is not null;
  end if;

  if p_transfer_to is not null then
    if p_transfer_to = p_job_id then
      raise exception 'Choose a different job to transfer to.';
    end if;
    if not exists (select 1 from public.jobs where id = p_transfer_to) then
      raise exception 'The job you are transferring to no longer exists.';
    end if;
    -- Other people's tickets and assessments ride along with a transfer.
    -- A technician may move them only between jobs they raised themselves;
    -- anywhere else is an admin's call.
    if not is_admin and not exists (
      select 1 from public.jobs where id = p_transfer_to and created_by = (select auth.uid())
    ) then
      raise exception 'You can transfer this job''s work only to another job you raised yourself. Ask an admin to move it elsewhere.';
    end if;

    update public.jhas           set job_id = p_transfer_to where job_id = p_job_id;
    update public.reports        set job_id = p_transfer_to where job_id = p_job_id;
    update public.tickets        set job_id = p_transfer_to where job_id = p_job_id;
    update public.rate_overrides set job_id = p_transfer_to where job_id = p_job_id;

  elsif (n_jhas + n_reports + n_tickets + n_overrides) > 0 then
    if not p_discard then
      raise exception
        'This job still has % JHA(s), % report(s), % ticket(s) and % override(s) on it. Transfer them to another job, or confirm they are to be deleted with it.',
        n_jhas, n_reports, n_tickets, n_overrides;
    end if;
    delete from public.tickets        where job_id = p_job_id;
    delete from public.rate_overrides where job_id = p_job_id;
  end if;

  delete from public.jobs where id = p_job_id;

  -- Every member the caller already reads, plus the two new arrays. On a
  -- transfer they are empty rather than absent, so the client never has to
  -- ask which shape it got.
  return jsonb_build_object(
    'transferred', p_transfer_to is not null,
    'jhas', n_jhas, 'reports', n_reports,
    'tickets', n_tickets, 'overrides', n_overrides,
    'jha_keys', to_jsonb(jha_keys),
    'report_keys', to_jsonb(report_keys)
  );
end $$;

-- ── 4 · A missing rank is not a Coordinator ─────────────────────────────
-- The live body, verbatim, with one changed line: coalesce on the client_id
-- test. The claim_role read at the top stays — it is not asking who you
-- are, it is asking whether this is an API call at all, which is the one
-- thing the token is still the honest source of.

create or replace function private.guard_job_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  claim_role text;
  who text;
begin
  claim_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
  -- Not an API call (the SQL editor, a migration) or the service role:
  -- not this trigger's to police.
  if claim_role is null or claim_role = 'service_role' then return new; end if;
  who := (select private.user_role());
  if new.job_number is distinct from old.job_number
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'A job''s number, who raised it and when are fixed.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and who is distinct from 'Admin' then
    raise exception 'Only an admin can complete or reopen a job.' using errcode = '42501';
  end if;
  -- coalesce, because `null not in (…)` is null and null is not true: an
  -- account with no rank — deactivated, or with no profiles row behind its
  -- token — used to fall straight past this branch. An unknown rank is not
  -- a Coordinator.
  if new.client_id is distinct from old.client_id
     and coalesce(who, '') not in ('Admin', 'Coordinator') then
    raise exception 'Only an Admin or Coordinator can move a job to another client — it decides the rate card every ticket prices from.' using errcode = '42501';
  end if;
  return new;
end $$;

-- ── 5 · The equipment screen keeps the crew's day ───────────────────────
-- Both bodies are the live ones with current_date replaced. The signatures
-- are copied from the catalog and must not drift: create or replace
-- refuses a changed return type, and these two are the return types the
-- app's columns are read from.

create or replace function public.equipment_stats()
returns table(overdue_count bigint, due_soon_count bigint)
language sql
stable
set search_path to 'public'
as $$
  -- One row, cross joined, so the date is read once and both counts agree
  -- with each other even across midnight in Grande Prairie.
  with today as (
    select (now() at time zone 'America/Edmonton')::date as d
  )
  select
    count(*) filter (where e.calibration_due is not null and e.calibration_due < t.d),
    count(*) filter (where e.calibration_due is not null and e.calibration_due >= t.d and e.calibration_due <= t.d + 30)
  from public.equipment e
  cross join today t;
$$;

comment on function public.equipment_stats() is
  'Overdue and due-soon calibration counts, against the date in Grande '
  'Prairie — not UTC, which has already rolled into tomorrow by evening.';

create or replace function public.search_equipment(
  filter_key text default 'All'::text,
  page_num integer default 0,
  page_size integer default 10,
  search text default ''::text
)
returns table(
  id uuid, type text, serial_number text, calibration_due date,
  status text, assigned_to uuid, assigned_name text, total_count bigint
)
language sql
stable
set search_path to 'public'
as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(search, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(search, '') = '' as blank,
           -- The same day equipment_stats counts by, so the tile and the
           -- filter can never name different equipment.
           (now() at time zone 'America/Edmonton')::date as today
  ),
  filtered as (
    select e.id, e.type, e.serial_number, e.calibration_due, e.status, e.assigned_to, p.name as assigned_name,
      count(*) over () as total_count
    from public.equipment e
    cross join esc
    left join public.profiles p on p.id = e.assigned_to
    where (filter_key = 'All'
       or (filter_key = 'Due soon' and e.calibration_due is not null and e.calibration_due >= esc.today and e.calibration_due <= esc.today + 30)
       or (filter_key = 'Overdue' and e.calibration_due is not null and e.calibration_due < esc.today)
       or e.type = filter_key)
      and (esc.blank
       or e.serial_number ilike esc.pat
       or e.type ilike esc.pat
       or p.name ilike esc.pat)
  )
  select * from filtered
  order by type, serial_number
  offset page_num * page_size
  limit page_size;
$$;

-- ── 6 · The dose ledger adds up where the rows are ──────────────────────
-- One row per person for a period — days with dose, the total, and the
-- four calendar quarters beside it — the same shape the screen builds
-- today out of every crew row of the year. The period is inclusive at both
-- ends, as listTimesheetEntries' gte/lte pair is.
--
-- SECURITY INVOKER, deliberately: crew hours and dose are private by RLS
-- (own rows, Admin/Coordinator, or a crewmate on a shared ticket) and this
-- function must not be a way around that. The extra own-or-Admin test in
-- the WHERE is not the security — RLS is — it is the screen's own rule
-- reproduced, because ticket_crew's read policy also shows a technician a
-- crewmate's row on a ticket they shared, and the ledger has always shown
-- a technician nobody but themselves.
--
-- It names private.user_role(), and it runs as the caller, so it is parsed
-- at call time and needs USAGE on schema private — which authenticated has
-- since 20260903055300, and which probe 12 exercises as a non-owner before
-- this is called done. That is the three-minute outage from round three;
-- do not skip the probe.
--
-- Quarters are the work date's calendar quarter, which is what
-- quarterOf(dateStr) in data.js computes from the month. Dose is summed
-- only where it was recorded (> 0), so a period with no dose leaves a
-- person off the ledger rather than printing them a zero — again what the
-- screen does today, filtering r.dose > 0 before it groups.
--
-- The client half (timesheets.jsx) is being switched to call this with a
-- fallback to the old row-by-row read, so it works either side of this
-- migration; the fallback comes out once this is live.

create or replace function public.dose_totals(p_start date, p_end date)
returns table(
  profile_id uuid, name text, days bigint, total_mr numeric,
  q1 numeric, q2 numeric, q3 numeric, q4 numeric
)
language sql
stable
security invoker
set search_path to 'public'
as $$
  -- Every column is qualified and the outer list is positional: the
  -- RETURNS TABLE names are parameters inside a sql body, and a bare
  -- `name` or `profile_id` here would be ambiguous against the tables.
  with dosed as (
    select c.profile_id as pid,
           -- fullName() in db.js: the parts if they are there, the display
           -- string if they are not.
           coalesce(nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''), p.name, '') as who,
           c.dose_mr as mr,
           extract(quarter from t.work_date)::int as qtr
      from public.ticket_crew c
      join public.tickets t on t.id = c.ticket_id
      left join public.profiles p on p.id = c.profile_id
     where t.work_date >= p_start
       and t.work_date <= p_end
       and c.dose_mr > 0
       and (c.profile_id = (select auth.uid())
            or (select private.user_role()) = 'Admin')
  )
  select d.pid, d.who,
         -- days: the crew rows behind the total, which is what the screen
         -- prints as "days with dose" — one row per person per ticket day.
         count(*),
         sum(d.mr),
         coalesce(sum(d.mr) filter (where d.qtr = 1), 0),
         coalesce(sum(d.mr) filter (where d.qtr = 2), 0),
         coalesce(sum(d.mr) filter (where d.qtr = 3), 0),
         coalesce(sum(d.mr) filter (where d.qtr = 4), 0)
    from dosed d
   group by d.pid, d.who
   order by 4 desc, 2;
$$;

comment on function public.dose_totals(date, date) is
  'Dose per person for a period, with calendar quarters — the ledger''s '
  'sums, done where the rows are. Invoker rights: RLS is the privacy.';

-- The same shape every other reporting function in this schema has: the
-- default EXECUTE to public and anon comes off, authenticated keeps it.
revoke execute on function public.dose_totals(date, date) from public, anon;
grant  execute on function public.dose_totals(date, date) to authenticated;

-- ── 7 · Filing a report needs the report tab ────────────────────────────
-- Both predicates are the live ones verbatim with the 'job' arm removed and
-- nothing else touched: same policy names, same commands, same roles.
-- reports_insert is `to public` in the catalog and stays `to public` — the
-- anon key could never satisfy has_any_tab() anyway, and widening or
-- narrowing that grant is not this finding's to do. It keeps has_any_tab
-- with one member left in its array for the same reason: it is the live
-- call with an arm gone, not a rewrite.
--
-- The two read policies are deliberately absent from this section.
-- reports_select and storage's `reports read` keep every tab they have,
-- including 'job': reading what is filed against a job you worked is not
-- filing one.
--
-- Each drop takes an ACCESS EXCLUSIVE lock on its table, and one of them is
-- storage.objects — every PDF the app opens goes through it. The `set local
-- lock_timeout` at the top of this file covers these two as well; if the
-- migration fails here it has failed on the wait, not on the change.

drop policy if exists reports_insert on public.reports;
create policy reports_insert
  on public.reports for insert to public
  with check ((select private.has_any_tab(variadic array['upload'::text])));

drop policy if exists "reports write" on storage.objects;
create policy "reports write"
  on storage.objects for insert to authenticated
  with check (((bucket_id = 'reports'::text) and (select private.has_tab('upload'::text))));
