// Tests for the chat's message merge — the function every arrival path
// funnels through. The cases here are the bugs it has already had, or
// nearly had: the "Someone" quote that refused correction, realtime
// copies blanking joins they never carried, and the identity guarantee
// the memoized rows depend on.

import test from "node:test";
import assert from "node:assert/strict";
import { mergeIn, inOrder, quotedKey, reactionsKey } from "./chatMerge.js";

const msg = (id, over = {}) => ({
  id, profileId: "p1", name: "Aaron Toews", body: "hello",
  imageKey: null, gifUrl: null, audioKey: null, fileKey: null, fileName: null,
  replyTo: null, quoted: null, reactions: [], pinnedAt: null,
  createdAt: "2026-08-20T10:00:0" + (String(id).slice(-1) || "0") + ".000Z", at: "",
  ...over
});

test("a new message is added in order", () => {
  const out = mergeIn([msg("a")], [msg("b")]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(m => m.id), ["a", "b"]);
});

test("an unchanged refresh returns the same array identity", () => {
  const prev = [msg("a"), msg("b")];
  assert.equal(mergeIn(prev, [msg("a"), msg("b")]), prev);
});

test("a realtime copy without joins keeps the name it cannot carry", () => {
  const prev = [msg("a")];
  const out = mergeIn(prev, [msg("a", { name: "", reactions: null })]);
  assert.equal(out, prev, "nothing really changed, so nothing re-renders");
});

test("the Someone bug: a corrected quote is allowed to land", () => {
  // The provisional quote arrived nameless; the correction fetch brings
  // the real name and words. The old presence-only diff dropped it.
  const prev = [msg("b", { replyTo: "a", quoted: { id: "a", name: "", body: "", label: "" } })];
  const out = mergeIn(prev, [msg("b", {
    replyTo: "a", quoted: { id: "a", name: "Aaron Toews", body: "Test round!", label: "" }
  })]);
  assert.notEqual(out, prev);
  assert.equal(out[0].quoted.name, "Aaron Toews");
  assert.equal(out[0].quoted.body, "Test round!");
});

test("a nameless provisional cannot overwrite a named quote", () => {
  const good = { id: "a", name: "Aaron Toews", body: "Test round!", label: "" };
  const prev = [msg("b", { replyTo: "a", quoted: good })];
  const out = mergeIn(prev, [msg("b", { replyTo: "a", quoted: { id: "a", name: "", body: "", label: "" } })]);
  assert.equal(out[0].quoted.name, "Aaron Toews");
});

test("an authoritative null quote clears a deleted parent's text", () => {
  // Bob's reply resolved its quote while Aaron's message existed. Aaron's
  // message is deleted; the next poll (which ran the reply_to join, so
  // hasQuoteJoin) returns quoted=null. The stale quote text must clear, not
  // linger forever on already-open clients.
  const prev = [msg("b", { replyTo: "a", quoted: { id: "a", name: "Aaron Toews", body: "bring RadHed 4471", label: "" } })];
  const out = mergeIn(prev, [msg("b", { replyTo: "a", quoted: null, hasQuoteJoin: true })]);
  assert.notEqual(out, prev);
  assert.equal(out[0].quoted, null);
});

test("a realtime null quote (no join) keeps the resolved quote", () => {
  // A joinless realtime update carries quoted=null because it never had the
  // embed — that must not wipe a quote the poll already resolved.
  const good = { id: "a", name: "Aaron Toews", body: "bring RadHed 4471", label: "" };
  const prev = [msg("b", { replyTo: "a", quoted: good })];
  const out = mergeIn(prev, [msg("b", { replyTo: "a", quoted: null, pinnedAt: "2026-08-20T11:00:00Z" })]);
  assert.equal(out[0].quoted && out[0].quoted.name, "Aaron Toews");
});

test("null reactions mean unknown; an array is authoritative", () => {
  const prev = [msg("a", { reactions: [{ emoji: "🔥", profileId: "p2" }] })];
  // A realtime pin update carries no reactions embed — must not clear.
  const kept = mergeIn(prev, [msg("a", { reactions: null, pinnedAt: "2026-08-20T11:00:00Z" })]);
  assert.equal(kept[0].reactions.length, 1);
  // A poll row with an empty array is the truth — the reaction was taken back.
  const cleared = mergeIn(kept, [msg("a", { reactions: [], pinnedAt: "2026-08-20T11:00:00Z" })]);
  assert.equal(cleared[0].reactions.length, 0);
});

test("a pin change alone is a change", () => {
  const prev = [msg("a")];
  const out = mergeIn(prev, [msg("a", { pinnedAt: "2026-08-20T11:00:00Z" })]);
  assert.notEqual(out, prev);
  assert.ok(out[0].pinnedAt);
});

test("ordering is stable on identical timestamps", () => {
  const t = "2026-08-20T10:00:00.000Z";
  const out = [msg("b", { createdAt: t }), msg("a", { createdAt: t })].sort(inOrder);
  assert.deepEqual(out.map(m => m.id), ["a", "b"]);
});

test("the keys tell apart what matters and ignore order", () => {
  assert.equal(
    reactionsKey([{ emoji: "🔥", profileId: "p1" }, { emoji: "👍", profileId: "p2" }]),
    reactionsKey([{ emoji: "👍", profileId: "p2" }, { emoji: "🔥", profileId: "p1" }])
  );
  assert.notEqual(quotedKey({ name: "A", body: "x" }), quotedKey({ name: "A", body: "y" }));
  assert.equal(quotedKey(null), "");
});
