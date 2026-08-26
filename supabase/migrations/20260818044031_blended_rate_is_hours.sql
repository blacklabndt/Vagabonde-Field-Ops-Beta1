-- Blended Rate is billed by the hour — it stands in for Straight time and
-- Overtime when a client negotiates one combined figure. It was added as a
-- custom expense line, and those were hardcoded to unit 'per unit'; the
-- Rate admin screen now asks for a unit when a custom line is added, and
-- the two Blended Rate lines already on file become what they meant.
update public.rate_lines set unit = 'h'
 where kind = 'custom_expense' and label = 'Blended Rate';
