-- Crew assignment, dose tracking and timesheets.
--
-- Three shifts here:
--
-- 1. People get real first and last names. `name` stays as the display
--    string every existing screen already reads, so nothing breaks — it is
--    now derived from the two parts rather than being the only source.
--
-- 2. A ticket gets a crew instead of a single technician. The ticket still
--    carries ONE billed hours figure (the client is invoiced once); the crew
--    rows record hours landing on each persons timesheet, plus their
--    own dose and mileage. `technician_id` stays as the ticket's raiser.
--
-- 3. Timesheets are approved per person per pay period, so approval is its
--    own small table rather than a flag on anything.

-- ── 0. The permission helper ──────────────────────────────────────────
-- Policies below ask "does the signed-in user have this tab?". Defining it
-- here rather than assuming it: a migration that depends on a helper it
-- does not create fails on any database that has not got it.
--
-- SECURITY DEFINER so it can read profiles without tripping row-level
-- security on that table, and the parameter is prefixed so it is not
-- mistaken for the column it is compared against.
create or replace function public.has_tab(_tab text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and _tab = any (p.tab_access)
  );
$$;

grant execute on function public.has_tab(text) to authenticated;

-- ── 1. Names and worker type ──────────────────────────────────────────
alter table public.profiles
  add column if not exists first_name       text,
  add column if not exists last_name        text,
  add column if not exists is_subcontractor boolean not null default false;

-- Backfill from the existing "D. Kowalchuk" display strings. An initial is
-- not a first name, so those land in first_name as-is and can be corrected
-- in Users & access — better than inventing a name the person does not use.
update public.profiles
set first_name = coalesce(first_name, split_part(name, ' ', 1)),
    last_name  = coalesce(last_name,  nullif(substring(name from position(' ' in name) + 1), ''))
where first_name is null or last_name is null;

-- ── 2. Ticket crew ────────────────────────────────────────────────────
create table if not exists public.ticket_crew (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      text not null references public.tickets(id) on delete cascade,
  profile_id     uuid not null references public.profiles(id) on delete restrict,
  crew_role      text not null default 'Technician',
  straight_hours numeric(6,2) not null default 0,
  ot_hours       numeric(6,2) not null default 0,
  -- Solo hours: a tech working the shot alone, with no assistant. Tracked
  -- apart from regular hours because it is a different rate and often has to
  -- be reported separately, not because it is extra time on top.
  solo_hours     numeric(6,2) not null default 0,
  solo_ot_hours  numeric(6,2) not null default 0,
  -- Dose is recorded in mR (milliroentgen), per person per ticket.
  dose_mr        numeric(8,2) not null default 0,
  -- Subcontractors invoice their own mileage, so it is per person here rather
  -- than only the single billed mileage line on the ticket.
  mileage_km     numeric(8,1) not null default 0,
  created_at     timestamptz not null default now(),
  unique (ticket_id, profile_id)
);

-- Added after this table first shipped, so guarded for databases that
-- already have it.
alter table public.ticket_crew
  add column if not exists solo_hours    numeric(6,2) not null default 0,
  add column if not exists solo_ot_hours numeric(6,2) not null default 0;

create index if not exists ticket_crew_profile_idx on public.ticket_crew (profile_id);
create index if not exists ticket_crew_ticket_idx  on public.ticket_crew (ticket_id);

alter table public.ticket_crew enable row level security;

drop policy if exists "crew read"  on public.ticket_crew;
drop policy if exists "crew write" on public.ticket_crew;

create policy "crew read" on public.ticket_crew
  for select to authenticated using (true);

create policy "crew write" on public.ticket_crew
  for all to authenticated
  using (public.has_tab('ticket') or public.has_tab('timesheets'))
  with check (public.has_tab('ticket') or public.has_tab('timesheets'));

-- Existing tickets predate crews: seed each one with its raiser, carrying the
-- hours already billed on it, so timesheets are not empty on day one.
insert into public.ticket_crew (ticket_id, profile_id, crew_role, straight_hours, ot_hours)
select t.id, t.technician_id, 'Lead',
       coalesce((select sum(l.quantity) from public.ticket_lines l
                 where l.ticket_id = t.id and l.label ilike '%straight%'), 0),
       coalesce((select sum(l.quantity) from public.ticket_lines l
                 where l.ticket_id = t.id and l.label ilike '%overtime%'), 0)
from public.tickets t
where t.technician_id is not null
  and not exists (select 1 from public.ticket_crew c where c.ticket_id = t.id)
on conflict do nothing;

-- ── 3. Timesheet approvals ────────────────────────────────────────────
create table if not exists public.timesheet_approvals (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  approved_at  timestamptz not null default now(),
  approved_by  uuid references public.profiles(id),
  unique (profile_id, period_start)
);

alter table public.timesheet_approvals enable row level security;

drop policy if exists "timesheet approvals read"  on public.timesheet_approvals;
drop policy if exists "timesheet approvals write" on public.timesheet_approvals;

create policy "timesheet approvals read" on public.timesheet_approvals
  for select to authenticated using (true);

create policy "timesheet approvals write" on public.timesheet_approvals
  for all to authenticated
  using (public.has_tab('timesheets')) with check (public.has_tab('timesheets'));

-- ── 4. Grant the new tab ──────────────────────────────────────────────
-- Timesheets are an admin/coordinator view, so it is not handed to everyone
-- the way Files was — only accounts that can already see the billing tracker.
update public.profiles
set tab_access = array_append(tab_access, 'timesheets')
where 'tracker' = any (tab_access)
  and not ('timesheets' = any (tab_access));
