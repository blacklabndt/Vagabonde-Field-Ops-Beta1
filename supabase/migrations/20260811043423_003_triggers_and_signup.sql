-- Auto-lock job-level rate overrides once any ticket on that job is
-- approved — matches "Overrides are locked once a ticket on the job is
-- client-approved" from the handoff, enforced in the database rather than
-- left to the client to remember.
create or replace function public.lock_overrides_on_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.approved_at is not null and (old.approved_at is null) then
    update public.rate_overrides set locked = true where job_id = new.job_id;
  end if;
  return new;
end;
$$;

create trigger tickets_lock_overrides
  after update on public.tickets
  for each row execute function public.lock_overrides_on_approval();

-- New auth.users row → seed a matching profile with that role's tab preset.
-- Reads name/role/cert out of the signup call's user_metadata; defaults to
-- Technician if the caller doesn't specify a role.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  chosen_role text := coalesce(new.raw_user_meta_data->>'role', 'Technician');
  preset text[];
begin
  preset := case chosen_role
    when 'Admin' then array['board','job','jha','upload','ticket','rates','tracker','users']
    when 'Coordinator' then array['board','job','jha','upload','ticket','tracker']
    else array['board','job','jha','upload','ticket']
  end;
  insert into public.profiles (id, name, role, cert, tab_access)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    chosen_role,
    new.raw_user_meta_data->>'cert',
    preset
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
