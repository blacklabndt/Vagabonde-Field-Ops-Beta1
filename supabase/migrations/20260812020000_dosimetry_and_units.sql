-- ─────────────────────────────────────────────────────────────────────────
-- Dosimetry and unit numbers
--
-- The FLHA names the people on site as Nuclear Energy Worker (1) — the
-- technician — and Nuclear Energy Worker (2) — the helper. Each carries three
-- pieces of monitoring equipment (TLD/OSLD, DRD, alarming dosimeter) and works
-- out of a numbered unit.
--
-- The serials and the unit live on the person, because they are assigned and
-- rarely change: the JHA screen pre-fills from here and the tech only touches
-- them when equipment is swapped. What is recorded per JHA is the reading —
-- start is always 0, so the end reading IS the dose for that assessment.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.profiles
  add column if not exists unit_number  text,
  add column if not exists tld_serial   text,
  add column if not exists drd_serial   text,
  add column if not exists alarm_serial text,
  add column if not exists id_code      text;

comment on column public.profiles.unit_number  is 'Unit # the worker is assigned to; carried onto their JHA.';
comment on column public.profiles.tld_serial   is 'TLD / OSLD serial number.';
comment on column public.profiles.drd_serial   is 'DRD serial (SOR/R, DMC 3000).';
comment on column public.profiles.alarm_serial is 'Alarming dosimeter serial (RDS-30).';
comment on column public.profiles.id_code      is 'ID code on the FLHA — NRCAN # or driver''s licence #.';

-- One row per worker on the assessment, kept as jsonb rather than its own
-- table: it is read and written whole with the JHA, never queried across
-- assessments, and the shape follows the form rather than the database.
--   [{ slot: 1|2, profileId, name, idCode, unit, tld, drd, alarm,
--      startReading: 0, endReading, doseMr }]
alter table public.jhas
  add column if not exists dosimetry   jsonb not null default '[]'::jsonb,
  add column if not exists unit_number text;

-- The rest of the sheet: site information, the equipment record, and the
-- severity / probability / frequency each selected hazard was rated at. One
-- column rather than a table per section — written once with the assessment
-- and read back whole to render the form.
alter table public.jhas
  add column if not exists details jsonb not null default '{}'::jsonb;

-- A JHA is filed at the start of the day and closed out at the end, when the
-- end readings exist. Open until then.
-- closed_by is a plain uuid, deliberately not a foreign key to profiles: jhas
-- already has one relationship to that table (signed_by), and a second makes
-- every embedded `profiles(name)` select ambiguous — which would break the
-- "Signed JHAs on file" table the moment this ran.
alter table public.jhas
  add column if not exists status    text not null default 'Open',
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by uuid;

-- Assessments filed before this migration have no close-out step to wait for.
update public.jhas
   set status = 'Closed', closed_at = signed_at
 where status = 'Open' and signed_at < now() - interval '1 day';
