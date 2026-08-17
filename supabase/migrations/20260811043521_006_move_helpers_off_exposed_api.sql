-- None of these four functions are meant to be called directly by the
-- client (RLS policies and triggers call them internally) — move them out
-- of the `public` schema so PostgREST stops auto-exposing them as RPCs,
-- rather than just gating them with grants.
create schema if not exists private;

alter function public.has_tab(text) set schema private;
alter function public.current_role_name() set schema private;
alter function public.lock_overrides_on_approval() set schema private;
alter function public.handle_new_auth_user() set schema private;

-- Recreate the policies/trigger that referenced the old public.* names.
drop policy profiles_insert on public.profiles;
drop policy profiles_update on public.profiles;
drop policy profiles_delete on public.profiles;
create policy profiles_insert on public.profiles for insert with check (private.has_tab('users'));
create policy profiles_update on public.profiles for update using (
  private.has_tab('users') and not (id = auth.uid() and not ('users' = any(tab_access)))
);
create policy profiles_delete on public.profiles for delete using (private.has_tab('users') and id <> auth.uid());

drop policy clients_select on public.clients;
drop policy clients_write on public.clients;
create policy clients_select on public.clients for select using (private.has_tab('board') or private.has_tab('job') or private.has_tab('rates'));
create policy clients_write on public.clients for all using (private.has_tab('board') or private.has_tab('rates')) with check (private.has_tab('board') or private.has_tab('rates'));

drop policy contractors_select on public.contractors;
drop policy contractors_write on public.contractors;
create policy contractors_select on public.contractors for select using (private.has_tab('board') or private.has_tab('job'));
create policy contractors_write on public.contractors for all using (private.has_tab('board')) with check (private.has_tab('board'));

drop policy contacts_select on public.contacts;
drop policy contacts_write on public.contacts;
create policy contacts_select on public.contacts for select using (private.has_tab('board') or private.has_tab('job'));
create policy contacts_write on public.contacts for all using (private.has_tab('board') or private.has_tab('job')) with check (private.has_tab('board') or private.has_tab('job'));

drop policy jobs_select on public.jobs;
drop policy jobs_insert on public.jobs;
drop policy jobs_update on public.jobs;
create policy jobs_select on public.jobs for select using (private.has_tab('board') or private.has_tab('job'));
create policy jobs_insert on public.jobs for insert with check (private.has_tab('board'));
create policy jobs_update on public.jobs for update using (private.has_tab('job') or private.has_tab('board'));

drop policy jhas_select on public.jhas;
drop policy jhas_insert on public.jhas;
create policy jhas_select on public.jhas for select using (private.has_tab('jha') or private.has_tab('job'));
create policy jhas_insert on public.jhas for insert with check (private.has_tab('jha'));

drop policy reports_select on public.reports;
drop policy reports_insert on public.reports;
create policy reports_select on public.reports for select using (private.has_tab('upload') or private.has_tab('job'));
create policy reports_insert on public.reports for insert with check (private.has_tab('upload') or private.has_tab('job'));

drop policy tickets_select on public.tickets;
drop policy tickets_insert on public.tickets;
drop policy tickets_update on public.tickets;
create policy tickets_select on public.tickets for select using (private.has_tab('ticket') or private.has_tab('job') or private.has_tab('tracker'));
create policy tickets_insert on public.tickets for insert with check (private.has_tab('ticket') or private.has_tab('job'));
create policy tickets_update on public.tickets for update using (
  (private.has_tab('ticket') or private.has_tab('job') or private.has_tab('tracker'))
  and approved_at is null
);

drop policy ticket_lines_select on public.ticket_lines;
drop policy ticket_lines_write on public.ticket_lines;
create policy ticket_lines_select on public.ticket_lines for select using (private.has_tab('ticket') or private.has_tab('job') or private.has_tab('tracker'));
create policy ticket_lines_write on public.ticket_lines for insert with check (
  exists (select 1 from public.tickets t where t.id = ticket_id and t.approved_at is null)
  and (private.has_tab('ticket') or private.has_tab('job'))
);

drop policy rate_schedules_all on public.rate_schedules;
drop policy rate_lines_all on public.rate_lines;
drop policy rate_overrides_select on public.rate_overrides;
drop policy rate_overrides_write on public.rate_overrides;
create policy rate_schedules_all on public.rate_schedules for all using (private.has_tab('rates')) with check (private.has_tab('rates'));
create policy rate_lines_all on public.rate_lines for all using (private.has_tab('rates')) with check (private.has_tab('rates'));
create policy rate_overrides_select on public.rate_overrides for select using (private.has_tab('rates') or private.has_tab('job'));
create policy rate_overrides_write on public.rate_overrides for all using (
  private.has_tab('rates') and not locked
) with check (private.has_tab('rates'));

drop policy audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select using (private.has_tab('users') or private.has_tab('rates'));

drop policy reports_bucket_read on storage.objects;
drop policy reports_bucket_write on storage.objects;
drop policy jhas_bucket_read on storage.objects;
drop policy jhas_bucket_write on storage.objects;
create policy reports_bucket_read on storage.objects for select
  using (bucket_id = 'reports' and (private.has_tab('upload') or private.has_tab('job')));
create policy reports_bucket_write on storage.objects for insert
  with check (bucket_id = 'reports' and (private.has_tab('upload') or private.has_tab('job')));
create policy jhas_bucket_read on storage.objects for select
  using (bucket_id = 'jhas' and (private.has_tab('jha') or private.has_tab('job')));
create policy jhas_bucket_write on storage.objects for insert
  with check (bucket_id = 'jhas' and private.has_tab('jha'));
