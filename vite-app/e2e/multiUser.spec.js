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
import {
  SEED_CLIENT, ticketRx, ticketRxFor, signedInInitials, goHome, scoutJobNumber,
  openJobFromBoard, cancelDraftsOnJob, openTicketRow, cancelOpenTicket, settledJobDetail
} from "./helpers.js";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const STATE = "e2e/.auth/state.json";

// The second technician (Ben Sawatzky) — a genuinely different account, for
// the cross-user tests. His tickets carry his own initials, which — like the
// first technician's — are read off the signed-in top bar rather than written
// in here, so pointing E2E_EMAIL at another account cannot make these sweeps
// hunt for numbers nobody is minting.
const HAS_SECOND = !!(process.env.E2E_EMAIL2 && process.env.E2E_PASSWORD2);
const STATE2 = "e2e/.auth/state2.json";

// The jobs a test minted drafts on, so afterEach can walk back and cancel
// them: a test that dies between "Save draft" and the cancel at its end used
// to leave its draft on the live job, and the retry left a second beside it.
// Each entry carries the account's banked session as well as the shape of its
// numbers, because a technician may cancel only their own ticket — so a
// two-account test parks one entry per person and the sweep visits each.
let sweepAfter = null;

// Only the desktop project runs this file at all — the mobile project's
// testMatch is fieldOps alone (playwright.config.js), which is why there is no
// project check here: a skip that can never fire only inflates the skipped
// count and reads as coverage that was considered and dropped.
test.beforeEach(async () => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD in vite-app/e2e/.env");
  sweepAfter = null;
});

test.afterEach(async ({ browser }) => {
  const left = sweepAfter;
  sweepAfter = null;
  if (!left) return;
  // The other two specs sweep with the test's own `page` fixture. These tests
  // have none: their pages live in contexts they open themselves and close in
  // a finally, so by the time this runs there is nothing left open. The sweep
  // therefore opens its own device on the same banked session, exactly as the
  // tests do.
  for (const { jobNumber, rx, state } of left) {
    let device = null;
    try {
      device = await newDevice(browser, state);
      await cancelAllDrafts(device.page, jobNumber, rx);
    } catch (e) {
      // Best effort: a sweep that cannot run must not turn a passing test red,
      // and must not hide the real failure of one that already went wrong.
      console.warn("Draft sweep on " + jobNumber + " did not finish:", e.message);
    } finally {
      if (device) await device.ctx.close();
    }
  }
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
  await goHome(page);
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

// The helpers' openJobFromBoard starts from the board; these tests hop between
// jobs and editors, so each call walks back to Home first.
const openJob = async (page, jobNumber) => {
  await goHome(page);
  await openJobFromBoard(page, jobNumber);
};

// Open the first of today's e2e drafts listed on the job.
async function openDraft(page, rx) {
  await openTicketRow(page, rx);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled({ timeout: 15_000 });
}

// The job number behind the dialog's nth job, learned without committing
// to the ticket screen — the dialog is cancelled once the label is read.
const scoutJob = async (page, jobIndex) => {
  await goHome(page);
  return scoutJobNumber(page, jobIndex);
};

// Leftovers from a failed or retried earlier run poison strict counts and
// pile up on the live project. Sweep every matching draft off the job so
// each test starts from zero and ends at zero — runs become self-healing.
async function cancelAllDrafts(page, jobNumber, rx) {
  await openJob(page, jobNumber);
  await cancelDraftsOnJob(page, rx);
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
    const jobNumber = await scoutJob(a.page, 1);
    const rx = await ticketRx(a.page);
    await cancelAllDrafts(a.page, jobNumber, rx);
    // Registered before a single row is written: the cancel at the end of the
    // test is the happy path, not the only cleanup.
    sweepAfter = [{ jobNumber, rx, state: STATE }];
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
    await openJob(a.page, jobNumber);
    await expect(a.page.locator("tr", { hasText: rx })).toHaveCount(2, { timeout: 15_000 });

    await cancelAllDrafts(a.page, jobNumber, rx);
    await expect(a.page.locator("tr", { hasText: rx })).toHaveCount(0);
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});

test("concurrent edits to one draft resolve last-write-wins, as one document", async ({ browser }) => {
  const a = await newDevice(browser);
  const b = await newDevice(browser);
  try {
    const jobNumber = await scoutJob(a.page, 2);
    const rx = await ticketRx(a.page);
    await cancelAllDrafts(a.page, jobNumber, rx);
    sweepAfter = [{ jobNumber, rx, state: STATE }];
    await toTicketScreen(a.page, 2);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await settledJobDetail(a.page);

    // Both devices open the same draft before either edits.
    await openDraft(a.page, rx);
    await openJob(b.page, jobNumber);
    await openDraft(b.page, rx);

    // A saves 3 welds; B — who never saw A's edit — saves 7.
    await addFilmLine(a.page, 3);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await expect(a.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    await addFilmLine(b.page, 7);
    await b.page.getByRole("button", { name: "Save draft" }).click();
    await expect(b.page.getByText("Job detail")).toBeVisible({ timeout: 20_000 });

    // The document is B's, wholesale: one FILM line, quantity 7 — not a
    // merge, not A's 3, and no duplicated line.
    await openJob(a.page, jobNumber);
    await openDraft(a.page, rx);
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
    const jobNumber = await scoutJob(a.page, 4);
    const rx = await ticketRx(a.page);
    await goHome(b.page);
    const rx2 = await ticketRx(b.page);
    // Two different accounts, so two different sets of initials — and the
    // union, for the "nothing left behind" check at the end.
    const eitherRx = ticketRxFor(await signedInInitials(a.page), await signedInInitials(b.page));
    await cancelAllDrafts(a.page, jobNumber, rx);
    await cancelAllDrafts(b.page, jobNumber, rx2);
    // One entry per technician: each sweeps from their own session, because
    // the delete policy refuses a swap.
    sweepAfter = [
      { jobNumber, rx, state: STATE },
      { jobNumber, rx: rx2, state: STATE2 }
    ];
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
    await openJob(a.page, jobNumber);
    await expect(a.page.locator("tr", { hasText: rx })).toHaveCount(1, { timeout: 15_000 });
    await expect(a.page.locator("tr", { hasText: rx2 })).toHaveCount(1);

    // Each cleans up their own — the delete policy would refuse a swap.
    await cancelAllDrafts(a.page, jobNumber, rx);
    await cancelAllDrafts(b.page, jobNumber, rx2);
    await openJob(a.page, jobNumber);
    await expect(a.page.locator("tr", { hasText: eitherRx })).toHaveCount(0, { timeout: 15_000 });
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
    const jobNumber = await scoutJob(a.page, 5);
    const rx = await ticketRx(a.page);
    await goHome(b.page);
    const rx2 = await ticketRx(b.page);
    await cancelAllDrafts(a.page, jobNumber, rx);
    // Ben's numbers are swept too. His save here is meant to be refused, so
    // nothing of his should ever land — which is the point: if that refusal
    // ever regresses, the run cleans up after itself while the test fails.
    await cancelAllDrafts(b.page, jobNumber, rx2);
    sweepAfter = [
      { jobNumber, rx, state: STATE },
      { jobNumber, rx: rx2, state: STATE2 }
    ];
    await toTicketScreen(a.page, 5);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await settledJobDetail(a.page);

    await openJob(b.page, jobNumber);
    await openDraft(b.page, rx);

    // …but his save must be refused in words a tech can act on — not RLS
    // jargon, and never a silent success that saved nothing.
    await addFilmLine(b.page, 5);
    await b.page.getByRole("button", { name: "Save draft" }).click();
    const alert = b.page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 15_000 });
    await expect(alert).toContainText(/another technician/i);

    // Aaron's draft is exactly as he left it: no lines.
    await openJob(a.page, jobNumber);
    await openDraft(a.page, rx);
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
    const jobNumber = await scoutJob(a.page, 3);
    const rx = await ticketRx(a.page);
    await cancelAllDrafts(a.page, jobNumber, rx);
    // Both devices are the same account here, so one entry covers the pair.
    sweepAfter = [{ jobNumber, rx, state: STATE }];
    await toTicketScreen(a.page, 3);
    await a.page.getByRole("button", { name: "Save draft" }).click();
    await settledJobDetail(a.page);

    await openDraft(a.page, rx);
    await openJob(b.page, jobNumber);
    await openDraft(b.page, rx);

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
    await openJob(b.page, jobNumber);
    await expect(b.page.locator("tr", { hasText: rx })).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});
