-- ═══════════════════════════════════════════════════════════════════════
-- VagaboNDE Field Ops — Beta 1 schema baseline
-- ═══════════════════════════════════════════════════════════════════════
--
-- The entire database as it stands at Beta 1, in one file: every table,
-- function, trigger, policy, index and storage bucket. Generated FROM the
-- live database's own catalogs (pg_get_functiondef, pg_get_triggerdef,
-- pg_get_indexdef, pg_get_constraintdef, pg_policies) — transcribed, not
-- reconstructed from memory — so this file says what the server says.
--
-- WHAT THIS REPLACES. The prototype accumulated 77 migrations, including
-- churn a fresh environment has no reason to replay: a scoreboard table
-- created and later folded into a general one, policies rewritten as the
-- access model tightened, functions hardened in stages. Their full text
-- lives in the prototype archive (uploads/field-ops/supabase/migrations);
-- the applied-history manifest is at the end of this header.
--
-- HOW TO USE IT.
--   Fresh environment:  replay this file, then any migrations after it.
--   The live project:   NEVER apply this file there — everything in it
--                       already exists. The live migration history table
--                       has been repaired to name this baseline as its
--                       first entry, so repo and database reconcile 1:1.
--
-- WHAT SQL CANNOT CARRY — dashboard setup a fresh project needs by hand:
--   · Auth hook: enable "Customize Access Token (JWT) Claims hook" and
--     point it at public.custom_access_token_hook (it stamps app_role and
--     tab_access into the JWT; everything degrades gracefully without it,
--     falling back to per-query profile lookups).
--   · Auth: enable leaked-password protection (advisor nags otherwise).
--   · Edge functions: deploy supabase/functions/* and set the POSTMARK
--     secrets (see "Things to do to get set up.md").
--   · Storage: buckets are created below, but the four of them must stay
--     private (no public toggle in the dashboard).
--
-- Applied-history manifest (retired by this baseline):
--   20260811000000 ticket_approval_tokens        20260811010000 shared_files_bucket
--   20260811020000 crew_and_timesheets           20260811043349 001_core_schema
--   20260811043411 002_row_level_security        20260811043423 003_triggers_and_signup
--   20260811043429 004_storage_buckets           20260811043456 005_lock_down_trigger_functions
--   20260811043521 006_move_helpers_off_exposed_api  20260811043547 007_seed_reference_data
--   20260811043804 008_contacts_unique_per_org   20260811113418 009_seed_expense_rate_lines
--   20260811113748 010_fix_rate_read_access      20260811114112 011_custom_rate_line_kinds
--   20260811114145 012_seed_rate_overrides       20260812000000 contacts_directory
--   20260812010000 job_status_active_complete    20260812020000 dosimetry_and_units
--   20260812030000 jhas_bucket                   20260812040000 jha_close_out_policy
--   20260813000000 search_indexes                20260813010000 equipment_tracking
--   20260813020000 default_rate_schedule         20260813030000 role_helper_and_resilient_signup
--   20260813040000 rls_perf_and_missing_indexes  20260813050000 tickets_write_not_gated_on_tab
--   20260813060000 search_jobs_rpc               20260813070000 jhas_insert_not_gated_on_tab
--   20260813080000 jhas_update_not_gated_on_tab  20260813090000 search_tickets_rpc
--   20260813100000 equipment_contacts_search     20260813110000 scope_ticket_jha_write_policies
--   20260813120000 rate_line_history             20260813130000 search_perf_followup
--   20260813140000 composite_indexes_and_bulk_rates  20260813150000 function_errors
--   20260813160000 role_presets_back_in_step     20260814000000 server_side_ticket_numbers
--   20260814010000 rls_consolidation_and_indexes 20260814020000 jha_work_date
--   20260814030000 jha_work_date_default         20260814040000 tab_access_from_jwt
--   20260814050000 tab_access_security_definer   20260814060000 paged_search_without_full_join
--   20260814070000 drop_redundant_indexes        20260814080000 rls_helpers_once_per_query
--   20260814090000 harden_new_functions          20260814100000 ownership_and_private_id_codes
--   20260814110000 id_code_back_on_profiles      20260814120000 deterministic_pagination
--   20260814195119 rates_cannot_be_negative      20260814195850 no_negative_billing_figures
--   20260815012240 ticket_lines_follow_their_ticket  20260815020914 search_tickets_uses_the_index
--   20260815021132 search_tickets_sargable_branches  20260815155943 delete_job_with_transfer
--   20260815185842 technicians_delete_their_own_jobs 20260815191345 no_more_for_all_policies
--   20260815191532 harden_remaining_functions    20260815202002 jha_files_follow_the_tabs
--   20260815203219 read_gates_match_the_data     20260815214020 rate_history_survives_the_line
--   20260815220617 reports_can_be_removed        20260816001948 area_delays_and_travel_rates
--   20260816002710 technician_level              20260816014134 issued_ticket_numbers_are_never_reused
--   20260816015047 ticket_total_follows_its_lines    20260816015524 a_ticket_cannot_claim_money_it_has_no_lines_for
--   20260816015713 ticket_total_balances_reads_current_state  20260816022258 search_treats_wildcards_as_text
--   20260816022417 search_escape_inline_not_via_private_schema  20260816140236 your_own_hours_unless_you_run_the_billing
--   20260816153712 the_easter_egg_keeps_a_scoreboard  20260816160911 the_scoreboard_keeps_its_own_time
--   20260817030734 only_the_office_signs_off_hours    20260817030750 an_approved_timesheet_is_a_document
--   20260817033441 every_egg_shares_one_scoreboard
--
-- ═══════════════════════════════════════════════════════════════════════
-- 1 · Extensions and schemas
-- ═══════════════════════════════════════════════════════════════════════

-- pg_trgm sits in public — the advisor flags it, and moving an installed
-- extension's schema is riskier than the warning it silences. A fresh
-- environment inherits the same trade-off knowingly.
create extension if not exists pg_trgm with schema public;

-- Everything in `private` is reachable only through definer functions and
-- policies; PostgREST never exposes it.
create schema if not exists private;
grant usage on schema private to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 2 · Private helpers — the access-control core
-- ═══════════════════════════════════════════════════════════════════════
-- All SECURITY DEFINER with a pinned search_path. tab_access() and
-- user_role() read the JWT claim when the auth hook has stamped it and
-- fall back to the profiles table when it hasn't, so a stale token still
-- resolves and a fresh project works before the hook is wired.

CREATE OR REPLACE FUNCTION private.burn_issued_ticket_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.approval_sent_at is not null then
    insert into public.burned_ticket_numbers (id, reason)
    values (old.id, 'sent for approval on ' || to_char(old.approval_sent_at, 'YYYY-MM-DD') || ', ticket later deleted')
    on conflict (id) do nothing;
  end if;
  return old;
end;
$function$;

CREATE OR REPLACE FUNCTION private.can_write_ticket(t_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.tickets t
    where t.id = t_id
      and t.approved_at is null
      and (
        t.technician_id = (select auth.uid())
        or (select private.user_role()) = any (array['Admin', 'Coordinator'])
      )
  );
$function$;

CREATE OR REPLACE FUNCTION private.current_role_name()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from public.profiles where id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION private.has_any_tab(VARIADIC tabs text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(private.tab_access() && tabs, false);
$function$;

CREATE OR REPLACE FUNCTION private.has_tab(tab text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(private.tab_access() && array[tab], false);
$function$;

CREATE OR REPLACE FUNCTION private.lock_overrides_on_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.approved_at is not null and (old.approved_at is null) then
    update public.rate_overrides set locked = true where job_id = new.job_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.sync_ticket_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _ticket text := coalesce(new.ticket_id, old.ticket_id);
begin
  update public.tickets t
     set total = coalesce((
           select sum(l.quantity * l.unit_rate)
             from public.ticket_lines l
            where l.ticket_id = _ticket
         ), 0)
   where t.id = _ticket;

  if tg_op = 'UPDATE' and new.ticket_id is distinct from old.ticket_id then
    update public.tickets t
       set total = coalesce((
             select sum(l.quantity * l.unit_rate)
               from public.ticket_lines l
              where l.ticket_id = old.ticket_id
           ), 0)
     where t.id = old.ticket_id;
  end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.tab_access()
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claim jsonb;
begin
  -- The token, when the hook has put it there.
  claim := auth.jwt() -> 'app_metadata' -> 'tab_access';
  if claim is not null and jsonb_typeof(claim) = 'array' then
    return array(select jsonb_array_elements_text(claim));
  end if;
  -- Otherwise the table, exactly as before.
  return (select p.tab_access from public.profiles p where p.id = (select auth.uid()));
end;
$function$;

CREATE OR REPLACE FUNCTION private.ticket_total_balances()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _row    public.tickets%rowtype;
  _lines  numeric;
begin
  select * into _row from public.tickets where id = new.id;
  if not found then
    return null;
  end if;

  if _row.approved_at is not null or _row.status in ('Approved', 'Invoiced') then
    return null;
  end if;

  select coalesce(sum(quantity * unit_rate), 0) into _lines
    from public.ticket_lines where ticket_id = _row.id;

  if _row.total is distinct from _lines then
    raise exception
      'Ticket % says % but its lines add up to %. A ticket cannot carry a total it has no lines for — save the lines, or save the ticket at zero.',
      _row.id, _row.total, _lines
      using errcode = 'check_violation';
  end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.user_role()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claim jsonb;
begin
  claim := auth.jwt() -> 'app_metadata' -> 'app_role';
  if claim is not null and jsonb_typeof(claim) = 'string' then
    return claim #>> '{}';
  end if;
  return (select p.role from public.profiles p where p.id = (select auth.uid()));
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3 · Tables
-- ═══════════════════════════════════════════════════════════════════════
-- Column lists, checks and uniques exactly as the live catalogs render
-- them. Foreign keys follow in section 4 so creation order cannot matter.

create table public.arcade_scores (
  game text not null,
  profile_id uuid not null,
  best integer not null,
  updated_at timestamp with time zone default now() not null,
  PRIMARY KEY (game, profile_id),
  constraint arcade_scores_best_check CHECK (((best >= 0) AND (best <= 1000000))),
  constraint arcade_scores_game_check CHECK (((char_length(game) >= 1) AND (char_length(game) <= 40)))
);

create table public.audit_log (
  id uuid default gen_random_uuid() not null,
  actor_id uuid,
  entity text not null,
  entity_id text not null,
  action text not null,
  before jsonb,
  after jsonb,
  at timestamp with time zone default now() not null,
  PRIMARY KEY (id)
);

create table public.burned_ticket_numbers (
  id text not null,
  burned_at timestamp with time zone default now() not null,
  reason text,
  PRIMARY KEY (id)
);

create table public.clients (
  id uuid default gen_random_uuid() not null,
  name text not null,
  agreement_ref text,
  effective_from date,
  minimum_callout text,
  constraint clients_name_key UNIQUE (name),
  PRIMARY KEY (id)
);

create table public.contacts (
  id uuid default gen_random_uuid() not null,
  org_type text not null,
  org_id uuid not null,
  name text not null,
  email text,
  phone text,
  last_used_at timestamp with time zone default now(),
  title text,
  notes text,
  is_primary boolean default false not null,
  PRIMARY KEY (id),
  constraint contacts_org_type_check CHECK ((org_type = ANY (ARRAY['client'::text, 'contractor'::text])))
);

create table public.contractors (
  id uuid default gen_random_uuid() not null,
  name text not null,
  constraint contractors_name_key UNIQUE (name),
  PRIMARY KEY (id)
);

create table public.equipment (
  id uuid default gen_random_uuid() not null,
  type text not null,
  serial_number text,
  calibration_due date,
  assigned_to uuid,
  status text default 'In service'::text not null,
  created_at timestamp with time zone default now() not null,
  PRIMARY KEY (id),
  constraint equipment_status_check CHECK ((status = ANY (ARRAY['In service'::text, 'Out for cal'::text, 'Retired'::text]))),
  constraint equipment_type_check CHECK ((type = ANY (ARRAY['Exposure device'::text, 'Survey meter'::text, 'Dosimeter'::text, 'TLD / OSLD'::text, 'Crank'::text, 'Guide tube'::text])))
);

create table public.function_errors (
  id uuid default gen_random_uuid() not null,
  function_name text not null,
  message text not null,
  context jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  PRIMARY KEY (id)
);

create table public.jhas (
  id uuid default gen_random_uuid() not null,
  job_id uuid not null,
  template text,
  hazards jsonb default '[]'::jsonb not null,
  signed_by uuid,
  site_rep text,
  signed_at timestamp with time zone,
  pdf_key text,
  created_at timestamp with time zone default now() not null,
  dosimetry jsonb default '[]'::jsonb not null,
  unit_number text,
  details jsonb default '{}'::jsonb not null,
  status text default 'Open'::text not null,
  closed_at timestamp with time zone,
  closed_by uuid,
  work_date date default ((now() AT TIME ZONE 'America/Edmonton'::text))::date,
  PRIMARY KEY (id)
);

create table public.jobs (
  id uuid default gen_random_uuid() not null,
  job_number text not null,
  project text not null,
  client_id uuid,
  contractor_id uuid,
  client_contact_id uuid,
  contractor_contact_id uuid,
  lsd text,
  afe text,
  method text,
  procedure text,
  status text default 'Unassigned'::text not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  started_at timestamp with time zone,
  search_text text,
  area text,
  constraint jobs_job_number_key UNIQUE (job_number),
  PRIMARY KEY (id),
  constraint jobs_status_check CHECK ((status = ANY (ARRAY['Active'::text, 'Complete'::text])))
);

create table public.profiles (
  id uuid not null,
  name text not null,
  role text not null,
  cert text,
  tab_access text[] default '{}'::text[] not null,
  created_at timestamp with time zone default now() not null,
  first_name text,
  last_name text,
  is_subcontractor boolean default false not null,
  unit_number text,
  tld_serial text,
  drd_serial text,
  alarm_serial text,
  id_code text,
  level text,
  PRIMARY KEY (id),
  constraint profiles_level_check CHECK (((level IS NULL) OR (level = ANY (ARRAY['S'::text, 'T2'::text, 'T1'::text, 'C'::text, 'T'::text, 'A'::text])))),
  constraint profiles_role_check CHECK ((role = ANY (ARRAY['Admin'::text, 'Coordinator'::text, 'Technician'::text, 'Helper'::text])))
);

create table public.rate_line_history (
  id uuid default gen_random_uuid() not null,
  rate_line_id uuid,
  schedule_id uuid not null,
  kind text,
  label text,
  unit text,
  old_rate numeric,
  new_rate numeric,
  changed_by uuid,
  changed_at timestamp with time zone default now() not null,
  PRIMARY KEY (id)
);

create table public.rate_lines (
  id uuid default gen_random_uuid() not null,
  schedule_id uuid not null,
  kind text not null,
  label text not null,
  unit text,
  rate numeric default 0 not null,
  PRIMARY KEY (id),
  constraint rate_lines_kind_check CHECK ((kind = ANY (ARRAY['rt_film'::text, 'rt_cr'::text, 'rt_dr'::text, 'method'::text, 'expense'::text, 'custom_weld'::text, 'custom_method'::text, 'custom_expense'::text]))),
  constraint rate_lines_rate_non_negative CHECK ((rate >= (0)::numeric))
);

create table public.rate_overrides (
  id uuid default gen_random_uuid() not null,
  job_id uuid not null,
  basis text,
  description text,
  bid_ref text,
  active boolean default true not null,
  locked boolean default false not null,
  PRIMARY KEY (id)
);

create table public.rate_schedules (
  id uuid default gen_random_uuid() not null,
  client_id uuid,
  effective_from date default CURRENT_DATE not null,
  published_at timestamp with time zone,
  PRIMARY KEY (id)
);

create table public.reports (
  id uuid default gen_random_uuid() not null,
  job_id uuid not null,
  filename text not null,
  pdf_key text,
  welds text,
  result text,
  interpreted_by text,
  uploaded_at timestamp with time zone default now() not null,
  sent_at timestamp with time zone,
  sent_to text,
  PRIMARY KEY (id),
  constraint reports_result_check CHECK ((result = ANY (ARRAY['Accept'::text, 'Repair'::text, 'Re-shoot'::text])))
);

create table public.ticket_crew (
  id uuid default gen_random_uuid() not null,
  ticket_id text not null,
  profile_id uuid not null,
  crew_role text default 'Technician'::text not null,
  straight_hours numeric(6,2) default 0 not null,
  ot_hours numeric(6,2) default 0 not null,
  dose_mr numeric(8,2) default 0 not null,
  mileage_km numeric(8,1) default 0 not null,
  created_at timestamp with time zone default now() not null,
  solo_hours numeric(6,2) default 0 not null,
  solo_ot_hours numeric(6,2) default 0 not null,
  constraint ticket_crew_ticket_id_profile_id_key UNIQUE (ticket_id, profile_id),
  PRIMARY KEY (id),
  constraint ticket_crew_dose_non_negative CHECK ((dose_mr >= (0)::numeric)),
  constraint ticket_crew_hours_non_negative CHECK (((straight_hours >= (0)::numeric) AND (ot_hours >= (0)::numeric) AND (solo_hours >= (0)::numeric) AND (solo_ot_hours >= (0)::numeric))),
  constraint ticket_crew_mileage_non_negative CHECK ((mileage_km >= (0)::numeric))
);

create table public.ticket_lines (
  id uuid default gen_random_uuid() not null,
  ticket_id text not null,
  kind text not null,
  label text not null,
  unit text,
  quantity numeric not null,
  unit_rate numeric not null,
  PRIMARY KEY (id),
  constraint ticket_lines_kind_check CHECK ((kind = ANY (ARRAY['weld'::text, 'charge'::text]))),
  constraint ticket_lines_quantity_non_negative CHECK ((quantity >= (0)::numeric)),
  constraint ticket_lines_unit_rate_non_negative CHECK ((unit_rate >= (0)::numeric))
);

create table public.tickets (
  id text not null,
  job_id uuid not null,
  technician_id uuid,
  work_date date not null,
  status text default 'Draft'::text not null,
  client_contact jsonb,
  contractor_contact jsonb,
  total numeric(10,2) default 0 not null,
  approved_at timestamp with time zone,
  approved_by_email text,
  approved_ip text,
  invoiced_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  approval_token text,
  approval_sent_at timestamp with time zone,
  approval_expires_at timestamp with time zone,
  delays text,
  constraint tickets_approval_token_key UNIQUE (approval_token),
  PRIMARY KEY (id),
  constraint tickets_status_check CHECK ((status = ANY (ARRAY['Draft'::text, 'Awaiting approval'::text, 'Approved'::text, 'Invoiced'::text]))),
  constraint tickets_total_non_negative CHECK ((total >= (0)::numeric))
);

create table public.timesheet_approvals (
  id uuid default gen_random_uuid() not null,
  profile_id uuid not null,
  period_start date not null,
  period_end date not null,
  approved_at timestamp with time zone default now() not null,
  approved_by uuid,
  pdf_key text,
  constraint timesheet_approvals_profile_id_period_start_key UNIQUE (profile_id, period_start),
  PRIMARY KEY (id)
);

-- ═══════════════════════════════════════════════════════════════════════
-- 4 · Foreign keys
-- ═══════════════════════════════════════════════════════════════════════
-- The delete rules are deliberate and were each argued over at the time:
-- audit rows outlive their actor (no cascade), crew rows block deleting a
-- person who has hours (RESTRICT), rate history survives its line
-- (SET NULL) but follows its schedule (CASCADE).

alter table public.arcade_scores add constraint arcade_scores_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.audit_log add constraint audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES profiles(id);
alter table public.equipment add constraint equipment_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.jhas add constraint jhas_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
alter table public.jhas add constraint jhas_signed_by_fkey FOREIGN KEY (signed_by) REFERENCES profiles(id);
alter table public.jobs add constraint jobs_client_contact_id_fkey FOREIGN KEY (client_contact_id) REFERENCES contacts(id);
alter table public.jobs add constraint jobs_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.jobs add constraint jobs_contractor_contact_id_fkey FOREIGN KEY (contractor_contact_id) REFERENCES contacts(id);
alter table public.jobs add constraint jobs_contractor_id_fkey FOREIGN KEY (contractor_id) REFERENCES contractors(id);
alter table public.jobs add constraint jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.rate_line_history add constraint rate_line_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES profiles(id);
alter table public.rate_line_history add constraint rate_line_history_rate_line_id_fkey FOREIGN KEY (rate_line_id) REFERENCES rate_lines(id) ON DELETE SET NULL;
alter table public.rate_line_history add constraint rate_line_history_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES rate_schedules(id) ON DELETE CASCADE;
alter table public.rate_lines add constraint rate_lines_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES rate_schedules(id) ON DELETE CASCADE;
alter table public.rate_overrides add constraint rate_overrides_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id);
alter table public.rate_schedules add constraint rate_schedules_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id);
alter table public.reports add constraint reports_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
alter table public.ticket_crew add constraint ticket_crew_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE RESTRICT;
alter table public.ticket_crew add constraint ticket_crew_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.ticket_lines add constraint ticket_lines_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table public.tickets add constraint tickets_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id);
alter table public.tickets add constraint tickets_technician_id_fkey FOREIGN KEY (technician_id) REFERENCES profiles(id);
alter table public.timesheet_approvals add constraint timesheet_approvals_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id);
alter table public.timesheet_approvals add constraint timesheet_approvals_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════
-- 5 · Public functions — RPCs, trigger bodies, the auth hook
-- ═══════════════════════════════════════════════════════════════════════
-- The four SECURITY DEFINER functions here (delete_job, has_tab, is_staff,
-- next_ticket_number) are the ones the security advisor permanently flags;
-- each is deliberate and each validates its own caller.

CREATE OR REPLACE FUNCTION public.arcade_keep_best()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.best <= old.best then
    new.best := old.best;
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.bulk_set_rate_lines(ids uuid[], rates numeric[])
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  update public.rate_lines rl
  set rate = v.rate
  from unnest(ids, rates) as v(id, rate)
  where rl.id = v.id;
$function$;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  claims jsonb;
  tabs   text[];
  urole  text;
begin
  select p.tab_access, p.role into tabs, urole
  from public.profiles p
  where p.id = (event ->> 'user_id')::uuid;

  if tabs is null then
    return event;
  end if;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  if claims ? 'app_metadata' then
    claims := jsonb_set(claims, '{app_metadata,tab_access}', to_jsonb(tabs));
    claims := jsonb_set(claims, '{app_metadata,app_role}', to_jsonb(coalesce(urole, '')));
  else
    claims := jsonb_set(claims, '{app_metadata}',
      jsonb_build_object('tab_access', to_jsonb(tabs), 'app_role', to_jsonb(coalesce(urole, ''))));
  end if;

  return jsonb_set(event, '{claims}', claims);
exception when others then
  return event;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_job(p_job_id uuid, p_transfer_to uuid DEFAULT NULL::uuid, p_discard boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n_jhas int; n_reports int; n_tickets int; n_overrides int;
  n_locked int; n_sent int;
  is_admin boolean;
  is_creator boolean;
begin
  is_admin := (select private.user_role()) = 'Admin';

  select (created_by = (select auth.uid())) into is_creator
    from public.jobs where id = p_job_id;

  if is_creator is null then
    raise exception 'That job no longer exists — it may already have been deleted.';
  end if;

  if not is_admin and not is_creator then
    raise exception 'You can only delete a job you raised yourself. Ask an admin to remove this one.';
  end if;

  if p_discard and not is_admin then
    raise exception 'Deleting what is filed against a job is an admin''s. Transfer it to another job instead.';
  end if;

  select count(*) into n_jhas      from public.jhas           where job_id = p_job_id;
  select count(*) into n_reports   from public.reports        where job_id = p_job_id;
  select count(*) into n_tickets   from public.tickets        where job_id = p_job_id;
  select count(*) into n_overrides from public.rate_overrides where job_id = p_job_id;

  select count(*) into n_locked
    from public.tickets
   where job_id = p_job_id
     and (approved_at is not null or status in ('Approved', 'Invoiced'));

  if n_locked > 0 then
    raise exception
      'This job has % approved or invoiced ticket(s) on it. That billing is what the client agreed to pay and cannot be moved or deleted, so the job has to stay.', n_locked;
  end if;

  if not is_admin then
    select count(*) into n_sent
      from public.tickets
     where job_id = p_job_id and status = 'Awaiting approval';
    if n_sent > 0 then
      raise exception
        'A ticket from this job has already gone to the client for approval, so the job can''t be deleted. An admin can still remove it.';
    end if;
  end if;

  if p_transfer_to is not null then
    if p_transfer_to = p_job_id then
      raise exception 'Choose a different job to transfer to.';
    end if;
    if not exists (select 1 from public.jobs where id = p_transfer_to) then
      raise exception 'The job you are transferring to no longer exists.';
    end if;

    update public.jhas           set job_id = p_transfer_to where job_id = p_job_id;
    update public.reports        set job_id = p_transfer_to where job_id = p_job_id;
    update public.tickets        set job_id = p_transfer_to where job_id = p_job_id;
    update public.rate_overrides set job_id = p_transfer_to where job_id = p_job_id;

  elsif (n_jhas + n_reports + n_tickets + n_overrides) > 0 then
    if not p_discard then
      raise exception
        'This job still has % JHA(s), % report(s), % ticket(s) and % override(s) on it. Transfer them to another job, or confirm they are to be deleted with it.',
        n_jhas, n_reports, n_tickets, n_overrides;
    end if;
    delete from public.tickets        where job_id = p_job_id;
    delete from public.rate_overrides where job_id = p_job_id;
  end if;

  delete from public.jobs where id = p_job_id;

  return jsonb_build_object(
    'transferred', p_transfer_to is not null,
    'jhas', n_jhas, 'reports', n_reports,
    'tickets', n_tickets, 'overrides', n_overrides
  );
end $function$;

CREATE OR REPLACE FUNCTION public.equipment_stats()
 RETURNS TABLE(overdue_count bigint, due_soon_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    count(*) filter (where calibration_due is not null and calibration_due < current_date),
    count(*) filter (where calibration_due is not null and calibration_due >= current_date and calibration_due <= current_date + 30)
  from public.equipment;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _role text := coalesce(new.raw_user_meta_data ->> 'role', 'Technician');
  _name text := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));
begin
  begin
    insert into public.profiles (id, name, role, cert, tab_access)
    values (
      new.id,
      _name,
      _role,
      nullif(new.raw_user_meta_data ->> 'cert', ''),
      public.tabs_for_role(_role)
    )
    on conflict (id) do nothing;
  exception when others then
    -- Never take the signup down with the profile. The account exists and
    -- an admin can repair the row; the alternative is an error message
    -- that says only "Database error saving new user".
    raise warning 'profile provisioning failed for %: %', new.email, sqlerrm;
  end;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.has_tab(_tab text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(private.tab_access() && array[_tab], false);
$function$;

CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select private.tab_access() is not null;
$function$;

CREATE OR REPLACE FUNCTION public.jobs_refresh_search_text()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.search_text := regexp_replace(lower(
    coalesce(new.project, '') || ' ' || coalesce(new.lsd, '') || ' ' || new.job_number || ' ' ||
    coalesce((select name from public.clients where id = new.client_id), '') || ' ' ||
    coalesce((select name from public.contractors where id = new.contractor_id), '')
  ), '[^a-z0-9]', '', 'g');
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.log_rate_line_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    insert into public.rate_line_history
      (rate_line_id, schedule_id, kind, label, unit, old_rate, new_rate, changed_by)
    values (new.id, new.schedule_id, new.kind, new.label, new.unit, null, new.rate, auth.uid());
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.rate_line_history
      (rate_line_id, schedule_id, kind, label, unit, old_rate, new_rate, changed_by)
    values (null, old.schedule_id, old.kind, old.label, old.unit, old.rate, null, auth.uid());
    return old;
  end if;

  if new.rate  is distinct from old.rate
  or new.label is distinct from old.label
  or new.unit  is distinct from old.unit then
    insert into public.rate_line_history
      (rate_line_id, schedule_id, kind, label, unit, old_rate, new_rate, changed_by)
    values (new.id, new.schedule_id, new.kind, new.label, new.unit, old.rate, new.rate, auth.uid());
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.next_ticket_number(_initials text, _work_date date)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _prefix text;
  _next   int;
begin
  if coalesce(trim(_initials), '') = '' then
    raise exception 'Ticket numbers need the technician''s initials.';
  end if;
  if _work_date is null then
    raise exception 'Ticket numbers need the work date.';
  end if;

  if upper(trim(_initials)) !~ '^[A-Z]{1,4}$' then
    raise exception 'Initials must be one to four letters.';
  end if;

  _prefix := upper(trim(_initials)) || '-' ||
             to_char(_work_date, 'MMDD') || '-' ||
             to_char(_work_date, 'YY') || '-';

  perform pg_advisory_xact_lock(hashtext(_prefix));

  select coalesce(max(n), 0) + 1 into _next
  from (
    select nullif(substring(id from '([0-9]+)$'), '')::int as n
      from public.tickets
     where id like _prefix || '%'
    union all
    select nullif(substring(id from '([0-9]+)$'), '')::int
      from public.burned_ticket_numbers
     where id like _prefix || '%'
  ) s;

  return _prefix || lpad(_next::text, 2, '0');
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_jobs_search_text_for_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if TG_TABLE_NAME = 'clients' then
    update public.jobs set search_text = regexp_replace(lower(
      coalesce(project, '') || ' ' || coalesce(lsd, '') || ' ' || job_number || ' ' || coalesce(new.name, '') || ' ' ||
      coalesce((select name from public.contractors where id = jobs.contractor_id), '')
    ), '[^a-z0-9]', '', 'g') where client_id = new.id;
  else
    update public.jobs set search_text = regexp_replace(lower(
      coalesce(project, '') || ' ' || coalesce(lsd, '') || ' ' || job_number || ' ' ||
      coalesce((select name from public.clients where id = jobs.client_id), '') || ' ' || coalesce(new.name, '')
    ), '[^a-z0-9]', '', 'g') where contractor_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_equipment(filter_key text DEFAULT 'All'::text, page_num integer DEFAULT 0, page_size integer DEFAULT 10)
 RETURNS TABLE(id uuid, type text, serial_number text, calibration_due date, status text, assigned_to uuid, assigned_name text, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with filtered as (
    select e.id, e.type, e.serial_number, e.calibration_due, e.status, e.assigned_to, p.name as assigned_name,
      count(*) over () as total_count
    from public.equipment e
    left join public.profiles p on p.id = e.assigned_to
    where filter_key = 'All'
       or (filter_key = 'Due soon' and e.calibration_due is not null and e.calibration_due >= current_date and e.calibration_due <= current_date + 30)
       or (filter_key = 'Overdue' and e.calibration_due is not null and e.calibration_due < current_date)
       or e.type = filter_key
  )
  select * from filtered
  order by type, serial_number
  offset page_num * page_size
  limit page_size;
$function$;

CREATE OR REPLACE FUNCTION public.search_jobs(q text DEFAULT ''::text, status_filter text DEFAULT 'All'::text, search_field text DEFAULT 'any'::text, page_num integer DEFAULT 0, page_size integer DEFAULT 10)
 RETURNS TABLE(id uuid, job_number text, project text, lsd text, afe text, method text, procedure text, status text, created_at timestamp with time zone, client_id uuid, contractor_id uuid, client_name text, contractor_name text, created_by uuid, created_by_name text, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- % _ and \ are LIKE syntax; a search box passes text, so they are escaped.
  -- Backslash first, or it would double-escape what the others add.
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  matched as (
    select j.id, j.created_at
    from public.jobs j, esc
    where (status_filter = 'All' or j.status = status_filter)
      and (
        q = '' or
        case search_field
          when 'project'    then j.project    ilike esc.pat
          when 'lsd'        then j.lsd        ilike esc.pat
          when 'id'         then j.job_number ilike esc.pat
          when 'client'     then exists (
                                 select 1 from public.clients c
                                 where c.id = j.client_id and c.name ilike esc.pat)
          when 'contractor' then exists (
                                 select 1 from public.contractors k
                                 where k.id = j.contractor_id and k.name ilike esc.pat)
          else j.search_text ilike '%' || regexp_replace(lower(q), '[^a-z0-9]', '', 'g') || '%'
        end
      )
  ),
  total as (select count(*) as n from matched),
  page as (
    select m.id from matched m
    order by m.created_at desc, m.id desc
    offset page_num * page_size
    limit page_size
  )
  select j.id, j.job_number, j.project, j.lsd, j.afe, j.method, j.procedure,
         j.status, j.created_at, j.client_id, j.contractor_id,
         c.name, k.name, j.created_by, p.name,
         (select n from total)
  from page pg
  join public.jobs j on j.id = pg.id
  left join public.clients c on c.id = j.client_id
  left join public.contractors k on k.id = j.contractor_id
  left join public.profiles p on p.id = j.created_by
  order by j.created_at desc, j.id desc;
$function$;

CREATE OR REPLACE FUNCTION public.search_org_directory(q text DEFAULT ''::text, scope text DEFAULT 'All'::text, page_num integer DEFAULT 0, page_size integer DEFAULT 20)
 RETURNS TABLE(org_type text, org_id uuid, name text, agreement_ref text, contact_count bigint, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  orgs as (
    select 'client'::text as org_type, c.id as org_id, c.name, c.agreement_ref
    from public.clients c where scope in ('All', 'Clients')
    union all
    select 'contractor'::text, k.id, k.name, null::text
    from public.contractors k where scope in ('All', 'Contractors')
  ), joined as (
    select o.org_type, o.org_id, o.name, o.agreement_ref,
      count(ct.id) as contact_count,
      bool_or(
        q = '' or o.name ilike (select pat from esc) or
        ct.name ilike (select pat from esc) or
        ct.email ilike (select pat from esc) or
        ct.phone ilike (select pat from esc)
      ) as matched
    from orgs o
    left join public.contacts ct on ct.org_type = o.org_type and ct.org_id = o.org_id
    group by o.org_type, o.org_id, o.name, o.agreement_ref
  ), counted as (
    select *, count(*) over () as total_count from joined where matched
  )
  select org_type, org_id, name, agreement_ref, contact_count, total_count
  from counted
  order by name
  offset page_num * page_size
  limit page_size;
$function$;

CREATE OR REPLACE FUNCTION public.search_tickets(status_filter text DEFAULT 'All'::text, page_num integer DEFAULT 0, page_size integer DEFAULT 10)
 RETURNS TABLE(id text, work_date date, status text, total numeric, created_at timestamp with time zone, job_number text, project text, client_name text, technician_name text, total_count bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  off integer := page_num * page_size;
begin
  if status_filter = 'All' then
    return query
      select t.id, t.work_date, t.status, t.total, t.created_at,
             j.job_number, j.project, c.name, p.name,
             (select count(*) from public.tickets)
      from (select t2.id from public.tickets t2
            order by t2.created_at desc, t2.id desc
            offset off limit page_size) pg
      join public.tickets t on t.id = pg.id
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
      order by t.created_at desc, t.id desc;

  elsif status_filter = 'Over 7 days' then
    return query
      select t.id, t.work_date, t.status, t.total, t.created_at,
             j.job_number, j.project, c.name, p.name,
             (select count(*) from public.tickets tc
               where tc.status = 'Awaiting approval'
                 and now() - tc.created_at > interval '7 days')
      from (select t2.id from public.tickets t2
            where t2.status = 'Awaiting approval'
              and now() - t2.created_at > interval '7 days'
            order by t2.created_at desc, t2.id desc
            offset off limit page_size) pg
      join public.tickets t on t.id = pg.id
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
      order by t.created_at desc, t.id desc;

  else
    return query
      select t.id, t.work_date, t.status, t.total, t.created_at,
             j.job_number, j.project, c.name, p.name,
             (select count(*) from public.tickets tc where tc.status = status_filter)
      from (select t2.id from public.tickets t2
            where t2.status = status_filter
            order by t2.created_at desc, t2.id desc
            offset off limit page_size) pg
      join public.tickets t on t.id = pg.id
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
      order by t.created_at desc, t.id desc;
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.tabs_for_role(_role text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case _role
    when 'Admin'       then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','rates','tracker','users']
    when 'Coordinator' then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','tracker']
    when 'Helper'      then array['board','job','jha','files','contacts']
    when 'Technician'  then array['board','job','jha','upload','ticket','mytickets','files','contacts']
    -- Any role this function has not been taught yet still gets a working
    -- account rather than a failed signup.
    else array['board','job','files','contacts']
  end;
$function$;

CREATE OR REPLACE FUNCTION public.ticket_tracker_stats()
 RETURNS TABLE(unsigned_count bigint, unsigned_total numeric, over7_count bigint, over7_total numeric, approved_count bigint, approved_total numeric, invoiced_count bigint, invoiced_total numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select
    count(*) filter (where status = 'Awaiting approval'),
    coalesce(sum(total) filter (where status = 'Awaiting approval'), 0),
    count(*) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'),
    coalesce(sum(total) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'), 0),
    count(*) filter (where status = 'Approved'),
    coalesce(sum(total) filter (where status = 'Approved'), 0),
    count(*) filter (where status = 'Invoiced'),
    coalesce(sum(total) filter (where status = 'Invoiced'), 0)
  from public.tickets;
$function$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6 · Indexes
-- ═══════════════════════════════════════════════════════════════════════
-- FK columns, the pagination composites the RPCs lean on, the trgm search
-- indexes, and two partial uniques that ARE business rules: one primary
-- contact per organisation, one default rate schedule ever.

CREATE INDEX idx_audit_log_actor_id ON public.audit_log USING btree (actor_id);
CREATE INDEX idx_clients_name ON public.clients USING btree (name);
CREATE INDEX idx_clients_name_trgm ON public.clients USING gin (name gin_trgm_ops);
CREATE INDEX contacts_org_idx ON public.contacts USING btree (org_type, org_id);
CREATE UNIQUE INDEX contacts_primary_per_org ON public.contacts USING btree (org_type, org_id) WHERE is_primary;
CREATE INDEX idx_contacts_email_trgm ON public.contacts USING gin (email gin_trgm_ops);
CREATE INDEX idx_contacts_name ON public.contacts USING btree (name);
CREATE INDEX idx_contacts_name_trgm ON public.contacts USING gin (name gin_trgm_ops);
CREATE INDEX idx_contractors_name ON public.contractors USING btree (name);
CREATE INDEX idx_contractors_name_trgm ON public.contractors USING gin (name gin_trgm_ops);
CREATE INDEX idx_equipment_assigned_to ON public.equipment USING btree (assigned_to);
CREATE INDEX idx_equipment_calibration_due ON public.equipment USING btree (calibration_due);
CREATE INDEX idx_equipment_status ON public.equipment USING btree (status);
CREATE INDEX idx_function_errors_created ON public.function_errors USING btree (created_at DESC);
CREATE INDEX idx_jhas_job_id ON public.jhas USING btree (job_id);
CREATE INDEX idx_jhas_job_status ON public.jhas USING btree (job_id, status);
CREATE INDEX idx_jhas_signed_at ON public.jhas USING btree (signed_at DESC);
CREATE INDEX idx_jhas_signed_by ON public.jhas USING btree (signed_by);
CREATE INDEX idx_jobs_client_contact_id ON public.jobs USING btree (client_contact_id);
CREATE INDEX idx_jobs_client_id ON public.jobs USING btree (client_id);
CREATE INDEX idx_jobs_contractor_contact_id ON public.jobs USING btree (contractor_contact_id);
CREATE INDEX idx_jobs_contractor_id ON public.jobs USING btree (contractor_id);
CREATE INDEX idx_jobs_created_at ON public.jobs USING btree (created_at DESC);
CREATE INDEX idx_jobs_created_by ON public.jobs USING btree (created_by);
CREATE INDEX idx_jobs_lsd_trgm ON public.jobs USING gin (lsd gin_trgm_ops);
CREATE INDEX idx_jobs_project_trgm ON public.jobs USING gin (project gin_trgm_ops);
CREATE INDEX idx_jobs_search_text_trgm ON public.jobs USING gin (search_text gin_trgm_ops);
CREATE INDEX idx_jobs_status_created ON public.jobs USING btree (status, created_at DESC);
CREATE INDEX idx_rate_line_history_changed_by ON public.rate_line_history USING btree (changed_by);
CREATE INDEX idx_rate_line_history_rate_line_id ON public.rate_line_history USING btree (rate_line_id);
CREATE INDEX idx_rate_line_history_schedule ON public.rate_line_history USING btree (schedule_id, changed_at DESC);
CREATE INDEX idx_rate_lines_schedule_id ON public.rate_lines USING btree (schedule_id);
CREATE INDEX idx_rate_overrides_job_id ON public.rate_overrides USING btree (job_id);
CREATE INDEX idx_rate_schedules_client_id ON public.rate_schedules USING btree (client_id);
CREATE UNIQUE INDEX rate_schedules_one_default ON public.rate_schedules USING btree (((client_id IS NULL))) WHERE (client_id IS NULL);
CREATE INDEX idx_reports_job_id ON public.reports USING btree (job_id);
CREATE INDEX idx_ticket_crew_profile_id ON public.ticket_crew USING btree (profile_id);
CREATE INDEX idx_ticket_crew_ticket_id ON public.ticket_crew USING btree (ticket_id);
CREATE INDEX idx_ticket_lines_ticket_id ON public.ticket_lines USING btree (ticket_id);
CREATE INDEX idx_tickets_created_id ON public.tickets USING btree (created_at DESC, id DESC);
CREATE INDEX idx_tickets_job_id ON public.tickets USING btree (job_id);
CREATE INDEX idx_tickets_status_created_id ON public.tickets USING btree (status, created_at DESC, id DESC);
CREATE INDEX idx_tickets_technician_id ON public.tickets USING btree (technician_id);
CREATE INDEX idx_tickets_work_date ON public.tickets USING btree (work_date);
CREATE INDEX idx_timesheet_approvals_approved_by ON public.timesheet_approvals USING btree (approved_by);
CREATE INDEX idx_timesheet_approvals_period ON public.timesheet_approvals USING btree (period_start);

-- ═══════════════════════════════════════════════════════════════════════
-- 7 · Triggers
-- ═══════════════════════════════════════════════════════════════════════
-- tickets_total_balances is a DEFERRABLE CONSTRAINT trigger on purpose: the
-- app writes a ticket and its lines in one transaction, and the total only
-- has to balance once the whole write has landed. The auth.users trigger
-- provisions a profile for every new account.

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();
CREATE TRIGGER arcade_scores_keep_best BEFORE UPDATE ON public.arcade_scores FOR EACH ROW EXECUTE FUNCTION arcade_keep_best();
CREATE TRIGGER clients_name_refresh_jobs AFTER UPDATE OF name ON public.clients FOR EACH ROW EXECUTE FUNCTION refresh_jobs_search_text_for_org();
CREATE TRIGGER contractors_name_refresh_jobs AFTER UPDATE OF name ON public.contractors FOR EACH ROW EXECUTE FUNCTION refresh_jobs_search_text_for_org();
CREATE TRIGGER jobs_search_text_biu BEFORE INSERT OR UPDATE OF project, lsd, job_number, client_id, contractor_id ON public.jobs FOR EACH ROW EXECUTE FUNCTION jobs_refresh_search_text();
CREATE TRIGGER rate_lines_history_trigger AFTER INSERT OR DELETE OR UPDATE ON public.rate_lines FOR EACH ROW EXECUTE FUNCTION log_rate_line_change();
CREATE TRIGGER ticket_lines_sync_total AFTER INSERT OR DELETE OR UPDATE ON public.ticket_lines FOR EACH ROW EXECUTE FUNCTION private.sync_ticket_total();
CREATE TRIGGER tickets_burn_issued_number BEFORE DELETE ON public.tickets FOR EACH ROW EXECUTE FUNCTION private.burn_issued_ticket_number();
CREATE TRIGGER tickets_lock_overrides AFTER UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION private.lock_overrides_on_approval();
CREATE CONSTRAINT TRIGGER tickets_total_balances AFTER INSERT OR UPDATE OF total ON public.tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.ticket_total_balances();

-- ═══════════════════════════════════════════════════════════════════════
-- 8 · Row-level security
-- ═══════════════════════════════════════════════════════════════════════
-- Every table gates in Postgres, not just in the UI. Two rules learned the
-- hard way and worth keeping in mind before touching any of these:
-- permissive policies OR together (a careless new policy can void an old
-- condition), and policy bodies wrap auth calls in (select …) so the
-- planner runs them once per query instead of once per row.

alter table public.arcade_scores          enable row level security;
alter table public.audit_log              enable row level security;
alter table public.burned_ticket_numbers  enable row level security;
alter table public.clients                enable row level security;
alter table public.contacts               enable row level security;
alter table public.contractors            enable row level security;
alter table public.equipment              enable row level security;
alter table public.function_errors        enable row level security;
alter table public.jhas                   enable row level security;
alter table public.jobs                   enable row level security;
alter table public.profiles               enable row level security;
alter table public.rate_line_history      enable row level security;
alter table public.rate_lines             enable row level security;
alter table public.rate_overrides         enable row level security;
alter table public.rate_schedules         enable row level security;
alter table public.reports                enable row level security;
alter table public.ticket_crew            enable row level security;
alter table public.ticket_lines           enable row level security;
alter table public.tickets                enable row level security;
alter table public.timesheet_approvals    enable row level security;

create policy "arcade insert own"
  on public.arcade_scores for insert to authenticated
  with check ((profile_id = ( SELECT auth.uid() AS uid)));

create policy "arcade read"
  on public.arcade_scores for select to authenticated
  using (true);

create policy "arcade update own"
  on public.arcade_scores for update to authenticated
  using ((profile_id = ( SELECT auth.uid() AS uid)))
  with check ((profile_id = ( SELECT auth.uid() AS uid)));

create policy audit_log_insert
  on public.audit_log for insert to public
  with check ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy audit_log_select
  on public.audit_log for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['users'::text, 'rates'::text]) AS has_any_tab));

create policy "burned numbers read"
  on public.burned_ticket_numbers for select to authenticated
  using (( SELECT is_staff() AS is_staff));

create policy clients_delete
  on public.clients for delete to authenticated
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text, 'rates'::text]) AS has_any_tab));

create policy clients_insert
  on public.clients for insert to authenticated
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text, 'rates'::text]) AS has_any_tab));

create policy clients_select
  on public.clients for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text, 'job'::text, 'rates'::text]) AS has_any_tab));

create policy clients_update
  on public.clients for update to authenticated
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text, 'rates'::text]) AS has_any_tab))
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text, 'rates'::text]) AS has_any_tab));

create policy "contacts delete"
  on public.contacts for delete to authenticated
  using ((( SELECT private.user_role() AS user_role) = 'Admin'::text));

create policy "contacts insert"
  on public.contacts for insert to authenticated
  with check (( SELECT is_staff() AS is_staff));

create policy "contacts read"
  on public.contacts for select to authenticated
  using (true);

create policy "contacts update"
  on public.contacts for update to authenticated
  using (( SELECT is_staff() AS is_staff))
  with check (( SELECT is_staff() AS is_staff));

create policy contractors_delete
  on public.contractors for delete to authenticated
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text]) AS has_any_tab));

create policy contractors_insert
  on public.contractors for insert to authenticated
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text]) AS has_any_tab));

create policy contractors_select
  on public.contractors for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text, 'job'::text]) AS has_any_tab));

create policy contractors_update
  on public.contractors for update to authenticated
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text]) AS has_any_tab))
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text]) AS has_any_tab));

create policy equipment_delete
  on public.equipment for delete to authenticated
  using ((( SELECT private.has_any_tab(VARIADIC ARRAY['equipment'::text]) AS has_any_tab) AND (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text]))));

create policy equipment_insert
  on public.equipment for insert to authenticated
  with check ((( SELECT private.has_any_tab(VARIADIC ARRAY['equipment'::text]) AS has_any_tab) AND (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text]))));

create policy "equipment select"
  on public.equipment for select to authenticated
  using (true);

create policy equipment_update
  on public.equipment for update to authenticated
  using ((( SELECT private.has_any_tab(VARIADIC ARRAY['equipment'::text]) AS has_any_tab) AND (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text]))))
  with check ((( SELECT private.has_any_tab(VARIADIC ARRAY['equipment'::text]) AS has_any_tab) AND (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text]))));

create policy "function errors read"
  on public.function_errors for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = 'Admin'::text)))));

create policy "jhas insert"
  on public.jhas for insert to authenticated
  with check (( SELECT is_staff() AS is_staff));

create policy "jhas read"
  on public.jhas for select to authenticated
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['jha'::text, 'job'::text, 'users'::text]) AS has_any_tab));

create policy "jhas update"
  on public.jhas for update to authenticated
  using (( SELECT is_staff() AS is_staff))
  with check (( SELECT is_staff() AS is_staff));

create policy jobs_delete
  on public.jobs for delete to authenticated
  using ((( SELECT private.user_role() AS user_role) = 'Admin'::text));

create policy jobs_insert
  on public.jobs for insert to public
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text]) AS has_any_tab));

create policy jobs_select
  on public.jobs for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['board'::text, 'job'::text]) AS has_any_tab));

create policy jobs_update
  on public.jobs for update to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['job'::text, 'board'::text]) AS has_any_tab));

create policy profiles_delete
  on public.profiles for delete to public
  using ((( SELECT private.has_any_tab(VARIADIC ARRAY['users'::text]) AS has_any_tab) AND (id <> ( SELECT auth.uid() AS uid))));

create policy profiles_insert
  on public.profiles for insert to public
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['users'::text]) AS has_any_tab));

create policy "auth admin reads profiles for the token hook"
  on public.profiles for select to supabase_auth_admin
  using (true);

create policy profiles_select
  on public.profiles for select to public
  using ((( SELECT auth.uid() AS uid) IS NOT NULL));

create policy profiles_update
  on public.profiles for update to public
  using ((( SELECT private.has_any_tab(VARIADIC ARRAY['users'::text]) AS has_any_tab) AND (NOT ((id = ( SELECT auth.uid() AS uid)) AND (NOT ('users'::text = ANY (tab_access)))))));

create policy "rate line history read"
  on public.rate_line_history for select to authenticated
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text, 'ticket'::text, 'job'::text]) AS has_any_tab));

create policy rate_lines_delete
  on public.rate_lines for delete to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy rate_lines_write
  on public.rate_lines for insert to public
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy rate_lines_select
  on public.rate_lines for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text, 'ticket'::text, 'job'::text]) AS has_any_tab));

create policy rate_lines_update
  on public.rate_lines for update to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy rate_overrides_delete
  on public.rate_overrides for delete to authenticated
  using ((( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab) AND (NOT locked)));

create policy rate_overrides_insert
  on public.rate_overrides for insert to authenticated
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy rate_overrides_select
  on public.rate_overrides for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text, 'job'::text]) AS has_any_tab));

create policy rate_overrides_update
  on public.rate_overrides for update to authenticated
  using ((( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab) AND (NOT locked)))
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy rate_schedules_delete
  on public.rate_schedules for delete to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy rate_schedules_write
  on public.rate_schedules for insert to public
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy rate_schedules_select
  on public.rate_schedules for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text, 'ticket'::text, 'job'::text]) AS has_any_tab));

create policy rate_schedules_update
  on public.rate_schedules for update to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['rates'::text]) AS has_any_tab));

create policy reports_insert
  on public.reports for insert to public
  with check (( SELECT private.has_any_tab(VARIADIC ARRAY['upload'::text, 'job'::text]) AS has_any_tab));

create policy reports_select
  on public.reports for select to authenticated
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['upload'::text, 'job'::text, 'users'::text]) AS has_any_tab));

create policy ticket_crew_delete
  on public.ticket_crew for delete to authenticated
  using (( SELECT private.can_write_ticket(ticket_crew.ticket_id) AS can_write_ticket));

create policy ticket_crew_insert
  on public.ticket_crew for insert to authenticated
  with check (( SELECT private.can_write_ticket(ticket_crew.ticket_id) AS can_write_ticket));

create policy "crew read"
  on public.ticket_crew for select to authenticated
  using ((( SELECT private.has_any_tab(VARIADIC ARRAY['ticket'::text, 'job'::text, 'tracker'::text]) AS has_any_tab) OR (profile_id = ( SELECT auth.uid() AS uid))));

create policy ticket_crew_update
  on public.ticket_crew for update to authenticated
  using (( SELECT private.can_write_ticket(ticket_crew.ticket_id) AS can_write_ticket))
  with check (( SELECT private.can_write_ticket(ticket_crew.ticket_id) AS can_write_ticket));

create policy ticket_lines_delete
  on public.ticket_lines for delete to authenticated
  using (( SELECT private.can_write_ticket(ticket_lines.ticket_id) AS can_write_ticket));

create policy ticket_lines_write
  on public.ticket_lines for insert to authenticated
  with check (( SELECT private.can_write_ticket(ticket_lines.ticket_id) AS can_write_ticket));

create policy ticket_lines_select
  on public.ticket_lines for select to public
  using (( SELECT private.has_any_tab(VARIADIC ARRAY['ticket'::text, 'job'::text, 'tracker'::text]) AS has_any_tab));

create policy "tickets delete"
  on public.tickets for delete to authenticated
  using ((( SELECT is_staff() AS is_staff) AND (approved_at IS NULL) AND (status <> ALL (ARRAY['Approved'::text, 'Invoiced'::text])) AND ((technician_id = ( SELECT auth.uid() AS uid)) OR (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text])))));

create policy "tickets insert"
  on public.tickets for insert to authenticated
  with check ((( SELECT is_staff() AS is_staff) AND ((technician_id = ( SELECT auth.uid() AS uid)) OR (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text])))));

create policy "tickets select"
  on public.tickets for select to authenticated
  using (( SELECT is_staff() AS is_staff));

create policy "tickets update"
  on public.tickets for update to authenticated
  using ((( SELECT is_staff() AS is_staff) AND (approved_at IS NULL) AND (status <> ALL (ARRAY['Approved'::text, 'Invoiced'::text])) AND ((technician_id = ( SELECT auth.uid() AS uid)) OR (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text])))))
  with check ((( SELECT is_staff() AS is_staff) AND ((technician_id = ( SELECT auth.uid() AS uid)) OR (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Coordinator'::text])))));

create policy timesheet_approvals_delete
  on public.timesheet_approvals for delete to authenticated
  using ((( SELECT private.user_role() AS user_role) = 'Admin'::text));

create policy timesheet_approvals_insert
  on public.timesheet_approvals for insert to authenticated
  with check ((( SELECT private.user_role() AS user_role) = 'Admin'::text));

create policy "timesheet approvals read"
  on public.timesheet_approvals for select to authenticated
  using (true);

create policy timesheet_approvals_update
  on public.timesheet_approvals for update to authenticated
  using ((( SELECT private.user_role() AS user_role) = 'Admin'::text))
  with check ((( SELECT private.user_role() AS user_role) = 'Admin'::text));

-- ═══════════════════════════════════════════════════════════════════════
-- 9 · Storage — buckets and their policies
-- ═══════════════════════════════════════════════════════════════════════
-- All four buckets are private; every object is reached through a signed
-- URL minted at click time. The timesheets bucket is folder-per-person,
-- which is what its read policy keys on.

insert into storage.buckets (id, name, public) values
  ('reports',    'reports',    false),
  ('shared',     'shared',     false),
  ('jhas',       'jhas',       false),
  ('timesheets', 'timesheets', false)
on conflict (id) do nothing;

create policy "jhas delete"
  on storage.objects for delete to authenticated
  using (((bucket_id = 'jhas'::text) AND ( SELECT private.has_tab('users'::text) AS has_tab)));

create policy "reports delete"
  on storage.objects for delete to authenticated
  using (((bucket_id = 'reports'::text) AND ( SELECT private.has_tab('users'::text) AS has_tab)));

create policy "shared delete"
  on storage.objects for delete to authenticated
  using (((bucket_id = 'shared'::text) AND ( SELECT private.has_tab('files'::text) AS has_tab)));

create policy "timesheets delete"
  on storage.objects for delete to authenticated
  using (((bucket_id = 'timesheets'::text) AND (( SELECT private.user_role() AS user_role) = 'Admin'::text)));

create policy "jhas write"
  on storage.objects for insert to authenticated
  with check (((bucket_id = 'jhas'::text) AND ( SELECT private.has_tab('jha'::text) AS has_tab)));

create policy "reports write"
  on storage.objects for insert to authenticated
  with check (((bucket_id = 'reports'::text) AND (( SELECT private.has_tab('upload'::text) AS has_tab) OR ( SELECT private.has_tab('job'::text) AS has_tab))));

create policy "shared write"
  on storage.objects for insert to authenticated
  with check (((bucket_id = 'shared'::text) AND ( SELECT private.has_tab('files'::text) AS has_tab)));

create policy "timesheets write"
  on storage.objects for insert to authenticated
  with check (((bucket_id = 'timesheets'::text) AND (( SELECT private.user_role() AS user_role) = 'Admin'::text)));

create policy "jhas read"
  on storage.objects for select to authenticated
  using (((bucket_id = 'jhas'::text) AND (( SELECT private.has_tab('jha'::text) AS has_tab) OR ( SELECT private.has_tab('job'::text) AS has_tab) OR ( SELECT private.has_tab('users'::text) AS has_tab))));

create policy "reports read"
  on storage.objects for select to authenticated
  using (((bucket_id = 'reports'::text) AND (( SELECT private.has_tab('upload'::text) AS has_tab) OR ( SELECT private.has_tab('job'::text) AS has_tab) OR ( SELECT private.has_tab('users'::text) AS has_tab))));

create policy "shared read"
  on storage.objects for select to authenticated
  using (((bucket_id = 'shared'::text) AND ( SELECT private.has_tab('files'::text) AS has_tab)));

create policy "timesheets read"
  on storage.objects for select to authenticated
  using (((bucket_id = 'timesheets'::text) AND ((( SELECT private.user_role() AS user_role) = 'Admin'::text) OR ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text))));

create policy "timesheets update"
  on storage.objects for update to authenticated
  using (((bucket_id = 'timesheets'::text) AND (( SELECT private.user_role() AS user_role) = 'Admin'::text)))
  with check (((bucket_id = 'timesheets'::text) AND (( SELECT private.user_role() AS user_role) = 'Admin'::text)));

-- ═══════════════════════════════════════════════════════════════════════
-- 10 · Function grants — who may call what
-- ═══════════════════════════════════════════════════════════════════════
-- Transcribed from the live ACLs. Three tiers: trigger bodies nobody calls
-- directly, RPCs for signed-in users (never anon), and the auth hook that
-- only the auth service and service role may run. Functions not named here
-- keep the default execute grant, matching the live state exactly.

-- Trigger-internal: no caller but the triggers themselves.
revoke execute on function private.burn_issued_ticket_number() from public, anon, authenticated, service_role;
revoke execute on function private.sync_ticket_total() from public, anon, authenticated, service_role;
revoke execute on function private.ticket_total_balances() from public, anon, authenticated, service_role;

-- Policy helper: callers are policies, whose bodies run as the caller.
revoke execute on function private.can_write_ticket(text) from public, anon, service_role;

-- Trigger bodies on public tables: service role only beyond their triggers.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.jobs_refresh_search_text() from public, anon, authenticated;
revoke execute on function public.log_rate_line_change() from public, anon, authenticated;
revoke execute on function public.refresh_jobs_search_text_for_org() from public, anon, authenticated;

-- The auth hook: the auth service reads profiles through it at token time.
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- RPCs: signed-in users, never anonymous ones.
revoke execute on function public.bulk_set_rate_lines(uuid[], numeric[]) from public, anon;
revoke execute on function public.delete_job(uuid, uuid, boolean) from public, anon;
revoke execute on function public.equipment_stats() from public, anon;
revoke execute on function public.has_tab(text) from public, anon;
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.next_ticket_number(text, date) from public, anon;
revoke execute on function public.search_equipment(text, integer, integer) from public, anon;
revoke execute on function public.search_jobs(text, text, text, integer, integer) from public, anon;
revoke execute on function public.search_org_directory(text, text, integer, integer) from public, anon;
revoke execute on function public.tabs_for_role(text) from public, anon;
revoke execute on function public.ticket_tracker_stats() from public, anon;

-- ═══════════════════════════════════════════════════════════════════════
-- End of baseline. New migrations continue on top of this file with later
-- timestamps, applied to the live project first and written here second,
-- exactly as before.
-- ═══════════════════════════════════════════════════════════════════════
