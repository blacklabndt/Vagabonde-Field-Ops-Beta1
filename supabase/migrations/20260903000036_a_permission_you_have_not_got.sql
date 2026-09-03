-- A permission you have not got is a door that stays shut.
--
-- Seven gaps from the deployment review, each a place where the database
-- trusted the screen or trusted a row it should have pinned:
--
-- 1. is_staff() meant "has a profile row" — tab_access defaults to '{}',
--    which is not null — so an account stripped of every tab (the only
--    lever on a departed technician whose crew hours forbid deleting the
--    profile) still read every ticket. Now: at least one tab.
-- 2. jhas: any staff account could rewrite any column of any assessment —
--    signed_by (take ownership, then delete it under the owner-delete
--    policy), job_id (move it), signed_at (backdate it). What a signed-in
--    account may change on a filed assessment is the close-out: dosimetry,
--    status, closed_at, closed_by. The functions write the rest with the
--    service role, which column grants do not bind.
-- 3. jobs: status was an admin's in the browser only; a job's number, who
--    raised it and when are fixed; its client — which decides the rate card
--    every ticket prices from — is an Admin's or Coordinator's to change. A
--    direct DELETE by an Admin bypassed delete_job's guards and cascaded
--    the JHAs and reports away: the RPC is now the only door.
-- 4. delete_job's transfer branch moved every ticket and assessment on the
--    job to any job the caller named. A non-admin may now transfer only to
--    a job they raised themselves.
-- 5. profiles: the users tab let its holder set any role — their own
--    included — and Admin unlocks the keys on the Admin screen. A role
--    change is an Admin's.
-- 6. chat_reactions had no UPDATE policy, so the upsert's conflict path (a
--    double tap, an offline replay) was refused with 42501.
-- 7. "tickets insert" had lost TO authenticated in its last rewrite, and
--    audit_log's insert pinned nothing — any account could write any actor.
--
-- Probed live with role simulation: a zero-tab account sees 0 tickets; a
-- technician changing a JHA's signed_by → 42501, a job's status → 42501,
-- their own role (with the users tab) → 42501; an Admin's status change
-- lands.

-- 1 · staff means at least one tab
create or replace function public.is_staff() returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select coalesce(cardinality(private.tab_access()) > 0, false);
$$;

-- 2 · what a signed-in account may change on a filed assessment
revoke update on public.jhas from anon, authenticated;
grant update (dosimetry, status, closed_at, closed_by) on public.jhas to authenticated;

-- 3 · a job's identity is fixed; its status and client are an admin's
create or replace function private.guard_job_update() returns trigger
  language plpgsql security definer set search_path to 'public' as $$
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
  if new.client_id is distinct from old.client_id and who not in ('Admin', 'Coordinator') then
    raise exception 'Only an Admin or Coordinator can move a job to another client — it decides the rate card every ticket prices from.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function private.guard_job_update() from public, anon, authenticated;
drop trigger if exists jobs_guard_update on public.jobs;
create trigger jobs_guard_update before update on public.jobs
  for each row execute function private.guard_job_update();
drop policy if exists jobs_delete on public.jobs;

-- 4 · a transfer lands only where the caller could have raised the work
create or replace function public.delete_job(p_job_id uuid, p_transfer_to uuid default null::uuid, p_discard boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n_jhas int; n_reports int; n_tickets int; n_overrides int;
  n_locked int; n_sent int;
  is_admin boolean;
  is_creator boolean;
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

  return jsonb_build_object(
    'transferred', p_transfer_to is not null,
    'jhas', n_jhas, 'reports', n_reports,
    'tickets', n_tickets, 'overrides', n_overrides
  );
end $function$;

-- 5 · a role is an Admin's to change
create or replace function private.stored_role(_id uuid) returns text
  language sql stable security definer set search_path to 'public' as $$
  select role from public.profiles where id = _id;
$$;
grant execute on function private.stored_role(uuid) to authenticated;
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    (select private.has_any_tab('users'))
    and not (id = (select auth.uid()) and not ('users' = any (tab_access)))
  )
  with check (
    (select private.has_any_tab('users'))
    and not (id = (select auth.uid()) and not ('users' = any (tab_access)))
    and (role = private.stored_role(id) or (select private.user_role()) = 'Admin')
  );

-- 6 · a reaction's upsert may land on its own row
drop policy if exists chat_reactions_update on public.chat_reactions;
create policy chat_reactions_update on public.chat_reactions
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- 7 · two policies that had slipped
drop policy if exists "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert to authenticated
  with check (
    (select is_staff())
    and (technician_id = (select auth.uid())
         or (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text]))
    and status = 'Draft'
    and approved_at is null and approved_by_email is null and approved_ip is null
    and approval_token is null and approval_sent_at is null and approved_signature is null
  );
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (actor_id = (select auth.uid()));
