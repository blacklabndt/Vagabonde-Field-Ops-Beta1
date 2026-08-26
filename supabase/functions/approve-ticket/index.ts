// approve-ticket — the public page a client rep lands on from the email.
//
// No account, no login: the token in the URL is the credential. The page is
// rendered here rather than served as a static file because the ticket has to
// be read with the service role — an anonymous browser has no RLS grant to
// see it, and shouldn't.
//
// GET  ?t=token  → the ticket, read-only, with an Approve button
// POST ?t=token  → records the approval and burns the token
//
// Runs without JWT verification — the rep has no bearer token, only the
// link — pinned by [functions.approve-ticket] in supabase/config.toml so a
// deploy can't quietly turn verification back on and 401 every approval.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { esc } from "../_shared/postmark.ts";
import { renderInvoice, invoiceCss } from "../_shared/invoice.ts";
import { loadInvoice, TICKET_INVOICE_SELECT } from "../_shared/ticketInvoice.ts";

// The invoice supplies its own .sheet and its own table styling, so this adds
// only what sits around it: the sign form, notices, and the stamp. The old
// shell defined .sheet and td itself and would have fought the document it is
// now wrapping.
const page = (inner: string) => new Response(
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field invoice · VagaboNDE</title>
<style>
${invoiceCss}
  .plain { width:min(560px,100%); margin:0 auto; background:var(--paper);
           border:1px solid var(--hard); padding:26px 24px }
  .kicker { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent) }
  h1 { font-size:26px; margin:6px 0 4px; font-weight:600 }
  .meta { color:var(--mute); margin-bottom:20px; font-size:13px }
  /* Reads as the foot of the invoice rather than as something floating below
     it: same width, same paper, butted straight onto the sheet above. */
  .actions { width:min(940px,100%); margin:0 auto; background:var(--paper);
             border:1px solid var(--hard); border-top:0; padding:16px 22px 20px }
  /* display:block on the input and a margin on the button. Without both the
     button painted over the name box — the input is inline by default, so it
     did not reserve its own line, and the button had no gap above it. */
  /* Not .sig — invoiceCss uses that for the invoice's signature table row
     and pins it to height:40px. Sharing the name clamped this label, the
     input overflowed it, and the button laid out over the top of the box
     the client types their name into. */
  label.signbox { display:block; font-size:12px; color:var(--mute) }
  input { display:block; width:100%; margin-top:6px; padding:11px 12px;
          border:1px solid var(--hard); background:#fff; color:var(--ink);
          font-size:15px; font-family:inherit }
  input:focus { outline:2px solid var(--accent); outline-offset:-2px }
  button { display:block; width:100%; min-height:52px; margin-top:14px; border:0;
           background:var(--accent); color:#fff; font-size:16px; font-weight:600;
           cursor:pointer }
  button:hover { background:#4a6d90 }
  button:disabled { opacity:.5; cursor:default }
  .signnote { font-size:12px; color:var(--mute); margin-top:12px }
</style></head><body>${inner}</body></html>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } }
);

const notice = (title: string, body: string) =>
  page(`<div class="plain"><div class="kicker">Ticket approval</div><h1>${esc(title)}</h1><p class="meta">${esc(body)}</p></div>`);

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    await logError("approve-ticket", (e as Error).message);
    return notice("Something went wrong", "This approval link couldn't be processed right now. Please try again shortly, or ask VagaboNDE to resend it.");
  }
});

async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) return notice("Link incomplete", "This approval link is missing its token. Please use the link exactly as it appeared in the email.");

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Cast because the select list is built at runtime: supabase-js can only
  // infer a row type from a literal, and falls back to an error type when the
  // string is concatenated. Only the token columns are read off this — the
  // invoice itself is loaded through loadInvoice below.
  const { data: row, error: readErr } = await admin
    .from("tickets")
    .select(TICKET_INVOICE_SELECT + ", approval_expires_at")
    .eq("approval_token", token).maybeSingle();
  // deno-lint-ignore no-explicit-any
  const ticket = row as any;

  // A failed lookup is not a spent token, and telling a rep their link is used
  // up when the database merely hiccuped sends them chasing the wrong thing.
  if (readErr) throw readErr;

  if (!ticket) {
    return notice("This link has already been used",
      "If the ticket still needs signing, ask VagaboNDE to send a fresh approval link.");
  }
  if (ticket.approval_expires_at && new Date(ticket.approval_expires_at) < new Date()) {
    return notice("This link has expired",
      "Approval links are good for 30 days. Ask VagaboNDE to send a new one.");
  }

  // Loaded through the shared reader, so this page, the emailed copy and the
  // office view cannot drift apart in what they print. Service role here: the
  // person following the link has no account, which is the whole point.
  const { data: invoiceData } = await loadInvoice(admin, ticket.id as string);
  const invoice = () => renderInvoice(invoiceData!);
  const header = invoice();

  // Checked before the POST branch, not after it. A ticket that still carries
  // a token but is already signed — an approval link re-sent by mistake, say —
  // used to fall straight through into the POST handler and be re-signed,
  // overwriting the original signature, time and IP on a finished record.
  if (ticket.status === "Approved" || ticket.approved_at) {
    // renderInvoice prints the approval stamp itself once the ticket is
    // signed, so this needs nothing added to it.
    return page(header);
  }

  if (req.method === "POST") {
    const form = await req.formData();
    const name = String(form.get("name") ?? "").trim();
    if (!name) {
      return page(header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">Please type your name to sign.</p></div>` + signForm());
    }
    // Best-effort client IP; behind Supabase's edge this is the forwarded header.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null;
    // Conditional on the ticket still being unsigned, so two taps on a slow
    // phone connection cannot both land and record the second as the
    // signature. The read above narrows the window; this closes it.
    const approvedAt = new Date().toISOString();
    // .select() so we learn whether THIS request is the one that signed.
    // Without it a zero-row update (the token already burned by a
    // concurrent submit — the same link forwarded to a colleague, both
    // signing at once) returns {data:null, error:null}, indistinguishable
    // from success; the loser would then be handed a receipt stamped with
    // their own name for a ticket the record attributes to someone else.
    const { data: signedRows, error: signErr } = await admin.from("tickets").update({
      status: "Approved",
      approved_at: approvedAt,
      approved_by_email: name,
      approved_ip: ip,
      approval_token: null // single use — burn it
    }).eq("id", ticket.id).is("approved_at", null).select("approved_by_email, approved_at");
    if (signErr) throw signErr;

    if (!signedRows || signedRows.length === 0) {
      // Someone else's submit won the race and burned the token. Show the
      // approval that actually persisted, not this request's attempt.
      const { data: fresh } = await admin.from("tickets")
        .select("approved_by_email, approved_at").eq("id", ticket.id).maybeSingle();
      invoiceData!.ticket.status = "Approved";
      invoiceData!.ticket.approved_at = fresh?.approved_at ?? approvedAt;
      invoiceData!.ticket.approved_by_email = fresh?.approved_by_email ?? "";
      return page(invoice() + `
        <div class="actions"><p class="signnote">This ticket was already approved. The signature on record is shown above.
        You can print or save this page for your records.</p></div>`);
    }

    // Re-render so the signed document itself carries the stamp, rather than
    // a stamp being tacked under a copy that still shows a blank signature
    // line — the rep keeps this page, and it should read as signed. The
    // loaded invoice data predates the update, so the stamp fields go onto
    // it from the row we just wrote.
    invoiceData!.ticket.status = "Approved";
    invoiceData!.ticket.approved_at = signedRows[0].approved_at ?? approvedAt;
    invoiceData!.ticket.approved_by_email = signedRows[0].approved_by_email ?? name;
    return page(invoice() + `
      <div class="actions"><p class="signnote">Thank you. VagaboNDE has been notified and this ticket is now
      locked. You can print or save this page for your records.</p></div>`);
  }

  return page(header + signForm());
}

function signForm() {
  return `<form method="POST" class="actions">
    <label class="signbox">Your name — typing it here signs this ticket
      <input name="name" autocomplete="name" placeholder="T. Beaudry" required>
    </label>
    <button type="submit">Approve this ticket</button>
    <p class="note">Approving records your name, the time, and your IP address as the signature. Questions before you sign? Reply to the email instead.</p>
  </form>`;
}
