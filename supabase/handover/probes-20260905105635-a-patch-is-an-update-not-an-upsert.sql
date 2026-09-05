-- Probes for restore_patch_rows (20260905105635).
--
-- READ ONLY, with one exception that is not: block 3 writes a job, a
-- ticket and two chat messages, patches them, and then raises so the whole
-- block rolls back. Nothing it makes survives — the raise is the rollback,
-- and running the block twice leaves the database exactly where it started.
-- Every other block only reads.
--
-- HOW TO RUN
--   Run each numbered block WHOLE. Blocks 0-3 fail before the migration is
--   applied (the function does not exist yet) and that IS their "before".
--   Apply, run them again, and read them against the assertions.
--
-- WHY THE FUNCTION EXISTS
--   Three columns are written back on their own after the load, and all
--   three were partial upserts. Block 0 is the proof that a partial upsert
--   could never have worked: Postgres builds the proposed tuple and checks
--   NOT NULL on it before it looks for the ON CONFLICT target, so a row of
--   {id, one column} is refused on a column it never named.

-- ═══ 0 · Why an upsert cannot do this (true before AND after) ══════════
-- BEFORE and AFTER, identically: every one of the three is REFUSED, on a
-- NOT NULL column the patch never mentioned —
--   jobs=REFUSED(null value in column "job_number" …)
--   tickets=REFUSED(null value in column "job_id" …)
--   chat=REFUSED(null value in column "profile_id" …)
-- The block raises at the end, so nothing it tried survives either way.
do $$
declare notes text := '';
begin
  begin
    insert into public.jobs (id, last_activity_at) values (gen_random_uuid(), now())
      on conflict (id) do update set last_activity_at = excluded.last_activity_at;
    notes := notes || 'jobs=ACCEPTED; ';
  exception when others then notes := notes || 'jobs=REFUSED(' || sqlerrm || '); ';
  end;
  begin
    insert into public.tickets (id, total) values (gen_random_uuid()::text, 0)
      on conflict (id) do update set total = excluded.total;
    notes := notes || 'tickets=ACCEPTED; ';
  exception when others then notes := notes || 'tickets=REFUSED(' || sqlerrm || '); ';
  end;
  begin
    insert into public.chat_messages (id, reply_to) values (gen_random_uuid(), null)
      on conflict (id) do update set reply_to = excluded.reply_to;
    notes := notes || 'chat=ACCEPTED; ';
  exception when others then notes := notes || 'chat=REFUSED(' || sqlerrm || '); ';
  end;
  raise exception 'PROBE %', notes;
end $$;

-- ═══ 1 · The function, and who may call it ═════════════════════════════
-- BEFORE: 0 rows.
-- AFTER: one row — security_definer t, search_path {search_path=public},
-- authenticated_may f, anon_may f, service_role_may t, owner postgres.
select 'the door' as probe,
       p.prosecdef                                               as security_definer,
       p.proconfig                                               as search_path,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_may,
       has_function_privilege('anon',          p.oid, 'execute') as anon_may,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role_may,
       pg_get_userbyid(p.proowner)                               as owner
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'restore_patch_rows';

-- ═══ 2 · Role simulation, and the pairs it refuses ═════════════════════
-- BEFORE: 42883, the function does not exist.
-- AFTER: PROBE authenticated=REFUSED(42501); profiles=REFUSED(restore_patch_rows
-- does not patch "profiles". …); null rows=0; empty rows=0;
--
-- 42501 is insufficient_privilege: a signed-in account has no execute
-- grant, so this is refused before the body is entered at all. The unknown
-- pair is refused by the body itself — the function knows three tables and
-- will not be talked into a fourth.
do $$
declare notes text := '';
begin
  begin
    set local role authenticated;
    perform public.restore_patch_rows('jobs', '[]'::jsonb);
    notes := notes || 'authenticated=ACCEPTED(!); ';
  exception when others then
    notes := notes || 'authenticated=REFUSED(' || sqlstate || '); ';
  end;
  reset role;
  begin
    perform public.restore_patch_rows('profiles', jsonb_build_array(jsonb_build_object('id', gen_random_uuid())));
    notes := notes || 'profiles=ACCEPTED(!); ';
  exception when others then notes := notes || 'profiles=REFUSED(' || sqlerrm || '); ';
  end;
  notes := notes || 'null rows=' || public.restore_patch_rows('jobs', null) || '; ';
  notes := notes || 'empty rows=' || public.restore_patch_rows('tickets', '[]'::jsonb) || '; ';
  raise exception 'PROBE %', notes;
end $$;

-- ═══ 3 · A real patch, on rows made for it and rolled back ═════════════
-- BEFORE: 42883, the function does not exist.
-- AFTER: PROBE jobs rows=1 now=2031-01-02 03:04:05+00; tickets rows=1
-- total=12345.67; chat rows=1 reply_to=<m1> body=probe two; absent id
-- rows=0; deferred triggers fired OK;
--
-- What each part is for:
--   · the ticket's own insert stamps the job with today, and the jobs patch
--     puts the backup's time back over it — the activity phase exactly;
--   · the ticket is Approved, which is the only kind whose total is written
--     back, and `set constraints all immediate` fires the deferred balance
--     trigger here rather than at a commit that never comes: an Approved
--     ticket is exempt, and this is where a mistake about that would show;
--   · the chat patch writes the quote and leaves the body alone;
--   · an id that is not on the table matches nothing and inserts nothing —
--     the difference between an UPDATE and the upsert this replaced.
--
-- The final raise rolls the whole block back. Confirm with block 4.
do $$
declare
  who uuid; j uuid; t text := 'ZZ-PROBE-TICKET'; m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  n integer; notes text := '';
begin
  select id into who from public.profiles where deactivated_at is null order by created_at limit 1;

  insert into public.jobs (job_number, project, created_by)
  values ('ZZ-PROBE-PATCH', 'probe, rolled back', who) returning id into j;

  insert into public.tickets (id, job_id, work_date, status, total)
  values (t, j, current_date, 'Approved', 0);

  insert into public.chat_messages (id, profile_id, body) values (m1, who, 'probe one');
  insert into public.chat_messages (id, profile_id, body) values (m2, who, 'probe two');

  n := public.restore_patch_rows('jobs',
    jsonb_build_array(jsonb_build_object('id', j, 'last_activity_at', '2031-01-02T03:04:05Z')));
  notes := notes || 'jobs rows=' || n || ' now=' || (select last_activity_at from public.jobs where id = j) || '; ';

  n := public.restore_patch_rows('tickets',
    jsonb_build_array(jsonb_build_object('id', t, 'total', 12345.67)));
  notes := notes || 'tickets rows=' || n || ' total=' || (select total from public.tickets where id = t) || '; ';

  n := public.restore_patch_rows('chat_messages',
    jsonb_build_array(jsonb_build_object('id', m2, 'reply_to', m1)));
  notes := notes || 'chat rows=' || n || ' reply_to=' || coalesce((select reply_to::text from public.chat_messages where id = m2), 'null')
                 || ' body=' || (select body from public.chat_messages where id = m2) || '; ';

  n := public.restore_patch_rows('jobs',
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'last_activity_at', now())));
  notes := notes || 'absent id rows=' || n || '; ';

  set constraints all immediate;
  notes := notes || 'deferred triggers fired OK; ';

  raise exception 'PROBE %', notes;
end $$;

-- ═══ 4 · Nothing block 3 made is still here ════════════════════════════
-- BEFORE and AFTER: 0, 0, 0.
select 'block 3 left nothing behind' as probe,
       (select count(*) from public.jobs where job_number like 'ZZ-PROBE%')      as probe_jobs,
       (select count(*) from public.tickets where id like 'ZZ-PROBE%')           as probe_tickets,
       (select count(*) from public.chat_messages where body like 'probe %')     as probe_messages;
