-- Round four, the database half of three things the owner chose:
--
-- 1 · "Query this ticket" on the approval page — what the client rep said
--     when they wouldn't sign, on the ticket for the tracker to show. Written
--     by the approval function alone (service role): the column grant on
--     tickets already keeps signed-in accounts off any column not named in
--     it, and the insert policy pins the three empty like the rest of the
--     approval plumbing.
-- 2 · The tracker's filtered total — the money across everything the search
--     matches, not only the page — from search_tickets, alongside the query.
-- 3 · The board ordered by last activity: a job with a ticket filed today
--     rises above one raised yesterday and untouched since. jobs carries the
--     stamp, three triggers keep it, search_jobs orders by it.

-- ── 1 · the query ────────────────────────────────────────────────────────
alter table public.tickets
  add column if not exists queried_at timestamp with time zone,
  add column if not exists query_text text,
  add column if not exists query_by text;

drop policy if exists "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert to authenticated
  with check (
    (select is_staff())
    and (technician_id = (select auth.uid())
         or (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text]))
    and status = 'Draft'
    and total = 0
    and approved_at is null and approved_by_email is null and approved_ip is null
    and approved_signature is null
    and approval_token is null and approval_sent_at is null and approval_expires_at is null
    and approval_sent_to is null and approval_sent_by is null
    and invoiced_at is null and chased_at is null
    and queried_at is null and query_text is null and query_by is null
  );

-- ── 2 · search_tickets: the query, and the money across the whole match ──
drop function if exists public.search_tickets(text, integer, integer, text, date, date);
create function public.search_tickets(
  status_filter text default 'All', page_num integer default 0, page_size integer default 10,
  q text default '', date_from date default null, date_to date default null)
returns table(id text, work_date date, status text, total numeric, created_at timestamp with time zone,
              job_number text, project text, client_name text, technician_name text,
              chased_at timestamp with time zone, invoiced_at timestamp with time zone,
              queried_at timestamp with time zone, query_text text, query_by text,
              total_count bigint, filtered_total numeric)
language sql stable set search_path to 'public' as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(q, '') = '' as blank,
           (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as priced
  ),
  hit as (
    select t.id, t.work_date, t.status,
           case when esc.priced then t.total end as total,
           t.created_at, t.chased_at, t.invoiced_at,
           t.queried_at, t.query_text, t.query_by,
           j.job_number, j.project, c.name as client_name, p.name as technician_name
      from public.tickets t
      cross join esc
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
     where (status_filter = 'All'
            or (status_filter = 'Over 7 days' and t.status = 'Awaiting approval' and now() - t.created_at > interval '7 days')
            or t.status = status_filter)
       and (esc.blank
            or t.id ilike esc.pat or j.job_number ilike esc.pat
            or j.project ilike esc.pat or c.name ilike esc.pat or p.name ilike esc.pat)
       and (date_from is null or t.work_date >= date_from)
       and (date_to is null or t.work_date <= date_to)
  )
  select h.id, h.work_date, h.status, h.total, h.created_at, h.job_number, h.project, h.client_name,
         h.technician_name, h.chased_at, h.invoiced_at, h.queried_at, h.query_text, h.query_by,
         count(*) over () as total_count,
         -- null for roles that don't see prices: every h.total is null for them.
         sum(h.total) over () as filtered_total
    from hit h
   order by h.created_at desc, h.id desc
  offset page_num * page_size limit page_size;
$$;
revoke execute on function public.search_tickets(text, integer, integer, text, date, date) from public, anon;
grant execute on function public.search_tickets(text, integer, integer, text, date, date) to authenticated;

-- ── 3 · the board by last activity ───────────────────────────────────────
alter table public.jobs add column if not exists last_activity_at timestamp with time zone;
update public.jobs j
   set last_activity_at = greatest(
         j.created_at,
         (select max(t.created_at) from public.tickets t where t.job_id = j.id),
         (select max(x.created_at) from public.jhas x where x.job_id = j.id),
         (select max(r.uploaded_at) from public.reports r where r.job_id = j.id))
 where j.last_activity_at is null;
alter table public.jobs alter column last_activity_at set default now();
create index if not exists idx_jobs_last_activity on public.jobs (last_activity_at desc);

-- Definer, like sync_ticket_total: the technician filing the ticket has no
-- business updating jobs, and doesn't — the trigger does, as the owner.
-- The jobs guard trigger still runs and sees an update that touches none
-- of the columns it protects.
create or replace function private.touch_job_activity()
returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  update public.jobs set last_activity_at = now() where id = coalesce(new.job_id, old.job_id);
  return null;
end;
$$;
revoke execute on function private.touch_job_activity() from public, anon, authenticated;
drop trigger if exists tickets_touch_job on public.tickets;
create trigger tickets_touch_job after insert or update of status on public.tickets
  for each row execute function private.touch_job_activity();
drop trigger if exists jhas_touch_job on public.jhas;
create trigger jhas_touch_job after insert or update of status on public.jhas
  for each row execute function private.touch_job_activity();
drop trigger if exists reports_touch_job on public.reports;
create trigger reports_touch_job after insert on public.reports
  for each row execute function private.touch_job_activity();

drop function if exists public.search_jobs(text, text, text, integer, integer);
create function public.search_jobs(q text default ''::text, status_filter text default 'All'::text, search_field text default 'any'::text, page_num integer default 0, page_size integer default 10)
returns table(id uuid, job_number text, project text, lsd text, afe text, method text, procedure text, status text, created_at timestamp with time zone, client_id uuid, contractor_id uuid, client_name text, contractor_name text, created_by uuid, created_by_name text, last_activity_at timestamp with time zone, total_count bigint)
language sql stable set search_path to 'public' as $$
  -- % _ and \ are LIKE syntax; a search box passes text, so they are escaped.
  -- Backslash first, or it would double-escape what the others add.
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  matched as (
    select j.id, j.created_at, j.last_activity_at
    from public.jobs j, esc
    where (status_filter = 'All' or j.status = status_filter)
      and (
        q = '' or
        case search_field
          when 'project'    then j.project    ilike esc.pat
          when 'lsd'        then j.lsd        ilike esc.pat
          when 'id'         then j.job_number ilike esc.pat
          when 'client'     then exists (
                                 select 1 from public.clients c
                                 where c.id = j.client_id and c.name ilike esc.pat)
          when 'contractor' then exists (
                                 select 1 from public.contractors k
                                 where k.id = j.contractor_id and k.name ilike esc.pat)
          else j.search_text ilike '%' || regexp_replace(lower(q), '[^a-z0-9]', '', 'g') || '%'
        end
      )
  ),
  total as (select count(*) as n from matched),
  page as (
    select m.id from matched m
    order by m.last_activity_at desc nulls last, m.created_at desc, m.id desc
    offset page_num * page_size
    limit page_size
  )
  select j.id, j.job_number, j.project, j.lsd, j.afe, j.method, j.procedure,
         j.status, j.created_at, j.client_id, j.contractor_id,
         c.name, k.name, j.created_by, p.name, j.last_activity_at,
         (select n from total)
  from page pg
  join public.jobs j on j.id = pg.id
  left join public.clients c on c.id = j.client_id
  left join public.contractors k on k.id = j.contractor_id
  left join public.profiles p on p.id = j.created_by
  order by j.last_activity_at desc nulls last, j.created_at desc, j.id desc;
$$;
revoke execute on function public.search_jobs(text, text, text, integer, integer) from public, anon;
grant execute on function public.search_jobs(text, text, text, integer, integer) to authenticated;
