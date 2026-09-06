-- Probes for 20260906181829 "shared delete". Run live on 6 Sept 2026.
--
-- storage.objects refuses a direct DELETE from SQL (storage.protect_delete),
-- so the policy's USING predicate is evaluated under role simulation instead
-- of the delete itself: false for a Helper holding the files tab, true for an
-- Admin. Both passed.
do $$
declare helper uuid; adm uuid; ok boolean;
begin
  select id into helper from public.profiles where role = 'Helper' and deactivated_at is null and 'files' = any(tab_access) limit 1;
  select id into adm from public.profiles where role = 'Admin' and deactivated_at is null limit 1;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', helper, 'role', 'authenticated')::text, true);
  select ((select private.has_tab('files')) and (select private.user_role()) = any (array['Admin','Coordinator'])) into ok;
  perform set_config('role', 'postgres', true);
  if ok then raise exception 'FAIL 1: predicate true for a Helper'; end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  select ((select private.has_tab('files')) and (select private.user_role()) = any (array['Admin','Coordinator'])) into ok;
  perform set_config('role', 'postgres', true);
  if not ok then raise exception 'FAIL 2: predicate false for an Admin'; end if;

  raise exception 'ROLLBACK_ON_PURPOSE both passed';
end $$;
