// gif-search — the team chat's GIF picker, proxying Tenor.
//
// A proxy rather than a browser call for one reason: the TENOR_API_KEY
// lives as a Supabase secret and never reaches a phone. Until the secret
// is set, the picker shows this function's own explanation instead of a
// grid — the same build-now-configure-later shape as Postmark.
//
// verify_jwt is on, so only signed-in accounts can spend the quota.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { q } = await req.json().catch(() => ({ q: "" }));
    const key = Deno.env.get("TENOR_API_KEY");
    if (!key) {
      throw new Error("GIF search isn't set up yet — an admin needs to add the TENOR_API_KEY secret in Supabase.");
    }

    const params = new URLSearchParams({
      key,
      client_key: "vagabonde-field-ops",
      limit: "24",
      media_filter: "gif,tinygif",
      contentfilter: "medium",
    });
    const term = String(q ?? "").trim();
    if (term) params.set("q", term);
    // No search term means the picker just opened — show what's trending
    // rather than an empty pane.
    const url = `https://tenor.googleapis.com/v2/${term ? "search" : "featured"}?${params}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`The GIF service answered ${res.status} — try again in a moment.`);
    const data = await res.json();

    // Trimmed to what the picker renders: the tiny copy for the grid, the
    // full copy for the message. Anything Tenor sends without a full-size
    // gif URL is dropped rather than sent as a broken bubble.
    const gifs = ((data.results ?? []) as any[])
      .map((r) => {
        const full = r.media_formats?.gif;
        const tiny = r.media_formats?.tinygif ?? full;
        if (!full?.url) return null;
        return {
          id: String(r.id ?? full.url),
          full: full.url as string,
          preview: (tiny?.url ?? full.url) as string,
          width: Number(tiny?.dims?.[0] ?? 0),
          height: Number(tiny?.dims?.[1] ?? 0),
        };
      })
      .filter(Boolean);

    return new Response(JSON.stringify({ gifs }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
