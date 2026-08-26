// send-ticket-approval — emails the client rep a link to sign a daily ticket.
//
// Attaches a PDF-style summary of the ticket as well as linking to the live
// approval page, so the rep has something to file even before they click.
// The link carries a single-use token (see the migration) — no account, no
// password, which is the whole point: a client rep signs from their phone.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, corsHeaders, wrapEmail, esc, recipients, optionalRecipients } from "../_shared/postmark.ts";
import { invoicePage, GST_RATE } from "../_shared/invoice.ts";
import { loadInvoice } from "../_shared/ticketInvoice.ts";

const money = (n: number) =>
  "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { ticketId, to, cc } = await req.json();
    if (!ticketId) throw new Error("ticketId is required");
    const toList = recipients(to, "to");
    const ccList = optionalRecipients(cc, "cc");

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

    const { data: ticket, error: tErr } = await asUser
      .from("tickets")
      .select("id, technician_id, work_date, total, status, delays, client_contact, jobs(job_number, project, lsd, afe, area, clients(name), contractors(name)), ticket_lines(kind, label, unit, quantity, unit_rate)")
      .eq("id", ticketId).single();
    if (tErr || !ticket) throw new Error("Ticket not found, or you don't have access to it");
    if (ticket.status === "Approved" || ticket.status === "Invoiced") {
      throw new Error("That ticket is already approved — nothing to send.");
    }

    // Being able to SEE the ticket is not being allowed to send it out for
    // signing: tickets_select is is_staff(), so every signed-in account —
    // Helpers included — can read any ticket. The mint below runs with the
    // service role and so bypasses tickets_update's owner-or-Admin gate;
    // this restores it. Without it, anyone could send a co-worker's ticket
    // to an inbox they control and self-approve a fabricated signature.
    const { data: caller } = await asUser.from("profiles").select("role").eq("id", user.id).single();
    const privileged = caller?.role === "Admin" || caller?.role === "Coordinator";
    if ((ticket as any).technician_id !== user.id && !privileged) {
      return new Response(JSON.stringify({ error: "Only the ticket's technician, or an Admin or Coordinator, can send it for approval." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const job = ticket.jobs as any;
    const lines = (ticket.ticket_lines as any[]) ?? [];

    // Summed from the lines, like the invoice does, rather than read off
    // tickets.total — the email and the document it links to must not be
    // able to quote a client two different numbers. Each line rounded to
    // the cent, summed in integer cents: the same formula the database
    // stores (migration 20260818140051) and invoice.ts prints.
    const lineTotal = (l: any) => Math.round(Number(l.quantity || 0) * Number(l.unit_rate || 0) * 100) / 100;
    const subtotal = lines.reduce((s: number, l: any) => s + Math.round(lineTotal(l) * 100), 0) / 100;
    const gst = Math.round(Math.round(subtotal * 100) * GST_RATE) / 100;
    const grand = Math.round((subtotal + gst) * 100) / 100;

    // Single-use token, 30 days. Long enough to survive a rep's holiday,
    // short enough that a stale forwarded email stops working.
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expires = new Date(Date.now() + 30 * 86400000).toISOString();

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // The link goes to the app's own domain, which proxies this function and
    // re-serves it as HTML — Supabase forces text/plain on HTML returned from
    // the shared functions domain, so a rep following a link straight here is
    // shown the page's source instead of the page. See worker/index.js.
    //
    // APPROVAL_BASE_URL is the app's origin, e.g. https://app.vagabonde.ca.
    // Falling back to the functions domain keeps the link working — as plain
    // text — rather than sending nothing at all if the secret is unset.
    const appBase = (Deno.env.get("APPROVAL_BASE_URL") ?? "").replace(/\/+$/, "");
    const link = appBase
      ? `${appBase}/approve?t=${token}`
      : `${(Deno.env.get("SUPABASE_URL") ?? "").replace(".supabase.co", ".functions.supabase.co")}/approve-ticket?t=${token}`;

    const rows = lines.map(l =>
      `<tr><td style="padding:6px 0">${esc(l.label)}</td>
       <td style="padding:6px 0;text-align:right;color:#6b6d6e">${esc(l.quantity)} ${esc(l.unit)}</td>
       <td style="padding:6px 0;text-align:right">${money(lineTotal(l))}</td></tr>`
    ).join("");

    const summary = `
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5980a6;margin-bottom:6px">Daily ticket ${esc(ticket.id)}</div>
      <div style="font-size:22px;font-weight:600;margin-bottom:4px">${esc(job.project)}</div>
      <div style="color:#6b6d6e;margin-bottom:18px">${esc(job.job_number)} · ${esc(job.clients?.name)}${job.lsd ? " · " + esc(job.lsd) : ""}${job.afe ? " · AFE " + esc(job.afe) : ""}</div>
      <div style="color:#6b6d6e;margin-bottom:10px">Work performed ${esc(ticket.work_date)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid rgba(29,31,32,.2);border-bottom:1px solid rgba(29,31,32,.2)">
        ${rows}
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:10px">
        <tr><td style="color:#6b6d6e">Subtotal</td>
            <td style="text-align:right;color:#6b6d6e">${money(subtotal)}</td></tr>
        <tr><td style="color:#6b6d6e">GST @ ${(GST_RATE * 100).toFixed(0)}%</td>
            <td style="text-align:right;color:#6b6d6e">${money(gst)}</td></tr>
        <tr><td style="font-weight:600;padding-top:6px">Total due</td>
            <td style="text-align:right;font-size:20px;font-weight:600;padding-top:6px">${money(grand)}</td></tr>
      </table>`;

    const html = wrapEmail(`
      ${summary}
      <p style="margin-top:24px"><a href="${link}" style="display:inline-block;background:#5980a6;color:#f2f2f3;text-decoration:none;padding:13px 24px;font-weight:600">Review &amp; approve this ticket</a></p>
      <p style="font-size:11px;color:#6b6d6e">A copy is attached for your records. The approval link works for 30 days and can only be used once.</p>
    `);

    const text = [
      `Daily ticket ${ticket.id} — ${job.project}`,
      `${job.job_number} · ${job.clients?.name ?? ""}`,
      `Work performed ${ticket.work_date}`,
      "",
      ...lines.map(l => `${l.label} — ${l.quantity} ${l.unit ?? ""} — ${money(lineTotal(l))}`),
      "",
      `Subtotal: ${money(subtotal)}`,
      `GST @ ${(GST_RATE * 100).toFixed(0)}%: ${money(gst)}`,
      `Total due: ${money(grand)}`,
      "",
      `Approve: ${link}`
    ].join("\n");

    // The attachment is the full field invoice as a standalone HTML file —
    // the same document the approval page renders, so a rep who files the
    // attachment and a rep who clicks the link are looking at one bill. It
    // opens and prints from a browser without needing a PDF renderer here.
    //
    const { data: invoiceData } = await loadInvoice(admin, ticketId, toList);
    const attachment = invoicePage(invoiceData!);
    const encoded = btoa(unescape(encodeURIComponent(attachment)));

    // Send first, record second. The other way round — which this used to do —
    // leaves a ticket marked "Awaiting approval" holding a live token when the
    // send throws, so the tracker says it went out and the rep never got it.
    // Postmark being unconfigured makes that the *normal* path, not the rare
    // one. send-report already had this order; now they match.
    await sendMail({
      from: Deno.env.get("MAIL_FROM_BILLING") ?? "billing@vagabonde.ca",
      to: toList, cc: ccList,
      subject: `Field invoice ${ticket.id} for approval — ${job.project} (${money(grand)})`,
      htmlBody: html, textBody: text,
      attachments: [{
        Name: `Field-invoice-${ticket.id}.html`,
        Content: encoded,
        ContentType: "text/html"
      }],
      tag: "ticket-approval"
    });

    // The token exists only in memory until this lands. If the write fails,
    // the emailed link points at a token no row holds — approve-ticket would
    // tell the rep the link was already used — so a failure here has to
    // surface as one, not vanish behind ok:true.
    const { error: tokenErr } = await admin.from("tickets").update({
      approval_token: token,
      approval_sent_at: new Date().toISOString(),
      approval_expires_at: expires,
      status: "Awaiting approval"
    }).eq("id", ticketId);
    if (tokenErr) {
      throw new Error(
        `The email went out, but the approval link could not be saved — resend the ticket. (${tokenErr.message})`
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("send-ticket-approval", (e as Error).message);
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
