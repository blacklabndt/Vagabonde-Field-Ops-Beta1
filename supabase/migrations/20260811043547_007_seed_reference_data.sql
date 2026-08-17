insert into public.clients (name, agreement_ref, effective_from, minimum_callout) values
  ('Peace River Midstream', 'MSA-118 rev 4', '2026-01-01', '4 h + mobilization'),
  ('Northridge Pipeline', 'MSA-204 rev 2', '2025-11-15', '6 h'),
  ('Sundre Gas Co-op', 'MSA-077 rev 1', '2025-04-01', '4 h'),
  ('Athabasca Terminals', 'Spot — no MSA', current_date, '8 h'),
  ('Bearspaw Fabrication', 'MSA-141 rev 3', '2025-07-01', 'Shop day rate');

insert into public.contractors (name) values
  ('Northridge Pipeline'), ('Kinuso Construction'), ('Foothills Mechanical');

insert into public.contacts (org_type, org_id, name, email, phone) values
  ('client', (select id from public.clients where name = 'Peace River Midstream'), 'T. Beaudry', 't.beaudry@prmidstream.ca', '(780) 555-0142'),
  ('client', (select id from public.clients where name = 'Northridge Pipeline'), 'R. Tessier', 'r.tessier@northridgepipeline.ca', '(780) 555-0198'),
  ('client', (select id from public.clients where name = 'Sundre Gas Co-op'), 'L. Mahoney', 'lmahoney@sundregas.coop', '(403) 555-0176'),
  ('client', (select id from public.clients where name = 'Bearspaw Fabrication'), 'C. Iwasiuk', 'shop@bearspawfab.ca', '(403) 555-0119'),
  ('contractor', (select id from public.contractors where name = 'Northridge Pipeline'), 'R. Tessier', 'docs@northridgepipeline.ca', '(780) 555-0198'),
  ('contractor', (select id from public.contractors where name = 'Kinuso Construction'), 'B. Cardinal', 'b.cardinal@kinusoconst.ca', '(780) 555-0233'),
  ('contractor', (select id from public.contractors where name = 'Foothills Mechanical'), 'P. Sandhu', 'p.sandhu@foothillsmech.ca', '(403) 555-0287');

insert into public.jobs (job_number, project, client_id, lsd, status, created_at) values
  ('J-2838', 'Wapiti loop crossing', (select id from public.clients where name = 'Northridge Pipeline'), '04-11-072-08 W6M', 'Complete', '2026-02-10 05:52'),
  ('J-2841', 'Tie-in spread 3', (select id from public.clients where name = 'Peace River Midstream'), '13-22-047-05 W5M', 'In progress', '2026-02-11 06:04'),
  ('J-2842', 'Sundre gathering system', (select id from public.clients where name = 'Sundre Gas Co-op'), '07-33-034-04 W5M', 'In progress', '2026-02-12 06:31'),
  ('J-2843', 'Winter tie-in program', (select id from public.clients where name = 'Northridge Pipeline'), '16-05-078-11 W6M', 'Dispatched', '2026-02-12 07:10'),
  ('J-2844', 'Terminal 2 turnaround', (select id from public.clients where name = 'Athabasca Terminals'), 'Plant 2 · Rack B', 'Dispatched', '2026-02-12 07:44'),
  ('J-2845', 'Compressor lateral', (select id from public.clients where name = 'Peace River Midstream'), '09-14-047-05 W5M', 'Unassigned', '2026-02-12 08:20'),
  ('J-2839', 'Q1 shop spool batch', (select id from public.clients where name = 'Bearspaw Fabrication'), 'Shop · Bay 4', 'Complete', '2026-02-09 07:15');

-- One published rate schedule per client, seeded from the handoff's sample
-- rate card (RT film/CR/DR per size band, other methods, time & expense).
do $$
declare
  c record;
  sched_id uuid;
  sizes text[] := array['2" NPS','4" NPS','6" NPS','8" NPS','12" NPS'];
  weld_base int[];
  i int;
begin
  for c in select * from public.clients loop
    weld_base := case c.name
      when 'Peace River Midstream' then array[42,58,76,104,148]
      when 'Northridge Pipeline' then array[38,54,71,98,139]
      when 'Sundre Gas Co-op' then array[45,62,82,112,158]
      when 'Athabasca Terminals' then array[48,66,88,118,168]
      when 'Bearspaw Fabrication' then array[34,47,62,84,122]
    end;
    insert into public.rate_schedules (client_id, effective_from, published_at)
    values (c.id, current_date, now()) returning id into sched_id;

    for i in 1..5 loop
      insert into public.rate_lines (schedule_id, kind, label, unit, rate) values
        (sched_id, 'rt_film', sizes[i], 'per weld', weld_base[i]),
        (sched_id, 'rt_cr', sizes[i], 'per weld', round(weld_base[i] * 1.15)),
        (sched_id, 'rt_dr', sizes[i], 'per weld', round(weld_base[i] * 1.32));
    end loop;

    insert into public.rate_lines (schedule_id, kind, label, unit, rate) values
      (sched_id, 'method', 'MT / MPI', 'per weld', round(34 * (weld_base[1] / 42.0))),
      (sched_id, 'method', 'PT', 'per weld', round(29 * (weld_base[1] / 42.0))),
      (sched_id, 'method', 'VT', 'per weld', round(18 * (weld_base[1] / 42.0))),
      (sched_id, 'method', 'Hardness test', 'per weld', round(46 * (weld_base[1] / 42.0))),
      (sched_id, 'method', 'UT', 'per weld', round(52 * (weld_base[1] / 42.0)));
  end loop;
end $$;
