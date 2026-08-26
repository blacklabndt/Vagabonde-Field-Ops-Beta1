// Tests for the sign-in restore path.
//
// Run with: node --test src/session.test.mjs
//
// This is the one piece of the app whose failure modes only appear when the
// network is gone, which is exactly when they are hardest to reproduce by
// hand — the bug these cover ("stuck on Loading…", and being signed out for
// going out of range) was found by cutting a laptop's wifi, not by clicking.

import test from "node:test";
import assert from "node:assert/strict";
import { restoreSession, identityFrom } from "./session.js";

const PROFILE = { id: "u1", name: "K. Keith", role: "Technician", cert: "Lvl II", tab_access: ["board", "job", "ticket"] };
const SESSION = { data: { session: { user: { id: "u1", email: "k@example.ca" } } } };
const CACHED = { id: "u1", name: "K. Keith", email: "k@example.ca", role: "Technician", cert: "Lvl II", tabs: ["board", "job", "ticket", "contacts"] };

const never = () => new Promise(() => {});
const isNetworkError = e => /failed to fetch|networkerror/i.test((e && e.message) || "");

const base = over => ({
  getSession: async () => SESSION,
  fetchProfile: async () => ({ data: PROFILE, error: null }),
  signOut: async () => { throw new Error("signOut should not have been called"); },
  readIdentity: async () => null,
  writeIdentity: async () => {},
  isNetworkError,
  timeoutMs: 50,
  ...over
});

test("signs in normally when everything answers", async () => {
  let written = null;
  const r = await restoreSession(base({ writeIdentity: async i => { written = i; } }));
  assert.equal(r.user.name, "K. Keith");
  assert.ok(r.user.tabs.includes("contacts"), "universal tab is added");
  assert.equal(written.id, "u1", "identity is remembered for the next offline start");
  assert.ok(!r.offline);
});

test("a getSession() that never settles does not hang the app", async () => {
  const r = await restoreSession(base({ getSession: never, readIdentity: async () => CACHED }));
  assert.equal(r.user.name, "K. Keith", "falls back to the identity saved on this device");
  assert.equal(r.offline, true);
  assert.equal(r.reason, "session-timeout");
});

test("a profile read that never settles does not hang the app", async () => {
  const r = await restoreSession(base({ fetchProfile: never, readIdentity: async () => CACHED }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "profile-timeout");
});

test("a network failure never signs the user out", async () => {
  // supabase-js reports a failed request as an error object, not a throw.
  const r = await restoreSession(base({
    fetchProfile: async () => ({ data: null, error: new TypeError("Failed to fetch") }),
    readIdentity: async () => CACHED
    // signOut in `base` throws if called, which is the assertion
  }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "profile-unreachable");
  assert.ok(!r.signedOut);
});

test("offline with nothing remembered lands on sign-in, not a spinner", async () => {
  const r = await restoreSession(base({ getSession: never, readIdentity: async () => null }));
  assert.equal(r.user, null);
  assert.equal(r.offline, true);
});

test("an account the server says has no access is still signed out", async () => {
  let signedOut = false;
  const r = await restoreSession(base({
    fetchProfile: async () => ({ data: { ...PROFILE, tab_access: [] }, error: null }),
    signOut: async () => { signedOut = true; }
  }));
  assert.equal(r.user, null);
  assert.equal(signedOut, true, "a real answer of 'no access' still ends the session");
  assert.equal(r.signedOut, true);
});

test("no session at all, while online, shows sign-in", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null } }),
    isOffline: () => false
  }));
  assert.equal(r.user, null);
  assert.ok(!r.offline);
});

// The one that actually bit: any session older than an hour needs refreshing,
// and offline that refresh fails. supabase-js reports the result as an
// ordinary "no session" — so this looked identical to signing out, and the
// app answered it with a login form that cannot reach the server.
test("an expired token that could not refresh offline restores from cache", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null }, error: new TypeError("Failed to fetch") }),
    readIdentity: async () => CACHED,
    isOffline: () => false   // proved by the error alone, not just the flag
  }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "no-session-offline");
});

test("no session while the browser knows it is offline restores from cache", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null } }),
    readIdentity: async () => CACHED,
    isOffline: () => true
  }));
  assert.equal(r.user.name, "K. Keith");
  assert.equal(r.reason, "no-session-offline");
});

// The mirror of the above: signing out clears this device's cache, so there
// is nothing to restore and the sign-in screen is correct even offline.
test("a deliberate sign-out still lands on sign-in, even with no network", async () => {
  const r = await restoreSession(base({
    getSession: async () => ({ data: { session: null } }),
    readIdentity: async () => null,
    isOffline: () => true
  }));
  assert.equal(r.user, null);
});

test("identityFrom refuses an account with no tabs", () => {
  assert.equal(identityFrom({ id: "u", tab_access: [] }, "a@b.c"), null);
  assert.equal(identityFrom(null, "a@b.c"), null);
});
