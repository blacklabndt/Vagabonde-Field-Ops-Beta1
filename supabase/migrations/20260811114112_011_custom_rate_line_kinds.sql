-- Rate admin's "+ Add line" boxes (custom weld size, custom method, custom
-- expense) need somewhere to land that's distinguishable from the standard
-- rows when re-rendering the three tables — widen the kind enum rather
-- than overload 'custom' with an ambiguous single bucket.
alter table public.rate_lines drop constraint rate_lines_kind_check;
alter table public.rate_lines add constraint rate_lines_kind_check
  check (kind in ('rt_film','rt_cr','rt_dr','method','expense','custom_weld','custom_method','custom_expense'));
