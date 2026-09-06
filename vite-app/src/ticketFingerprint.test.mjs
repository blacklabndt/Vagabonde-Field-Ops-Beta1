// The fingerprint the outbox compares before it writes a queued ticket over
// whatever is on the row now. What matters is that it moves when somebody
// edited the ticket and stays put when nobody did — a false accusation sends
// a technician to check figures that are fine, and teaches them to ignore the
// next one.

import test from "node:test";
import assert from "node:assert/strict";
import { ticketFingerprint, replacedNewerWork } from "./ticketFingerprint.js";

const line = (label, quantity, unit_rate, kind = "weld", unit = "weld") =>
  ({ kind, label, unit, quantity, unit_rate });

const person = (profileId, straight, extra = {}) => ({
  profileId, role: "Technician", straight, ot: 0, solo: 0, soloOt: 0,
  dose: 0, mileage: 0, ...extra
});

test("an empty ticket has a fingerprint, and it is always the same one", () => {
  const empty = ticketFingerprint([], [], "");
  assert.equal(typeof empty, "string");
  assert.equal(ticketFingerprint([], [], ""), empty);
  // A ticket read back from the database has null delays, and a payload
  // built by a device that has never loaded one may carry nothing at all.
  assert.equal(ticketFingerprint([], [], null), empty);
  assert.equal(ticketFingerprint(null, null, undefined), empty);
});

test("the order lines and crew come back in is not an edit", () => {
  const a = [line("Up to 3\" XS · RT film", 4, 8), line("Mileage", 0.35, 2, "charge", "km")];
  const b = [a[1], a[0]];
  const crewA = [person("aaron", 8), person("ben", 3)];
  const crewB = [crewA[1], crewA[0]];
  assert.equal(ticketFingerprint(a, crewA, "held up at the gate"),
    ticketFingerprint(b, crewB, "held up at the gate"));
});

test("a changed quantity is a different ticket", () => {
  const four = ticketFingerprint([line("FILM", 4, 8)], [], "");
  const nine = ticketFingerprint([line("FILM", 9, 8)], [], "");
  assert.notEqual(four, nine);
});

test("a changed rate, label, crew figure or delay note all move it", () => {
  const base = ticketFingerprint([line("FILM", 4, 8)], [person("aaron", 8)], "");
  assert.notEqual(base, ticketFingerprint([line("FILM", 4, 9)], [person("aaron", 8)], ""));
  assert.notEqual(base, ticketFingerprint([line("PAPER", 4, 8)], [person("aaron", 8)], ""));
  assert.notEqual(base, ticketFingerprint([line("FILM", 4, 8)], [person("aaron", 7.5)], ""));
  assert.notEqual(base, ticketFingerprint([line("FILM", 4, 8)], [person("ben", 8)], ""));
  assert.notEqual(base, ticketFingerprint([line("FILM", 4, 8)], [person("aaron", 8)], "waited on the welder"));
  // A second person on the crew is the change nobody was told about in beta.
  assert.notEqual(base, ticketFingerprint([line("FILM", 4, 8)], [person("aaron", 8), person("denis", 0)], ""));
});

test("the same figures typed and read back are the same fingerprint", () => {
  // The database hands numerics back as strings, and hours come back to two
  // decimal places whatever was typed in. Neither is an edit.
  const typed = ticketFingerprint([line("Mileage", 0.35, 2, "charge", "km")], [person("aaron", 8)], "");
  const read = ticketFingerprint(
    [{ kind: "charge", label: "Mileage", unit: "km", quantity: "0.350", unit_rate: "2.00" }],
    [person("aaron", "8.00")], null
  );
  assert.equal(typed, read);
});

test("dropping a line changes it, and so does adding one", () => {
  const one = ticketFingerprint([line("FILM", 4, 8)], [], "");
  const two = ticketFingerprint([line("FILM", 4, 8), line("Blended Rate", 0, 198, "charge", "hr")], [], "");
  assert.notEqual(one, two);
});

test("nothing is called an overwrite without both fingerprints", () => {
  // An item queued before this shipped carries no base; a read that failed
  // hands back no current. Neither is evidence, and both answer no.
  assert.equal(replacedNewerWork(null, "mine", "current"), false);
  assert.equal(replacedNewerWork("base", "mine", null), false);
  assert.equal(replacedNewerWork("", "mine", "current"), false);
});

test("an untouched ticket is not an overwrite; somebody else's save is", () => {
  assert.equal(replacedNewerWork("base", "mine", "base"), false);
  assert.equal(replacedNewerWork("base", "mine", "theirs"), true);
});

test("the retry that finds its own copy on the row says nothing", () => {
  // The item wrote, the send afterwards failed, the flush comes round again.
  assert.equal(replacedNewerWork("base", "mine", "mine"), false);
});
