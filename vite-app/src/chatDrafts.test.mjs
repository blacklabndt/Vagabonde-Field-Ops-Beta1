import test from "node:test";
import assert from "node:assert/strict";
import { heldDraftFor, holdDraft, heldComposerFor, holdComposer, forgetHeldDrafts } from "./chatDrafts.js";

test("the composer is held whole, per account, and emptied piece by piece", () => {
  forgetHeldDrafts();
  const reply = { id: "m1", name: "Kyle" };
  const pic = { name: "site.jpg" };
  holdDraft("a", "on my way");
  holdComposer("a", { reply, attachFile: pic });
  assert.equal(heldDraftFor("a"), "on my way");
  assert.equal(heldComposerFor("a").reply, reply);
  assert.equal(heldComposerFor("a").attachFile, pic);
  // Another account on the same tablet sees nothing of it.
  assert.equal(heldDraftFor("b"), "");
  assert.equal(heldComposerFor("b").reply, null);
  // The words going out leaves the picture and the reply where they were.
  holdDraft("a", "");
  assert.equal(heldDraftFor("a"), "");
  assert.equal(heldComposerFor("a").attachFile, pic);
  // Only when every part is empty is the account forgotten.
  holdComposer("a", { reply: null, attachFile: null });
  assert.equal(heldComposerFor("a").reply, null);
  holdComposer("a", { voiceFile: pic });
  assert.equal(heldComposerFor("a").voiceFile, pic);
  forgetHeldDrafts();
  assert.equal(heldComposerFor("a").voiceFile, null);
});
