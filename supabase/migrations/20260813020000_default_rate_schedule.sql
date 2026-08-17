-- The Default rates card is a rate_schedules row with no client attached,
-- so it uses the same editor, line types and publish flow as a client
-- schedule. That needs client_id to allow null.
--
-- Folded in from the standalone ALLOW-DEFAULT-SCHEDULE.sql runbook. Safe to
-- run more than once.

alter table public.rate_schedules alter column client_id drop not null;

-- One house default, enforced rather than trusted: a second one would make
-- "the default" ambiguous and Fill from default would pick arbitrarily.
create unique index if not exists rate_schedules_one_default
  on public.rate_schedules ((client_id is null)) where client_id is null;

-- Create it if it is not there yet, so the page has something to open.
insert into public.rate_schedules (client_id, effective_from)
select null, current_date
where not exists (select 1 from public.rate_schedules where client_id is null);
