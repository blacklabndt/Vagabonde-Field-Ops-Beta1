-- Three access rules that were missing: who may edit a ticket, who may delete
-- a contact, and who may read someone's ID number.
--
-- Until now the policies asked only "which tabs do you have", never "is this
-- yours". Everyone with a login could edit anyone's draft ticket, wipe the
-- contact directory, and read every colleague's driver's licence number.

-- === 1. A ticket belongs to the technician who raised it =============
--
-- Reading stays wide open: seeing each other's tickets is wanted. Writing
-- does not. A ticket may now be changed by the person who raised it, or by
-- office staff whose job is billing — Admins and Coordinators, who finish
-- other people's drafts from the billing tracker. A technician can no longer
-- edit or cancel a colleague's ticket.
--
-- The approved/invoiced immutability from 20260814010000 is unchanged and
-- still applies on top of this.

drop policy if exists "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert to authenticated
  with check (
    (select public.is_staff())
    -- Raise it in your own name, unless you are office staff acting for
    -- someone else.
    and (technician_id = (select auth.uid())
         or (select private.user_role()) in ('Admin', 'Coordinator'))
  );

drop policy if exists "tickets update" on public.tickets;
create policy "tickets update" on public.tickets
  for update to authenticated
  using (
    (select public.is_staff())
    and approved_at is null
    and status not in ('Approved', 'Invoiced')
    and (technician_id = (select auth.uid())
         or (select private.user_role()) in ('Admin', 'Coordinator'))
  )
  with check (
    (select public.is_staff())
    and (technician_id = (select auth.uid())
         or (select private.user_role()) in ('Admin', 'Coordinator'))
  );

drop policy if exists "tickets delete" on public.tickets;
create policy "tickets delete" on public.tickets
  for delete to authenticated
  using (
    (select public.is_staff())
    and approved_at is null
    and status not in ('Approved', 'Invoiced')
    and (technician_id = (select auth.uid())
         or (select private.user_role()) in ('Admin', 'Coordinator'))
  );

-- Ticket lines follow the ticket they belong to, or a technician could edit a
-- colleague's charges without touching the ticket row.
drop policy if exists ticket_lines_write on public.ticket_lines;
create policy ticket_lines_write on public.ticket_lines
  for insert to authenticated
  with check (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_lines.ticket_id
        and t.approved_at is null
        and (t.technician_id = (select auth.uid())
             or (select private.user_role()) in ('Admin', 'Coordinator'))
    )
    and (select private.has_any_tab('ticket', 'job'))
  );

drop policy if exists ticket_lines_delete on public.ticket_lines;
create policy ticket_lines_delete on public.ticket_lines
  for delete to authenticated
  using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_lines.ticket_id
        and t.approved_at is null
        and (t.technician_id = (select auth.uid())
             or (select private.user_role()) in ('Admin', 'Coordinator'))
    )
    and (select private.has_any_tab('ticket', 'job'))
  );

-- === 2. Only admins delete contacts =================================
--
-- Adding and correcting stays open to staff: creating a job files the rep it
-- was given straight into the directory, so every role that can raise a job
-- has to be able to write here. Deleting is the destructive one, and it is
-- now an admin's to do.

drop policy if exists "contacts write" on public.contacts;

create policy "contacts insert" on public.contacts
  for insert to authenticated with check ((select public.is_staff()));

create policy "contacts update" on public.contacts
  for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

create policy "contacts delete" on public.contacts
  for delete to authenticated
  using ((select private.user_role()) = 'Admin');

-- === 3. ID numbers out of the shared row ============================
--
-- `profiles` cannot be closed to admins only: PostgREST embeds `profiles(name)`
-- into tickets, JHAs, equipment, crew rows, timesheets and rate history, and
-- the crew pickers list every technician. Locking the row would blank names
-- across the app and empty every crew dropdown.
--
-- What actually needed protecting was one column. `id_code` holds an NRCAN
-- number or a driver's licence, and it lived on a row every signed-in user
-- could read. It moves to its own table, readable only by the person it
-- belongs to and by admins. The rest of the profile stays visible, because
-- the app structurally depends on it.

create table if not exists public.profile_private (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  id_code    text,
  updated_at timestamptz not null default now()
);

insert into public.profile_private (profile_id, id_code)
select id, id_code from public.profiles where id_code is not null
on conflict (profile_id) do nothing;

alter table public.profile_private enable row level security;

drop policy if exists "own or admin reads id code" on public.profile_private;
create policy "own or admin reads id code" on public.profile_private
  for select to authenticated
  using (profile_id = (select auth.uid()) or (select private.has_any_tab('users')));

drop policy if exists "own or admin writes id code" on public.profile_private;
create policy "own or admin writes id code" on public.profile_private
  for all to authenticated
  using (profile_id = (select auth.uid()) or (select private.has_any_tab('users')))
  with check (profile_id = (select auth.uid()) or (select private.has_any_tab('users')));

-- The old column goes, or it would still be readable by everyone and the two
-- copies would drift. `select *` simply returns one fewer column, so a client
-- that has not been redeployed keeps working for reads.
alter table public.profiles drop column if exists id_code;
