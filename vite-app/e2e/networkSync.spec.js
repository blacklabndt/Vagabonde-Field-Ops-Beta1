// Network & sync: what the app does when the signal dies mid-shift.
//
// The contract under test (offlineQueue.js, offlineCache.js, queuePanel.jsx):
// a ticket saved with no signal is queued on the device and the top bar says
// so; the queue replays on the browser's `online` event; the board falls back
// to its cached rows with an "Offline —" banner; and the client picker answers
// from the directory cached at sign-in rather than queueing a read.
//
// Desktop project only — the network machinery is viewport-blind, and the
// suite's one writer keeps replays from racing each other. Everything the
// run creates it also cancels.
import { test, expect } from "@playwright/test";
import {
  SEED_CLIENT, ticketRx, goHome, scoutJobNumber, openJobFromBoard,
  cancelDraftsOnJob
} from "./helpers.js";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

// The second technician (Ben Sawatzky) — for the shared-tablet test, which
// needs two genuinely different accounts on one device. Optional: the test
// that needs him skips when he isn't configured.
const EMAIL2 = process.env.E2E_EMAIL2;
const PASSWORD2 = process.env.E2E_PASSWORD2;
const HAS_SECOND = !!(EMAIL2 && PASSWORD2);

// Ticket numbers are initials-MMDD-YY-seq; the replayed draft mints its own,
// so cleanup finds it by shape (helpers' ticketRx, read off the signed-in top
// bar), not by a number captured on screen.
//
// The job a test minted a draft on, so afterEach can walk back and cancel it —
// a run that dies between the save and the cancel used to leave the draft on
// the live job, and the retry left a second one beside it.
let sweepAfter = null;

// Drawer navigation, scoped to the drawer itself: a bare name match grabs
// the topbar brand ("VagaboNDE — go to home") behind the open drawer, and
// the backdrop swallows the click forever.
const drawerGo = async (page, label) => {
  await page.getByRole("button", { name: "Sections" }).click();
  await page.getByRole("dialog", { name: "Sections" }).getByRole("button", { name: label }).first().click();
};

// Sign out lives in the same drawer, below the sections. Its name is unique
// on the page, so it needs no scoping — only the drawer being open.
const signOutFromDrawer = async page => {
  // Sign-out asks first when the device holds a half-entered ticket or a
  // queued item (round three): a real person answers the dialog; Playwright
  // dismisses dialogs by default, which cancels the sign-out. Accept it for
  // exactly the span of the sign-out — a handler left on the page would
  // collide with the once-handlers the draft clean-up registers for its own
  // confirm, and a dialog accepted twice is an error.
  const accept = d => d.accept().catch(() => {});
  page.on("dialog", accept);
  try {
    await page.getByRole("button", { name: "Sections" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByPlaceholder("you@vagabonde.ca")).toBeVisible({ timeout: 15_000 });
  } finally {
    page.off("dialog", accept);
  }
};

// Through the real form, as auth.setup.js does — the banked session belongs to
// the first technician, and these tests are about the tablet changing hands.
const signIn = async (page, email, password) => {
  await page.getByPlaceholder("you@vagabonde.ca").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "+ Ticket" })).toBeVisible({ timeout: 20_000 });
};

// The muster point box. Field renders its label as a sibling rather than a
// wrapper, so there is nothing for getByLabel to bind to — the field itself
// is what identifies the input.
const musterBox = page => page.locator("div.field").filter({ hasText: "Muster point" }).locator("input");

// The JHA's work-in-progress copy is written to the offline cache 700 ms after
// typing stops. Waiting for it to actually be on disk beats sleeping for a
// round number and hoping the machine was quick enough.
async function jhaDraftOnDisk(page, muster) {
  return page.evaluate(async expected => {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("nde-offline-cache");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const rows = await new Promise((resolve, reject) => {
          const req = db.transaction("reads", "readonly").objectStore("reads").getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return rows.some(r => String(r.key).startsWith("jha.wip.")
          && r.value && r.value.site && r.value.site.muster === expected);
      } finally { db.close(); }
    } catch { return false; }
  }, muster);
}

// The desktop project is the only one that matches this file at all (see
// playwright.config.js), so there is no project check here — a skip that can
// never fire is not a decision, it is noise in the skipped count.
test.beforeEach(async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD in vite-app/e2e/.env");
  sweepAfter = null;
  await goHome(page);
});

test.afterEach(async ({ page, context }) => {
  // Never leave a test's dead network to poison the next one — and put the
  // signal back before the sweep, which is a live read and a live delete.
  await context.setOffline(false);
  const left = sweepAfter;
  sweepAfter = null;
  if (!left) return;
  // Best effort: cleanup must not turn a passing test red, nor bury the real
  // failure of one that already went wrong.
  try {
    await goHome(page);
    await openJobFromBoard(page, left.jobNumber);
    await cancelDraftsOnJob(page, left.rx);
  } catch (e) {
    console.warn("Draft sweep on " + left.jobNumber + " did not finish:", e.message);
  }
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

test("a search offline answers from the cached directory instead of queueing", async ({ page, context }) => {
  // The directory is saved at sign-in; wait for it to have landed — the
  // New job dialog lists clients from that same load — before the signal
  // dies, or this tests a device that has never been in range.
  await page.getByRole("button", { name: "+ Job" }).click();
  await expect(page.getByRole("dialog").locator("option", { hasText: SEED_CLIENT })).toHaveCount(1, { timeout: 15_000 });
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

  await context.setOffline(true);
  await page.getByRole("button", { name: "+ Ticket" }).click();
  // With no network the picker's search is answered by the directory the
  // sign-in warmed — a ticket can still be started from the truck — and the
  // dialog shows no failure.
  await page.getByLabel("Search clients").fill("Athabasca");
  const list = page.locator("#ticket-client-list");
  await expect(list.locator("[role='option']", { hasText: SEED_CLIENT }).first()).toBeVisible({ timeout: 10_000 });
  // ErrorBox renders nothing at all when there is no message.
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0);
  // And nothing snuck into the outbox: reads are not work.
  await expect(page.getByRole("button", { name: /queued/ })).toHaveCount(0);
});

test("a ticket saved offline queues, syncs on reconnect, and lands as a draft", async ({ page, context }) => {
  // Anything an earlier run left on this job goes first, and the job is
  // registered for the afterEach sweep before a single row is written: the
  // cancel at the end of this test is the happy path, not the only cleanup.
  const rx = await ticketRx(page);
  const jobNumber = await scoutJobNumber(page, 1);
  await openJobFromBoard(page, jobNumber);
  await cancelDraftsOnJob(page, rx);
  sweepAfter = { jobNumber, rx };
  await goHome(page);

  // Build the ticket online — the picker and job list are server searches.
  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    expect((await jobSelect.locator("option").count())).toBeGreaterThan(1);
  }).toPass({ timeout: 10_000 });
  // The same job the sweep just cleared — the draft that replays lands there.
  await expect(jobSelect.locator("option").nth(1)).toContainText(jobNumber);
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
  await openJobFromBoard(page, jobNumber);
  await expect(page.locator("tr", { hasText: rx })).toHaveCount(1, { timeout: 20_000 });
  await cancelDraftsOnJob(page, rx);
  await expect(page.locator("tr", { hasText: rx })).toHaveCount(0);
});

test("a ticket queued on a shared tablet is not shown to the next person", async ({ page, context }) => {
  test.skip(!HAS_SECOND, "Set E2E_EMAIL2 and E2E_PASSWORD2 in vite-app/e2e/.env");
  // This test found its bug the first time it ran: offlineQueue.js stamped,
  // filtered and refused to replay correctly, but App.jsx had subscribed to
  // the queue once at mount, so the next technician's top bar still showed
  // the last one's queued ticket — and its Discard button. setOwner now
  // re-notifies subscribers and App re-subscribes per account.

  // One tablet, two technicians, and a ticket that never made it out of the
  // truck. The outbox is stamped with whoever queued it: the next person must
  // not see it in the badge (it is not their work, and the panel would offer
  // them a Discard button for it) and must never replay it under their own
  // session, where the insert names someone else and is refused.
  // The first technician's number shape, read now and kept for the whole test:
  // the tablet changes hands halfway through, but the draft it queues is his.
  const rx = await ticketRx(page);
  const jobNumber = await scoutJobNumber(page, 1);
  await openJobFromBoard(page, jobNumber);
  await cancelDraftsOnJob(page, rx);
  sweepAfter = { jobNumber, rx };
  await drawerGo(page, "Home");

  // Built in range — the picker and the job list are server searches.
  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    expect(await jobSelect.locator("option").count()).toBeGreaterThan(1);
  }).toPass({ timeout: 10_000 });
  await expect(jobSelect.locator("option").nth(1)).toContainText(jobNumber);
  await jobSelect.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continue" }).click();
  const saveDraft = page.getByRole("button", { name: "Save draft" });
  await expect(saveDraft).toBeEnabled({ timeout: 15_000 });

  // …and saved with the signal gone, so it lands in the outbox instead.
  await context.setOffline(true);
  await saveDraft.click();
  await expect(page.getByText("Saved on this device")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "1 queued" })).toBeVisible({ timeout: 10_000 });

  // The tablet changes hands while it is still out of range.
  await signOutFromDrawer(page);
  // Signing in is the one thing that cannot be done offline, so the tablet is
  // back in range by the time the second technician takes it — which is
  // exactly when the outbox is at its most dangerous.
  await context.setOffline(false);
  await signIn(page, EMAIL2, PASSWORD2);

  // His board is his own. Read the badge rather than asserting on it here —
  // judged at the end, so the ticket this test minted is always cleaned up
  // whatever the answer turns out to be.
  await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3_000);
  const benSaw = await page.getByRole("button", { name: /queued|won't sync/ }).allTextContents();

  // The first technician takes his tablet back: the work is still his, and
  // now that he is signed in and in range it syncs under his own name.
  await signOutFromDrawer(page);
  await signIn(page, EMAIL, PASSWORD);
  await expect(page.getByRole("button", { name: /queued|won't sync/ })).toHaveCount(0, { timeout: 30_000 });

  await openJobFromBoard(page, jobNumber);
  await expect(page.locator("tr", { hasText: rx })).toHaveCount(1, { timeout: 20_000 });
  await cancelDraftsOnJob(page, rx);
  await expect(page.locator("tr", { hasText: rx })).toHaveCount(0);

  // Nothing was sent under the wrong name: the queue's owner filter kept the
  // item out of the second technician's flush, so it never reached the
  // database to be refused.
  expect(benSaw.join(" "), "the outbox must not try to sync one technician's work under another's session")
    .not.toMatch(/won't sync/);
  // And he was never shown it either.
  expect(benSaw, "one technician's outbox must not appear in the next person's top bar").toEqual([]);
});

test("a half-built JHA survives a reload", async ({ page }) => {
  // Fifteen rated hazards used to go with any tap on the drawer, an update
  // restart, or a phone evicting the tab. The assessment is now kept as it is
  // typed and offered back on return — this is that promise, made to a tab
  // that is reloaded out from under it.
  const MUSTER = "North gate, by the flare stack";
  const jobNumber = await scoutJobNumber(page, 1);
  await openJobFromBoard(page, jobNumber);
  await page.getByRole("button", { name: "+ New JHA" }).click();
  await expect(musterBox(page)).toBeVisible({ timeout: 15_000 });

  // Nothing is ticked when the sheet opens (a pre-ticked safety form is a
  // form to tap past), so the edit that proves anything is putting one on —
  // that plus a muster point covers both halves of what the draft carries:
  // the worksheet and the site information.
  const driving = page.getByRole("checkbox", { name: "Driving" });
  await expect(driving).toHaveAttribute("aria-checked", "false");
  await driving.click();
  await expect(driving).toHaveAttribute("aria-checked", "true");
  await musterBox(page).fill(MUSTER);
  await expect(async () => {
    expect(await jhaDraftOnDisk(page, MUSTER)).toBe(true);
  }).toPass({ timeout: 10_000 });

  // The tab goes and comes back — nothing was filed, so the server has never
  // heard of any of this.
  // The address names the job now (route.js), so the reload comes back to
  // Job detail itself rather than to Home — the builder is one tap away.
  await page.reload();
  await expect(page.getByRole("button", { name: "+ New JHA" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "+ New JHA" }).click();

  await expect(page.getByText("Brought back the assessment you were building")).toBeVisible({ timeout: 15_000 });
  await expect(musterBox(page)).toHaveValue(MUSTER);
  await expect(page.getByRole("checkbox", { name: "Driving" })).toHaveAttribute("aria-checked", "true");

  // Offered back, not forced back: Start empty throws it away and leaves a
  // blank form. Nothing here is ever filed.
  await page.getByRole("button", { name: "Start empty" }).click();
  await expect(page.getByText("Brought back the assessment you were building")).toHaveCount(0);
  await expect(musterBox(page)).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "Driving" })).toHaveAttribute("aria-checked", "false");
});
