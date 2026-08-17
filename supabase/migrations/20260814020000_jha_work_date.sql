-- The date a hazard assessment covers, as distinct from when it was typed in.
--
-- A JHA is filled in at the start of the day's work. Sometimes it isn't — the
-- crew works, the paperwork gets missed, and it is written up two days later.
-- Until now the only date on the record was `signed_at`, so a JHA written up
-- late claimed to cover the day it was entered, and the rendered PDF printed
-- that date at the top.
--
-- Two dates, because they are two different facts and a safety document
-- should not blur them:
--
--   work_date  — the day the assessment applies to. Editable, and what the
--                PDF prints as "Date".
--   signed_at  — when this record was actually created. Not editable, and
--                what the PDF prints as "Filed".
--
-- `tickets` already carries `work_date` for the same reason, so this is the
-- vocabulary the schema already uses.

alter table public.jhas add column if not exists work_date date;

-- Existing rows were filed on the day they covered, so far as anyone knows.
-- Converted in Alberta time rather than UTC: an assessment filed at 19:00
-- local is already the next day in UTC, and would otherwise be backfilled
-- onto the wrong day.
update public.jhas
set work_date = (signed_at at time zone 'America/Edmonton')::date
where work_date is null and signed_at is not null;
