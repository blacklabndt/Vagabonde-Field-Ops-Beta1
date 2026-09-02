-- Found in review: the mail migration backfilled the 'mail' tab onto the
-- Admins that existed, but new Admin accounts get their tabs from this
-- function (create-user calls it by rpc) — and it was never taught the
-- tab. The first Admin the client creates after handover would have had
-- no Admin screen. The client-side ROLE_PRESETS and this list must stay
-- in step; this brings the database's half level again.
create or replace function public.tabs_for_role(_role text)
 returns text[]
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case _role
    when 'Admin'       then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','rates','tracker','users','mail','chat']
    when 'Coordinator' then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','tracker','chat']
    when 'Helper'      then array['board','job','jha','files','contacts','chat']
    when 'Technician'  then array['board','job','jha','upload','ticket','mytickets','files','contacts','chat']
    -- Any role this function has not been taught yet still gets a working
    -- account rather than a failed signup.
    else array['board','job','files','contacts']
  end;
$function$;
