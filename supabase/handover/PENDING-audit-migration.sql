-- DRAFT — not applied. Apply live first (the applier stamps the version),
-- then file this under supabase/migrations/<version>_the_token_is_not_the_
-- record.sql with the version the applier gave it.
--
-- Round six: three seams the fourth review found.
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
--     token hook stays exactly as it is: the claim still tells the app
--     which screens to draw, it just no longer tells the database who you
--     are. Every policy already wraps these calls in (select …), so this
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
--     ones keeps working unchanged.

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

-- Nothing else in either schema reads auth.jwt(): these two were the only
-- functions that named it and no policy compares against it directly.
-- private.has_tab, private.has_any_tab and public.is_staff are all
-- tab_access() in a coat, and private.stored_role and private.can_write_
-- ticket already read the table, so all five follow along for free.

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
-- deletes and the two members added to the returned object.

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
  is_admin := (select private.user_role()) = 'Admin';

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
