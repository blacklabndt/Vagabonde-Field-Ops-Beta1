-- The easter egg gets a leaderboard.
--
-- Everything else in Flappy 880 is deliberately self-contained: it touches
-- no table, no queue and no cache, and forgets everything when the dialog
-- closes. This is the one part that cannot be, because a high score nobody
-- else can see is just a number.
--
-- One row per player holding their best run, not one row per run. The board
-- only ever shows bests, and storing every attempt would put a write on the
-- database every time somebody flies into a pipe.

create table public.flappy_scores (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  best       integer not null check (best >= 0 and best <= 9999),
  updated_at timestamptz not null default now()
);

alter table public.flappy_scores enable row level security;

-- Anyone signed in can read the board; that is the entire point of it.
-- `to authenticated` and not `public`, because anon holds the same table
-- grants here and has no business reading the crew's names.
create policy "scores read" on public.flappy_scores
  for select to authenticated
  using (true);

-- You may only ever write your own row.
create policy "scores insert own" on public.flappy_scores
  for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy "scores update own" on public.flappy_scores
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- A best score only ever goes up. The client checks before it writes, but a
-- tab left open since before a good run would hand back the stale number and
-- reset the row, and losing a good run is the exact annoyance the feature
-- exists to avoid. A tie keeps the earlier timestamp, so whoever got there
-- first stays ahead of whoever matched it.
create or replace function public.flappy_keep_best()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.best <= old.best then
    new.best := old.best;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

create trigger flappy_scores_keep_best
  before update on public.flappy_scores
  for each row execute function public.flappy_keep_best();
