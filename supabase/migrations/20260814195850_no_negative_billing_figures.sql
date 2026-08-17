-- Nothing that feeds a bill may be negative.
--
-- The companion to 20260814195119, which did this for rate_lines.rate. The
-- same reasoning applies to every other figure that ends up multiplied into a
-- ticket total: a negative one prices its line below zero and quietly credits
-- the client, and no code path anywhere treats that as an error — the ticket
-- simply totals up short.
--
-- ticket_lines.unit_rate is the other true rate. It is copied off the client's
-- rate card rather than typed, so it inherits the rate_lines guard in
-- practice; this makes that structural instead of incidental.
--
-- The quantity and hour columns are not rates, but a negative quantity is the
-- identical bug wearing a different hat — 4 welds at -$50 and -4 welds at $50
-- reach the same wrong total — so they are covered on the same terms.
--
-- Zero stays legal throughout: an unworked line, a day with no overtime and an
-- unpriced rate are all real, ordinary states.
--
-- dose_mr is here for a different reason. It is not billed at all; it is a
-- radiation exposure reading that feeds each technician's dose record, and a
-- negative one is physically meaningless. It is a safety figure, so it is
-- worth being unable to record nonsense in it.
--
-- All of these columns are clean today, so every constraint below is added
-- fully validated rather than NOT VALID.

alter table public.ticket_lines
  drop constraint if exists ticket_lines_unit_rate_non_negative,
  drop constraint if exists ticket_lines_quantity_non_negative;

alter table public.ticket_lines
  add constraint ticket_lines_unit_rate_non_negative check (unit_rate >= 0),
  add constraint ticket_lines_quantity_non_negative check (quantity  >= 0);

-- The stored total is derived from the lines above, so with those floored it
-- cannot go negative on its own. Constrained anyway: `tickets.total` is what
-- the billing tracker sums and what the client is asked to approve, and it is
-- written as a plain column rather than computed, so nothing but this stops a
-- direct write from disagreeing with the lines it is supposed to summarise.
alter table public.tickets
  drop constraint if exists tickets_total_non_negative;

alter table public.tickets
  add constraint tickets_total_non_negative check (total >= 0);

alter table public.ticket_crew
  drop constraint if exists ticket_crew_hours_non_negative,
  drop constraint if exists ticket_crew_mileage_non_negative,
  drop constraint if exists ticket_crew_dose_non_negative;

alter table public.ticket_crew
  add constraint ticket_crew_hours_non_negative check (
    straight_hours >= 0 and ot_hours >= 0 and solo_hours >= 0 and solo_ot_hours >= 0
  ),
  add constraint ticket_crew_mileage_non_negative check (mileage_km >= 0),
  add constraint ticket_crew_dose_non_negative    check (dose_mr    >= 0);

-- rate_line_history is deliberately left alone. It is an append-only audit of
-- what the rates used to be, and it has to be able to record the negatives
-- that existed before this rule did. Constraining it would let a guard on
-- today's data rewrite the record of yesterday's.
