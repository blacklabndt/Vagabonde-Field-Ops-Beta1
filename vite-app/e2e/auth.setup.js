// Signs in once, through the real form, and saves the session for every
// other test to reuse. One password grant per run instead of one per test:
// Supabase throttles repeated sign-ins from one IP, and a suite that signs
// in ten times trips it — later tests were timing out on "Signing in…".
import { test as setup, expect } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

async function bank(page, email, password, path) {
  await page.goto("/");
  await page.getByPlaceholder("you@vagabonde.ca").fill(email);
  await page.getByPlaceholder("••••••••").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "+ Ticket" })).toBeVisible({ timeout: 20_000 });
  await page.context().storageState({ path });
}

setup("sign in and bank the session", async ({ page }) => {
  setup.skip(!EMAIL || !PASSWORD, "Set E2E_EMAIL and E2E_PASSWORD in vite-app/e2e/.env");
  await bank(page, EMAIL, PASSWORD, "e2e/.auth/state.json");
});

// The second technician, for the cross-account race tests. Optional — the
// tests that need it skip when it isn't configured.
setup("bank the second technician's session", async ({ browser }) => {
  setup.skip(!process.env.E2E_EMAIL2 || !process.env.E2E_PASSWORD2, "Set E2E_EMAIL2 and E2E_PASSWORD2 for cross-account tests");
  const ctx = await browser.newContext();
  await bank(await ctx.newPage(), process.env.E2E_EMAIL2, process.env.E2E_PASSWORD2, "e2e/.auth/state2.json");
  await ctx.close();
});
