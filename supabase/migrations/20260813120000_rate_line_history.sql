-- Rate history — "Rate history" in Rate admin has sat disabled since it was
-- built, with no backing data to show. A trigger on rate_lines captures
-- every rate change (old value, new value, who, when) into a small history
-- table; the button now opens that instead of doing nothing.
create table if not exists public.rate_line_history (
  id uuid primary key default gen_random_uuid(),
  rate_line_id uuid not null references public.rate_lines(id) on delete cascade,
  schedule_id uuid not null references public.rate_schedules(id) on delete cascade,
  kind text, label text, unit text,
  old_rate numeric, new_rate numeric,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now()
);

create index if not exists idx_rate_line_history_schedule on public.rate_line_history (schedule_id, changed_at desc);

create or replace function public.log_rate_line_change()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rate is distinct from old.rate then
    insert into public.rate_line_history (rate_line_id, schedule_id, kind, label, unit, old_rate, new_rate, changed_by)
    values (old.id, old.schedule_id, old.kind, old.label, old.unit, old.rate, new.rate, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists rate_lines_history_trigger on public.rate_lines;
create trigger rate_lines_history_trigger
  after update on public.rate_lines
  for each row execute function public.log_rate_line_change();

alter table public.rate_line_history enable row level security;
drop policy if exists "rate line history read" on public.rate_line_history;
create policy "rate line history read" on public.rate_line_history
  for select to authenticated using (public.is_staff());
-- No insert/update/delete policy: only the trigger (security definer) ever
-- writes to this table.
