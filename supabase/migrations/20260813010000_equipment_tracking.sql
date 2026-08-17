create table if not exists public.equipment (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('Exposure device', 'Survey meter', 'Dosimeter', 'TLD / OSLD', 'Crank', 'Guide tube')),
  serial_number text,
  calibration_due date,
  assigned_to uuid references public.profiles(id) on delete set null,
  status text not null default 'In service' check (status in ('In service', 'Out for cal', 'Retired')),
  created_at timestamptz not null default now()
);

alter table public.equipment enable row level security;

-- Anyone signed in can read: JHA autofill (DRD/alarming-dosimeter serials by
-- assignment) needs this for every role that files a JHA, not just the roles
-- that see the Equipment tab. The tab only gates who sees the screen itself.
drop policy if exists "equipment select" on public.equipment;
create policy "equipment select" on public.equipment for select to authenticated
  using (true);

-- Only Admins/Coordinators can add/edit/retire equipment — has_tab already
-- gates the tab itself to those roles (see ROLE_PRESETS), but write access
-- is checked again here rather than trusted from the screen.
drop policy if exists "equipment write" on public.equipment;
create policy "equipment write" on public.equipment for all to authenticated
  using (public.has_tab('equipment') and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Admin', 'Coordinator')))
  with check (public.has_tab('equipment') and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Admin', 'Coordinator')));

create index if not exists idx_equipment_status on public.equipment (status);
create index if not exists idx_equipment_calibration_due on public.equipment (calibration_due);

-- Grant the new tab: equipment is an admin/coordinator view, so hand it to
-- accounts that already have Users & access (Admin) or Billing tracker
-- (Coordinator) rather than to everyone — matches ROLE_PRESETS in data.js.
update public.profiles
set tab_access = array_append(tab_access, 'equipment')
where ('users' = any (tab_access) or 'tracker' = any (tab_access))
  and not ('equipment' = any (tab_access));

-- Fix for a project where this table was already created (by an earlier
-- version of this migration) before "TLD / OSLD" was added to the allowed
-- list — `create table if not exists` above no-ops on an existing table, so
-- the live check constraint can be stuck on the old, narrower list. This
-- brings it in line with what the app expects. Safe to run more than once.
alter table public.equipment drop constraint if exists equipment_type_check;
alter table public.equipment add constraint equipment_type_check
  check (type in ('Exposure device', 'Survey meter', 'Dosimeter', 'TLD / OSLD', 'Crank', 'Guide tube'));
