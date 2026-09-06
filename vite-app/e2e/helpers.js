// The moves every e2e spec makes: find a seed job, walk to it from the board,
// open a ticket row, and sweep the drafts a run minted off the job again.
//
// They lived as three near-identical copies, one per spec, which is how they
// drifted: two of them slept on a round number where there is a real signal to
// wait for, and each carried its own hardcoded initials. One copy, waiting on
// what the screen actually says.
import { expect } from "@playwright/test";
// data.js is pure arithmetic and vocabulary — no imports, no import.meta.env —
// so the suite can borrow the very functions that mint the number it hunts,
// rather than keeping a second copy of the shape that can drift from the app's.
import { initialsOf, ticketDateStamp } from "../src/data.js";

// One client from the load-test seed with plenty of active jobs.
export const SEED_CLIENT = "Athabasca Energy";

// Ticket numbers are {initials}-{MMDD}-{YY}-{NN}. The initials are the signed-in
// technician's, so hardcoding them made every sweep below pass vacuously the
// moment E2E_EMAIL pointed at another account — the drafts stayed on the job and
// the counts still read zero. Read them off the top bar instead, once per page:
// `.topbar-who` carries the name at every width (a phone hides it in CSS, which
// textContent does not care about).
const initialsCache = new WeakMap();

export async function signedInInitials(page) {
  if (!initialsCache.has(page)) {
    let initials = "";
    await expect(async () => {
      initials = initialsOf((await page.locator(".topbar-who").textContent()) || "");
      expect(initials, "the signed-in technician's name should be in the top bar").not.toBe("");
    }).toPass({ timeout: 15_000 });
    initialsCache.set(page, initials);
  }
  return initialsCache.get(page);
}

// The shape of today's ticket numbers for one or more sets of initials.
export const ticketRxFor = (...initials) =>
  new RegExp(`(?:${initials.join("|")})-${ticketDateStamp(new Date())}-\\d{2}`);

// …and the same for whoever is signed in on this page. Cached per page, so a
// test that hands the tablet to a second technician keeps hunting the first
// one's numbers — which is exactly what those tests clean up.
export const ticketRx = async page => ticketRxFor(await signedInInitials(page));

export async function goHome(page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "+ Ticket" })).toBeVisible({ timeout: 15_000 });
}

// The job number behind the ticket dialog's nth job, learned without committing
// to the ticket screen — the dialog is cancelled once the label is read. The
// dialog lists only active jobs, so whatever comes back can still take work.
// Assumes the board is already up.
export async function scoutJobNumber(page, jobIndex) {
  await page.getByRole("button", { name: "+ Ticket" }).click();
  const list = page.locator("#ticket-client-list");
  await expect(list).toBeVisible({ timeout: 10_000 });
  await list.locator("[role='option']", { hasText: SEED_CLIENT }).first().click();
  const jobSelect = page.getByLabel("Active jobs for this client");
  await expect(async () => {
    expect(await jobSelect.locator("option").count()).toBeGreaterThan(jobIndex);
  }).toPass({ timeout: 10_000 });
  const label = (await jobSelect.locator("option").nth(jobIndex).textContent()).trim();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  return label.split(" — ")[0];
}

// From the board (already on it) to a job's own page, settled.
export async function openJobFromBoard(page, jobNumber) {
  await page.getByPlaceholder(/^Search /).fill(jobNumber);
  const row = page.locator("table tbody tr", { hasText: jobNumber }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await settledJobDetail(page);
}

// Job detail fetches its JHAs, reports and tickets under one loading flag and
// puts a Loading… row in each table until they land. Waiting for the billing
// table's row to go is waiting for the real thing — "the ticket list has
// arrived" — where the old sleep only hoped 1.2 s was enough.
export async function settledJobDetail(page) {
  // The section name in the top bar, and only that. A bare
  // getByText("Job detail") also matched the ticket editor's "Go to Job
  // detail" button, which the editor grows whenever the job has an open
  // assessment — so on those jobs the helper died of a strict-mode
  // violation instead of waiting.
  await expect(page.locator(".topbar-section")).toHaveText("Job detail", { timeout: 15_000 });
  const billing = page.locator("table").filter({
    has: page.getByRole("columnheader", { name: "Ticket", exact: true })
  });
  await expect(billing.getByRole("status")).toHaveCount(0, { timeout: 20_000 });
}

// Click a listed ticket row and land in its editor. A row can be on screen a
// beat before the click takes — so click and check are retried as one step,
// and the click is only repeated while the editor is still not open.
export async function openTicketRow(page, rx) {
  const row = page.locator("tr", { hasText: rx }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const cancel = page.getByRole("button", { name: "Cancel this ticket" });
  await expect(async () => {
    if (!(await cancel.count())) await row.click();
    await expect(cancel).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 25_000 });
}

// Cancel the ticket whose editor is open; accept the confirm.
export async function cancelOpenTicket(page) {
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Cancel this ticket" }).click();
  await settledJobDetail(page);
}

// Sweep every matching draft off the open job. Called before a test as well as
// after, so leftovers from a run that died — or from its retry, which doubles
// them — heal the next run instead of poisoning its counts.
export async function cancelDraftsOnJob(page, rx) {
  for (;;) {
    await settledJobDetail(page);
    const row = page.locator("tr", { hasText: rx }).first();
    if (!(await row.count())) break;
    await openTicketRow(page, rx);
    await cancelOpenTicket(page);
  }
}

// The same sweep, starting from wherever the page happens to be.
export async function cancelDraftsOnJobFromHome(page, jobNumber, rx) {
  await goHome(page);
  await openJobFromBoard(page, jobNumber);
  await cancelDraftsOnJob(page, rx);
}
