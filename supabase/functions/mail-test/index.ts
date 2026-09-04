// mail-test — the Email setup screen's "Send test email" button.
//
// Sends one plain proof-of-pipework email through exactly the same path
// the real reports and approvals use, so a delivered test means the
// configuration is genuinely done. Admin-gated the same way create-user
// is: the settings it exercises include a credential only Admins manage.
//
// While the sender is still Resend's onboarding address (no domain
// verified yet), Resend only delivers to the Resend account owner's own
// email — the response says which sender was used so the screen can
// explain that.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, appSettings, corsHeaders, wrapEmail, esc, recipients } from "../_shared/mail.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them — the address check
  // below answers a stranger with a description of what it wanted, and this
  // family of functions all settles the caller first.
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  try {
    const { to } = await req.json();
    const toList = recipients(to, "to");

    const { data: callerProfile } = await asUser.from("profiles").select("role, name").eq("id", user.id).single();
    if (!callerProfile || callerProfile.role !== "Admin") {
      return json({ error: "Only an Admin can send a test email" }, 403);
    }

    const settings = await appSettings();
    const html = wrapEmail(`
<h2 style="margin:0 0 10px;font-size:18px">Email is working</h2>
<p>This is a test from VagaboNDE Field Ops, sent by ${esc(callerProfile.name)} from the Admin screen.</p>
<p>It went out from <strong>${esc(settings.fromReports)}</strong> — if that is still Resend's onboarding address, the sending domain isn't verified yet and real recipients can't receive mail; once the domain is verified in Resend and the addresses are set, tests and real sends go anywhere.</p>`);

    await sendMail({
      from: "reports",
      to: toList,
      subject: "VagaboNDE Field Ops — test email",
      htmlBody: html,
      textBody: `Email is working. Sent from ${settings.fromReports} via the Admin screen.`,
      tag: "test"
    });

    return json({ ok: true, from: settings.fromReports });
  } catch (e) {
    return json({ error: (e as Error).message || "The test send failed." }, 400);
  }
});
