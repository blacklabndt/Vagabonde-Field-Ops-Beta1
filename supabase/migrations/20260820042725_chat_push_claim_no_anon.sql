-- The security advisor's point, taken: claim_push_subscription is
-- SECURITY DEFINER, and Postgres grants EXECUTE on public functions to
-- everyone by default — so a signed-out visitor could reach it through
-- the REST API. Its own first line already refuses them (no auth.uid(),
-- no chat tab), so nothing was exploitable; this just stops anon at the
-- door instead of in the hallway. Signed-in accounts keep it.

revoke execute on function public.claim_push_subscription(text, text, text) from public, anon;
grant execute on function public.claim_push_subscription(text, text, text) to authenticated;
