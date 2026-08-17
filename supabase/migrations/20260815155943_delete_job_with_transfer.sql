-- Deleting a job, and deciding what happens to what was filed against it.
--
-- There was no DELETE policy on jobs, so a job raised by mistake stayed on the
-- board for good. Adding one on its own would have been worse than nothing,
-- because of how the foreign keys are set:
--
--   jhas            ON DELETE CASCADE   -- silently destroyed with the job
--   reports         ON DELETE CASCADE   -- silently destroyed with the job
--   tickets         no action           -- blocks the delete outright
--   rate_overrides  no action           -- blocks the delete outright
--
-- So a bare delete either takes a regulatory record with it without saying so,
-- or fails with a constraint name. Neither is something to hand an admin.
--
-- This does the whole thing in one statement instead: check who is asking,
-- refuse if the billing is settled, move or discard what is attached, then
-- delete. One transaction, so a failure half way leaves the job and its
-- contents exactly as they were rather than half moved.
--
-- SECURITY DEFINER with the role checked here in the body. The alternative is
-- four separate policies that all have to agree about who may reassign a JHA,
-- which is more surface for the same decision.

create or replace function public.delete_job(
  p_job_id uuid,
  p_transfer_to uuid default null,
  -- Destroying what is attached has to be asked for by name. Without this a
  -- mis-click on a job with eight JHAs on it would take them all.
  p_discard boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_jhas int; n_reports int; n_tickets int; n_overrides int;
  n_locked int;
  moved jsonb;
begin
  if (select private.user_role()) <> 'Admin' then
    raise exception 'Only an admin can delete a job.';
  end if;

  if not exists (select 1 from public.jobs where id = p_job_id) then
    raise exception 'That job no longer exists — it may already have been deleted.';
  end if;

  select count(*) into n_jhas      from public.jhas           where job_id = p_job_id;
  select count(*) into n_reports   from public.reports        where job_id = p_job_id;
  select count(*) into n_tickets   from public.tickets        where job_id = p_job_id;
  select count(*) into n_overrides from public.rate_overrides where job_id = p_job_id;

  -- An approved or invoiced ticket is the record of what a client agreed to
  -- pay, against a named job. Moving it rewrites that; deleting it destroys
  -- it. The same rule the ticket screen and RLS already enforce, applied to
  -- the job above it.
  select count(*) into n_locked
    from public.tickets
   where job_id = p_job_id
     and (approved_at is not null or status in ('Approved', 'Invoiced'));

  if n_locked > 0 then
    raise exception
      'This job has % approved or invoiced ticket(s) on it. That billing is what the client agreed to pay and cannot be moved or deleted, so the job has to stay.', n_locked;
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
      -- The caller has to have seen this and chosen. The screen shows the same
      -- numbers, but the database does not take that on trust.
      raise exception
        'This job still has % JHA(s), % report(s), % ticket(s) and % override(s) on it. Transfer them to another job, or confirm they are to be deleted with it.',
        n_jhas, n_reports, n_tickets, n_overrides;
    end if;
    -- Tickets and overrides do not cascade, so they go explicitly. Ticket
    -- lines and crew rows cascade off the ticket.
    delete from public.tickets        where job_id = p_job_id;
    delete from public.rate_overrides where job_id = p_job_id;
    -- jhas and reports cascade with the job below.
  end if;

  delete from public.jobs where id = p_job_id;

  moved := jsonb_build_object(
    'transferred', p_transfer_to is not null,
    'jhas', n_jhas, 'reports', n_reports,
    'tickets', n_tickets, 'overrides', n_overrides
  );
  return moved;
end $$;

revoke all on function public.delete_job(uuid, uuid, boolean) from public;
grant execute on function public.delete_job(uuid, uuid, boolean) to authenticated;

-- The RPC is the only supported route, but leaving the table with no DELETE
-- policy at all would mean a direct delete fails with "new row violates" style
-- confusion rather than a clear refusal. Admins only, matching the function.
drop policy if exists jobs_delete on public.jobs;
create policy jobs_delete on public.jobs
  for delete to authenticated
  using ((select private.user_role()) = 'Admin');
