// Multi-user races and conflict resolution, played out with two browser
// contexts — two devices, one crew — mutating the same records.
//
// What the app promises (db.js):
// - Ticket numbers are minted by the database; a collision retries with the
//   next number, so two saves racing for one number both land, distinct.
// - A draft's lines are replaced wholesale on save — deliberate last-write-
//   wins, "a ticket's lines are edited as one document".
// - A ticket cancelled under an open editor must refuse the late save with
//   the truth, not resurrect the ticket and not claim it still exists.
//
// Desktop only, serial: these tests choreograph two pages against shared
// live rows. Every draft the suite mints it also cancels.
import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const SEED_CLIENT = "Athabasca Energy";
const STATE = "e2e/.auth/state.json";

const today = new Date();
const mmdd = String(today.getMonth() + 1).padStart(2, "0") + String(today.getDate()).padStart(2, "0");
const TICKET_RX = new RegExp(`AT-${mmdd}-\\d{2}-\\d{2}`);

// The second technician (Ben Sawatzky) — a genuinely different account, for
// the cross-user tests. His tickets carry his own initials.
const HAS_SECOND = !!(process.env.E2E_EMAIL2 && process.env.E2E_PASSWORD2);
const STATE2 = "e2e/.auth/state2.json";
const TICKET2_RX = new RegExp(`BS-${mmdd}-\\d{2}-\\d{2}`);
const EITHER_RX = new RegExp(`(AT|BS)-${mmdd}-\\d{2}-\\d{2}`);

test.beforeEach(async ({}, testInfo) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD in vite-app/e2e/.env");
  test.skip(testInfo.project.name !== "desktop", "two-device choreography — one project is enough");
});

// A second (or third) signed-in device: a banked session, fresh context.
// Pass STATE2 for the second technician's account.
async function newDevice(browser, state = STATE) {
  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  return { ctx, page: await ctx.newPage() };
}

// Board → + Ticket → seed client → nth job → billing screen ready to save.
// Returns the job number so cleanup can walk back to the job later.
async function toTicketScreen(page, jobIndex) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ Ticket" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    expect(await jobSelect.locator("option").count()).toBeGreaterThan(jobIndex);
  }).toPass({ timeout: 10_000 });
  const jobLabel = (await jobSelect.locator("option").nth(jobIndex).textContent()).trim();
  await jobSelect.selectOption({ index: jobIndex });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled({ timeout: 15_000 });
  return jobLabel.split(" — ")[0];
}

async function openJobFromBoard(page, jobNumber) {
  await page.goto("/");
  await page.getByPlaceholder(/^Search /).fill(jobNumber);
  const row = page.locator("table tbody tr", { hasText: jobNumber }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByText("Job detail")).toBeVisible({ timeout: 15_000 });
}

// Open the first of today's e2e drafts listed on the job.
async function openDraft(page) {
  const row = page.locator("tr", { hasText: TICKET_RX }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled({ timeout: 15_000 });
}

async function cancelOpenTicket(page) {
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Cancel this ticket" }).click();
  await expect(page.getByText("Job detail")).toBeVisible({ timeout: 15_000 });
}

// The job number behind the dialog's nth job, learned without committing
// to the ticket screen — the dialog is cancelled once the label is read.
async function scoutJobNumber(page, jobIndex) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ Ticket" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    expect(await jobSelect.locator("option").count()).toBeGreaterThan(jobIndex);
  }).toPass({ timeout: 10_000 });
  const label = (await jobSelect.locator("option").nth(jobIndex).textContent()).trim();
  await page.getByRole("button", { name: "Cancel" }).click();
  return label.split(" — ")[0];
}

// Leftovers from a failed or retried earlier run poison strict counts and
// pile up on the live project. Sweep every matching draft off the job so
// each test starts from zero and ends at zero — runs become self-healing.
async function cancelAllDrafts(page, jobNumber, rx) {
  await openJobFromBoard(page, jobNumber);
  // Let the job's ticket list arrive before deciding it is empty.
  await page.waitForTimeout(1200);
  for (;;) {
    const row = page.locator("tr", { hasText: rx }).first();
    if (!(await row.count())) break;
    await row.click();
    await expect(page.getByRole("button", { name: "Cancel this ticket" })).toBeVisible({ timeout: 15_000 });
    page.once("dialog", d => d.accept());
    await page.getByRole("button", { name: "Cancel this ticket" }).click();
    await expect(page.getByText("Job detail")).toBeVisible({ timeout: 15_000 });
  }
}

// Add one FILM weld line (the catalog's first pick) and type its count.
async function addFilmLine(page, qty) {
  await page.getByLabel("Add a FILM line").locator("xpath=..").getByRole("button", { name: "Add" }).click();
  const qtyInput = page.locator('input[aria-label*="Up to 3"]').first();
  await qtyInput.fill(String(qty));
  await qtyInput.blur();
}

test("two saves racing for one ticket number both land, distinct", async ({ browser }) => {
  const a = await newDevice(browser);
  const b = await newDevice(browser);
  try {
    const jobNumber = await scoutJobNumber(a.page, 1);
    await cancelAllDrafts(a.page, jobNumber, TICKET_RX);
    await toTicketScreen(a.page, 1);
    await toTicketScreen(b.page, 1);

    // Both screens hold the same preview number — the exact collision the
    // database's retry loop exists to absorb.
    const previewA = (await a.page.locator(".tabular").first().textContent()).trim();
    const previewB = (await b.page.locator(".tabular").first().textContent()).trim();
    expect(previewA).toBe(previewB);

    await Promise.all([
      a.page.getByRole("button", { name: "Save draft" }).click(),
      b.page.getByRole("button", { name: "Save draft" }).click()
    ]);
    await expect(a.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });
    await expect(b.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    // Two distinct drafts on the job — nobody's save was swallowed.
    await openJobFromBoard(a.page, jobNumber);
    await expect(a.page.locator("tr", { hasText: TICKET_RX })).toHaveCount(2, { timeout: 15_000 });

    await cancelAllDrafts(a.page, jobNumber, TICKET_RX);
    await expect(a.page.locator("tr", { hasText: TICKET_RX })).toHaveCount(0);
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});

test("concurrent edits to one draft resolve last-write-wins, as one document", async ({ browser }) => {
  const a = await newDevice(browser);
  const b = await newDevice(browser);
  try {
    const jobNumber = await scoutJobNumber(a.page, 2);
    await cancelAllDrafts(a.page, jobNumber, TICKET_RX);
    await toTicketScreen(a.page, 2);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await expect(a.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    // Both devices open the same draft before either edits.
    await openDraft(a.page);
    await openJobFromBoard(b.page, jobNumber);
    await openDraft(b.page);

    // A saves 3 welds; B — who never saw A's edit — saves 7.
    await addFilmLine(a.page, 3);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await expect(a.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    await addFilmLine(b.page, 7);
    await b.page.getByRole("button", { name: "Save draft" }).click();
    await expect(b.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    // The document is B's, wholesale: one FILM line, quantity 7 — not a
    // merge, not A's 3, and no duplicated line.
    await openJobFromBoard(a.page, jobNumber);
    await openDraft(a.page);
    const filmQty = a.page.locator('input[aria-label*="Up to 3"]');
    await expect(filmQty).toHaveCount(1);
    await expect(filmQty).toHaveValue("7");

    await cancelOpenTicket(a.page);
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});

test("two technicians racing on one job never collide — each keeps their own number", async ({ browser }) => {
  test.skip(!HAS_SECOND, "Set E2E_EMAIL2/E2E_PASSWORD2 for cross-account tests");
  const a = await newDevice(browser);
  const b = await newDevice(browser, STATE2);
  try {
    const jobNumber = await scoutJobNumber(a.page, 4);
    await cancelAllDrafts(a.page, jobNumber, TICKET_RX);
    await cancelAllDrafts(b.page, jobNumber, TICKET2_RX);
    await toTicketScreen(a.page, 4);
    await toTicketScreen(b.page, 4);

    await Promise.all([
      a.page.getByRole("button", { name: "Save draft" }).click(),
      b.page.getByRole("button", { name: "Save draft" }).click()
    ]);
    await expect(a.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });
    await expect(b.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    // One draft each, under each technician's own initials — per-tech
    // numbering means these two never even contested a number.
    await openJobFromBoard(a.page, jobNumber);
    await expect(a.page.locator("tr", { hasText: TICKET_RX })).toHaveCount(1, { timeout: 15_000 });
    await expect(a.page.locator("tr", { hasText: TICKET2_RX })).toHaveCount(1);

    // Each cleans up their own — the delete policy would refuse a swap.
    await cancelAllDrafts(a.page, jobNumber, TICKET_RX);
    await cancelAllDrafts(b.page, jobNumber, TICKET2_RX);
    await openJobFromBoard(a.page, jobNumber);
    await expect(a.page.locator("tr", { hasText: EITHER_RX })).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});

test("another technician's draft refuses an outsider's save, in plain words", async ({ browser }) => {
  test.skip(!HAS_SECOND, "Set E2E_EMAIL2/E2E_PASSWORD2 for cross-account tests");
  const a = await newDevice(browser);
  const b = await newDevice(browser, STATE2);
  try {
    // Aaron parks a draft; Ben can see it (tickets are staff-readable)…
    const jobNumber = await scoutJobNumber(a.page, 5);
    await cancelAllDrafts(a.page, jobNumber, TICKET_RX);
    await toTicketScreen(a.page, 5);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await expect(a.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    await openJobFromBoard(b.page, jobNumber);
    await openDraft(b.page);

    // …but his save must be refused in words a tech can act on — not RLS
    // jargon, and never a silent success that saved nothing.
    await addFilmLine(b.page, 5);
    await b.page.getByRole("button", { name: "Save draft" }).click();
    const alert = b.page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(/another technician/i);

    // Aaron's draft is exactly as he left it: no lines.
    await openJobFromBoard(a.page, jobNumber);
    await openDraft(a.page);
    await expect(a.page.locator('input[aria-label*="Up to 3"]')).toHaveCount(0);
    await cancelOpenTicket(a.page);
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});

test("a draft cancelled under an open editor refuses the late save honestly", async ({ browser }) => {
  const a = await newDevice(browser);
  const b = await newDevice(browser);
  try {
    const jobNumber = await scoutJobNumber(a.page, 3);
    await cancelAllDrafts(a.page, jobNumber, TICKET_RX);
    await toTicketScreen(a.page, 3);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await expect(a.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    await openDraft(a.page);
    await openJobFromBoard(b.page, jobNumber);
    await openDraft(b.page);

    // A cancels the ticket while B is still typing into it.
    await cancelOpenTicket(a.page);

    await addFilmLine(b.page, 5);
    await b.page.getByRole("button", { name: "Save draft" }).click();

    // B must be told the truth — the ticket is gone — not "it exists,
    // press Save again", and not a silent success.
    const alert = b.page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(/no longer exists|cancelled/i);

    // And the cancelled ticket stayed cancelled — no resurrection.
    await openJobFromBoard(b.page, jobNumber);
    await expect(b.page.locator("tr", { hasText: TICKET_RX })).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});
