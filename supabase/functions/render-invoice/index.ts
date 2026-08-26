// render-invoice — the field invoice as the office sees it.
//
// The same document a client is sent, rendered for someone signed in. Job
// detail shows this when a ticket is opened to be read, so what the office
// looks at and what the client signed are one document rather than two
// descriptions of one.
//
// Read as the caller, not with the service role: row-level security decides
// which tickets a person can see, and this must not be a way around that.
// Unlike approve-ticket, there is no token — the JWT is the credential, so
// this one is deployed with JWT verification left on.
//
// Returns HTML, which Supabase serves from the shared functions domain as
// text/plain with a sandbox CSP. That does not matter here: the app fetches
// this and puts it in an iframe rather than navigating to it, so the browser
// never has to be persuaded to render the response itself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/postmark.ts";
import { invoicePage } from "../_shared/invoice.ts";
import { loadInvoice } from "../_shared/ticketInvoice.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { ticketId } = await req.json();
    if (!ticketId) throw new Error("ticketId is required");

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } }
    );
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Not signed in" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { data, error } = await loadInvoice(asUser, ticketId);
    if (error || !data) throw new Error(error ?? "Ticket not found.");

    return new Response(JSON.stringify({ html: invoicePage(data) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("render-invoice", (e as Error).message);
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
