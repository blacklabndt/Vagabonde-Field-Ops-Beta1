// gif-search — hands the team chat's GIF picker its KLIPY app key.
//
// This began life as a Tenor proxy, which died with Tenor's API
// (shut down 2026-06-30). KLIPY — where the GIF ecosystem moved — takes
// the opposite architecture: its integration terms require search and
// media requests to come from the end user's own browser, not through a
// partner server, so there is nothing to proxy. The key itself still
// lives as a Supabase secret rather than in the public bundle: this
// function hands it only to signed-in accounts (verify_jwt is on),
// which is as guarded as a client-side key can be.
//
// Until the KLIPY_API_KEY secret is set, the picker shows this
// function's own explanation instead of a grid — the same
// build-now-configure-later shape as Postmark.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const key = Deno.env.get("KLIPY_API_KEY");
    if (!key) {
      throw new Error("GIF search isn't set up yet — an admin needs to add the KLIPY_API_KEY secret in Supabase.");
    }
    return new Response(JSON.stringify({ appKey: key }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
