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

// The three serials a profile row holds, in the kit's own shape, so a kit
// and a profile can be compared without either side learning the other's
// column names.
export function serialsOnProfile(profile) {
  const p = profile || {};
  return { tld: String(p.tld_serial || "").trim(), drd: String(p.drd_serial || "").trim(), alarm: String(p.alarm_serial || "").trim() };
}

// Which of the typed serials are news to what is on file: non-empty, and not
// the same as the one held. A box left empty says nothing — a worker who
// wears two devices is not told every job that the third is missing — and a
// serial retyped exactly as the profile has it is nothing to keep. This is
// what turns the first-time offer into an offer for the worker whose profile
// holds two of three, or whose dosimeter was swapped since.
export function newSerials(typed, onFile) {
  const t = trimmedSerials(typed);
  const o = trimmedSerials(onFile);
  return ["tld", "drd", "alarm"].filter(k => t[k] && t[k] !== o[k]);
}

// What goes to the profile when a typed kit is kept over what is on file:
// every typed serial, and for a box left empty the profile's own — the RPC
// writes all three, and an empty box must not wipe a serial the profile has.
export function mergedSerials(typed, onFile) {
  const t = trimmedSerials(typed);
  const o = trimmedSerials(onFile);
  return { tld: t.tld || o.tld, drd: t.drd || o.drd, alarm: t.alarm || o.alarm };
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

// Who has been offered the serials panel this session, by profile id. Marked
// when the panel is shown, so a dismissal is respected for the rest of the
// session; cleared when a session ends (App.jsx), so a tablet that runs for
// a week asks the next person in their own right rather than never again.
const asked = new Set();
export const dosimetryAskedFor = id => asked.has(id);
export const markDosimetryAsked = id => { asked.add(id); };
export const forgetDosimetryAsked = () => { asked.clear(); };
