import test from "node:test";
import assert from "node:assert/strict";
import { overwroteKey, overwroteWords } from "./overwriteNote.js";

test("the overwrite note is keyed by ticket and dated when it can be", () => {
  assert.equal(overwroteKey("S-10113-01"), "ticket.overwrote.S-10113-01");
  assert.match(overwroteWords(Date.UTC(2026, 8, 5, 20, 30)), /^When this ticket synced at .+, your queued copy replaced changes somebody else/);
  assert.match(overwroteWords(null), /^When this ticket synced, your queued copy/);
});
