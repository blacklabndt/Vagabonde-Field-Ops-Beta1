-- ── Profiles ────────────────────────────────────────────────────────────
-- One row per app user, 1:1 with auth.users. Role presets seed tab_access;
-- an admin can then edit individual grants (per-user, not merely per-role).
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null check (role in ('Admin','Coordinator','Technician')),
  cert text,
  tab_access text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  agreement_ref text,
  effective_from date,
  minimum_callout text
);

create table public.contractors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_type text not null check (org_type in ('client','contractor')),
  org_id uuid not null,
  name text not null,
  email text,
  phone text,
  last_used_at timestamptz default now()
);
create index contacts_org_idx on public.contacts(org_type, org_id);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  job_number text not null unique,
  project text not null,
  client_id uuid references public.clients(id),
  contractor_id uuid references public.contractors(id),
  client_contact_id uuid references public.contacts(id),
  contractor_contact_id uuid references public.contacts(id),
  lsd text,
  afe text,
  method text,
  procedure text,
  status text not null default 'Unassigned' check (status in ('Unassigned','Dispatched','In progress','Complete')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  started_at timestamptz
);

create table public.jhas (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  template text,
  hazards jsonb not null default '[]',
  signed_by uuid references public.profiles(id),
  site_rep text,
  signed_at timestamptz,
  pdf_key text,
  created_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  filename text not null,
  pdf_key text,
  welds text,
  result text check (result in ('Accept','Repair','Re-shoot')),
  interpreted_by text,
  uploaded_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_to text
);

-- Ticket numbers are minted client-side offline as {initials}{YYMMDD}{NN};
-- the unique constraint is what makes a bad sync fail loudly instead of
-- silently duplicating (see handoff "Ticket numbering").
create table public.tickets (
  id text primary key,
  job_id uuid not null references public.jobs(id),
  technician_id uuid references public.profiles(id),
  work_date date not null,
  status text not null default 'Draft' check (status in ('Draft','Awaiting approval','Approved','Invoiced')),
  client_contact jsonb,
  contractor_contact jsonb,
  total numeric(10,2) not null default 0,
  approved_at timestamptz,
  approved_by_email text,
  approved_ip text,
  invoiced_at timestamptz,
  created_at timestamptz not null default now()
);

-- Line amounts snapshot the rate at raise time — never a FK to rate_lines —
-- so publishing new rates can never reprice an issued ticket.
create table public.ticket_lines (
  id uuid primary key default gen_random_uuid(),
  ticket_id text not null references public.tickets(id) on delete cascade,
  kind text not null check (kind in ('weld','charge')),
  label text not null,
  unit text,
  quantity numeric not null,
  unit_rate numeric not null
);

create table public.rate_schedules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  effective_from date not null default current_date,
  published_at timestamptz
);

create table public.rate_lines (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.rate_schedules(id) on delete cascade,
  kind text not null check (kind in ('rt_film','rt_cr','rt_dr','method','expense','custom')),
  label text not null,
  unit text,
  rate numeric not null default 0
);

create table public.rate_overrides (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id),
  basis text,
  description text,
  bid_ref text,
  active boolean not null default true,
  locked boolean not null default false
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  entity text not null,
  entity_id text not null,
  action text not null,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
