-- The arcade grows a second cabinet, so the scoreboard generalises.
--
-- flappy_scores was one game's table. Rather than copy-paste a table,
-- trigger and three policies per easter egg, one arcade_scores table keyed
-- by (game, profile_id) holds every game's best runs: the flappy rows move
-- in under 'flappy880', the platformer arrives as 'superhelper', and the
-- next egg costs nothing but a new game string. Same rules as before:
-- anyone signed in reads the boards, you only ever write your own row, a
-- best only goes up, and the server stamps the time of writes it accepts.

create table public.arcade_scores (
  game       text not null check (char_length(game) between 1 and 40),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  best       integer not null check (best >= 0 and best <= 1000000),
  updated_at timestamptz not null default now(),
  primary key (game, profile_id)
);

alter table public.arcade_scores enable row level security;

create policy "arcade read" on public.arcade_scores
  for select to authenticated
  using (true);

create policy "arcade insert own" on public.arcade_scores
  for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy "arcade update own" on public.arcade_scores
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create or replace function public.arcade_keep_best()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.best <= old.best then
    new.best := old.best;
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger arcade_scores_keep_best
  before update on public.arcade_scores
  for each row execute function public.arcade_keep_best();

-- Move the flappy rows across, then retire the old table whole.
insert into public.arcade_scores (game, profile_id, best, updated_at)
select 'flappy880', profile_id, best, updated_at from public.flappy_scores;

drop trigger if exists flappy_scores_keep_best on public.flappy_scores;
drop function if exists public.flappy_keep_best();
drop table public.flappy_scores;
