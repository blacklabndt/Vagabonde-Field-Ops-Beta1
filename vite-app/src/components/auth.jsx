import React, { useState } from "react";
import { sbClient } from "../config.js";
import { tabList, Blueprint, Btn, Field, ErrorBox } from "./common.jsx";
import { OfflineCache } from "../offlineCache.js";
import { IDENTITY_KEY } from "../session.js";

export function SignInScreen({ onSignIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    const { data: profile, error: profErr } = await sbClient
      .from("profiles").select("*").eq("id", data.user.id).single();
    setBusy(false);
    if (profErr || !profile) {
      setError("Signed in, but no profile is set up for this account yet — ask an admin to add you in Users & access.");
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
          <Field label="Email">
            <input className="input" style={{ minHeight: 42 }} type="email" value={email}
              name="email" autoComplete="username" required
              onChange={e => setEmail(e.target.value)} placeholder="you@meridiannde.ca" />
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
            <a href="#" onClick={e => e.preventDefault()}>Forgot password</a>
          </div>
        </Blueprint>
      </div>
    </div>
  );
}

