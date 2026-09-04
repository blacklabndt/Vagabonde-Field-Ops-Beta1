// password-reset — an Admin sends an account a set-password link.
//
// Until now a reset meant the Supabase dashboard, or the person finding
// "Forgot password" on the sign-in screen themselves. This is the office
// doing it from Users & access: verify the caller is a signed-in Admin (as
// create-user and delete-user do), look the address up from the account
// with the service role, and mail Auth's own recovery link through the
// app's transport (see _shared/setPassword.ts). The link works once and
// lands on the app's set-password screen.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSetPasswordLink } from "../_shared/setPassword.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Who is asking comes before anything is read from them: the parse below
  // throws on a malformed body, and the catch at the bottom writes that to
  // function_errors — a log an anonymous POST must not be able to fill.
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  try {
    const { userId } = await req.json();
    if (!userId) throw new Error("userId is required");

    const { data: callerProfile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
    if (!callerProfile || callerProfile.role !== "Admin") {
      return json({ error: "Only an Admin can send a set-password link" }, 403);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: target, error: tErr } = await admin.auth.admin.getUserById(userId);
    if (tErr || !target?.user?.email) throw new Error("That account has no email address on file.");
    const { data: profile } = await admin.from("profiles").select("name, deactivated_at").eq("id", userId).maybeSingle();
    if (profile?.deactivated_at) {
      throw new Error("That account is locked out — it can't sign in until it is unbanned in the Supabase dashboard.");
    }

    await sendSetPasswordLink(admin, target.user.email, profile?.name ?? "", "reset");
    return json({ ok: true, sentTo: target.user.email });
  } catch (e) {
    await logError("password-reset", (e as Error).message);
    return json({ error: (e as Error).message }, 400);
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
