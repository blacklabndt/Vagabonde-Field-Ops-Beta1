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
// The row holds a hash of the token, never the token (see
// _shared/approvalToken.ts): the tickets table is readable by every staff
// account, and a raw token there was a way for anyone signed in to sign a
// colleague's ticket as the client.
//
// Runs without JWT verification — the rep has no bearer token, only the
// link — pinned by [functions.approve-ticket] in supabase/config.toml so a
// deploy can't quietly turn verification back on and 401 every approval.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { esc } from "../_shared/mail.ts";
import { renderInvoice, invoiceCss } from "../_shared/invoice.ts";
import { loadInvoice, TICKET_INVOICE_SELECT } from "../_shared/ticketInvoice.ts";
import { hashToken, invoiceFingerprint } from "../_shared/approvalToken.ts";

// A signature is a typed name and, optionally, a small PNG. Anything bigger
// than this is not a form a person filled in, and formData() would buffer
// the lot before anything here could object.
const MAX_BODY_BYTES = 1_000_000;
const MAX_NAME_CHARS = 120;

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
  /* The signing surface. touch-action:none or the page scrolls instead of
     inking on the one device most reps sign from. */
  .sigpad { display:block; width:100%; height:150px; margin-top:6px;
            border:1px dashed var(--hard); background:#fff;
            touch-action:none; cursor:crosshair }
  .sigrow { display:flex; gap:10px; margin-top:8px; align-items:center; flex-wrap:wrap }
  .sigrow .ghost { display:inline-block; width:auto; min-height:0; margin:0; padding:9px 13px;
                   background:none; border:1px solid var(--hard); color:var(--ink);
                   font-size:13px; font-weight:400; cursor:pointer }
  .sigrow .ghost:hover { background:var(--band) }
  .sigrow input[type=file] { display:none }
  button.dl { background:none; border:1px solid var(--accent); color:var(--accent) }
  button.dl:hover { background:var(--band); color:var(--accent) }
  /* Printing (or Save as PDF) keeps the bill and drops the buttons — the
     invoice's own print rules already strip the grey backdrop. */
  @media print { .actions { display:none } }
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
    .eq("approval_token", await hashToken(token)).maybeSingle();
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
    // signed — including the drawn signature, which rides the select.
    return page(header + `<div class="actions">${downloadButton()}</div>`);
  }

  // What this page is asking the rep to sign for, as of right now.
  const fingerprint = await invoiceFingerprint(invoiceData!);

  if (req.method === "POST") {
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
      return page(header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">That signature image is too large — try a smaller photo, or just type your name.</p></div>` + signForm(fingerprint));
    }
    const form = await req.formData();
    // The page the rep is submitting from showed a particular set of charges.
    // If the ticket has been edited since — or the page predates this check —
    // show the current bill and ask again, rather than recording a signature
    // against figures the rep never saw.
    if (String(form.get("fp") ?? "") !== fingerprint) {
      return page(header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">This ticket has changed since this page was opened. Please look over the charges above and sign again below.</p></div>` + signForm(fingerprint));
    }
    const name = String(form.get("name") ?? "").trim().slice(0, MAX_NAME_CHARS);
    if (!name) {
      return page(header + `<div class="actions"><p style="color:#8a3b3b;font-size:13px">Please type your name to sign.</p></div>` + signForm(fingerprint));
    }
    // The drawn/uploaded signature, if one came along. Validated to exactly
    // a small PNG data URL — anything else (oversized, wrong type, not a
    // data URL at all) is dropped rather than argued with: the typed name
    // above is the signature of record either way.
    const rawSig = String(form.get("signature") ?? "");
    const signature =
      rawSig && rawSig.length <= 400000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(rawSig)
        ? rawSig : null;
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
      // Always written, even as null: the signature column must only ever
      // hold what THIS approval carried, never something staged earlier.
      approved_signature: signature,
      approval_token: null // single use — burn it
    }).eq("id", ticket.id).is("approved_at", null).select("approved_by_email, approved_at, approved_signature");
    if (signErr) throw signErr;

    if (!signedRows || signedRows.length === 0) {
      // Someone else's submit won the race and burned the token. Show the
      // approval that actually persisted, not this request's attempt.
      const { data: fresh } = await admin.from("tickets")
        .select("approved_by_email, approved_at, approved_signature").eq("id", ticket.id).maybeSingle();
      invoiceData!.ticket.status = "Approved";
      invoiceData!.ticket.approved_at = fresh?.approved_at ?? approvedAt;
      invoiceData!.ticket.approved_by_email = fresh?.approved_by_email ?? "";
      invoiceData!.ticket.approved_signature = fresh?.approved_signature ?? null;
      return page(invoice() + `
        <div class="actions"><p class="signnote">This ticket was already approved. The signature on record is shown above.</p>
        ${downloadButton()}</div>`);
    }

    // Re-render so the signed document itself carries the stamp, rather than
    // a stamp being tacked under a copy that still shows a blank signature
    // line — the rep keeps this page, and it should read as signed. The
    // loaded invoice data predates the update, so the stamp fields go onto
    // it from the row we just wrote.
    invoiceData!.ticket.status = "Approved";
    invoiceData!.ticket.approved_at = signedRows[0].approved_at ?? approvedAt;
    invoiceData!.ticket.approved_by_email = signedRows[0].approved_by_email ?? name;
    invoiceData!.ticket.approved_signature = signedRows[0].approved_signature ?? null;
    return page(invoice() + `
      <div class="actions"><p class="signnote">Thank you. VagaboNDE has been notified and this ticket is now
      locked.</p>
      ${downloadButton()}</div>`);
  }

  return page(header + signForm(fingerprint));
}

// The typed name remains the signature of record; the pad adds the rep's
// actual mark to the bill. One canvas is the single source: drawing inks
// it, uploading a picture lands the picture in it (fitted), Clear empties
// it, and whatever it holds at submit rides along as a small PNG.
//
// `fingerprint` is the digest of the charges this page shows; the POST
// handler refuses a submit whose digest no longer matches the ticket.
function signForm(fingerprint: string) {
  return `<form method="POST" class="actions" id="signform">
    <input type="hidden" name="fp" value="${esc(fingerprint)}">
    <label class="signbox">Your name — typing it here signs this ticket
      <input name="name" autocomplete="name" placeholder="T. Beaudry" maxlength="${MAX_NAME_CHARS}" required>
    </label>
    <label class="signbox" style="margin-top:14px">Your signature (optional) — draw it below with a finger or mouse, or upload a photo of it</label>
    <canvas id="sigpad" class="sigpad"></canvas>
    <div class="sigrow">
      <button type="button" class="ghost" id="sigclear">Clear</button>
      <label class="ghost">Upload signature image<input type="file" id="sigfile" accept="image/*"></label>
    </div>
    <input type="hidden" name="signature" id="sigdata">
    <button type="submit">Approve this ticket</button>
    <p class="note">Approving records your name, the time, and your IP address as the signature. Questions before you sign? Reply to the email instead.</p>
  </form>
  <script>
  (function () {
    var pad = document.getElementById("sigpad");
    if (!pad || !pad.getContext) return;
    var ctx = pad.getContext("2d");
    var dirty = false;
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    function reset() {
      pad.width = Math.round(pad.clientWidth * dpr);
      pad.height = Math.round(pad.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = "#1d1f20";
      dirty = false;
    }
    reset();
    var drawing = false, lx = 0, ly = 0;
    function pos(e) { var r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    pad.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      // Capture keeps a stroke inked when the finger wanders off the pad;
      // losing the capture is no reason to lose the stroke.
      try { pad.setPointerCapture(e.pointerId); } catch { /* draw anyway */ }
      drawing = true;
      var p = pos(e); lx = p[0]; ly = p[1];
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 0.01, ly); ctx.stroke();
      dirty = true;
    });
    pad.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      var p = pos(e);
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(p[0], p[1]); ctx.stroke();
      lx = p[0]; ly = p[1];
    });
    ["pointerup", "pointercancel"].forEach(function (t) {
      pad.addEventListener(t, function () { drawing = false; });
    });
    document.getElementById("sigclear").addEventListener("click", reset);
    document.getElementById("sigfile").addEventListener("change", function () {
      var f = this.files && this.files[0];
      this.value = "";
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { alert("That image is over 8 MB — use a smaller photo of your signature."); return; }
      var img = new Image();
      img.onload = function () {
        reset();
        var w = pad.clientWidth, h = pad.clientHeight;
        var s = Math.min(w / img.width, h / img.height);
        ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
        dirty = true;
        URL.revokeObjectURL(img.src);
      };
      img.onerror = function () { alert("That file couldn't be read as an image."); };
      img.src = URL.createObjectURL(f);
    });
    document.getElementById("signform").addEventListener("submit", function () {
      // One tap, one approval: a second tap on a slow connection used to
      // reach the server as a second submit and land the rep on "already
      // approved". The disabled button is left out of the form data, which
      // is fine — it carries no name.
      var go = this.querySelector("button[type=submit]");
      if (go) { go.disabled = true; go.textContent = "Approving…"; }
      if (!dirty) return;
      // Exported small: the bill needs a legible mark, not a photograph.
      var out = document.createElement("canvas");
      out.width = 600; out.height = Math.max(1, Math.round(600 * pad.clientHeight / pad.clientWidth));
      out.getContext("2d").drawImage(pad, 0, 0, out.width, out.height);
      var data = out.toDataURL("image/png");
      if (data.length > 400000) {
        out.width = 300; out.height = Math.max(1, Math.round(out.height / 2));
        out.getContext("2d").drawImage(pad, 0, 0, out.width, out.height);
        data = out.toDataURL("image/png");
      }
      if (data.length <= 400000) document.getElementById("sigdata").value = data;
    });
  })();
  </script>`;
}

// Offered once the document is signed (or was already): the page IS the
// bill, so the device's own print dialog — Save as PDF — hands over a
// pixel-faithful copy. The print rules hide this bar itself.
function downloadButton() {
  return `<button type="button" class="dl" onclick="window.print()">Download PDF</button>
    <p class="signnote">Opens your device's print dialog — choose &ldquo;Save as PDF&rdquo; to keep a copy of this bill.</p>`;
}
