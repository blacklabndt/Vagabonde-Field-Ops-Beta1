-- Indexes that can never be the best choice, because another index already
-- covers everything they do.
--
-- The tables carry far more index than data — `jobs` is 32 kB of rows under
-- 304 kB of index, `tickets` 8 kB under 136 kB — and every one of them is
-- considered by the planner on every query and maintained on every write.
--
-- Only provably redundant ones are dropped here. "Never scanned" on a
-- database this young mostly means "not scanned yet": the trigram indexes are
-- what the rewritten search_jobs() reaches for once there are enough rows to
-- prefer an index scan, and the foreign-key indexes added in
-- 20260814010000 exist for cascades that have not fired yet. Those stay.
--
-- What goes is only where index A is a strict prefix of index B, or a partial
-- copy of a unique index. In those cases B serves every query A could.

-- (status) is the leading column of (status, created_at desc).
drop index if exists public.idx_jobs_status;
drop index if exists public.idx_tickets_status;

-- A partial index on approval_token, alongside a UNIQUE index on the same
-- column across all rows. The unique one answers the approval-page lookup.
drop index if exists public.tickets_approval_token_idx;

-- (profile_id) is the leading column of the unique (profile_id, period_start).
drop index if exists public.idx_timesheet_approvals_profile;
