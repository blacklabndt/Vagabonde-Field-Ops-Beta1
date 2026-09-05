// The plumbing the three backup functions share: CORS, a JSON reply, the
// service-role client, the error log, and the door an Admin has to come
// through.
//
// Deno-only, deliberately. This is the one backup module that imports
// supabase-js and reads the environment — the others (drive.ts,
// backupTables.ts, backupManifest.ts, backupOauth.ts, backupSchedule.ts) are
// imported straight into the node test suite and must stay import-free, so
// nothing here may ever move into them.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret"
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" }
  });

// The service role. Everything the backup does to app_settings — the tokens,
// the nonce, the connection's own columns — is written with this, because no
// signed-in account has a grant on any of it.
export const adminClient = (): SupabaseClient => createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Who is asking, answered before anything is read from them. The parse of a
// request body throws on malformed input and the catch that follows writes
// to function_errors — a log an anonymous POST must not be able to fill.
//
// Returns a Response when the caller is refused, and the caller's id when
// they are not. Checked against their own profile through RLS, the way
// delete-user does it, so a non-admin JWT cannot claim a rank.
export async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
  const asUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
  );
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  const { data: profile } = await asUser.from("profiles").select("role").eq("id", user.id).single();
  if (!profile || profile.role !== "Admin") {
    return json({ error: "Only an Admin can set up the backup" }, 403);
  }
  return { userId: user.id };
}

export async function logError(
  functionName: string, message: string, context: Record<string, unknown> = {}
): Promise<void> {
  try {
    await adminClient().from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
