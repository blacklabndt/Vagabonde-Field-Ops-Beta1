// End-to-end pass over the field flows this beta has been polishing:
// sign-in, the home board, the + Ticket dialog's client picker (the one the
// dialog used to clip), and the save-an-empty-draft path — raised, reopened
// and cancelled so the run cleans up after itself.
//
// Runs signed in as a seed technician (E2E_EMAIL/E2E_PASSWORD in e2e/.env),
// against the live project's load-test data. Every ticket the suite creates
// it also cancels; nothing else is written.
import { test, expect } from "@playwright/test";
import {
  SEED_CLIENT, ticketRx, goHome, scoutJobNumber, openJobFromBoard,
  cancelDraftsOnJob, cancelDraftsOnJobFromHome, openTicketRow, settledJobDetail
} from "./helpers.js";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

// The job a test minted a draft on, so afterEach can walk back and cancel it.
// A test that dies between "Save draft" and "Cancel this ticket" used to leave
// its draft on the live job — and with retries on, the retry left a second.
let sweepAfter = null;

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD in vite-app/e2e/.env");
  sweepAfter = null;
  // Already signed in — auth.setup.js banked the session into storageState.
  await goHome(page);
});

test.afterEach(async ({ page }) => {
  const left = sweepAfter;
  sweepAfter = null;
  if (!left) return;
  // Best effort: a sweep that cannot run must not turn a passing test red, and
  // must not hide the real failure of one that already went wrong.
  try {
    await cancelDraftsOnJobFromHome(page, left.jobNumber, left.rx);
  } catch (e) {
    console.warn("Draft sweep on " + left.jobNumber + " did not finish:", e.message);
  }
});

test("the board loads jobs from the live project", async ({ page }) => {
  // The jobs table gets real rows, not just a header.
  await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 15_000 });
  const rows = await page.locator("table tbody tr").count();
  expect(rows).toBeGreaterThan(0);
});

// @desktop tests are the ones the mobile project has no business running: a
// desktop-only layout assertion, or a writer whose second copy would only mint
// a second live draft. The mobile project greps them out (playwright.config.js)
// rather than each test skipping itself into a fat skipped count.
test("desktop keeps the new-work buttons at the row's right edge", { tag: "@desktop" }, async ({ page }) => {
  const buttons = page.locator(".home-new-work");
  const search = page.getByPlaceholder(/^Search /);
  const b = await buttons.boundingBox();
  const s = await search.boundingBox();
  // Right of the search box and on the same line — the desktop ordering.
  expect(b.x).toBeGreaterThan(s.x + s.width);
  expect(Math.abs(b.y - s.y)).toBeLessThan(20);
});

test("the client picker overflows the dialog instead of clipping", async ({ page }) => {
  await page.getByRole("button", { name: "+ Ticket" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The dialog auto-focuses the picker, which opens the list.
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await expect(list.locator("[role='option']").nth(2)).toBeVisible();

  // Portaled to the body — inside the dialog it would be clipped again.
  const parentTag = await list.evaluate(el => el.parentElement.tagName);
  expect(parentTag).toBe("BODY");

  // Taller than the two-option sliver the clipped version showed, and
  // entirely on screen — the phone keyboard case sizes against the visual
  // viewport the same way.
  const box = await list.boundingBox();
  const viewport = page.viewportSize();
  expect(box.height).toBeGreaterThan(120);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
});

// Same code both viewports — one sweep is enough.
test("every drawer screen renders without uncaught errors", { tag: "@desktop" }, async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));

  // The technician's menu, as Users & access grants it.
  for (const label of ["Open tickets", "Team chat", "Files", "Contacts"]) {
    await page.getByRole("button", { name: "Sections" }).click();
    // Not exact: a drawer item's accessible name can carry its unread badge
    // ("Open tickets 3"), and exact matching would miss it.
    await page.getByRole("button", { name: label }).first().click();
    // Let the screen fetch and settle before moving on.
    await page.waitForTimeout(1500);
  }
  expect(errors, `Uncaught errors while touring: ${errors.join(" | ")}`).toEqual([]);
});

// One writer is enough — mobile covers the picker.
test("an empty draft saves, reopens and cancels", { tag: "@desktop" }, async ({ page }) => {
  // Whatever an earlier run left on this job goes first, and the job is
  // registered for the afterEach sweep before a single row is written: the
  // cancel at the end of this test is the happy path, not the only cleanup.
  const rx = await ticketRx(page);
  const jobNumber = await scoutJobNumber(page, 1);
  await openJobFromBoard(page, jobNumber);
  await cancelDraftsOnJob(page, rx);
  sweepAfter = { jobNumber, rx };
  await goHome(page);

  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();

  // Jobs load for the client; pick the same one the sweep just cleared.
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    const options = await jobSelect.locator("option").allTextContents();
    expect(options.length).toBeGreaterThan(1);
  }).toPass({ timeout: 10_000 });
  await expect(jobSelect.locator("option").nth(1)).toContainText(jobNumber);
  await jobSelect.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continue" }).click();

  // On the billing screen: a blank ticket can be parked, not sent.
  const saveDraft = page.getByRole("button", { name: "Save draft" });
  const send = page.getByRole("button", { name: "Email for approval" });
  await expect(saveDraft).toBeEnabled({ timeout: 15_000 });
  await expect(send).toBeDisabled();

  // The ticket number on screen is what we clean up by.
  const ticketId = (await page.locator(".tabular").first().textContent()).trim();
  expect(ticketId).toMatch(/^[A-Z]{1,3}-\d{4}-\d{2}-\d{2}$/);

  await saveDraft.click();
  // Saving an empty draft lands back on Job detail.
  await settledJobDetail(page);

  // The draft is on the job's ticket list — reopen it.
  await openTicketRow(page, ticketId);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled({ timeout: 15_000 });

  // Cancel deletes it outright; accept the confirm.
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Cancel this ticket" }).click();
  await settledJobDetail(page);
});

// One writer is enough — mobile covers the picker.
test("Create ticket on Job detail opens the editor without filing a draft", { tag: "@desktop" }, async ({ page }) => {
  // Borrow the + Ticket dialog's job list to learn a seed job number, then
  // walk to that job from the board the way a technician would.
  const rx = await ticketRx(page);
  const jobNumber = await scoutJobNumber(page, 1);

  await openJobFromBoard(page, jobNumber);
  const before = await page.locator("tr", { hasText: rx }).count();

  // The dialog used to insert an empty draft on Create; now it only chooses
  // the day and the reps and hands them to the editor.
  await page.getByRole("button", { name: "+ Create ticket" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Create ticket" }).click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Cancel this ticket" })).toHaveCount(0);

  // Walk away without saving: nothing was filed, the job's list is as it was.
  await page.getByRole("button", { name: "Sections" }).click();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Home" }).first().click();
  await openJobFromBoard(page, jobNumber);
  await expect(page.locator("tr", { hasText: rx })).toHaveCount(before);
});
