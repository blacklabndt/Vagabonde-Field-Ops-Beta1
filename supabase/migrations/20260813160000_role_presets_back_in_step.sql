-- Role presets had drifted from the app.
--
-- public.tabs_for_role() (20260813030000) is what the signup trigger seeds a
-- new account's tab_access from. ROLE_PRESETS in data.js is what the app
-- believes each role gets. Two tabs were added to the app after that function
-- was written and never added here, so every account created since has been
-- provisioned short:
--
--   equipment  — worse than a missing menu entry: the equipment write policy
--                is `has_tab('equipment') and role in (Admin, Coordinator)`,
--                so a new Admin could not add or edit equipment at all, and
--                the failure surfaced as a row that silently would not save.
--   mytickets  — the Open tickets screen, which no preset has ever granted,
--                so nobody has had it in their menu without an admin ticking
--                the box by hand.
--
-- Also adds 'contacts' explicitly. The app treats it as universal (see
-- UNIVERSAL_TABS in common.jsx) and the contacts policies are open to any
-- signed-in account, so nothing was broken by its absence — but a tab_access
-- list that says what the app shows is easier to reason about than one that
-- relies on a client-side addition.
--
-- Safe to run more than once.

create or replace function public.tabs_for_role(_role text)
returns text[]
language sql
immutable
as $$
  select case _role
    when 'Admin'       then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','rates','tracker','users']
    when 'Coordinator' then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','tracker']
    when 'Helper'      then array['board','job','jha','files','contacts']
    when 'Technician'  then array['board','job','jha','upload','ticket','mytickets','files','contacts']
    -- Any role this function has not been taught yet still gets a working
    -- account rather than a failed signup.
    else array['board','job','files','contacts']
  end;
$$;

-- Top up existing accounts with only the tabs this migration adds, in the
-- style of the earlier ones (files, equipment, timesheets). Deliberately not
-- "reset everyone to their preset": an admin who has hidden a section from
-- someone meant it, and a repair migration should not quietly undo that.
update public.profiles
set tab_access = array_append(tab_access, 'contacts')
where not ('contacts' = any (tab_access));

update public.profiles
set tab_access = array_append(tab_access, 'mytickets')
where 'ticket' = any (tab_access)
  and not ('mytickets' = any (tab_access));

update public.profiles
set tab_access = array_append(tab_access, 'equipment')
where role in ('Admin', 'Coordinator')
  and not ('equipment' = any (tab_access));
