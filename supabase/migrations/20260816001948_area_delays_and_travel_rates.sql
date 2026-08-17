-- The three fields the field invoice needs and the app did not have.
--
-- Taken from the real LEM ticket the crew hands a client rep (the Obsidian
-- Energy workbook), which the app's client-facing bill is being built to
-- match. Everything else on that sheet the app already held, once it was
-- clear that billing is per truck rather than per technician: the extra
-- technician rows on the paper ticket record who was in the truck, and only
-- one crew labour line is ever charged. ticket_crew already plays exactly
-- that role, and the money already comes off the client's rate card.
--
-- 1. jobs.area — where the work is, in the operator's own words ("McCool
--    Oilfield, Grande Prairie"). Distinct from jobs.project, which is the
--    internal name for the job, and from lsd, which is the legal location.
--
-- 2. tickets.delays — standby, waiting on the line, road bans. It belongs to
--    the day rather than to the job, so it sits on the ticket.
--
-- 3. Travel hours as rate lines rather than as new crew columns. The paper
--    ticket bills travel separately from hours worked, at its own rate. Two
--    more expense lines is all that takes, because a rate line already flows
--    through the whole chain — the rate card prices it, the ticket screen
--    offers it as a charge, and it lands on the invoice with everything else.
--    Seeded at 0 so they show up in Rate admin to be priced per client rather
--    than arriving with a number nobody agreed to.

alter table public.jobs    add column if not exists area   text;
alter table public.tickets add column if not exists delays text;

comment on column public.jobs.area is
  'Operator''s name for the area, e.g. "McCool Oilfield, Grande Prairie". Not the LSD, not the internal project name.';
comment on column public.tickets.delays is
  'Job delays for this day — standby, waiting on the line, road bans. Printed on the client''s field invoice.';

-- Travel lines on every schedule that does not already carry them, priced 0.
insert into public.rate_lines (schedule_id, kind, label, unit, rate)
select s.id, 'expense', v.label, 'h', 0
from public.rate_schedules s
cross join (values ('Travel — straight'), ('Travel — overtime')) as v(label)
where not exists (
  select 1 from public.rate_lines l
  where l.schedule_id = s.id and l.kind = 'expense' and l.label = v.label
);
