-- Seed wipe: the load-test rows only, by their markers, keeping everything else.
--
-- The live project carries generated data alongside real records (see
-- CLAUDE.md, "Live data"). This removes what the markers identify and
-- nothing more:
--
--   - jobs numbered S-1…, with every ticket, line, crew row, JHA, report
--     and rate override filed against them;
--   - the staff accounts @seed.vagabonde.ca, with their profiles, chat,
--     reactions, read marks, push subscriptions, scores and audit rows;
--   - clients and contractors that only ever appeared on seed jobs, with
--     their contacts and per-client rate cards.
--
-- That last rule is the one to read twice: an organisation with no
-- non-seed job is treated as generated. A real client entered but never
-- given a job would go with them — run the preview first and look at the
-- names. wipe-seed-data.sql beside this file is the other script: it
-- empties the book entirely and is for the handover.
--
-- THIS IS DESTRUCTIVE AND NOT A MIGRATION. Run by hand, once.
--
-- Rehearse: run everything down to (not including) COMMIT, read the
-- receipt, then type COMMIT or ROLLBACK yourself.

begin;

-- Preview — the organisations this will remove. Read it before the deletes.
select 'client' as kind, c.name from public.clients c
 where not exists (select 1 from public.jobs j where j.client_id = c.id and j.job_number not like 'S-1%')
   and exists (select 1 from public.jobs j where j.client_id = c.id)
union all
select 'contractor', k.name from public.contractors k
 where not exists (select 1 from public.jobs j where j.contractor_id = k.id and j.job_number not like 'S-1%')
   and exists (select 1 from public.jobs j where j.contractor_id = k.id)
order by 1, 2;

create temporary table seed_jobs on commit drop as
  select id from public.jobs where job_number like 'S-1%';
create temporary table seed_people on commit drop as
  select u.id from auth.users u where u.email like '%@seed.vagabonde.ca';
create temporary table seed_clients on commit drop as
  select c.id from public.clients c
   where not exists (select 1 from public.jobs j where j.client_id = c.id and j.job_number not like 'S-1%')
     and exists (select 1 from public.jobs j where j.client_id = c.id);
create temporary table seed_contractors on commit drop as
  select k.id from public.contractors k
   where not exists (select 1 from public.jobs j where j.contractor_id = k.id and j.job_number not like 'S-1%')
     and exists (select 1 from public.jobs j where j.contractor_id = k.id);

-- Billing on seed jobs, and anything a seed person raised or worked.
create temporary table seed_tickets on commit drop as
  select t.id from public.tickets t
   where t.job_id in (select id from seed_jobs)
      or t.technician_id in (select id from seed_people)
      or exists (select 1 from public.ticket_crew c where c.ticket_id = t.id and c.profile_id in (select id from seed_people));
delete from public.ticket_crew  where ticket_id in (select id from seed_tickets);
delete from public.ticket_lines where ticket_id in (select id from seed_tickets);
delete from public.tickets      where id in (select id from seed_tickets);
delete from public.timesheet_approvals where profile_id in (select id from seed_people);
update public.timesheet_approvals set approved_by = null where approved_by in (select id from seed_people);

-- Field paperwork on seed jobs, or signed by seed people. A real assessment
-- a seed person merely closed out keeps its readings and loses the name.
update public.jhas set closed_by = null where closed_by in (select id from seed_people);
delete from public.jhas    where job_id in (select id from seed_jobs) or signed_by in (select id from seed_people);
delete from public.reports where job_id in (select id from seed_jobs);
delete from public.rate_overrides where job_id in (select id from seed_jobs);
-- A real job a seed account happened to raise (the e2e suite signs in as
-- two of them) keeps its records and loses the name.
update public.jobs set created_by = null where created_by in (select id from seed_people) and id not in (select id from seed_jobs);
delete from public.jobs where id in (select id from seed_jobs);

-- Their organisations, contacts and rate cards.
delete from public.contacts where (org_type = 'client' and org_id in (select id from seed_clients))
                                or (org_type = 'contractor' and org_id in (select id from seed_contractors));
delete from public.rate_line_history where changed_by in (select id from seed_people)
   or schedule_id in (select id from public.rate_schedules where client_id in (select id from seed_clients));
delete from public.rate_lines where schedule_id in (select id from public.rate_schedules where client_id in (select id from seed_clients));
delete from public.rate_schedules where client_id in (select id from seed_clients);
delete from public.clients where id in (select id from seed_clients);
delete from public.contractors where id in (select id from seed_contractors);

-- What the seed people said and did.
delete from public.chat_reactions where profile_id in (select id from seed_people);
delete from public.chat_reads where profile_id in (select id from seed_people);
update public.chat_messages set pinned_by = null where pinned_by in (select id from seed_people);
delete from public.chat_messages where profile_id in (select id from seed_people);
delete from public.push_subscriptions where profile_id in (select id from seed_people);
delete from public.arcade_scores where profile_id in (select id from seed_people);
delete from public.audit_log where actor_id in (select id from seed_people);
update public.tickets set approval_sent_by = null where approval_sent_by in (select id from seed_people);

-- The accounts themselves. Deleting the auth user cascades the profile.
delete from auth.users where id in (select id from seed_people);

-- The receipt. Rehearsing: read it, then COMMIT or ROLLBACK by hand.
select
  (select count(*) from public.jobs)     as jobs_left,
  (select count(*) from public.tickets)  as tickets_left,
  (select count(*) from public.clients)  as clients_left,
  (select count(*) from public.contacts) as contacts_left,
  (select count(*) from public.profiles) as profiles_left,
  (select count(*) from auth.users)      as accounts_left;

commit;
