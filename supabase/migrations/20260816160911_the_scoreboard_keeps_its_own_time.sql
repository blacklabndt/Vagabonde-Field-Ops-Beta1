-- The scoreboard keeps its own time.
--
-- The client was stamping updated_at from its own clock, and that timestamp
-- decides who wins a tie -- earlier stays ahead. A phone with its clock set
-- wrong by an hour would rank its owner above people who genuinely got
-- there first, or behind people who didn't. The trigger already decides
-- whether a write counts; it now stamps the time of the ones that do, and
-- what the client sends for updated_at no longer matters.

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
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;
