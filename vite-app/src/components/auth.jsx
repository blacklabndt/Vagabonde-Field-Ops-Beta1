import React, { useState, useEffect } from "react";
import { sbClient } from "../config.js";
import { tabList, Blueprint, Btn, Field, ErrorBox } from "./common.jsx";
import { OfflineCache } from "../offlineCache.js";
import { IDENTITY_KEY } from "../session.js";
import { Recovery } from "../recovery.js";

export function SignInScreen({ onSignIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetState, setResetState] = useState("idle"); // idle | sending | sent
  // Read at module load, before anything could clear the hash: a reset link
  // that has expired or already been used comes back here as an error in the
  // URL and nothing else, and this screen used to answer it in silence.
  const [linkError] = useState(Recovery.error);
  useEffect(() => {
    if (!linkError) return;
    // Said out loud now, so take it out of the address bar — a reload
    // shouldn't bring the same dead link's complaint back with it.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [linkError]);

  // The reset email carries a link back to this app; opening it starts a
  // recovery session, which App.jsx catches and answers with the
  // set-a-new-password screen. Uses whatever is typed in the email field —
  // the link is only ever mailed to the account's own address, so there is
  // nothing to leak by asking.
  const forgotPassword = async e => {
    e.preventDefault();
    if (resetState === "sending") return;
    const addr = email.trim();
    if (!addr) {
      setError("Type your email above first, then tap Forgot password.");
      return;
    }
    setError("");
    setResetState("sending");
    const { error: resetErr } = await sbClient.auth.resetPasswordForEmail(addr, {
      redirectTo: window.location.origin
    });
    if (resetErr) {
      setResetState("idle");
      // Supabase rate-limits these hard (a couple per hour per address) —
      // the likeliest failure, and "try later" is the honest advice for it.
      setError(resetErr.message || "Couldn't send the reset email — wait a few minutes and try again.");
      return;
    }
    setResetState("sent");
  };

  const submit = async e => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const { data, error: authErr } = await sbClient.auth.signInWithPassword({
      email: email.trim(), password
    });
    if (authErr || !data.user) {
      setBusy(false);
      setError("That email and password don't match an account.");
      return;
    }
    let profile = null, profErr = null;
    try {
      const res = await sbClient.from("profiles").select("*").eq("id", data.user.id).single();
      profile = res.data; profErr = res.error;
    } catch (e) { profErr = e; }
    setBusy(false);
    // A dropped request is not a missing account. .single() reports a
    // genuinely-absent row as PGRST116; anything else — a timeout, an RLS
    // hiccup, a 5xx, a thrown network error on this flaky field link — is a
    // transient failure, and telling a correctly-provisioned tech to "ask an
    // admin" sends them chasing a problem that isn't theirs.
    if (profErr && profErr.code !== "PGRST116") {
      setError("Signed in, but couldn't load your profile just now — check your connection and try again.");
      return;
    }
    if (!profile) {
      setError("Signed in, but no profile is set up for this account yet — ask an admin to add you in Users & access.");
      // Same as the no-tabs branch below: an account the app has judged
      // unusable must not leave a live session on a shared tablet.
      await sbClient.auth.signOut();
      return;
    }
    const tabs = tabList(profile.tab_access);
    if (!tabs.length) {
      setError("This account has no screens enabled yet — ask an admin to grant access in Users & access.");
      await sbClient.auth.signOut();
      return;
    }
    const identity = { id: profile.id, name: profile.name, email: data.user.email, role: profile.role, cert: profile.cert, tabs };
    // Remembered so the next start with no signal knows who this is, rather
    // than showing a sign-in form that cannot reach the server anyway.
    OfflineCache.put(IDENTITY_KEY, identity);
    onSignIn(identity);
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "40px 24px" }}>
      <div style={{ width: "min(760px,100%)", display: "grid", gridTemplateColumns: "1fr 340px", gap: 40, alignItems: "center" }} className="grid-2col">
        <div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 34, letterSpacing: "-0.01em", marginBottom: 10 }}>
            VagaboNDE
          </div>
          <div className="kicker" style={{ marginBottom: 18 }}>Field Ops · RT Weld Inspection</div>
          <p style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", maxWidth: "38ch" }}>
            Hazard assessments, radiographic reports and daily billing for crews working out of Grande Prairie. Sign in with your company email.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 20, fontSize: 12, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
            <span>No account yet? Ask an admin to add you from Users &amp; access —</span>
            <span>accounts are created in Supabase Auth, not self-serve signup.</span>
          </div>
        </div>

        {/* A real <form>, so Enter submits and password managers recognise the
            pair — neither worked when this was two loose inputs. */}
        <Blueprint as="form" onSubmit={submit} style={{ padding: "22px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          <h4 style={{ margin: 0, fontSize: 20 }}>Sign in</h4>
          {/* Why they landed back on the sign-in screen instead of the
              set-a-new-password one. Above the fields, not beside the
              button, because it is about the link they just followed. */}
          {linkError && <ErrorBox>{linkError}</ErrorBox>}
          <Field label="Email">
            <input className="input" style={{ minHeight: 42 }} type="email" value={email}
              name="email" autoComplete="username" required
              onChange={e => setEmail(e.target.value)} placeholder="you@vagabonde.ca" />
          </Field>
          <Field label="Password">
            <input className="input" style={{ minHeight: 42 }} type="password" value={password}
              name="password" autoComplete="current-password" required
              onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
          </Field>
          <ErrorBox>{error}</ErrorBox>
          <Btn type="submit" variant="primary" block style={{ minHeight: 48 }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Btn>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginTop: 4, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            <span>Offline sign-in cached for 12 h</span>
            {resetState === "sent"
              ? <span>Reset link sent — check that inbox</span>
              : <a href="#" onClick={forgotPassword}>{resetState === "sending" ? "Sending…" : "Forgot password"}</a>}
          </div>
        </Blueprint>
      </div>
    </div>
  );
}


// Where the reset email's link lands. The link signs the person in for one
// recovery session; without this screen that session would just open the
// app and they'd still be locked out next time. App.jsx shows this over
// everything when the recovery session starts; Save writes the new
// password onto the account they're now (temporarily) signed in as.
export function SetNewPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async e => {
    if (e && e.preventDefault) e.preventDefault();
    if (busy) return;
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== again) { setError("The two passwords don't match."); return; }
    setBusy(true);
    setError("");
    const { error: updErr } = await sbClient.auth.updateUser({ password });
    setBusy(false);
    if (updErr) {
      setError(updErr.message || "Couldn't set the new password — try again.");
      return;
    }
    onDone(true);
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "40px 24px" }}>
      <Blueprint as="form" onSubmit={save} style={{ width: "min(380px,100%)", padding: "22px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 19 }}>Set a new password</h3>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          You followed a reset link, so you're signed in just long enough to choose a new password.
        </div>
        <Field label="New password">
          <input className="input" type="password" autoComplete="new-password" value={password}
            onChange={e => { setPassword(e.target.value); setError(""); }} style={{ width: "100%" }} />
        </Field>
        <Field label="Same again">
          <input className="input" type="password" autoComplete="new-password" value={again}
            onChange={e => { setAgain(e.target.value); setError(""); }} style={{ width: "100%" }} />
        </Field>
        <ErrorBox>{error}</ErrorBox>
        <Btn type="submit" variant="primary" block style={{ minHeight: 44 }} disabled={busy}>
          {busy ? "Saving…" : "Save new password"}
        </Btn>
        <Btn variant="ghost" block onClick={e => { e.preventDefault(); onDone(false); }}>
          Keep my old password
        </Btn>
      </Blueprint>
    </div>
  );
}
