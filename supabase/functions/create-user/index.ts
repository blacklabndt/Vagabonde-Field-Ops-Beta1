// create-user — provisions a staff account, Admin-to-Admin.
//
// Account creation used to go through the public signUp endpoint with the
// role riding in client metadata — which meant the rank was ultimately the
// client's claim, on an endpoint that answers to anyone holding the
// publishable key. The provisioning trigger now caps metadata roles to the
// field ones (see migration 20260826035549), and this function is where a
// real rank gets written: verify the caller is a signed-in Admin, create
// the auth user with the service role, then set the profile's role and
// tabs directly. With the app calling this instead of signUp, public
// sign-ups can be switched off in the dashboard entirely.
//
// Accounts arrive email-confirmed: the admin standing there creating it is
// the confirmation, and the new tech can sign in immediately.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// The same four ranks as the profiles_role_check constraint and
// ROLE_PRESETS in vite-app/src/data.js.
const VALID_ROLES = ["Admin", "Coordinator", "Technician", "Helper"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { email, password, name, role, cert } = await req.json();
    if (!email || !password) throw new Error("email and password are required");
    if (!VALID_ROLES.includes(role)) throw new Error("role must be one of: " + VALID_ROLES.join(", "));

    const authHeader = req.headers.get("Authorization") ?? "";
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);

    // Only an Admin may create an account — checked against the caller's
    // own profile, read through RLS, exactly as delete-user does it.
    const { data: callerProfile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
    if (!callerProfile || callerProfile.role !== "Admin") {
      return json({ error: "Only an Admin can create an account" }, 403);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { name, role, cert }
    });
    if (cErr) throw cErr;
    const userId = created.user!.id;

    // The trigger has already provisioned a profile off the metadata, but
    // it deliberately caps metadata roles to the field ones — the real
    // rank is written here, by the path that proved its caller is an
    // Admin. tabs_for_role keeps the tab set in step with the rank.
    const { data: tabs, error: tErr } = await admin.rpc("tabs_for_role", { _role: role });
    if (tErr) throw new Error("Account created, but its tabs could not be derived: " + tErr.message);
    const { error: pErr } = await admin.from("profiles")
      .update({ role, tab_access: tabs }).eq("id", userId);
    if (pErr) throw new Error("Account created, but its role could not be set: " + pErr.message);

    return json({ ok: true, user: { id: userId, email } });
  } catch (e) {
    await logError("create-user", (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
