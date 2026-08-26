// Storage keys are stricter than filenames — the API refuses non-ASCII,
// % breaks the request, # and ? truncate the key. These fixtures are the
// names that actually failed in beta testing.

import test from "node:test";
import assert from "node:assert/strict";
import { storageKeySafe } from "./data.js";

test("a plain filename passes through untouched", () => {
  assert.equal(storageKeySafe("KK-0815-26-02 report.pdf"), "KK-0815-26-02-report.pdf");
});

test("accents fold to their plain letters, not dashes", () => {
  assert.equal(storageKeySafe("Réport çamera.pdf"), "Report-camera.pdf");
});

test("emoji and other non-ASCII become a single dash", () => {
  assert.equal(storageKeySafe("émojis 🙂📄.pdf"), "emojis-.pdf");
});

test("the URL-hazard characters go: # ? %", () => {
  assert.equal(storageKeySafe("bad #1? 100%.pdf"), "bad-1-100-.pdf");
});

test("dots survive mid-name so extensions stay real", () => {
  assert.equal(storageKeySafe("spaces   and...dots....pdf"), "spaces-and...dots....pdf");
});

test("leading and trailing junk is trimmed", () => {
  assert.equal(storageKeySafe("...---weird.pdf"), "weird.pdf");
});

test("a name with nothing usable falls back", () => {
  assert.equal(storageKeySafe("🙂🙂🙂", "report.pdf"), "report.pdf");
  assert.equal(storageKeySafe("", "file"), "file");
});

test("length is capped at a hundred characters", () => {
  assert.equal(storageKeySafe("a".repeat(300) + ".pdf").length, 100);
});
