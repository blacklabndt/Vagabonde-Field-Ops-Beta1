-- approval_sent_by is a plain uuid.
--
-- 20260902211209 gave tickets a second foreign key to profiles
-- (approval_sent_by beside technician_id). PostgREST resolves an embed by
-- foreign key, and with two candidates `profiles(name)` on tickets became
-- ambiguous (PGRST201) — every ticket list in the app (Job detail, Open
-- tickets, the tracker) came back as an error, and the e2e suite caught it
-- within the hour. The client embeds `profiles(name)` in more places than
-- are worth rewriting to `profiles!tickets_technician_id_fkey(name)`, so the
-- constraint goes and the column keeps its value as a plain uuid. Nothing
-- joins through it; delete-user never deletes a profile with work on file
-- (it locks the account instead), so nothing is left dangling.
alter table public.tickets drop constraint if exists tickets_approval_sent_by_fkey;
drop index if exists public.tickets_approval_sent_by_idx;
