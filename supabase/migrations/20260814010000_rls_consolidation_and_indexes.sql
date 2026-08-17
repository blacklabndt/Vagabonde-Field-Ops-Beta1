-- Two generations of row-level security policies, reconciled.
--
-- The original schema named its policies `table_action` (contacts_select,
-- tickets_update). Later migrations added replacements named `table action`
-- (contacts read, tickets write) and dropped only their own names, so both
-- generations are live on four tables. Permissive policies OR together, which
-- has three consequences:
--
--   1. The wider policy always wins, so the narrower one is dead weight
--      evaluated on every row.
--   2. Anyone tightening the narrow policy later changes nothing at all,
--      while the migration they are reading says otherwise. That is the real
--      hazard here — a security fix that silently does nothing.
--   3. On `tickets` it has already cost a documented guarantee. See below.
--
-- Safe to run more than once.

-- === 1. Billing immutability, restored ===============================
-- `tickets_update` (original) allowed updates only while `approved_at is
-- null` — the handoff's billing-immutability rule, enforced in Postgres
-- rather than in the UI, which the README states as a property of this
-- system. `tickets write` (20260813110000) then granted FOR ALL on
-- is_staff() to relax *tab* gating, and being FOR ALL it ORs over the update
-- policy: any signed-in member of staff can currently edit or delete a ticket
-- the client has already approved, straight through the REST API. db.js
-- refuses to, but that is the UI check the handoff explicitly said not to
-- rely on.
--
-- Replaced with one policy per command, so relaxing tab gating and preserving
-- immutability stop being in tension.
drop policy if exists "tickets write" on public.tickets;
drop policy if exists tickets_select   on public.tickets;
drop policy if exists tickets_insert   on public.tickets;
drop policy if exists tickets_update   on public.tickets;
drop policy if exists tickets_delete   on public.tickets;

create policy "tickets select" on public.tickets
  for select to authenticated using (public.is_staff());

create policy "tickets insert" on public.tickets
  for insert to authenticated with check (public.is_staff());

-- An approved ticket is the client's document. A correction is a new ticket.
create policy "tickets update" on public.tickets
  for update to authenticated
  using (public.is_staff() and approved_at is null and status not in ('Approved', 'Invoiced'))
  with check (public.is_staff());

create policy "tickets delete" on public.tickets
  for delete to authenticated
  using (public.is_staff() and approved_at is null and status not in ('Approved', 'Invoiced'));

-- The approve-ticket Edge Function signs tickets with the service-role key,
-- which bypasses row-level security entirely, so approval still works.

-- === 2. ticket_lines could never be deleted ==========================
-- `ticket_lines` has RLS on, a SELECT policy and an INSERT policy — and
-- nothing permitting DELETE. Db.updateTicket replaces a draft's lines by
-- deleting them and re-inserting; the delete silently affected zero rows and
-- the insert added a second copy of every line. Nobody has hit it yet only
-- because no draft with lines on it has been reopened and saved. The next one
-- would have been billed twice over.
drop policy if exists ticket_lines_delete on public.ticket_lines;
create policy ticket_lines_delete on public.ticket_lines
  for delete to authenticated
  using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_lines.ticket_id and t.approved_at is null
    )
    and (public.has_tab('ticket') or public.has_tab('job'))
  );

-- === 3. Redundant duplicates from the first generation ===============
-- Each of these is strictly narrower than the policy that supersedes it, so
-- dropping them cannot take access away from anyone:
--   contacts_select / contacts_write  -> "contacts read" / "contacts write" (true)
--   jhas_select                       -> "jhas read"   (true)
--   jhas_insert  (has_tab('jha'))     -> "jhas insert" (is_staff(), broader)
drop policy if exists contacts_select on public.contacts;
drop policy if exists contacts_write  on public.contacts;
drop policy if exists jhas_select     on public.jhas;
drop policy if exists jhas_insert     on public.jhas;

-- === 4. auth.uid() evaluated once per query, not once per row ========
-- Postgres treats a bare auth.uid() inside a policy as volatile-per-row.
-- Wrapping it in a subquery lets the planner hoist it into an InitPlan.
-- 20260813040000 did this for public.has_tab(); private.has_tab() was missed,
-- and it backs most of the original policies, so fixing the function fixes
-- every policy that calls it in one go.
create or replace function private.has_tab(tab text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select tab = any (tab_access) from public.profiles where id = (select auth.uid())),
    false
  );
$$;

-- The four policies that call auth.uid() directly rather than through a helper.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using ((select auth.uid()) is not null);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (
    private.has_tab('users')
    and not (id = (select auth.uid()) and not ('users' = any (tab_access)))
  );

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete using (private.has_tab('users') and id <> (select auth.uid()));

drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log
  for insert with check ((select auth.uid()) is not null);

-- === 5. Duplicate indexes ============================================
-- Identical pairs created by two migrations that each added what they needed
-- without checking. The second copy of an index costs write throughput and
-- disk and buys nothing.
drop index if exists public.idx_contacts_org;           -- same as contacts_org_idx
drop index if exists public.contacts_id_key;            -- same as contacts_pkey
drop index if exists public.ticket_crew_profile_idx;    -- same as idx_ticket_crew_profile_id
drop index if exists public.ticket_crew_ticket_idx;     -- same as idx_ticket_crew_ticket_id

-- === 6. Foreign keys with no covering index ==========================
-- Every one of these is a join or a cascade the app actually performs.
create index if not exists idx_audit_log_actor_id
  on public.audit_log (actor_id);
create index if not exists idx_jobs_client_contact_id
  on public.jobs (client_contact_id);
create index if not exists idx_jobs_contractor_contact_id
  on public.jobs (contractor_contact_id);
create index if not exists idx_rate_line_history_changed_by
  on public.rate_line_history (changed_by);
create index if not exists idx_rate_line_history_rate_line_id
  on public.rate_line_history (rate_line_id);
