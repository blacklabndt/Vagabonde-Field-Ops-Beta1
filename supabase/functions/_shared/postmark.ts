// Shared Postmark helper for the email functions.
//
// Lives server-side only: it reads POSTMARK_TOKEN from the function's
// environment, which is a Supabase secret and never reaches the browser.
// Docs: https://postmarkapp.com/developer/api/email-api

const POSTMARK_URL = "https://api.postmarkapp.com/email";

// Postmark rejects a message over 10 MB total, and base64 inflates a file by
// ~33%. 7 MB of raw PDF is the largest that reliably fits — anything bigger
// goes out as a link only, which the email copy accounts for.
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

export interface Attachment {
  Name: string;
  Content: string; // base64
  ContentType: string;
}

export async function sendMail(opts: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  replyTo?: string;
  attachments?: Attachment[];
  tag?: string;
}) {
  const token = Deno.env.get("POSTMARK_TOKEN");
  if (!token) throw new Error("POSTMARK_TOKEN is not set — see 'Things to do to get set up', step 3.");

  const res = await fetch(POSTMARK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Postmark-Server-Token": token
    },
    body: JSON.stringify({
      From: opts.from,
      To: opts.to,
      Cc: opts.cc || undefined,
      ReplyTo: opts.replyTo || Deno.env.get("MAIL_REPLY_TO") || undefined,
      Subject: opts.subject,
      HtmlBody: opts.htmlBody,
      TextBody: opts.textBody,
      MessageStream: "outbound",
      Tag: opts.tag,
      Attachments: opts.attachments
    })
  });

  const body = await res.json();
  // Postmark answers 200 with ErrorCode 0 on success; anything else carries a
  // human-readable Message worth surfacing rather than swallowing.
  if (!res.ok || body.ErrorCode) {
    throw new Error(`Postmark ${body.ErrorCode ?? res.status}: ${body.Message ?? "send failed"}`);
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
