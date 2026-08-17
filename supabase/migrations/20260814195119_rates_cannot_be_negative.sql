-- A billing rate can't be negative.
--
-- The rate admin screen took whatever the number box would give it, minus
-- sign included, and nothing downstream objected: a negative rate prices a
-- ticket line below zero and quietly credits the client, so the ticket totals
-- up short with no error raised anywhere. The screen is admin-only, so this
-- was a typo away rather than an attack, but a typo that bills wrong is worth
-- making impossible rather than unlikely.
--
-- Zero stays legal. It is the app's "not priced yet" value — new lines are
-- created at 0, and "Fill from default" looks for exactly that.
--
-- The UI floors the field at zero and db.js clamps before writing, but both
-- are one code path in front of a table PostgREST also exposes directly. This
-- is the guard that holds regardless of how the row is written.

alter table public.rate_lines
  drop constraint if exists rate_lines_rate_non_negative;

alter table public.rate_lines
  add constraint rate_lines_rate_non_negative check (rate >= 0);
