-- ─────────────────────────────────────────────────────────────────────────
-- Clear the jobs and reseed example ones
--
-- Paste this into the Supabase SQL Editor and run it. It wipes every job and
-- everything filed against a job — JHAs, reports, tickets, ticket lines and
-- crew rows — then creates eight fresh example jobs, all Active.
--
-- It does NOT touch: user accounts, clients, contractors, the contact
-- directory, or rate schedules. Those stay exactly as they are.
--
-- Files already uploaded to the reports storage bucket are not deleted (SQL
-- can't reach storage). They're orphaned, harmless, and only visible in the
-- Supabase dashboard.
--
-- Safe to run more than once: each run clears and reseeds the same eight.
-- ─────────────────────────────────────────────────────────────────────────

begin;

-- Deleted innermost-first rather than relying on cascades, so this works the
-- same whether or not every foreign key was declared with one.
delete from public.ticket_crew;
delete from public.ticket_lines;
delete from public.tickets;
delete from public.reports;
delete from public.jhas;
-- Job-level rate overrides hang off the job too, and their foreign key has no
-- cascade — a leftover override would block the job delete outright.
delete from public.rate_overrides;
delete from public.jobs;

-- Clients and contractors are matched by position, not by name, so this runs
-- against whatever is on file rather than assuming the seeded names. If there
-- are fewer of either than the jobs reference, the modulo wraps around.
with c as (
  select id, row_number() over (order by name) - 1 as n, count(*) over () as total
    from public.clients
), k as (
  select id, row_number() over (order by name) - 1 as n, count(*) over () as total
    from public.contractors
), author as (
  select id from public.profiles
   where role = 'Admin'
   order by created_at
   limit 1
), seed (job_number, project, lsd, afe, method, procedure, client_i, contractor_i, days_ago) as (
  values
    ('J-3001', 'Tie-in spread 3',        '13-22-047-05 W5M', 'AFE 24-1180', 'RT · Ir-192', 'CSA Z662 cl. 7.11', 0, 0, 1),
    ('J-3002', 'Compressor lateral',     '09-14-047-05 W5M', 'AFE 24-1204', 'RT · Ir-192', 'CSA Z662 cl. 7.11', 0, 1, 2),
    ('J-3003', 'Terminal 2 turnaround',  'Plant 2 · Rack B', 'AFE 24-0987', 'RT · CR',     'ASME B31.3',        1, 2, 4),
    ('J-3004', 'Winter tie-in — north',  '16-05-078-11 W6M', 'AFE 24-1233', 'RT · Ir-192', 'CSA Z662 cl. 7.11', 2, 0, 5),
    ('J-3005', 'Shop fabrication 03-15', '03-15-062-04 W5M', 'AFE 24-1156', 'RT · DR',     'CSA W59',           3, 1, 7),
    ('J-3006', 'Sour service loop',      '07-31-055-08 W5M', 'AFE 24-1261', 'RT · Ir-192', 'CSA Z662 cl. 7.11', 1, 2, 9),
    ('J-3007', 'Pump station piping',    '11-08-041-02 W5M', 'AFE 24-1274', 'RT · CR',     'ASME B31.3',        2, 0, 12),
    ('J-3008', 'Battery site repair',    '04-19-069-07 W5M', 'AFE 24-1288', 'MT / PT',     'CSA W59',           3, 1, 15)
)
insert into public.jobs (job_number, project, client_id, contractor_id, lsd, afe, method, procedure, status, created_by, created_at)
select s.job_number, s.project,
       (select id from c where c.n = s.client_i % c.total),
       (select id from k where k.n = s.contractor_i % k.total),
       s.lsd, s.afe, s.method, s.procedure,
       'Active',
       (select id from author),
       now() - (s.days_ago || ' days')::interval
  from seed s;

commit;

-- Check what you got:
--   select job_number, project, status from public.jobs order by created_at desc;
