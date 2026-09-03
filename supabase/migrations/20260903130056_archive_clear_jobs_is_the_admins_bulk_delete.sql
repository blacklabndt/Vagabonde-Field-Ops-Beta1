-- The one bulk delete in the app: the jobs an Admin has just archived from
-- Home, and everything filed against them. Admin-only, definer, and only
-- ever reached from the archive dialog after the zip has been handed to the
-- browser and the word CLEAR typed. Unlike delete_job it does not refuse
-- approved or invoiced tickets — the archive is the record now, which is
-- the whole point — so the dialog says how many are being removed and how
-- many are still out for signature before it asks. Returns the counts and
-- the storage keys, which the client removes from the two private buckets.
create or replace function public.archive_clear_jobs(p_job_ids uuid[])
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  n_jobs int; n_tickets int; n_jhas int; n_reports int; n_overrides int;
  jha_keys text[]; report_keys text[];
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'Clearing archived jobs is an Admin''s.';
  end if;
  if p_job_ids is null or cardinality(p_job_ids) = 0 then
    raise exception 'No jobs were named.';
  end if;

  select count(*) into n_jobs from public.jobs where id = any(p_job_ids);
  select count(*) into n_tickets from public.tickets where job_id = any(p_job_ids);
  select count(*) into n_jhas from public.jhas where job_id = any(p_job_ids);
  select count(*) into n_reports from public.reports where job_id = any(p_job_ids);
  select count(*) into n_overrides from public.rate_overrides where job_id = any(p_job_ids);
  select coalesce(array_agg(pdf_key), '{}') into jha_keys
    from public.jhas where job_id = any(p_job_ids) and pdf_key is not null;
  select coalesce(array_agg(pdf_key), '{}') into report_keys
    from public.reports where job_id = any(p_job_ids) and pdf_key is not null;

  -- Children first, explicitly, whatever the cascades would have done.
  delete from public.ticket_crew  where ticket_id in (select id from public.tickets where job_id = any(p_job_ids));
  delete from public.ticket_lines where ticket_id in (select id from public.tickets where job_id = any(p_job_ids));
  delete from public.tickets        where job_id = any(p_job_ids);
  delete from public.jhas           where job_id = any(p_job_ids);
  delete from public.reports        where job_id = any(p_job_ids);
  delete from public.rate_overrides where job_id = any(p_job_ids);
  delete from public.jobs           where id = any(p_job_ids);

  return jsonb_build_object(
    'jobs', n_jobs, 'tickets', n_tickets, 'jhas', n_jhas, 'reports', n_reports, 'overrides', n_overrides,
    'jha_keys', to_jsonb(jha_keys), 'report_keys', to_jsonb(report_keys)
  );
end;
$$;
revoke execute on function public.archive_clear_jobs(uuid[]) from public, anon;
grant execute on function public.archive_clear_jobs(uuid[]) to authenticated;
