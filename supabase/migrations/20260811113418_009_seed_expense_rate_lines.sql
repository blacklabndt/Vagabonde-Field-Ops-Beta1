-- Time & expense rows weren't part of migration 007's per-weld seeding —
-- fill them in now so the billing-ticket screen has a real "expense" kind
-- to look up per client, matching the labels ticketMobile.jsx's SERVICES
-- list expects (Db.getPublishedRatesForClient joins on `label`).
do $$
declare
  c record;
  sched_id uuid;
  vals numeric[];
begin
  for c in select id, name from public.clients loop
    select id into sched_id from public.rate_schedules where client_id = c.id order by effective_from desc limit 1;

    vals := case c.name
      when 'Peace River Midstream' then array[96, 144, 1.35, 5.6, 185]
      when 'Northridge Pipeline'   then array[92, 138, 1.25, 5.2, 175]
      when 'Sundre Gas Co-op'      then array[102, 153, 1.4, 6.0, 195]
      when 'Athabasca Terminals'   then array[108, 162, 1.5, 6.4, 210]
      when 'Bearspaw Fabrication'  then array[88, 132, 0.95, 4.8, 0]
    end;

    insert into public.rate_lines (schedule_id, kind, label, unit, rate) values
      (sched_id, 'expense', 'Technician — straight', 'per hour, Lvl II', vals[1]),
      (sched_id, 'expense', 'Technician — overtime', 'per hour, after 10 h', vals[2]),
      (sched_id, 'expense', 'Mileage', 'per km, unit + crew', vals[3]),
      (sched_id, 'expense', 'Film & consumables', 'per exposure', vals[4]),
      (sched_id, 'expense', 'Subsistence / LOA', 'per tech per day', vals[5]);
  end loop;
end $$;
