-- Team chat: one room for the whole crew.
--
-- A message is a row; the tab is the permission, like everywhere else.
-- Anyone whose account carries the 'chat' tab reads the room and writes
-- as themselves; a message can be taken back by its author, or by an
-- Admin tidying up. No edits — a correction is a new message, which is
-- how a chat log stays an honest account of what was said.

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  -- Cascade, like arcade_scores: chat is conversation, not a work record,
  -- and a departed account must stay deletable from Users & access.
  profile_id uuid not null references public.profiles (id) on delete cascade,
  body text not null constraint chat_messages_body_says_something
    check (btrim(body) <> '' and length(body) <= 4000),
  created_at timestamptz not null default now()
);

-- The room is read newest-first, a page at a time.
create index chat_messages_recent on public.chat_messages (created_at desc, id desc);

alter table public.chat_messages enable row level security;

create policy chat_messages_select on public.chat_messages
  for select using ((select private.has_tab('chat')));

create policy chat_messages_insert on public.chat_messages
  for insert with check (
    (select private.has_tab('chat'))
    and profile_id = (select auth.uid())
  );

create policy chat_messages_delete on public.chat_messages
  for delete using (
    profile_id = (select auth.uid())
    or (select private.user_role()) = 'Admin'
  );

-- Live updates: being in the publication is what lets a phone hear a new
-- message without polling. Row-level security still decides who hears
-- what — a subscriber only receives rows their own read policy allows.
alter publication supabase_realtime add table public.chat_messages;

-- Every role gets the room. Kept in step with ROLE_PRESETS in data.js.
create or replace function public.tabs_for_role(_role text)
returns text[]
language sql
immutable
set search_path to 'public'
as $$
  select case _role
    when 'Admin'       then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','rates','tracker','users','chat']
    when 'Coordinator' then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','tracker','chat']
    when 'Helper'      then array['board','job','jha','files','contacts','chat']
    when 'Technician'  then array['board','job','jha','upload','ticket','mytickets','files','contacts','chat']
    -- Any role this function has not been taught yet still gets a working
    -- account rather than a failed signup.
    else array['board','job','files','contacts']
  end;
$$;

-- ...including everyone who already has an account.
update public.profiles
  set tab_access = tab_access || array['chat']
  where not (tab_access @> array['chat']);
