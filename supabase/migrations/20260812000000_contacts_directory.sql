-- ─────────────────────────────────────────────────────────────────────────
-- Contacts directory
--
-- `contacts` started as a one-row-per-organisation cache: the New job dialog
-- wrote the rep it had just been given so the next job for that client
-- pre-filled. That is why it carried a unique constraint on
-- (org_type, org_id) — a second contact for the same client overwrote the
-- first.
--
-- Real clients have several people: a site rep who signs the JHA, an AP clerk
-- who receives the invoice, a night-shift foreman. This migration turns the
-- cache into a directory: many contacts per organisation, exactly one of them
-- flagged primary. "Primary" is what every existing pre-fill (New job, job
-- record, ticket email) reads, so those screens keep working unchanged.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.contacts
  add column if not exists title       text,
  add column if not exists notes       text,
  add column if not exists is_primary  boolean not null default false;

-- Deletes and edits address a row by id. The original table may have used the
-- (org_type, org_id) pair as its key, so make sure an id exists and is unique
-- before anything relies on it.
alter table public.contacts add column if not exists id uuid default gen_random_uuid();
update public.contacts set id = gen_random_uuid() where id is null;
alter table public.contacts alter column id set not null;
create unique index if not exists contacts_id_key on public.contacts (id);

-- Drop whatever unique constraint or index enforced one-contact-per-org. Its
-- name depends on how the table was first created, so find it rather than
-- guess: any unique constraint over exactly (org_type, org_id).
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public' and rel.relname = 'contacts' and con.contype = 'u'
       and (select array_agg(att.attname::text order by att.attname)
              from unnest(con.conkey) k
              join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k)
           = array['org_id', 'org_type']
  loop
    execute format('alter table public.contacts drop constraint %I', c.conname);
  end loop;
end $$;

drop index if exists public.contacts_org_type_org_id_key;
drop index if exists public.contacts_org_type_org_id_idx;

-- Every row that exists today was the only contact for its organisation, so it is
-- its primary. Done per organisation rather than table-wide: if a duplicate
-- somehow exists, only the most recently used of the pair is promoted, or the
-- partial index below would reject the whole statement.
update public.contacts c set is_primary = true
 where not exists (
   select 1 from public.contacts o
    where o.org_type = c.org_type and o.org_id = c.org_id and o.is_primary
 )
   and c.id = (
     select c2.id from public.contacts c2
      where c2.org_type = c.org_type and c2.org_id = c.org_id
      order by c2.last_used_at desc nulls last, c2.name
      limit 1
   );

-- At most one primary per organisation, enforced rather than trusted.
create unique index if not exists contacts_primary_per_org
  on public.contacts (org_type, org_id) where is_primary;

create index if not exists contacts_org_idx on public.contacts (org_type, org_id);

alter table public.contacts enable row level security;

drop policy if exists "contacts read"  on public.contacts;
drop policy if exists "contacts write" on public.contacts;

create policy "contacts read" on public.contacts
  for select to authenticated using (true);

-- Write is open to any signed-in account rather than gated on
-- has_tab('contacts'): creating a job writes the rep it was given, and every
-- role that can raise a job or a ticket has to be able to do that. The tab
-- only controls who sees the directory screen.
create policy "contacts write" on public.contacts
  for all to authenticated using (true) with check (true);
