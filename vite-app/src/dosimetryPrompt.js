// The JHA builder's offer to keep a worker's dosimeter serials, as the three
// answers that have nothing to do with React or the database.
//
// Filing an assessment needs at least one of a worker's three serials, and a
// technician whose profile carries none types them again on every job —
// nothing the field can press has ever written them back, because the
// profiles UPDATE policy wants the users tab. The builder asks once and
// offers to keep them; these are the questions it asks first.

// Whether a kit carries no dosimeter serial at all. Whitespace is nothing: a
// space typed into a box is not a serial, and filing already reads it that
// way (it trims before it checks), so the prompt has to agree — otherwise it
// would go quiet for a worker the form is still about to refuse.
export function hasNoSerials(kit) {
  const k = kit || {};
  return !String(k.tld || "").trim()
    && !String(k.drd || "").trim()
    && !String(k.alarm || "").trim();
}

// The three serials as they go to the profile: trimmed, and a box left empty
// is an empty string rather than undefined, so the caller sends all three
// every time instead of deciding which ones it may leave out.
export function trimmedSerials(kit) {
  const k = kit || {};
  return {
    tld: String(k.tld || "").trim(),
    drd: String(k.drd || "").trim(),
    alarm: String(k.alarm || "").trim()
  };
}

// Whether this error means the database has no set_own_dosimetry yet — a
// fresh environment standing up before the migration is applied — rather
// than a refusal or a timeout.
//
// Both halves matter, exactly as the dose ledger's fallback does it
// (timesheets.jsx): PGRST202 is the reliable half, and a message is believed
// only when it names this function, so a permission refusal or a dead
// gateway never gets quietly dressed up as "not deployed yet" and swallowed.
export function isMissingSetOwnDosimetry(error) {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  const msg = String(error.message || "");
  return msg.includes("set_own_dosimetry") && /could not find|does not exist|not found/i.test(msg);
}
