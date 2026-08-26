// send-report — emails a radiographic report to the contractor.
//
// Sends the PDF BOTH ways: attached (what contractors expect and can file
// straight into their turnover package) and as a secure link (survives size
// limits, and can be re-opened if the attachment gets lost in a thread).
//
// Runs server-side because it holds the Postmark token and needs the
// service-role key to read a private storage object. The caller's own JWT is
// checked first, so this can't be used as an open relay.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendMail, base64, corsHeaders, wrapEmail, esc, MAX_ATTACHMENT_BYTES,
         recipients, optionalRecipients } from "../_shared/postmark.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { reportId, to, cc, message } = await req.json();
    if (!reportId) throw new Error("reportId is required");
    // The caller check below proves who is asking, not who receives — the
    // link this email carries opens a private PDF for 14 days.
    const toList = recipients(to, "to");
    const ccList = optionalRecipients(cc, "cc");

    // 1. Who's asking? Reject anything without a valid session.
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

    // RLS still applies to this read, so a user who can't see the report
    // can't email it either.
    const { data: report, error: rErr } = await asUser
      .from("reports")
      .select("id, filename, pdf_key, welds, result, jobs(job_number, project, clients(name))")
      .eq("id", reportId).single();
    if (rErr || !report) throw new Error("Report not found, or you don't have access to it");

    const job = report.jobs as any;
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 2. A link that outlives the email being forwarded around a bit, but not
    // forever — 14 days is about one turnover cycle.
    let link = "";
    let attachments = undefined;
    let attachmentNote = "";

    if (report.pdf_key) {
      const { data: signed } = await admin.storage
        .from("reports").createSignedUrl(report.pdf_key, 60 * 60 * 24 * 14);
      link = signed?.signedUrl ?? "";

      const { data: blob } = await admin.storage.from("reports").download(report.pdf_key);
      if (blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length <= MAX_ATTACHMENT_BYTES) {
          attachments = [{
            Name: report.filename,
            Content: base64(bytes),
            ContentType: "application/pdf"
          }];
        } else {
          attachmentNote =
            "<p style=\"color:#6b6d6e\">The file was too large to attach — use the link above to download it.</p>";
        }
      }
      // Both storage calls are individually best-effort, but an email with
      // neither the attachment nor a working link delivers nothing while
      // the row records it as sent. A report that has a PDF on file must
      // ship at least one way, or the send is a failure and has to say so.
      if (!link && !attachments) {
        throw new Error("Couldn't read the report's PDF from storage — nothing was sent. Try again shortly.");
      }
    }

    const subject = `${job.job_number} · ${job.project} — radiographic report${report.welds ? " (" + report.welds + ")" : ""}`;
    const note = (message || "").trim();

    const html = wrapEmail(`
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5980a6;margin-bottom:6px">Radiographic report</div>
      <div style="font-size:22px;font-weight:600;margin-bottom:4px">${esc(job.project)}</div>
      <div style="color:#6b6d6e;margin-bottom:18px">${esc(job.job_number)} · ${esc(job.clients?.name)}</div>
      ${note ? `<p>${esc(note).replace(/\n/g, "<br>")}</p>` : ""}
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid rgba(29,31,32,.2);margin:18px 0 0">
        <tr><td style="padding:8px 0;color:#6b6d6e;width:120px">File</td><td style="padding:8px 0">${esc(report.filename)}</td></tr>
        ${report.welds ? `<tr><td style="padding:8px 0;color:#6b6d6e">Welds</td><td style="padding:8px 0">${esc(report.welds)}</td></tr>` : ""}
        ${report.result ? `<tr><td style="padding:8px 0;color:#6b6d6e">Result</td><td style="padding:8px 0">${esc(report.result)}</td></tr>` : ""}
      </table>
      ${link ? `<p style="margin-top:22px"><a href="${link}" style="display:inline-block;background:#5980a6;color:#f2f2f3;text-decoration:none;padding:11px 20px;font-weight:600">Download the report</a></p>
      <p style="font-size:11px;color:#6b6d6e">The report is attached, and this link works for 14 days.</p>` : ""}
      ${attachmentNote}
    `);

    const text = [
      `${job.job_number} — ${job.project}`,
      job.clients?.name ?? "",
      "",
      note,
      "",
      `File: ${report.filename}`,
      report.welds ? `Welds: ${report.welds}` : "",
      report.result ? `Result: ${report.result}` : "",
      link ? `\nDownload (14 days): ${link}` : ""
    ].filter(Boolean).join("\n");

    await sendMail({
      from: Deno.env.get("MAIL_FROM_REPORTS") ?? "reports@vagabonde.ca",
      to: toList, cc: ccList, subject, htmlBody: html, textBody: text,
      attachments, tag: "report"
    });

    // 3. Record that it went, so the job detail's "Sent" column is truthful.
    await admin.from("reports").update({
      sent_at: new Date().toISOString(), sent_to: toList
    }).eq("id", reportId);

    return new Response(JSON.stringify({ ok: true, attached: !!attachments }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    await logError("send-report", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

// Logged with a throwaway service-role client rather than trying to reuse
// `admin` from above, since a failure early in the handler (before `admin`
// exists) still needs somewhere to log to.
async function logError(functionName: string, message: string, context: Record<string, unknown> = {}) {
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("function_errors").insert({ function_name: functionName, message, context });
  } catch { /* logging is best-effort; never let it mask the real error */ }
}
