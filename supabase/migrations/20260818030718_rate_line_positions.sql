-- The rate card's order becomes data. Rows were drawn in whatever order the
-- code listed them; now each line carries a position, dragged into place on
-- the Rate admin screen, per schedule.
alter table public.rate_lines add column position integer;

-- Standards keep the order everyone knows. The three RT kinds of one size
-- share a position — the editor shows them as one row and they move as one.
update public.rate_lines rl set position = s.pos
  from (values
    ('rt_film','2" NPS',0),('rt_cr','2" NPS',0),('rt_dr','2" NPS',0),
    ('rt_film','4" NPS',1),('rt_cr','4" NPS',1),('rt_dr','4" NPS',1),
    ('rt_film','6" NPS',2),('rt_cr','6" NPS',2),('rt_dr','6" NPS',2),
    ('rt_film','8" NPS',3),('rt_cr','8" NPS',3),('rt_dr','8" NPS',3),
    ('rt_film','12" NPS',4),('rt_cr','12" NPS',4),('rt_dr','12" NPS',4),
    ('method','MT / MPI',10),('method','PT',11),('method','VT',12),
    ('method','Hardness test',13),('method','UT',14),
    ('expense','Straight time',20),('expense','Overtime',21),
    ('expense','Travel — straight',22),('expense','Travel — overtime',23),
    ('expense','Mileage',24),('expense','Film & consumables',25),
    ('expense','Subsistence / LOA',26)
  ) as s(kind, label, pos)
 where rl.kind = s.kind and rl.label = s.label;

-- Custom lines after the standards, in the order they were added.
update public.rate_lines rl set position = 1000 + r.rn
  from (select id, row_number() over (partition by schedule_id order by id) as rn
          from public.rate_lines where position is null) r
 where rl.id = r.id;

-- One line per (schedule, kind, label) — the editor's lookups and the
-- pricing lookups both assume it, and nothing enforced it until now.
create unique index rate_lines_schedule_kind_label_key
  on public.rate_lines (schedule_id, kind, label);
