-- Indexes on the columns actually filtered/ordered on in db.js. Postgres
-- already indexes primary keys and unique constraints; these cover the
-- foreign-key lookups and name searches that do not get one for free.

-- Jobs board: filtered by status, joined to client/contractor, listed newest first.
create index if not exists idx_jobs_status on public.jobs (status);
create index if not exists idx_jobs_client_id on public.jobs (client_id);
create index if not exists idx_jobs_contractor_id on public.jobs (contractor_id);
create index if not exists idx_jobs_created_at on public.jobs (created_at desc);

-- Name lookups (createContractor/createClient dedupe by ilike, createJob by eq).
create index if not exists idx_clients_name on public.clients (name);
create index if not exists idx_contractors_name on public.contractors (name);

-- Contacts: always looked up by org, ordered by name.
create index if not exists idx_contacts_org on public.contacts (org_type, org_id);
create index if not exists idx_contacts_name on public.contacts (name);

-- JHAs: per-job history, open-JHA check, same-day-JHA check all filter on job_id
-- (+ status, + signed_at), and close-out updates by id (already indexed).
create index if not exists idx_jhas_job_id on public.jhas (job_id);
create index if not exists idx_jhas_job_status on public.jhas (job_id, status);
create index if not exists idx_jhas_signed_at on public.jhas (signed_at desc);

-- Tickets: per-job history, the billing tracker's full list, work-date range
-- scans for timesheets.
create index if not exists idx_tickets_job_id on public.tickets (job_id);
create index if not exists idx_tickets_status on public.tickets (status);
create index if not exists idx_tickets_created_at on public.tickets (created_at desc);
create index if not exists idx_tickets_work_date on public.tickets (work_date);

-- Ticket line items and crew rows: always fetched/replaced by ticket_id.
create index if not exists idx_ticket_lines_ticket_id on public.ticket_lines (ticket_id);
create index if not exists idx_ticket_crew_ticket_id on public.ticket_crew (ticket_id);
create index if not exists idx_ticket_crew_profile_id on public.ticket_crew (profile_id);

-- Rates: schedule lookups by client, lines/overrides by schedule/job.
create index if not exists idx_rate_schedules_client_id on public.rate_schedules (client_id);
create index if not exists idx_rate_lines_schedule_id on public.rate_lines (schedule_id);
create index if not exists idx_rate_overrides_job_id on public.rate_overrides (job_id);

-- Timesheet approvals: looked up and cleared by period_start (+ profile).
create index if not exists idx_timesheet_approvals_period on public.timesheet_approvals (period_start);
create index if not exists idx_timesheet_approvals_profile on public.timesheet_approvals (profile_id);

-- Reports: per-job list, newest first.
create index if not exists idx_reports_job_id on public.reports (job_id);
