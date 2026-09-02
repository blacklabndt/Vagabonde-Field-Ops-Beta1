// Shared mail helper for the email functions — the transport is Resend.
//
// Lives server-side only: it reads RESEND_API_KEY from the function's
// environment, which is a Supabase secret and never reaches the browser.
// Docs: https://resend.com/docs/api-reference/emails/send-email
//
// (This module carried Postmark before; only the transport changed. The
// recipient guards, escaping and the email frame are provider-neutral.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_URL = "https://api.resend.com/emails";

// Resend's universal test sender: works with any account, no domain
// verification — but only delivers to the Resend account owner's own
// address. It's how an admin proves the pipework before DNS is done.
const TEST_SENDER = "VagaboNDE Field Ops <onboarding@resend.dev>";

// The Email setup screen writes this row; the env vars remain as fallback
// so an install configured the old way (Supabase secrets) keeps working.
// Read with the service role — the table is Admin-only under RLS.
export async function mailSettings() {
  let row: Record<string, string | null> = {};
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await admin.from("mail_settings").select("resend_api_key, from_reports, from_billing, reply_to").maybeSingle();
    row = data ?? {};
  } catch { /* table missing or unreadable — the env fallbacks decide */ }
  return {
    apiKey: row.resend_api_key || Deno.env.get("RESEND_API_KEY") || "",
    fromReports: row.from_reports || Deno.env.get("MAIL_FROM_REPORTS") || TEST_SENDER,
    fromBilling: row.from_billing || Deno.env.get("MAIL_FROM_BILLING") || TEST_SENDER,
    replyTo: row.reply_to || Deno.env.get("MAIL_REPLY_TO") || undefined
  };
}

// Resend's own ceiling is 40 MB per message after encoding, but a 7 MB raw
// PDF is deliberately still the cap: base64 inflates it by ~33%, corporate
// inboxes start refusing well before 40, and anything bigger already goes
// out as a link only — which the email copy accounts for.
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

// The shape the send functions build (unchanged from the Postmark era, so
// the callers didn't have to move); sendMail translates it on the way out.
export interface Attachment {
  Name: string;
  Content: string; // base64
  ContentType: string;
}

export async function sendMail(opts: {
  // Which sending identity, not a literal address: the Email setup screen
  // (or the env fallbacks) decides what "reports" and "billing" mean.
  from: "reports" | "billing";
  to: string;
  cc?: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  replyTo?: string;
  attachments?: Attachment[];
  tag?: string;
}) {
  const settings = await mailSettings();
  if (!settings.apiKey) {
    throw new Error("Email isn't set up yet — an Admin can add the Resend API key under Email setup.");
  }

  const replyTo = opts.replyTo || settings.replyTo;
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      from: opts.from === "billing" ? settings.fromBilling : settings.fromReports,
      // recipients() hands lists over comma-joined; Resend wants arrays.
      to: opts.to.split(","),
      cc: opts.cc ? opts.cc.split(",") : undefined,
      reply_to: replyTo,
      subject: opts.subject,
      html: opts.htmlBody,
      text: opts.textBody,
      tags: opts.tag ? [{ name: "kind", value: opts.tag }] : undefined,
      attachments: opts.attachments?.map(a => ({
        filename: a.Name,
        content: a.Content,
        content_type: a.ContentType
      }))
    })
  });

  // Success is 200 with an id; anything else carries a human-readable
  // message worth surfacing rather than swallowing.
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend ${body.statusCode ?? res.status}: ${body.message ?? "send failed"}`);
  }
  return body;
}

export function base64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000; // chunked so a big PDF doesn't blow the call stack
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Everything interpolated into an email or the approval page is data someone
// typed — a project name, a rate line's label, the name a client rep signs
// with. Unescaped, an ampersand in "Smith & Sons" is already wrong, and a
// stray "<" silently eats the rest of the line.
export function esc(v: unknown) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Both send functions take their recipients straight from the request body,
// which means a signed-in account could otherwise post any address it liked
// and have VagaboNDE's own domain deliver a ticket's pricing — or a 14-day
// signed link to a private report — anywhere on the internet. The caller
// check upstream proves who is asking; it says nothing about who receives.
//
// So: parse the list, insist every entry is a plausible address, and cap how
// many go out at once. A real send is one rep and maybe a couple of copies;
// anything reaching for dozens is not a person filing paperwork.
const MAX_RECIPIENTS = 10;
// The domain half allows any depth of dot-separated labels — rep@mail.client.ca
// is a perfectly ordinary contractor address, and the first cut of this
// pattern (one label + TLD) refused it. The character class still bans
// whitespace, commas, semicolons, angle brackets and quotes, which is the
// header-injection guard doing the actual work here.
const ADDRESS = /^[^\s@,;<>"]+@(?:[^\s@,;<>".]+\.)+[a-z]{2,}$/i;

export function recipients(value: unknown, field: string): string {
  const list = String(value ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (!list.length) throw new Error(`${field} needs at least one email address.`);
  if (list.length > MAX_RECIPIENTS) {
    throw new Error(`${field} has ${list.length} addresses; ${MAX_RECIPIENTS} is the limit.`);
  }
  const bad = list.filter(a => !ADDRESS.test(a));
  if (bad.length) throw new Error(`${field} is not a valid email address: ${bad.join(", ")}`);

  return list.join(",");
}

// Same, but an empty cc is simply no cc rather than an error.
export function optionalRecipients(value: unknown, field: string): string | undefined {
  const raw = String(value ?? "").trim();
  return raw ? recipients(raw, field) : undefined;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};

// The app's own visual language, inlined — email clients strip <style>.
export function wrapEmail(inner: string) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f2f2f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f3;padding:28px 16px">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:#f2f2f3;border:1px solid rgba(29,31,32,.2)">
<tr><td style="padding:24px 26px;font-family:Helvetica,Arial,sans-serif;color:#1d1f20;font-size:14px;line-height:1.55">
${inner}
</td></tr></table>
<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#6b6d6e;padding-top:14px">VagaboNDE · RT Weld Inspection · Grande Prairie, AB</div>
</td></tr></table></body></html>`;
}
