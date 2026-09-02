-- The Email setup screen grows into the Admin screen: every vendor key
-- and deployment address the app needs, editable in one place, so the
-- client's admin can bring the whole app to life without a terminal.
-- mail_settings was named for its first tenant; the roster now includes
-- the KLIPY key (team chat GIFs) and the app's public address (where
-- ticket-approval links point). Policies and grants ride along with the
-- rename; env secrets remain the fallback for every column.
alter table public.mail_settings rename to app_settings;
alter policy "mail_settings admin read" on public.app_settings rename to "app_settings admin read";
alter policy "mail_settings admin insert" on public.app_settings rename to "app_settings admin insert";
alter policy "mail_settings admin update" on public.app_settings rename to "app_settings admin update";

alter table public.app_settings
  add column klipy_api_key text,
  add column approval_base_url text;
