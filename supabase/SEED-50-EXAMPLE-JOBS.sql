-- ─────────────────────────────────────────────────────────────────────────
-- Add 50 example jobs — for trying out Home page pagination
--
-- Paste into the Supabase SQL Editor and run. Adds 50 more jobs (job numbers
-- J-5001 through J-5050) without touching anything already on file — unlike
-- RESEED-EXAMPLE-JOBS.sql, this does NOT delete existing jobs, tickets, JHAs
-- or reports. About a fifth are marked Complete so the status filter has
-- something to show too.
--
-- Safe to run more than once: it deletes any J-5001…J-5050 jobs (and
-- everything filed against them) before recreating them, so a repeat run
-- doesn't duplicate.
--
-- To remove them afterwards:
--   delete from public.jobs where job_number like 'J-5%';
-- (their JHAs/reports/tickets cascade or are deleted with them below first)
-- ─────────────────────────────────────────────────────────────────────────

begin;

delete from public.ticket_crew where ticket_id in (select id from public.tickets where job_id in (select id from public.jobs where job_number like 'J-5%'));
delete from public.ticket_lines where ticket_id in (select id from public.tickets where job_id in (select id from public.jobs where job_number like 'J-5%'));
delete from public.tickets where job_id in (select id from public.jobs where job_number like 'J-5%');
delete from public.reports where job_id in (select id from public.jobs where job_number like 'J-5%');
delete from public.jhas where job_id in (select id from public.jobs where job_number like 'J-5%');
delete from public.rate_overrides where job_id in (select id from public.jobs where job_number like 'J-5%');
delete from public.jobs where job_number like 'J-5%';

with c as (
  select id, row_number() over (order by name) - 1 as n, count(*) over () as total from public.clients
), k as (
  select id, row_number() over (order by name) - 1 as n, count(*) over () as total from public.contractors
), author as (
  select id from public.profiles where role = 'Admin' order by created_at limit 1
), n as (
  select g as i from generate_series(1, 50) as g
), seed as (
  select
    i,
    'J-' || (5000 + i) as job_number,
    (array['Tie-in spread', 'Compressor lateral', 'Terminal turnaround', 'Winter tie-in', 'Shop fabrication',
           'Sour service loop', 'Pump station piping', 'Battery site repair', 'Meter station upgrade',
           'Pipeline crossing', 'Valve replacement', 'Facility inspection'])[1 + (i % 12)]
      || ' ' || (1 + (i % 9)) as project,
    lpad((1 + (i % 32))::text, 2, '0') || '-' || lpad((1 + (i % 36))::text, 2, '0') || '-' ||
      lpad((40 + (i % 40))::text, 3, '0') || '-' || lpad((1 + (i % 12))::text, 2, '0') || ' W5M' as lsd,
    'AFE 26-' || (1000 + i * 3) as afe,
    (array['RT · Ir-192', 'RT · CR', 'RT · DR', 'MT / PT', 'UT'])[1 + (i % 5)] as method,
    (array['CSA Z662 cl. 7.11', 'ASME B31.3', 'CSA W59'])[1 + (i % 3)] as procedure,
    i % 8 as client_i,
    i % 6 as contractor_i,
    i as days_ago,
    case when i % 5 = 0 then 'Complete' else 'Active' end as status
  from n
)
insert into public.jobs (job_number, project, client_id, contractor_id, lsd, afe, method, procedure, status, created_by, created_at)
select s.job_number, s.project,
       (select id from c where c.n = s.client_i % c.total),
       (select id from k where k.n = s.contractor_i % k.total),
       s.lsd, s.afe, s.method, s.procedure,
       s.status,
       (select id from author),
       now() - (s.days_ago || ' days')::interval
  from seed s;

commit;

-- Check what you got:
--   select count(*) from public.jobs where job_number like 'J-5%';
