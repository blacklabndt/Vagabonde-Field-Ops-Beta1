-- A signup can no longer name its own rank.
--
-- handle_new_user copied whatever role the signup's metadata claimed into
-- profiles.role — and the signup endpoint answers to anyone holding the
-- publishable key, which ships inside the app bundle by design. A stranger
-- could sign themselves up as 'Admin' and be provisioned every tab. The
-- trigger now honours only the two field roles a self-service signup could
-- honestly be; anything else lands as Technician. The privileged ranks
-- (Admin, Coordinator) are written afterwards by the create-user Edge
-- Function, which has verified its caller is a signed-in Admin and holds
-- the service key. With the app no longer calling signUp at all, public
-- sign-ups can also be switched off in the dashboard (Authentication →
-- Sign In / Up) without breaking account creation.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _role text := case
    when new.raw_user_meta_data ->> 'role' in ('Technician', 'Helper')
      then new.raw_user_meta_data ->> 'role'
    else 'Technician'
  end;
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
$function$;
