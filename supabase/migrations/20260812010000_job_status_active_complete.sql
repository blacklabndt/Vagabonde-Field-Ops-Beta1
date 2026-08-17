-- ─────────────────────────────────────────────────────────────────────────
-- Job status: Active / Complete only
--
-- Jobs used to carry Unassigned → Dispatched → In progress → Complete. In
-- practice nobody moved a job through those middle states — a job is either
-- being worked or it is closed — so the app now creates jobs as Active and an
-- admin marks them Complete, which freezes them.
--
-- This folds the retired states into Active so no job is left showing a status
-- the app no longer has a filter or a tag for.
-- ─────────────────────────────────────────────────────────────────────────

update public.jobs
   set status = 'Active'
 where status in ('Unassigned', 'Dispatched', 'In progress');

-- The old names were also pinned by a CHECK constraint, which would reject
-- 'Active' on every future insert. Replaced after the update, so existing rows
-- already satisfy it.
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs
  add constraint jobs_status_check check (status in ('Active', 'Complete'));

-- Nothing else references the old names: ticket statuses (Draft, Awaiting
-- approval, Approved, Invoiced) are a separate vocabulary on their own table.
