-- An invoice has a number. Applied live 6 Sept 2026 as 20260906154840, after
-- 20260906154650; the search_tickets here is the merged definition carrying
-- both migrations' columns. Probed with role simulation (probes beside it).
--
-- Why: the document a client signs has never carried the things that make a
-- bill payable by an accounts department — a number to quote, the terms, the
-- GST registration, and where to send the money. So every approved ticket was
-- typed a second time into another program to become the real invoice, which
-- is both a second record of one bill and the place transcription mistakes
-- come from. This puts the number and the words on the document the client
-- already has.
--
-- 1 · tickets.invoice_number, and the series it comes from.
-- 2 · mark_tickets_invoiced stamps it — the only writer there is.
-- 3 · The tickets insert policy pins the new column empty, like the rest of
--     the billing plumbing.
-- 4 · Three app_settings columns: terms, remit-to, GST number.
-- 5 · search_tickets carries the number, so the tracker can show it.

-- ── 1 · the number ───────────────────────────────────────────────────────
-- Starts at 1000 because an invoice numbered 1 tells a client's accounts
-- department how much work the company has ever billed. `as integer` so the
-- series and the column share a ceiling rather than the sequence quietly
-- outgrowing what the column can hold.
--
-- Deliberately not `owned by` the column: the series is the office's, and a
-- column dropped and re-added in some later migration must not take the
-- numbering with it. To continue a series that started in another program,
-- an owner runs `alter sequence public.invoice_number_seq restart with N`
-- once, before the first invoice is marked here. (Same command after a
-- restore into a fresh project, set past the highest number restored — the
-- backup carries the tickets, not the sequence.)
create sequence if not exists public.invoice_number_seq as integer start with 1000;

-- Nobody but the definer function below needs the series, and a signed-in
-- account calling nextval() would burn numbers out of the middle of it. The
-- function runs as the owner, so revoking costs it nothing. (Supabase's
-- default privileges grant sequences in public to anon and authenticated,
-- which is why this has to be said out loud.)
revoke all on sequence public.invoice_number_seq from public, anon, authenticated;

alter table public.tickets add column if not exists invoice_number integer;

-- Unique, and only among the tickets that have one: a number that appears on
-- two bills is the one failure this column exists to prevent. Partial, so the
-- thousands of tickets that were never invoiced don't sit in the index.
create unique index if not exists tickets_invoice_number_key
  on public.tickets (invoice_number) where invoice_number is not null;

-- ── 2 · marking invoiced is what stamps it ───────────────────────────────
-- Re-created whole from 20260903010110 §1, with the same Admin check: the
-- only change is the number. The app's ticket editor never writes this
-- column — it cannot, the UPDATE grant on tickets names five columns and
-- this is not one of them — so this function is the single writer.
--
-- coalesce keeps an existing number: un-invoicing (the else branch) clears
-- the status and the date but leaves the number where it is, so a ticket
-- pulled back, corrected and re-invoiced goes out under the number the
-- client already has in their system. Renumbering it would be a second
-- invoice for one job in their ledger, and a gap in ours.
--
-- coalesce does not evaluate nextval when the first argument is non-null, so
-- a re-invoice does not burn a number; if a future Postgres ever did, the
-- coalesce still keeps the old number and the cost is a gap in the series.
create or replace function public.mark_tickets_invoiced(p_ids text[], p_invoiced boolean default true)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'Only an admin can mark a ticket invoiced.' using errcode = '42501';
  end if;
  if p_invoiced then
    update public.tickets
       set status = 'Invoiced',
           invoiced_at = now(),
           invoice_number = coalesce(invoice_number, nextval('public.invoice_number_seq'))
     where id = any(p_ids) and status = 'Approved' and approved_at is not null;
  else
    update public.tickets set status = 'Approved', invoiced_at = null
     where id = any(p_ids) and status = 'Invoiced';
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.mark_tickets_invoiced(text[], boolean) from public, anon;
grant execute on function public.mark_tickets_invoiced(text[], boolean) to authenticated;

-- ── 3 · a new ticket carries no number ───────────────────────────────────
-- Re-created whole from 20260903095901 §1 with one clause added. A policy
-- cannot pin a column it does not name, and the same gap in the approval
-- columns once let a technician plant a token hash on a ticket they were
-- inserting. Without this, a technician could insert a draft already holding
-- an invoice number of their choosing: coalesce above would keep it, and the
-- bill would print under a number the office never issued.
drop policy if exists "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert to authenticated
  with check (
    (select is_staff())
    and (technician_id = (select auth.uid())
         or (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text]))
    and status = 'Draft'
    and total = 0
    and approved_at is null and approved_by_email is null and approved_ip is null
    and approved_signature is null
    and approval_token is null and approval_sent_at is null and approval_expires_at is null
    and approval_sent_to is null and approval_sent_by is null
    and invoiced_at is null and chased_at is null
    and invoice_number is null
    and queried_at is null and query_text is null and query_by is null
  );

-- ── 4 · what the invoice says besides the money ──────────────────────────
-- Ordinary columns on the one enforced app_settings row: the table's grants
-- are table-wide and its policies are Admin-only whole-row, so there is
-- nothing else to change. They ride the automatic backup and come back from
-- a restore without a code change either — backup-run dumps app_settings
-- with select *, and settingsRestorePatch writes back every column that is
-- neither a credential nor one of the backup_* columns a restore must not
-- touch.
--
-- Free text on purpose: "Net 30 days" and "Due on receipt" are both terms,
-- and a remit-to block is an address, which is several lines of whatever the
-- bank and the business need it to say.
alter table public.app_settings
  add column if not exists invoice_terms text,
  add column if not exists invoice_remit_to text,
  add column if not exists business_number text;

-- ── 5 · the tracker can see the number ───────────────────────────────────
-- Re-created whole from 20260903095901 §2 — every column it returned is
-- still returned, in the same order, and the null-money rule is untouched:
-- `total` and `filtered_total` are still null for a role that may not see
-- prices. invoice_number is not money and is not gated: it is the reference
-- the office quotes on the phone, and a Coordinator chasing payment needs to
-- be able to say it. Added at the END of the record, because a returns-table
-- record is positional to anything reading it by index and the app reads it
-- by name.
--
-- This is the merged definition: 20260906… a-client-may-be-gst-exempt lands
-- first and appends client_gst_rate; this one keeps that column and appends
-- invoice_number and client_id after it, so the two migrations applied in
-- order leave one search_tickets carrying all three. client_id is the
-- accounting export's customer reference — not money, not gated.
drop function if exists public.search_tickets(text, integer, integer, text, date, date);
create function public.search_tickets(
  status_filter text default 'All', page_num integer default 0, page_size integer default 10,
  q text default '', date_from date default null, date_to date default null)
returns table(id text, work_date date, status text, total numeric, created_at timestamp with time zone,
              job_number text, project text, client_name text, technician_name text,
              chased_at timestamp with time zone, invoiced_at timestamp with time zone,
              queried_at timestamp with time zone, query_text text, query_by text,
              total_count bigint, filtered_total numeric, client_gst_rate numeric,
              invoice_number integer, client_id uuid)
language sql stable set search_path to 'public' as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(q, '') = '' as blank,
           (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as priced
  ),
  hit as (
    select t.id, t.work_date, t.status,
           case when esc.priced then t.total end as total,
           t.created_at, t.chased_at, t.invoiced_at,
           t.queried_at, t.query_text, t.query_by, t.invoice_number,
           j.job_number, j.project, c.name as client_name, p.name as technician_name,
           c.gst_rate as client_gst_rate, j.client_id
      from public.tickets t
      cross join esc
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
     where (status_filter = 'All'
            or (status_filter = 'Over 7 days' and t.status = 'Awaiting approval' and now() - t.created_at > interval '7 days')
            or t.status = status_filter)
       and (esc.blank
            or t.id ilike esc.pat or j.job_number ilike esc.pat
            or j.project ilike esc.pat or c.name ilike esc.pat or p.name ilike esc.pat)
       and (date_from is null or t.work_date >= date_from)
       and (date_to is null or t.work_date <= date_to)
  )
  select h.id, h.work_date, h.status, h.total, h.created_at, h.job_number, h.project, h.client_name,
         h.technician_name, h.chased_at, h.invoiced_at, h.queried_at, h.query_text, h.query_by,
         count(*) over () as total_count,
         -- null for roles that don't see prices: every h.total is null for them.
         sum(h.total) over () as filtered_total,
         -- Not money. A ticket whose job has no client has no rate, and the
         -- app reads that absence as the ordinary 5%.
         h.client_gst_rate,
         h.invoice_number,
         h.client_id
    from hit h
   order by h.created_at desc, h.id desc
  offset page_num * page_size limit page_size;
$$;
revoke execute on function public.search_tickets(text, integer, integer, text, date, date) from public, anon;
grant execute on function public.search_tickets(text, integer, integer, text, date, date) to authenticated;
