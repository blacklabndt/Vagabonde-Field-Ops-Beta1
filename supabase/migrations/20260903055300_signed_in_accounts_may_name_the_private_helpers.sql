-- The round-three search and stats functions run as the caller and call
-- private.user_role() by name. A policy expression is stored resolved, so
-- policies never needed schema USAGE — but a SQL-language function body is
-- parsed at call time with the caller's privileges, and authenticated had
-- no USAGE on private: "permission denied for schema private" on the
-- tracker for everyone, caught by the post-apply role probe. USAGE is
-- name resolution only; which private functions a signed-in account may
-- EXECUTE is still decided function by function (internal_secret and the
-- trigger bodies stay revoked), and PostgREST exposes only public.
grant usage on schema private to authenticated;
