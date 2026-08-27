// Network & sync: what the app does when the signal dies mid-shift.
//
// The contract under test (offlineQueue.js, offlineCache.js, queuePanel.jsx):
// a ticket saved with no signal is queued on the device and the top bar says
// so; the queue replays on the browser's `online` event; the board falls back
// to its cached rows with an "Offline —" banner; and read paths (the client
// search) fail with an error on the spot rather than queueing.
//
// Desktop project only — the network machinery is viewport-blind, and the
// suite's one writer keeps replays from racing each other. Everything the
// run creates it also cancels.
import { test, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const SEED_CLIENT = "Athabasca Energy";

// Ticket numbers are initials-MMDD-YY-seq; the replayed draft mints its own,
// so cleanup finds it by shape, not by a number captured on screen.
const today = new Date();
const mmdd = String(today.getMonth() + 1).padStart(2, "0") + String(today.getDate()).padStart(2, "0");
const TICKET_RX = new RegExp(`AT-${mmdd}-\\d{2}-\\d{2}`);

// Drawer navigation, scoped to the drawer itself: a bare name match grabs
// the topbar brand ("VagaboNDE — go to home") behind the open drawer, and
// the backdrop swallows the click forever.
const drawerGo = async (page, label) => {
  await page.getByRole("button", { name: "Sections" }).click();
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: label }).first().click();
};

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD in vite-app/e2e/.env");
  test.skip(testInfo.project.name !== "desktop", "network behavior is viewport-blind");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ Ticket" })).toBeVisible({ timeout: 15_000 });
});

test.afterEach(async ({ context }) => {
  // Never leave a test's dead network to poison the next one.
  await context.setOffline(false);
});

test("the board falls back to cached jobs when the signal dies", async ({ page, context }) => {
  // The signed-in board load has already warmed the cache. Leave, kill the
  // network, come back: the fetch fails and the cache serves.
  await drawerGo(page, "Contacts");
  await context.setOffline(true);
  await drawerGo(page, "Home");

  await expect(page.getByText(/Offline — showing the \d+ most recent/)).toBeVisible({ timeout: 15_000 });
  const rows = await page.locator("table tbody tr").count();
  expect(rows).toBeGreaterThan(0);
});

test("a search offline errors on the spot instead of queueing", async ({ page, context }) => {
  await context.setOffline(true);
  await page.getByRole("button", { name: "+ Ticket" }).click();
  // The dialog's auto-focused picker fires its search; with no network the
  // dialog shows the failure right there.
  await expect(page.getByRole("dialog").getByRole("alert")).not.toBeEmpty({ timeout: 10_000 });
  // And nothing snuck into the outbox: reads are not work.
  await expect(page.getByRole("button", { name: /queued/ })).toHaveCount(0);
});

test("a ticket saved offline queues, syncs on reconnect, and lands as a draft", async ({ page, context }) => {
  // Build the ticket online — the picker and job list are server searches.
  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    expect((await jobSelect.locator("option").count())).toBeGreaterThan(1);
  }).toPass({ timeout: 10_000 });
  // Remember which job, so cleanup can walk back to it from the board.
  const jobLabel = (await jobSelect.locator("option").nth(1).textContent()).trim();
  const jobNumber = jobLabel.split(" — ")[0];
  await jobSelect.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continue" }).click();
  const saveDraft = page.getByRole("button", { name: "Save draft" });
  await expect(saveDraft).toBeEnabled({ timeout: 15_000 });

  // The signal dies; the save becomes an outbox entry, and the app says so
  // in both places it promises to.
  await context.setOffline(true);
  await saveDraft.click();
  await expect(page.getByText("Saved on this device")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "1 queued" })).toBeVisible({ timeout: 10_000 });

  // Back in range: the `online` event replays the outbox and the badge goes.
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: /queued|won't sync/ })).toHaveCount(0, { timeout: 30_000 });

  // The replay minted a real draft on the job. Find it and cancel it.
  await drawerGo(page, "Home");
  await page.getByPlaceholder(/^Search /).fill(jobNumber);
  const jobRow = page.locator("table tbody tr", { hasText: jobNumber }).first();
  await expect(jobRow).toBeVisible({ timeout: 15_000 });
  await jobRow.click();

  const draftRow = page.locator("tr", { hasText: TICKET_RX }).first();
  await expect(draftRow).toBeVisible({ timeout: 15_000 });
  await draftRow.click();
  await expect(page.getByRole("button", { name: "Cancel this ticket" })).toBeVisible({ timeout: 15_000 });
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Cancel this ticket" }).click();
  await expect(page.getByText("Job detail")).toBeVisible({ timeout: 15_000 });
});
