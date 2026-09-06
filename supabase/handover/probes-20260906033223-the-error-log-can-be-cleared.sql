-- Probes for 20260906033223 clear_function_errors(), run as postgres with role
-- simulation. Run live on 6 Sept 2026 as one DO block ending in a deliberate
-- raise, so the Admin clear in probe 2 rolled back: all three passed.
-- Each block is its own transaction and rolls back, so the log is untouched.

-- 1 · A Technician is refused (42501), and the rows stay.
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null limit 1), 'role', 'authenticated')::text, true);
do $$ begin
  perform public.clear_function_errors();
  raise exception 'FAIL: a Technician cleared the log';
exception when insufficient_privilege then raise notice 'PASS: technician refused'; end $$;
rollback;

-- 2 · An Admin clears it and gets the count back; the table is then empty.
begin;
insert into public.function_errors (function_name, message) values ('probe', 'probe row');
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null limit 1), 'role', 'authenticated')::text, true);
select public.clear_function_errors() as cleared;           -- expect >= 1
select count(*) as remaining from public.function_errors;    -- expect 0
rollback;

-- 3 · anon has no execute grant.
select has_function_privilege('anon', 'public.clear_function_errors()', 'execute') as anon_can;  -- expect false
select has_function_privilege('authenticated', 'public.clear_function_errors()', 'execute') as authenticated_can;  -- expect true
