-- has_tab / current_role_name are safe as callable RPCs (security definer,
-- but they only ever read auth.uid()'s own row). The two trigger functions
-- are not meant to be invoked directly by clients — revoke that.
revoke execute on function public.lock_overrides_on_approval() from anon, authenticated;
revoke execute on function public.handle_new_auth_user() from anon, authenticated;
