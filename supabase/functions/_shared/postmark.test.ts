// Tests for the recipient guard.
//
//   deno test supabase/functions/_shared/postmark.test.ts
//
// This is the only thing standing between a signed-in account and using
// VagaboNDE's own sending domain to deliver a ticket's pricing, or a 14-day
// signed link to a private report, anywhere it likes. Worth pinning down.

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recipients, optionalRecipients, esc } from "./postmark.ts";

Deno.test("a single address passes through", () => {
  assertEquals(recipients("rep@client.ca", "to"), "rep@client.ca");
});

Deno.test("a list is trimmed and rejoined", () => {
  assertEquals(
    recipients(" a@b.ca , c@d.com ", "to"),
    "a@b.ca,c@d.com",
  );
});

Deno.test("an empty to is refused", () => {
  assertThrows(() => recipients("", "to"), Error, "at least one");
  assertThrows(() => recipients(null, "to"), Error, "at least one");
  assertThrows(() => recipients("   ", "to"), Error, "at least one");
});

Deno.test("rubbish that is not an address is refused", () => {
  for (const bad of [
    "not-an-email",
    "@nodomain.ca",
    "no-at-sign.ca",
    "trailing@dot.",
    "two@@at.ca",
    "spaces in@name.ca",
  ]) {
    assertThrows(() => recipients(bad, "to"), Error, "not a valid email");
  }
});

Deno.test("one bad address spoils the whole list", () => {
  // Otherwise a valid first entry smuggles the rest past the check.
  assertThrows(
    () => recipients("good@client.ca, rubbish", "to"),
    Error,
    "not a valid email",
  );
});

Deno.test("header injection through a recipient is refused", () => {
  // A newline in a header is the classic way to append a Bcc of your own.
  for (const bad of [
    "rep@client.ca\nBcc: attacker@evil.com",
    "rep@client.ca\r\nBcc: attacker@evil.com",
    "rep@client.ca<script>",
    'rep@client.ca"',
  ]) {
    assertThrows(() => recipients(bad, "to"), Error);
  }
});

Deno.test("a bulk send is capped", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@client.ca`).join(",");
  assertThrows(() => recipients(eleven, "to"), Error, "10 is the limit");

  const ten = Array.from({ length: 10 }, (_, i) => `p${i}@client.ca`).join(",");
  assertEquals(recipients(ten, "to").split(",").length, 10, "ten is still fine");
});

Deno.test("an absent cc is simply no cc", () => {
  assertEquals(optionalRecipients("", "cc"), undefined);
  assertEquals(optionalRecipients(null, "cc"), undefined);
  assertEquals(optionalRecipients("  ", "cc"), undefined);
});

Deno.test("a cc that is present still has to be valid", () => {
  assertEquals(optionalRecipients("boss@client.ca", "cc"), "boss@client.ca");
  assertThrows(() => optionalRecipients("rubbish", "cc"), Error, "not a valid email");
});

Deno.test("esc closes every hole it claims to", () => {
  assertEquals(esc("Smith & Sons"), "Smith &amp; Sons");
  assertEquals(esc("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertEquals(esc(`" onmouseover="x`), "&quot; onmouseover=&quot;x");
  assertEquals(esc("it's"), "it&#39;s");
  assertEquals(esc(null), "");
  assertEquals(esc(undefined), "");
  assertEquals(esc(12.5), "12.5");
});
