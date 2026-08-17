-- Four read gates that did not match the data behind them. Found by asking
-- the database what each real account can actually see, table by table, as
-- the role rather than as the migration runner:
--
--   table              total   Bob   Dave   Kyle   Mark
--   rate_lines           177  NONE    all    all    all
--   rate_line_history     54   all    all    all    all      ← the problem
--
-- 1. rate_line_history leaked the rate card it was meant to record.
--
--    Its policy was `is_staff()`, and is_staff() is only "has a profile with
--    any tab at all" — every signed-in account. So an account with no rates,
--    ticket or job tab is correctly refused rate_lines and then hands over
--    all 54 rows of label / unit / old_rate / new_rate per schedule, which is
--    the same pricing plus who changed it and when. The audit trail was a
--    side door around the thing it audits. It now matches rate_lines exactly:
--    history can never be more visible than the rates themselves.
--
-- 2. jhas rows said `true` while jha files were gated.
--
--    20260815202002 shut the storage side of this and left the rows open, so
--    the same person who could not download the PDF could still read the row
--    behind it — hazards, crew, signed_at. Half a gate is not a gate. The row
--    now takes the same tabs as the file.
--
-- 3. reports rows were invisible to admins.
--
--    Not a leak, the reverse: `upload, job` excludes both admin accounts, so
--    Job detail's report list came back empty for them while the storage gate
--    (as of the last migration) would happily serve the file. The two now
--    agree, and an admin can see the reports they are meant to be chasing.
--
-- 4. ticket_crew rows said `true`.
--
--    Hours and dose per person, readable by anyone signed in. Every current
--    account holds one of these four tabs, so nothing visible changes today —
--    this is closing the door before someone new walks through it.
--
-- Deliberately left alone: contacts, equipment and timesheet_approvals also
-- read `true`. Those are a shared directory, a shared kit list, and a small
-- crew's approved hours — defensible as open, and tightening them would break
-- pickers across the app for no real gain. Noted so the next person knows it
-- was a decision and not an oversight.

-- 1 ────────────────────────────────────────────────────────────────────────
drop policy if exists "rate line history read" on public.rate_line_history;
create policy "rate line history read" on public.rate_line_history
  for select to authenticated
  using ((select private.has_any_tab('rates', 'ticket', 'job')));

-- 2 ────────────────────────────────────────────────────────────────────────
drop policy if exists "jhas read" on public.jhas;
create policy "jhas read" on public.jhas
  for select to authenticated
  using ((select private.has_any_tab('jha', 'job', 'users')));

-- 3 ────────────────────────────────────────────────────────────────────────
drop policy if exists "reports_select" on public.reports;
create policy "reports_select" on public.reports
  for select to authenticated
  using ((select private.has_any_tab('upload', 'job', 'users')));

-- 4 ────────────────────────────────────────────────────────────────────────
drop policy if exists "crew read" on public.ticket_crew;
create policy "crew read" on public.ticket_crew
  for select to authenticated
  using ((select private.has_any_tab('ticket', 'job', 'tracker', 'timesheets')));
