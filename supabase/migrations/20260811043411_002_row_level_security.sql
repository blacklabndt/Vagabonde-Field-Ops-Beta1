-- Helper: does the signed-in user have a given tab in their tab_access[]?
-- security definer so it can read profiles regardless of the caller's own
-- row-level policy on that table (avoids recursive-policy issues).
create or replace function public.has_tab(tab text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select tab in (select unnest(tab_access)) from public.profiles where id = auth.uid()),
    false
  );
$$;

create or replace function public.current_role_name()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.contractors enable row level security;
alter table public.contacts enable row level security;
alter table public.jobs enable row level security;
alter table public.jhas enable row level security;
alter table public.reports enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_lines enable row level security;
alter table public.rate_schedules enable row level security;
alter table public.rate_lines enable row level security;
alter table public.rate_overrides enable row level security;
alter table public.audit_log enable row level security;

-- profiles: everyone signed in can see the account list (needed for the
-- "Created by" column etc.); only Users & access can edit accounts, and an
-- admin can never remove their own admin access.
create policy profiles_select on public.profiles for select using (auth.uid() is not null);
create policy profiles_insert on public.profiles for insert with check (public.has_tab('users'));
create policy profiles_update on public.profiles for update using (
  public.has_tab('users') and not (id = auth.uid() and not ('users' = any(tab_access)))
);
create policy profiles_delete on public.profiles for delete using (public.has_tab('users') and id <> auth.uid());

-- clients / contractors / contacts: readable by anyone with board or job
-- access (dispatch needs client names; job detail needs contacts); writable
-- only from Home (new-job contact write-back) or Rate admin.
create policy clients_select on public.clients for select using (public.has_tab('board') or public.has_tab('job') or public.has_tab('rates'));
create policy clients_write on public.clients for all using (public.has_tab('board') or public.has_tab('rates')) with check (public.has_tab('board') or public.has_tab('rates'));

create policy contractors_select on public.contractors for select using (public.has_tab('board') or public.has_tab('job'));
create policy contractors_write on public.contractors for all using (public.has_tab('board')) with check (public.has_tab('board'));

create policy contacts_select on public.contacts for select using (public.has_tab('board') or public.has_tab('job'));
create policy contacts_write on public.contacts for all using (public.has_tab('board') or public.has_tab('job')) with check (public.has_tab('board') or public.has_tab('job'));

-- jobs: visible to anyone with the board or job tab (coordinators, techs,
-- admin); created from Home; edited from Job detail.
create policy jobs_select on public.jobs for select using (public.has_tab('board') or public.has_tab('job'));
create policy jobs_insert on public.jobs for insert with check (public.has_tab('board'));
create policy jobs_update on public.jobs for update using (public.has_tab('job') or public.has_tab('board'));

-- jhas / reports: field data, gated by their own tabs plus job detail (so
-- coordinators reviewing a job can see them even without jha/upload access).
create policy jhas_select on public.jhas for select using (public.has_tab('jha') or public.has_tab('job'));
create policy jhas_insert on public.jhas for insert with check (public.has_tab('jha'));

create policy reports_select on public.reports for select using (public.has_tab('upload') or public.has_tab('job'));
create policy reports_insert on public.reports for insert with check (public.has_tab('upload') or public.has_tab('job'));

-- tickets / ticket_lines: raised from the ticket tab or job detail; the
-- tracker (admin/coordinator) needs to see every ticket regardless of job.
create policy tickets_select on public.tickets for select using (public.has_tab('ticket') or public.has_tab('job') or public.has_tab('tracker'));
create policy tickets_insert on public.tickets for insert with check (public.has_tab('ticket') or public.has_tab('job'));
-- Freeze on client approval: once approved_at is set, no further edits —
-- enforced here, not just by the UI, per "Billing immutability".
create policy tickets_update on public.tickets for update using (
  (public.has_tab('ticket') or public.has_tab('job') or public.has_tab('tracker'))
  and approved_at is null
);

create policy ticket_lines_select on public.ticket_lines for select using (public.has_tab('ticket') or public.has_tab('job') or public.has_tab('tracker'));
create policy ticket_lines_write on public.ticket_lines for insert with check (
  exists (select 1 from public.tickets t where t.id = ticket_id and t.approved_at is null)
  and (public.has_tab('ticket') or public.has_tab('job'))
);

-- rates: admin-only surface end to end.
create policy rate_schedules_all on public.rate_schedules for all using (public.has_tab('rates')) with check (public.has_tab('rates'));
create policy rate_lines_all on public.rate_lines for all using (public.has_tab('rates')) with check (public.has_tab('rates'));
-- Overrides lock once any ticket on the job is approved — same immutability
-- rule as tickets, enforced at the row level.
create policy rate_overrides_select on public.rate_overrides for select using (public.has_tab('rates') or public.has_tab('job'));
create policy rate_overrides_write on public.rate_overrides for all using (
  public.has_tab('rates') and not locked
) with check (public.has_tab('rates'));

create policy audit_log_select on public.audit_log for select using (public.has_tab('users') or public.has_tab('rates'));
create policy audit_log_insert on public.audit_log for insert with check (auth.uid() is not null);
