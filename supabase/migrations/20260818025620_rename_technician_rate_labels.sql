-- The crew rate is per truck, not per technician — the old labels said
-- otherwise every time someone read the rate card. Per Kyle: "Straight time"
-- and "Overtime", matching the card's own style ("Standby time").
--
-- rates.exp is matched by label text against EXPENSE_LABELS in data.js, so
-- this rename lands in the same commit as the code's copy of the names.
-- rate_line_history keeps its stored labels: it records what a line was
-- called when its rate changed, and rewriting that would falsify the record.
-- Old tickets likewise keep the label they were billed under; the ticket
-- screen carries a legacy alias so reopening them still works.
update public.rate_lines set label = 'Straight time'
 where kind = 'expense' and label = 'Technician — straight';
update public.rate_lines set label = 'Overtime'
 where kind = 'expense' and label = 'Technician — overtime';
