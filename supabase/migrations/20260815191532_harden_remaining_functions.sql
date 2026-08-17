-- Function hardening the last pass missed.
--
-- 20260814090000 pinned search_path on the functions written that day. Eight
-- older ones never had it, and every function in `public` is exposed as an
-- RPC endpoint whether or not anyone meant it to be.
--
-- ── search_path ──────────────────────────────────────────────────────────
--
-- A function without a pinned search_path resolves its table and operator
-- names against whatever the caller's search_path happens to be. For a
-- SECURITY DEFINER function that is a privilege-escalation route: create a
-- table that shadows one it references, call it, and the body runs against
-- yours with the owner's rights. The invoker-rights ones here can't be
-- escalated that way, but they can be made to read the wrong table, which is
-- its own kind of wrong. `alter function ... set search_path` changes only
-- that setting — the bodies are untouched.
alter function public.jobs_refresh_search_text()          set search_path = public;
alter function public.refresh_jobs_search_text_for_org()  set search_path = public;
alter function public.search_org_directory(text, text, integer, integer) set search_path = public;
alter function public.tabs_for_role(text)                 set search_path = public;
alter function public.ticket_tracker_stats()              set search_path = public;
alter function public.equipment_stats()                   set search_path = public;
alter function public.search_equipment(text, integer, integer) set search_path = public;
alter function public.bulk_set_rate_lines(uuid[], numeric[])          set search_path = public;

-- ── who can call what ────────────────────────────────────────────────────
--
-- Supabase grants EXECUTE to `anon` and `authenticated` explicitly on
-- everything in `public`. That is why `revoke ... from public` on delete_job
-- in 20260815155943 did not actually stop anon calling it: the PUBLIC grant
-- went, the role's own grant stayed. Revoking has to name the role.
--
-- Trigger functions first. A trigger fires as part of the statement that set
-- it off and needs no EXECUTE grant on the function at all — the only thing
-- the grant does is publish it at /rest/v1/rpc/<name>, where calling it
-- directly does nothing good. handle_new_user is the sharpest of these: it is
-- SECURITY DEFINER and writes a profile row.
revoke execute on function public.handle_new_user()                  from anon, authenticated, public;
revoke execute on function public.log_rate_line_change()             from anon, authenticated, public;
revoke execute on function public.jobs_refresh_search_text()         from anon, authenticated, public;
revoke execute on function public.refresh_jobs_search_text_for_org() from anon, authenticated, public;

-- The policy helpers stay callable by signed-in users, because a policy
-- evaluates them as the querying role and 9 policies use is_staff() and 5 use
-- has_tab(). Signed out, they have nothing to say.
revoke execute on function public.is_staff()        from anon, public;
revoke execute on function public.has_tab(text)     from anon, public;

-- Everything else here answers only for the caller, so a signed-out call is
-- pointless at best. delete_job is the one that mattered.
revoke execute on function public.delete_job(uuid, uuid, boolean)        from anon, public;
revoke execute on function public.search_org_directory(text, text, integer, integer) from anon, public;
revoke execute on function public.search_equipment(text, integer, integer)     from anon, public;
revoke execute on function public.ticket_tracker_stats()                 from anon, public;
revoke execute on function public.equipment_stats()                      from anon, public;
revoke execute on function public.tabs_for_role(text)                    from anon, public;
revoke execute on function public.bulk_set_rate_lines(uuid[], numeric[])             from anon, public;
revoke execute on function public.next_ticket_number(text, date)         from anon, public;
