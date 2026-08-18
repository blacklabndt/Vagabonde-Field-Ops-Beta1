-- Blended Rate stands in for Straight time and Overtime, so it belongs
-- beside them — on the card, in the ticket's dropdown, and on the printed
-- invoice, which all follow the card's order now. On the schedules that
-- carry it, everything from Travel down shifts one place and Blended Rate
-- takes the slot right after Overtime (21). Dragging it elsewhere later
-- remains the admin's call.
update public.rate_lines l set position = l.position + 1
  from public.rate_lines b
 where b.schedule_id = l.schedule_id
   and b.kind = 'custom_expense' and b.label = 'Blended Rate'
   and l.kind in ('expense', 'custom_expense')
   and l.position >= 22 and l.id <> b.id;

update public.rate_lines set position = 22
 where kind = 'custom_expense' and label = 'Blended Rate';
