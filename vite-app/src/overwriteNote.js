// The note a queued replay leaves when it wrote over somebody else's save.
//
// The replay says so once, in a forced toast — and a toast is gone in
// seconds, on a phone that may be in a pocket. This is the copy that lasts:
// keyed by the ticket in the device cache, read by the editor when that
// ticket is reopened, and cleared when the technician says they have looked.
// The cache is the right home because the replay was this device's own
// doing, and the cache is emptied when another account takes the device.
export const overwroteKey = ticketId => `ticket.overwrote.${ticketId}`;

// The banner's words. "Somebody else" because the fingerprint that caught
// it says the row changed, not who changed it.
export function overwroteWords(at) {
  const when = at ? new Date(at).toLocaleString("en-CA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  return `When this ticket synced${when ? ` at ${when}` : ""}, your queued copy replaced changes somebody else had saved while you were out of range. Check the welds, charges and crew against theirs before this goes to the client.`;
}
