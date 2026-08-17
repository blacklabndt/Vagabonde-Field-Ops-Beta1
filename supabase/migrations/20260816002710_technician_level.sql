-- The certification level that prints beside a technician's name on the
-- client's field invoice.
--
-- The paper ticket has two columns per person and the app only had one: an
-- "ID code" holding the CEDO / CGSB number, which fills CGSB #. LEVEL is a
-- separate thing — the grade the number was issued at — and the ticket prints
-- its own legend for it at the foot of the labour block:
--
--   S = Specialist · T2 = Level 2 Certified Technician
--   T1 = Level 1 Certified Technician · C = CEDO
--   T = Trainee · A = Administrative
--
-- Constrained to exactly those six rather than left free text, because the
-- legend on the invoice is printed from the same list. Free text lets someone
-- type "Level II" and produce a ticket whose legend explains codes the ticket
-- does not use.
--
-- profiles.cert is left alone. It is a different field with a different job
-- ("Certification" in Users & access) and it already appears elsewhere.

alter table public.profiles add column if not exists level text;

alter table public.profiles drop constraint if exists profiles_level_check;
alter table public.profiles add constraint profiles_level_check
  check (level is null or level in ('S', 'T2', 'T1', 'C', 'T', 'A'));

comment on column public.profiles.level is
  'Certification level printed on the client field invoice: S, T2, T1, C, T or A. See the legend in the LABOUR COSTS block.';
