-- A client schedule can follow the house card. While the flag is on, the
-- client's tickets price from Default rates — live, tracking every edit the
-- default takes — and their own lines lie dormant, kept exactly as they
-- were for the day the flag is turned off again. The Rate admin screen
-- shows the flag as a switch, which is also the visible answer to "is this
-- client on house rates?" — replacing the one-shot Fill from default
-- button, which copied figures but left no trace of the intent.
alter table public.rate_schedules
  add column follows_default boolean not null default false;
