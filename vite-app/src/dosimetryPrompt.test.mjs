// The "keep your serials" prompt on the JHA builder. Beta testing found both
// seed technicians filing with all three profile serials null, so every
// assessment started blocked on three numbers typed by hand.
//
// The tests that matter here are the two edges: a kit holding only spaces is
// still an empty kit (or the prompt goes quiet for a worker the form is
// about to refuse anyway), and an error is only "the function isn't there"
// when it says so by name.
//
// Run with: node --test src/dosimetryPrompt.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { hasNoSerials, trimmedSerials, isMissingSetOwnDosimetry, serialsOnProfile, newSerials, mergedSerials } from "./dosimetryPrompt.js";

test("a kit with nothing in it is the one worth asking about", () => {
  assert.equal(hasNoSerials({ unit: "12", idCode: "24401", tld: "", drd: "", alarm: "" }), true);
  assert.equal(hasNoSerials({}), true);
  assert.equal(hasNoSerials(null), true);
});

test("spaces are not a serial", () => {
  // Filing trims before it checks, so a kit of three spaces is refused by
  // the form; the prompt has to call it empty too or it stays hidden for
  // exactly the person it exists for.
  assert.equal(hasNoSerials({ tld: "   ", drd: "\t", alarm: " " }), true);
});

test("one serial is enough to leave the worker alone", () => {
  assert.equal(hasNoSerials({ tld: "TLD-9", drd: "", alarm: "" }), false);
  assert.equal(hasNoSerials({ tld: "", drd: "", alarm: "AL-3" }), false);
});

test("all three go to the profile, trimmed, blanks included", () => {
  assert.deepEqual(trimmedSerials({ tld: " T-1 ", drd: "", alarm: " A-2" }), { tld: "T-1", drd: "", alarm: "A-2" });
  assert.deepEqual(trimmedSerials(null), { tld: "", drd: "", alarm: "" });
});

test("a missing function is recognised by code and by name", () => {
  assert.equal(isMissingSetOwnDosimetry({ code: "PGRST202", message: "anything at all" }), true);
  assert.equal(isMissingSetOwnDosimetry({ message: "Could not find the function public.set_own_dosimetry(p_alarm, p_drd, p_tld)" }), true);
  assert.equal(isMissingSetOwnDosimetry({ message: "function set_own_dosimetry does not exist" }), true);
});

test("a refusal, a timeout and a silence are not a missing function", () => {
  // The whole point of the two-part test: these must reach the screen as
  // themselves rather than becoming "an admin has to do it for you".
  assert.equal(isMissingSetOwnDosimetry({ code: "42501", message: "permission denied for function set_own_dosimetry" }), false);
  assert.equal(isMissingSetOwnDosimetry({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isMissingSetOwnDosimetry({ message: "Could not find the function public.dose_totals" }), false);
  assert.equal(isMissingSetOwnDosimetry(null), false);
});

test("a typed serial is news only when the profile does not hold it", () => {
  const onFile = serialsOnProfile({ tld_serial: "T-1", drd_serial: null, alarm_serial: " A-9 " });
  assert.deepEqual(onFile, { tld: "T-1", drd: "", alarm: "A-9" });
  // Retyped as held, and a box left empty: nothing to keep.
  assert.deepEqual(newSerials({ tld: " T-1 ", drd: "", alarm: "A-9" }, onFile), []);
  // The missing one filled in, the alarm swapped for another unit.
  assert.deepEqual(newSerials({ tld: "T-1", drd: "D-4", alarm: "A-10" }, onFile), ["drd", "alarm"]);
  // Keeping writes all three: typed where typed, the profile's where not.
  assert.deepEqual(mergedSerials({ tld: "", drd: "D-4", alarm: "" }, onFile), { tld: "T-1", drd: "D-4", alarm: "A-9" });
  // A profile with nothing on it: every typed serial is news.
  assert.deepEqual(newSerials({ tld: "T-1", drd: "", alarm: "" }, serialsOnProfile(null)), ["tld"]);
});
