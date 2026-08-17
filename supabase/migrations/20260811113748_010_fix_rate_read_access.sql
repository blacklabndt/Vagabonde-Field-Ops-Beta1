-- rate_schedules_all / rate_lines_all restricted reads to has_tab('rates')
-- only, which locks out the billing-ticket screen for Coordinators and
-- Technicians — they need to *read* the published schedule to price a
-- ticket, even though they can't edit it. Split select from write.
drop policy rate_schedules_all on public.rate_schedules;
drop policy rate_lines_all on public.rate_lines;

create policy rate_schedules_select on public.rate_schedules for select
  using (private.has_tab('rates') or private.has_tab('ticket') or private.has_tab('job'));
create policy rate_schedules_write on public.rate_schedules for insert with check (private.has_tab('rates'));
create policy rate_schedules_update on public.rate_schedules for update using (private.has_tab('rates'));
create policy rate_schedules_delete on public.rate_schedules for delete using (private.has_tab('rates'));

create policy rate_lines_select on public.rate_lines for select
  using (private.has_tab('rates') or private.has_tab('ticket') or private.has_tab('job'));
create policy rate_lines_write on public.rate_lines for insert with check (private.has_tab('rates'));
create policy rate_lines_update on public.rate_lines for update using (private.has_tab('rates'));
create policy rate_lines_delete on public.rate_lines for delete using (private.has_tab('rates'));
