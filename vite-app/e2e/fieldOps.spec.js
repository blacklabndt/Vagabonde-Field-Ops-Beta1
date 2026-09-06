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

// What each drawer screen puts on the page once it has actually arrived —
// a heading where the screen has one, the composer where it does not.
// Keyed by the drawer's own label, and the tour below fails on a label that
// isn't here: a screen added to TABS then goes red rather than being toured
// as "no uncaught errors" while never rendering anything.
const SCREEN_LANDMARK = {
  "Home": p => p.getByRole("button", { name: "+ Ticket" }),
  "Open tickets": p => p.getByRole("heading", { name: "Open tickets" }),
  // Chat's heading is the crew's own messages, so the composer's Send is what
  // says the screen is up.
  "Team chat": p => p.getByRole("button", { name: "Send", exact: true }),
  "Files": p => p.getByRole("heading", { name: "Files" }),
  "Contacts": p => p.getByRole("heading", { name: "Contacts" }),
  "Equipment": p => p.getByRole("heading", { name: "Equipment" }),
  "Timesheets": p => p.getByRole("heading", { name: "Timesheets" }),
  // The screen calls itself by what it holds, not by its menu label.
  "Rate admin": p => p.getByRole("heading", { name: "Rate admin" }),
  "Billing tracker": p => p.getByRole("heading", { name: "Billing tracker" }),
  "Users & access": p => p.getByRole("heading", { name: "Users & access" }),
  "Admin": p => p.getByRole("heading", { name: "Admin", exact: true })
};

// Every "still fetching" marker the screens use: common.jsx's Loading carries
// .loading, and the chat's own spinner names itself instead. Waiting for both
// to go is waiting for the screen to have finished, where the old fixed sleep
// only hoped 1.5 s was enough — and passed regardless when it wasn't.
const stillLoading = page => page.locator(".loading, [aria-label='Loading the chat']");

// Same code both viewports — one sweep is enough.
test("every drawer screen this account has opens and renders", { tag: "@desktop" }, async ({ page }) => {
  // One test, but a live fetch per screen and as many screens as the account
  // has tabs — the suite's 45 s default is a per-test budget written for tests
  // that touch one screen.
  test.setTimeout(120_000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));

  // The menu as Users & access actually grants it to E2E_EMAIL, read off the
  // drawer rather than written in here: a hardcoded four toured four of the
  // eleven screens and called itself "every". Direct children of the nav are
  // the tab buttons; the footer's name and Sign out live in a div below them.
  await page.getByRole("button", { name: "Sections" }).click();
  const drawer = page.getByRole("dialog", { name: "Sections" });
  await expect(drawer.locator("> button").first()).toBeVisible({ timeout: 15_000 });
  // The unread badge rides inside the button's text ("Team chat3"), so trim a
  // trailing count off before matching the label.
  const labels = (await drawer.locator("> button").allTextContents())
    .map(t => t.replace(/\s*\d+\s*$/, "").trim());
  expect(labels.length, "the drawer should list this account's screens").toBeGreaterThan(0);
  // Shut it again before the tour starts — the Sections button is a toggle,
  // and the drawer only unmounts once its slide-away animation has ended.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden({ timeout: 10_000 });

  for (const label of labels) {
    const landmark = SCREEN_LANDMARK[label];
    expect(landmark, `no landmark known for the drawer screen "${label}"`).toBeTruthy();
    // Open the drawer and take the screen, click and check retried as one
    // step — the drawer slides away as the screen changes, so a click can be
    // dispatched at the very moment the item detaches, and an unbounded retry
    // then waits forever for a button that has already done its job. Same
    // shape as openTicketRow in helpers.js, and the same reason.
    let clicked = false;
    await expect(async () => {
      if (!clicked || !(await landmark(page).isVisible().catch(() => false))) {
        // The Sections button is a toggle: clicking it on an open drawer
        // would shut the very menu this is trying to use.
        if (!(await drawer.isVisible().catch(() => false))) {
          await page.getByRole("button", { name: "Sections" }).click({ timeout: 8_000 });
        }
        // Inside the drawer, not the page: an accessible name matches as a
        // substring, so a page-wide "Home" also finds the top bar's wordmark
        // ("VagaboNDE — go to home") — which the open drawer is covering, so
        // the click sat there being intercepted until the test ran out of
        // time. Still not exact, though: a drawer item's name can carry its
        // unread badge ("Open tickets 154").
        await drawer.getByRole("button", { name: label }).first().click({ timeout: 8_000 });
        clicked = true;
      }
      await expect(landmark(page), `${label} should render its own screen`)
        .toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 40_000 });
    await expect(stillLoading(page), `${label} should finish fetching`)
      .toHaveCount(0, { timeout: 25_000 });
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

  // The number on screen before the save is a preview: the sequence at the
  // end is minted against the day's tickets when the row lands, so another
  // ticket raised in between makes the saved number differ from this one.
  // Worth asserting the shape, never worth hunting the row by.
  const preview = (await page.locator(".tabular").first().textContent()).trim();
  expect(preview).toMatch(/^[A-Z]{1,3}-\d{4}-\d{2}-\d{2}$/);

  await saveDraft.click();
  // Saving an empty draft lands back on Job detail.
  await settledJobDetail(page);

  // The draft is on the job's ticket list — reopen it. By today's shape for
  // whoever is signed in, which is what the sweeps clean up by too.
  await openTicketRow(page, rx);
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

  // The crew picker is a type-ahead, not a dropdown: focusing it lists the
  // people not yet on the crew, picking one adds them straight away, and
  // the same person is then no longer offered. Nothing is saved by this.
  const picker = page.getByRole("combobox", { name: "Add someone to the crew" });
  await picker.click();
  const option = page.locator("#ticket-crew-list [role=option]").first();
  await expect(option).toBeVisible();
  const name = (await option.locator("div").first().innerText()).trim();
  await picker.fill(name.slice(0, 3));
  await page.locator("#ticket-crew-list [role=option]", { hasText: name }).first().click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await picker.click();
  await expect(page.locator("#ticket-crew-list [role=option]", { hasText: name })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Walk away without saving: nothing was filed, the job's list is as it was.
  await page.getByRole("button", { name: "Sections" }).click();
  await page.getByRole("dialog", { name: "Sections" }).getByRole("button", { name: "Home" }).first().click();
  await openJobFromBoard(page, jobNumber);
  await expect(page.locator("tr", { hasText: rx })).toHaveCount(before);
});
