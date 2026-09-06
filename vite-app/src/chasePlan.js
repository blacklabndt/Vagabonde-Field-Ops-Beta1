// Who a bulk chase is actually going to — worked out before a single email
// leaves the building.
//
// "Chase all unsigned" reads every unsigned ticket and then quietly drops
// three kinds of them: a ticket whose rep has a question open (a resend wipes
// the question off the tracker before anybody answered it), one chased in the
// last few days, and one with no address on file at all. Those decisions used
// to live inside the send loop, which meant the office learned what had been
// skipped in the summary line afterwards — after four thousand emails had
// gone. Pulled out here, the same decisions can be shown in the confirm
// dialog first, and can be tested without a live inbox.
//
// Deliberately free of React and db.js: it takes rows and returns buckets.
//
// `emailIn` is passed in rather than imported because it lives in
// common.jsx (a JSX module this can't import and a node test can't load).
// Injecting it keeps the one address-extraction rule in one place instead of
// growing a second copy of the email pattern here, which would drift.

import { withinDays } from "./data.js";

// Chased on Tuesday is chased: a client nudged then does not need the same
// email again on Thursday.
export const CHASE_RECENT_DAYS = 3;

// list: rows from Db.listUnsignedTicketContacts — { id, contactLabel,
// chasedAt, queriedAt }. Returns the tickets due a chase, each with the
// address its link will go to, and the three skipped buckets as id lists so
// the caller can count them or name them.
//
// The order of the tests is the meaning: a queried ticket that was also
// chased yesterday and has no address is reported once, as queried, because
// that is the reason the office needs to act on.
export function planChase(list, { emailIn, recentDays = CHASE_RECENT_DAYS } = {}) {
  const due = [], queried = [], recent = [], noEmail = [];
  for (const t of list || []) {
    // A rep who pressed "Query this ticket" is waiting on the office, not on
    // a reminder — and a resend clears the query, so chasing this one would
    // rub out the question before anybody answered it and ask the same rep
    // to sign the same figures again.
    if (t.queriedAt) { queried.push(t.id); continue; }
    if (withinDays(t.chasedAt, recentDays)) { recent.push(t.id); continue; }
    // The rep's address as the ticket carries it. The contact label is
    // free text ("Dana Reyes <dana@acme.ca>"), so the address is whatever
    // reads as one inside it; a label with none means nobody to send to.
    const to = emailIn(t.contactLabel);
    if (!to) { noEmail.push(t.id); continue; }
    due.push({ id: t.id, to });
  }
  return { due, queried, recent, noEmail };
}
