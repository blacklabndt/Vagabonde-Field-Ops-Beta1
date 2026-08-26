-- The advisor's other point: pg_net registered itself in the public
-- schema (the one PostgREST exposes) when it was enabled for the chat
-- pipeline. It is not relocatable, so moving it means recreating it in
-- the extensions schema, where Supabase wants extension internals.
--
-- Safe to do in one transaction: everything that matters — net.http_post
-- and the request queue the chat trigger and the nightly retention cron
-- call — lives in pg_net's own `net` schema, which is recreated here,
-- and both callers name it at runtime rather than holding dependencies.
-- The only thing lost is the old request/response log rows.

drop extension pg_net;
create extension pg_net schema extensions;
