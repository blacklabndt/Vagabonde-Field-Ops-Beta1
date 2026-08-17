-- Nothing in this app told anyone when a background job actually failed —
-- if the report-email function 500'd, the tech saw "Uploaded, but the email
-- didn't go out" and could retry, but an Admin had no way to notice a
-- pattern (a bad API key, a broken template) without hearing about it from
-- an annoyed client. This table is where every Edge Function logs its own
-- failures; Users & access shows the most recent ones to an Admin.
create table if not exists public.function_errors (
  id uuid primary key default gen_random_uuid(),
  function_name text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_function_errors_created on public.function_errors (created_at desc);

alter table public.function_errors enable row level security;
drop policy if exists "function errors read" on public.function_errors;
create policy "function errors read" on public.function_errors
  for select to authenticated using (
    exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'Admin')
  );
-- No insert/update/delete policy: only the service role (each Edge
-- Function's admin client) ever writes here, which bypasses RLS entirely.
