-- Fixes "Database error saving new user": a role the trigger did not know
-- about (Helper) produced a null tab list, which profiles.tab_access
-- rejects as NOT NULL, and a role CHECK constraint that predated Helper
-- rejected the insert outright.
--
-- Also makes the trigger unable to block a signup ever again: if the
-- profile insert fails for any reason, the account is still created and the
-- row can be fixed in Users and access rather than the person being locked
-- out with an error that names nothing.
--
-- Folded in from the standalone FIX-NEW-USER.sql runbook. Safe to run more
-- than once.

-- === 1. Let the role column hold Helper ==============================
alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('Admin', 'Coordinator', 'Technician', 'Helper'));

-- === 2. Role presets live in one place ===============================
-- The app has the same table in data.js. Keeping it as a function means the
-- trigger below and any future backfill agree on what a role can see.
create or replace function public.tabs_for_role(_role text)
returns text[]
language sql
immutable
as $$
  select case _role
    when 'Admin'       then array['board','job','jha','upload','ticket','files','timesheets','rates','tracker','users']
    when 'Coordinator' then array['board','job','jha','upload','ticket','files','timesheets','tracker']
    when 'Helper'      then array['board','job','jha','files']
    when 'Technician'  then array['board','job','jha','upload','ticket','files']
    -- Any role this function has not been taught yet still gets a working
    -- account rather than a failed signup.
    else array['board','job','files']
  end;
$$;

-- === 3. The provisioning trigger =====================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _role text := coalesce(new.raw_user_meta_data ->> 'role', 'Technician');
  _name text := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));
begin
  begin
    insert into public.profiles (id, name, role, cert, tab_access)
    values (
      new.id,
      _name,
      _role,
      nullif(new.raw_user_meta_data ->> 'cert', ''),
      public.tabs_for_role(_role)
    )
    on conflict (id) do nothing;
  exception when others then
    -- Never take the signup down with the profile. The account exists and
    -- an admin can repair the row; the alternative is an error message
    -- that says only "Database error saving new user".
    raise warning 'profile provisioning failed for %: %', new.email, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- === 4. Repair any account that failed this way already ==============
insert into public.profiles (id, name, role, tab_access)
select u.id,
       coalesce(u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1)),
       coalesce(u.raw_user_meta_data ->> 'role', 'Technician'),
       public.tabs_for_role(coalesce(u.raw_user_meta_data ->> 'role', 'Technician'))
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- And top up anyone whose tab list is null or empty.
update public.profiles
set tab_access = public.tabs_for_role(role)
where tab_access is null or cardinality(tab_access) = 0;
