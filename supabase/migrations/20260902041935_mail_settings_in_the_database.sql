-- Email configuration moves from developer-set function secrets into a
-- table an Admin can edit from the app's Email setup screen. The software
-- ships to a client; their admin pastes a Resend API key and the sending
-- addresses themselves, with no CLI and nobody's terminal involved. The
-- send functions read this row with the service role (env vars remain as
-- fallback, so an install configured the old way keeps working).
--
-- One row, enforced: id is a boolean primary key that must be true, so
-- there is exactly one place the key can live.
create table public.mail_settings (
  id boolean primary key default true check (id),
  resend_api_key text,
  from_reports text,
  from_billing text,
  reply_to text,
  updated_at timestamptz not null default now()
);

alter table public.mail_settings enable row level security;

-- Admin only, read and write: the API key is a credential. Technicians
-- have no business seeing it, and the send functions bypass RLS with the
-- service role anyway.
create policy "mail_settings admin read" on public.mail_settings
  for select using ((select private.user_role()) = 'Admin');
create policy "mail_settings admin insert" on public.mail_settings
  for insert with check ((select private.user_role()) = 'Admin');
create policy "mail_settings admin update" on public.mail_settings
  for update using ((select private.user_role()) = 'Admin')
  with check ((select private.user_role()) = 'Admin');

grant select, insert, update on public.mail_settings to authenticated;

-- The Email setup screen rides the tab system like every other screen:
-- grant it to the Admins that exist today. New admins get it from the
-- role preset in the app.
update public.profiles
  set tab_access = tab_access || '{mail}'::text[]
  where role = 'Admin' and not (tab_access @> '{mail}'::text[]);
