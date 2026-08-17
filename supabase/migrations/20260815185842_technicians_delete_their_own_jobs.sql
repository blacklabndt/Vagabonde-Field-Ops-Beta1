-- A technician can remove a job they raised, until it has billed anything.
--
-- Deleting was admin-only, which is right for a job with history on it but
-- wrong for the common case: a job typed against the wrong client, or twice,
-- noticed a minute later by the person who typed it. Making that an admin
-- errand means the board carries someone else's typo until an admin gets to
-- it.
--
-- The line is whether anything has left the building. A ticket that is still
-- a draft is the technician's own unsent work and goes with the job. Once one
-- has gone out for approval a client is holding a link to it, and the job it
-- names has to stay put — so anything sent, approved or invoiced stops the
-- delete for a technician entirely.
--
-- Admins keep the wider power, minus the same immutability rule they already
-- had: approved and invoiced billing stops everyone.
--
-- Discarding stays admin-only. A technician clearing up their own mistake can
-- move a JHA to the right job, but destroying a filed safety record is not
-- theirs to do.

create or replace function public.delete_job(
  p_job_id uuid,
  p_transfer_to uuid default null,
  p_discard boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  -- Settled billing stops everyone, admin included.
  select count(*) into n_locked
    from public.tickets
   where job_id = p_job_id
     and (approved_at is not null or status in ('Approved', 'Invoiced'));

  if n_locked > 0 then
    raise exception
      'This job has % approved or invoiced ticket(s) on it. That billing is what the client agreed to pay and cannot be moved or deleted, so the job has to stay.', n_locked;
  end if;

  -- Sent-but-unsigned stops a technician. An admin may still move it: the
  -- approval link lives on the ticket, so it keeps working wherever the
  -- ticket ends up.
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
end $$;

revoke all on function public.delete_job(uuid, uuid, boolean) from public;
grant execute on function public.delete_job(uuid, uuid, boolean) to authenticated;

-- The board has to be able to say whose job it is.
--
-- `search_jobs` returned the creator's *name* and nothing else, so a screen
-- could print "raised by Kyle Keith" but could not ask "did I raise this" —
-- two people sharing a name would answer yes to each other's jobs, and a name
-- is not an identity anyway. Returning the id alongside it lets the delete
-- button appear for the person it belongs to.
--
-- Dropped and recreated rather than replaced: the return type is changing,
-- and CREATE OR REPLACE cannot do that.
drop function if exists public.search_jobs(text, text, text, integer, integer);

create function public.search_jobs(
  q text default '',
  status_filter text default 'All',
  search_field text default 'any',
  page_num integer default 0,
  page_size integer default 10
)
returns table (
  id uuid, job_number text, project text, lsd text, afe text, method text,
  procedure text, status text, created_at timestamptz, client_id uuid,
  contractor_id uuid, client_name text, contractor_name text,
  created_by uuid, created_by_name text, total_count bigint
)
language sql
stable
set search_path = public
as $$
  with matched as (
    select j.id, j.created_at
    from public.jobs j
    where (status_filter = 'All' or j.status = status_filter)
      and (
        q = '' or
        case search_field
          when 'project'    then j.project    ilike '%' || q || '%'
          when 'lsd'        then j.lsd        ilike '%' || q || '%'
          when 'id'         then j.job_number ilike '%' || q || '%'
          when 'client'     then exists (
                                 select 1 from public.clients c
                                 where c.id = j.client_id and c.name ilike '%' || q || '%')
          when 'contractor' then exists (
                                 select 1 from public.contractors k
                                 where k.id = j.contractor_id and k.name ilike '%' || q || '%')
          else j.search_text ilike '%' || regexp_replace(lower(q), '[^a-z0-9]', '', 'g') || '%'
        end
      )
  ),
  total as (select count(*) as n from matched),
  page as (
    select m.id from matched m
    order by m.created_at desc, m.id desc
    offset page_num * page_size
    limit page_size
  )
  select j.id, j.job_number, j.project, j.lsd, j.afe, j.method, j.procedure,
         j.status, j.created_at, j.client_id, j.contractor_id,
         c.name, k.name, j.created_by, p.name,
         (select n from total)
  from page pg
  join public.jobs j on j.id = pg.id
  left join public.clients c on c.id = j.client_id
  left join public.contractors k on k.id = j.contractor_id
  left join public.profiles p on p.id = j.created_by
  order by j.created_at desc, j.id desc;
$$;
