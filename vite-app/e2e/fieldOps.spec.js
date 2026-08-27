// End-to-end pass over the field flows this beta has been polishing:
// sign-in, the home board, the + Ticket dialog's client picker (the one the
// dialog used to clip), and the save-an-empty-draft path — raised, reopened
// and cancelled so the run cleans up after itself.
//
// Runs signed in as a seed technician (E2E_EMAIL/E2E_PASSWORD in e2e/.env),
// against the live project's load-test data. Every ticket the suite creates
// it also cancels; nothing else is written.
import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

// One client from the load-test seed with plenty of active jobs.
const SEED_CLIENT = "Athabasca Energy";

test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD in vite-app/e2e/.env");
  // Already signed in — auth.setup.js banked the session into storageState.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ Ticket" })).toBeVisible({ timeout: 15_000 });
});

test("the board loads jobs from the live project", async ({ page }) => {
  // The jobs table gets real rows, not just a header.
  await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 15_000 });
  const rows = await page.locator("table tbody tr").count();
  expect(rows).toBeGreaterThan(0);
});

test("desktop keeps the new-work buttons at the row's right edge", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop layout only");
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

test("every drawer screen renders without uncaught errors", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "same code both viewports — one sweep is enough");
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

test("an empty draft saves, reopens and cancels", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one writer is enough — mobile covers the picker");

  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();

  // Jobs load for the client; pick the first real one.
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    const options = await jobSelect.locator("option").allTextContents();
    expect(options.length).toBeGreaterThan(1);
  }).toPass({ timeout: 10_000 });
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
  await expect(page.getByText("Job detail")).toBeVisible({ timeout: 15_000 });

  // The draft is on the job's ticket list — reopen it.
  await page.getByText(ticketId, { exact: false }).first().click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled({ timeout: 15_000 });

  // Cancel deletes it outright; accept the confirm.
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Cancel this ticket" }).click();
  await expect(page.getByText("Job detail")).toBeVisible({ timeout: 15_000 });
});
