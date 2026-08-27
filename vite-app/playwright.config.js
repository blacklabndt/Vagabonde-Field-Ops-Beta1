// Playwright e2e config. Tests live in e2e/ and drive the real app against
// the live Supabase project, signed in as a seed technician account —
// credentials come from e2e/.env (gitignored), never from this file.
//
// The dev server is started by Playwright itself and torn down with the run;
// reuseExistingServer lets a hand-started `npm run dev` be borrowed instead.
import { defineConfig, devices } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Tiny .env loader — not worth a dependency. KEY=value lines only.
try {
  for (const line of readFileSync(new URL("./e2e/.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env — the tests will say what's missing */ }

// Without credentials the auth setup skips and never writes the storage
// states — and a missing storageState file makes every test ERROR at
// context creation instead of reaching its "set E2E_EMAIL" skip. Seed
// empty states so a credential-less run skips gracefully.
const authDir = fileURLToPath(new URL("./e2e/.auth/", import.meta.url));
mkdirSync(authDir, { recursive: true });
for (const f of ["state.json", "state2.json"]) {
  const p = authDir + f;
  if (!existsSync(p)) writeFileSync(p, JSON.stringify({ cookies: [], origins: [] }));
}

export default defineConfig({
  testDir: "./e2e",
  // The suite walks one shared account through real data — parallel workers
  // would race each other creating and cancelling the same draft.
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:5173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  // Live-backend suites hit real latency; one retry keeps a slow moment from
  // reading as a regression.
  retries: 1,
  projects: [
    // Signs in once and banks the session — every other project reuses it
    // instead of burning a password grant per test (Supabase throttles those).
    { name: "setup", testMatch: /auth\.setup\.js/ },
    {
      name: "desktop",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, storageState: "e2e/.auth/state.json" }
    },
    {
      name: "mobile",
      dependencies: ["setup"],
      use: { ...devices["Pixel 7"], storageState: "e2e/.auth/state.json" }
    }
  ],
  webServer: {
    command: "npm run dev",
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000
  }
});
