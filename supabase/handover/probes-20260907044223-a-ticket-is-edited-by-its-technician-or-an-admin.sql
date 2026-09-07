-- Probes for 20260907044223 "a ticket is edited by its technician or an
-- admin". Run live on 7 Sept 2026 (UTC; the evening of the 6th in Grande
-- Prairie).
--
-- private.can_write_ticket is asked about one technician's draft under role
-- simulation: true for that technician, false for another technician, true
-- for an Admin, and false for a Coordinator when one exists. The live project
-- had no Coordinator account, so the fourth check was skipped and said so.
-- The three that ran passed.
do $$
declare owner uuid; other uuid; adm uuid; coord uuid; tk text; ok boolean;
begin
  select t.id, t.technician_id into tk, owner from public.tickets t
    join public.profiles p on p.id = t.technician_id
   where t.status = 'Draft' and t.approved_at is null and p.role = 'Technician' and p.deactivated_at is null limit 1;
  select id into other from public.profiles where role = 'Technician' and deactivated_at is null and id <> owner limit 1;
  select id into adm from public.profiles where role = 'Admin' and deactivated_at is null limit 1;
  select id into coord from public.profiles where role = 'Coordinator' and deactivated_at is null limit 1;
  if tk is null or other is null or adm is null then raise exception 'no fixtures'; end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated')::text, true);
  select private.can_write_ticket(tk) into ok;
  perform set_config('role', 'postgres', true);
  if not ok then raise exception 'FAIL 1: the technician cannot write their own draft'; end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', other, 'role', 'authenticated')::text, true);
  select private.can_write_ticket(tk) into ok;
  perform set_config('role', 'postgres', true);
  if ok then raise exception 'FAIL 2: another technician can write it'; end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  select private.can_write_ticket(tk) into ok;
  perform set_config('role', 'postgres', true);
  if not ok then raise exception 'FAIL 3: an Admin cannot write it'; end if;

  if coord is not null then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', coord, 'role', 'authenticated')::text, true);
    select private.can_write_ticket(tk) into ok;
    perform set_config('role', 'postgres', true);
    if ok then raise exception 'FAIL 4: a Coordinator can still write it'; end if;
    raise exception 'ROLLBACK_ON_PURPOSE all four passed (coordinator present)';
  end if;
  raise exception 'ROLLBACK_ON_PURPOSE three passed (no coordinator on file)';
end $$;
