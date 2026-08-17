-- A default for jhas.work_date, so the column is never null regardless of
-- which version of the app wrote the row.
--
-- The column was added before the client that populates it was deployed, so
-- assessments filed in between carry no date. The PDF falls back to the
-- filing timestamp for those, but "sometimes null depending on which build
-- the phone was running" is a bad property for a column other things will
-- come to rely on.
--
-- Alberta's date, not the server's. `current_date` on a UTC server rolls over
-- at 18:00 local, so an assessment filed at the end of a summer evening would
-- default to tomorrow — the same class of bug the app's own todayLocal()
-- exists to avoid.
alter table public.jhas
  alter column work_date set default ((now() at time zone 'America/Edmonton')::date);

update public.jhas
set work_date = (signed_at at time zone 'America/Edmonton')::date
where work_date is null and signed_at is not null;
