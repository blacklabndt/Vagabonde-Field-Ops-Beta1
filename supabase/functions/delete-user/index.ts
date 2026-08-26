// delete-user — actually deletes a Supabase Auth account, not just its
// profiles row.
//
// Users & access's "Remove account" used to only delete the profiles row —
// the app treats that as removed (no profile, no sign-in), but the real
// auth.users account was left behind. Deleting an auth user needs the
// service-role key, which must never reach the browser, so this runs
// server-side: verify the caller is a signed-in Admin, then delete both the
// profile and the underlying auth account.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { userId } = await req.json();
    if (!userId) throw new Error("userId is required");

    const authHeader = req.headers.get("Authorization") ?? "";
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "Not signed in" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

    // Only an Admin may remove an account — checked against the caller's own
    // profile, read through RLS so this can't be spoofed by a non-admin JWT.
    const { data: callerProfile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
    if (!callerProfile || callerProfile.role !== "Admin") {
      return new Response(JSON.stringify({ error: "Only an Admin can remove an account" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (userId === user.id) {
      return new Response(JSON.stringify({ error: "You can't remove your own account" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // The profile row first — if the auth delete below fails partway, the
    // person still can't sign in (no profile behind their session), rather
    // than the reverse order leaving an orphaned profile with no account.
    await admin.from("profiles").delete().eq("id", userId);
    const { error: authErr } = await admin.auth.admin.deleteUser(userId);
    if (authErr) throw authErr;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("delete-user", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
