// The backup panel's arithmetic, away from React. Three small questions get
// asked on that screen and each of them has a wrong answer that costs
// something real: the redirect URI has to be the same string the provider's
// registration holds or the connection dies at the door; a blank secret box
// has to mean "keep the one you have" rather than "erase it"; and the
// ?backup=… the drive sends the browser home with has to be read once and
// then taken off the address bar.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_PROVIDERS, PROVIDER_LABEL,
  redirectUriFor, backupSettingsPatch, readBackupOutcome
} from "./backupPanelLogic.js";

// ── The redirect URI ─────────────────────────────────────────────────────

test("the redirect URI is the stored app address plus the provider", () => {
  const state = { approval_base_url: "https://ops.example.ca" };
  assert.equal(redirectUriFor(state, "google", "https://elsewhere"), "https://ops.example.ca/backup/oauth/google");
  assert.equal(redirectUriFor(state, "microsoft", "https://elsewhere"), "https://ops.example.ca/backup/oauth/microsoft");
  assert.equal(redirectUriFor(state, "dropbox", "https://elsewhere"), "https://ops.example.ca/backup/oauth/dropbox");
});

test("only the origin of the stored address counts — a path or a trailing slash is dropped", () => {
  assert.equal(
    redirectUriFor({ approval_base_url: "https://ops.example.ca/" }, "google", "https://x"),
    "https://ops.example.ca/backup/oauth/google"
  );
  assert.equal(
    redirectUriFor({ approval_base_url: "https://ops.example.ca/app?x=1" }, "google", "https://x"),
    "https://ops.example.ca/backup/oauth/google"
  );
});

test("with no address stored, this window's origin is the honest guess", () => {
  assert.equal(redirectUriFor({}, "google", "https://guess.example.ca"), "https://guess.example.ca/backup/oauth/google");
  assert.equal(redirectUriFor({ approval_base_url: "   " }, "google", "https://guess.example.ca"),
    "https://guess.example.ca/backup/oauth/google");
});

test("a stored address that isn't a URL falls back rather than throwing", () => {
  assert.equal(redirectUriFor({ approval_base_url: "ops.example.ca" }, "google", "https://guess.example.ca"),
    "https://guess.example.ca/backup/oauth/google");
});

test("the three providers, and each with a name a person would recognise", () => {
  assert.deepEqual(BACKUP_PROVIDERS, ["google", "microsoft", "dropbox"]);
  assert.deepEqual(BACKUP_PROVIDERS.map(p => PROVIDER_LABEL[p]), ["Google Drive", "OneDrive", "Dropbox"]);
});

// ── The saved settings ───────────────────────────────────────────────────

const FORM = {
  frequency: "weekly", weekday: 3, hour: 2, keep: 14,
  clientIdGoogle: "", clientSecretGoogle: "",
  clientIdMicrosoft: "", clientSecretMicrosoft: "",
  clientIdDropbox: "", clientSecretDropbox: ""
};

test("a blank secret box leaves the stored secret alone — the column is not in the patch at all", () => {
  const patch = backupSettingsPatch(FORM, Date.parse("2026-09-05T12:00:00Z"));
  assert.ok(!("backup_client_secret_google" in patch));
  assert.ok(!("backup_client_secret_microsoft" in patch));
  assert.ok(!("backup_client_secret_dropbox" in patch));
});

test("a typed secret is written, trimmed", () => {
  const patch = backupSettingsPatch({ ...FORM, clientSecretGoogle: "  s3cr3t  " }, 0);
  assert.equal(patch.backup_client_secret_google, "s3cr3t");
  assert.ok(!("backup_client_secret_dropbox" in patch));
});

test("whitespace alone is still blank — it does not erase a stored secret", () => {
  const patch = backupSettingsPatch({ ...FORM, clientSecretDropbox: "   " }, 0);
  assert.ok(!("backup_client_secret_dropbox" in patch));
});

test("client IDs are trimmed, and an emptied box does clear the column", () => {
  const patch = backupSettingsPatch({ ...FORM, clientIdGoogle: " abc.apps ", clientIdDropbox: "" }, 0);
  assert.equal(patch.backup_client_id_google, "abc.apps");
  assert.equal(patch.backup_client_id_dropbox, null);
});

test("the schedule is clamped to what the database's own checks allow", () => {
  const patch = backupSettingsPatch({ ...FORM, frequency: "hourly", weekday: 99, hour: -4, keep: 9000 }, 0);
  assert.equal(patch.backup_frequency, "daily");
  assert.equal(patch.backup_weekday, 6);
  assert.equal(patch.backup_hour, 0);
  assert.equal(patch.backup_keep, 365);
});

test("nonsense in the number boxes lands on the defaults rather than on NaN", () => {
  const patch = backupSettingsPatch({ ...FORM, weekday: "", hour: "abc", keep: null }, 0);
  assert.equal(patch.backup_weekday, 0);
  assert.equal(patch.backup_hour, 0);
  assert.equal(patch.backup_keep, 14);
});

test("the four frequencies the schedule knows all survive", () => {
  for (const f of ["daily", "weekdays", "weekly", "monthly"]) {
    assert.equal(backupSettingsPatch({ ...FORM, frequency: f }, 0).backup_frequency, f);
  }
});

test("the next run is only worked out once there is a drive to run to", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  assert.ok(!("backup_next_run_at" in backupSettingsPatch({ ...FORM, connected: false }, now)));
  const patch = backupSettingsPatch({ ...FORM, connected: true }, now);
  assert.equal(typeof patch.backup_next_run_at, "string");
  assert.ok(Date.parse(patch.backup_next_run_at) > now);
});

test("the patch names the one row and stamps it", () => {
  const patch = backupSettingsPatch(FORM, Date.parse("2026-09-05T12:00:00Z"));
  assert.equal(patch.id, true);
  assert.equal(patch.updated_at, "2026-09-05T12:00:00.000Z");
});

test("the patch never carries a refresh token, an account or a provider — those are the callback's", () => {
  const patch = backupSettingsPatch({ ...FORM, backup_refresh_token: "x", provider: "google" }, 0);
  for (const key of ["backup_refresh_token", "backup_provider", "backup_account", "backup_root_folder_id"]) {
    assert.ok(!(key in patch), `${key} must not be writable from the browser's save`);
  }
});

// ── Coming back from the consent screen ──────────────────────────────────

test("a connected callback is read, and the query it came home with is taken off", () => {
  const out = readBackupOutcome("?backup=connected");
  assert.equal(out.outcome, "connected");
  assert.equal(out.why, "");
  assert.equal(out.rest, "");
});

test("a refusal carries the function's own words", () => {
  const out = readBackupOutcome("?backup=failed&why=That%20connection%20took%20more%20than%20ten%20minutes.");
  assert.equal(out.outcome, "failed");
  assert.equal(out.why, "That connection took more than ten minutes.");
});

test("a cancelled consent screen is not an error", () => {
  assert.equal(readBackupOutcome("?backup=denied").outcome, "denied");
});

test("anything else on the address bar is left where it was", () => {
  const out = readBackupOutcome("?job=S-1234&backup=connected&why=x&tab=home");
  assert.equal(out.outcome, "connected");
  assert.equal(out.rest, "job=S-1234&tab=home");
});

test("no backup query at all means there is nothing to say", () => {
  assert.equal(readBackupOutcome("").outcome, "");
  assert.equal(readBackupOutcome("?job=S-1234").outcome, "");
});

test("an outcome word we don't know is treated as a failure, not as success", () => {
  const out = readBackupOutcome("?backup=sideways");
  assert.equal(out.outcome, "failed");
});
