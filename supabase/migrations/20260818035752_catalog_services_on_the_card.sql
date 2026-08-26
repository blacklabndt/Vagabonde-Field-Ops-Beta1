-- The last eight services priced from constants in the code move onto the
-- rate card: Standby, Callout, Source/isotope, Truck/unit day, Darkroom,
-- Crawler, Mobe/demob and Safety watch had never been rate lines at all —
-- the ticket screen carried their prices as numbers in SERVICES. Every
-- schedule gets them at exactly those historical figures, so nothing a
-- ticket bills changes; from here on the card is the only place a dollar
-- comes from, and the admin can finally see and edit these eight.
insert into public.rate_lines (schedule_id, kind, label, unit, rate, position)
select s.id, v.kind, v.label, v.unit, v.rate, v.pos
  from public.rate_schedules s
 cross join (values
    ('expense','Standby time','h',96,27),
    ('expense','Callout premium','ea',320,28),
    ('expense','Source / isotope charge','days',210,29),
    ('expense','Truck / unit day rate','days',475,30),
    ('expense','Darkroom / processing','h',88,31),
    ('expense','Crawler unit','days',650,32),
    ('expense','Mobilization / demob','ea',540,33),
    ('expense','Safety watch / attendant','h',74,34)
  ) as v(kind, label, unit, rate, pos)
    on conflict (schedule_id, kind, label) do nothing;
