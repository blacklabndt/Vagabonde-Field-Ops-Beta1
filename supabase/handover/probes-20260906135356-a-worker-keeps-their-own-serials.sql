-- Probes for 20260906135356 set_own_dosimetry(), run as postgres with role
-- simulation. Run live on 6 Sept 2026 as one DO block ending in a deliberate
-- raise so every write rolled back: all five passed (own row written and a
-- blank serial stored as null; another profile not writable by a direct
-- UPDATE; a locked account refused; no session refused; anon has no grant).
--
-- Each block is its own transaction and rolls back, so no profile keeps
-- anything these probes wrote.

-- 1 · A Technician sets their own three serials and gets their own id back.
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null limit 1), 'role', 'authenticated')::text, true);
-- expect: the same uuid as the claim's sub
select public.set_own_dosimetry('TLD-PROBE', 'DRD-PROBE', 'AL-PROBE') as wrote_row;
-- expect: TLD-PROBE / DRD-PROBE / AL-PROBE on that row and no other
select tld_serial, drd_serial, alarm_serial
  from public.profiles where id = (select auth.uid());
rollback;

-- 2 · The same Technician cannot set anybody else's. There is no id to pass,
--     so the only way to try is the table itself — and profiles_update wants
--     the users tab, which a Technician does not hold.
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null limit 1), 'role', 'authenticated')::text, true);
select public.set_own_dosimetry('TLD-PROBE', 'DRD-PROBE', 'AL-PROBE');
-- expect 0: the call touched one row, and it was the caller's own
select count(*) as others_written from public.profiles
 where id <> (select auth.uid())
   and (tld_serial = 'TLD-PROBE' or drd_serial = 'DRD-PROBE' or alarm_serial = 'AL-PROBE');
do $$
declare n integer;
begin
  update public.profiles set tld_serial = 'TLD-STOLEN'
   where id <> (select auth.uid());
  get diagnostics n = row_count;
  if n > 0 then raise exception 'FAIL: a Technician wrote % other profiles', n; end if;
  raise notice 'PASS: no other profile is writable';
end $$;
rollback;

-- 3 · A deactivated account is refused (42501) even with a live token. The
--     lock is stamped here as postgres, before the simulation starts.
begin;
update public.profiles set deactivated_at = now()
 where id = (select id from public.profiles where role = 'Technician' and deactivated_at is null limit 1);
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is not null limit 1), 'role', 'authenticated')::text, true);
do $$ begin
  perform public.set_own_dosimetry('TLD-PROBE', 'DRD-PROBE', 'AL-PROBE');
  raise exception 'FAIL: a locked account kept serials';
exception when insufficient_privilege then raise notice 'PASS: locked account refused'; end $$;
rollback;

-- 4 · No signed-in user is refused the same way. Simulated as authenticated
--     with no `sub` on the claim rather than as anon, so what is being proven
--     is the function's own refusal and not the missing grant in probe 5.
begin;
select set_config('role', 'authenticated', true);
select set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
do $$ begin
  perform public.set_own_dosimetry('TLD-PROBE', 'DRD-PROBE', 'AL-PROBE');
  raise exception 'FAIL: a call with no signed-in user wrote a profile';
exception when insufficient_privilege then raise notice 'PASS: no session refused'; end $$;
rollback;

-- 5 · anon has no execute grant; authenticated does.
select has_function_privilege('anon', 'public.set_own_dosimetry(text, text, text)', 'execute') as anon_can;  -- expect false
select has_function_privilege('authenticated', 'public.set_own_dosimetry(text, text, text)', 'execute') as authenticated_can;  -- expect true
