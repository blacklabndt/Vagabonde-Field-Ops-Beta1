-- The Admin screen's Recent background errors gets a Clear button. Admins
-- could only read function_errors; the delete stays behind a definer RPC
-- rather than a DELETE policy so `authenticated` never holds the grant, the
-- shape every other bulk door in the app takes (mark_tickets_invoiced,
-- archive_clear_jobs). Nothing else reads the log: delete-user, the restore
-- and this screen write or empty it, none of them depend on a row staying.
create or replace function public.clear_function_errors()
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'Only an admin can clear the error log.' using errcode = '42501';
  end if;
  delete from public.function_errors;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.clear_function_errors() from public, anon;
grant execute on function public.clear_function_errors() to authenticated;
