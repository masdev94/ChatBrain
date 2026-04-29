#!/usr/bin/env node
// Apply Supabase migrations from `supabase/migrations/` to a remote
// database via the Supabase CLI. Reads SUPABASE_DB_URL from backend/.env
// (the existing source of truth for backend secrets) so contributors
// don't have to maintain a second env file just for migrations.
//
// Usage:
//     npm run db:push            # push pending migrations
//     npm run db:push -- --dry   # show pending migrations without applying
//
// Why a Node wrapper rather than a raw `supabase db push` invocation:
//   * loads SUPABASE_DB_URL automatically (no shell-specific env quoting)
//   * works identically on Windows / macOS / Linux (pure node:child_process)
//   * surfaces actionable errors when the CLI or env var is missing,
//     instead of letting the user hit cryptic "command not found" or
//     "missing connection" messages from supabase
//   * zero new package dependencies — uses only the Node stdlib.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BACKEND_ENV = resolve(REPO_ROOT, "backend", ".env");
// The Supabase CLI ships as the `supabase` npm devDependency. We prefer
// the locally-installed binary so contributors get a pinned version
// after a single `npm install` — no global install required.
const LOCAL_SUPABASE = resolve(
  REPO_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "supabase.cmd" : "supabase",
);

// ANSI colors only when stdout is a TTY — keeps CI/CD logs clean.
const isTty = process.stdout.isTTY;
const dim = (s) => (isTty ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (isTty ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (isTty ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (isTty ? `\x1b[33m${s}\x1b[0m` : s);
const bold = (s) => (isTty ? `\x1b[1m${s}\x1b[0m` : s);

function info(message) {
  console.log(`${dim("›")} ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Load SUPABASE_DB_URL from backend/.env (or process.env if already set).
// ─────────────────────────────────────────────────────────────────────────────

function loadEnvFile(path) {
  // Tiny, dependency-free .env parser. Supports KEY=value and
  // KEY="quoted value with spaces". Skips comments and empty lines.
  // Doesn't try to handle every edge case dotenv does — we control
  // the file's shape via .env.example.
  if (!existsSync(path)) return {};
  const out = {};
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile(BACKEND_ENV);
// process.env wins so CI/CD systems can override the file value.
let dbUrl = process.env.SUPABASE_DB_URL || fileEnv.SUPABASE_DB_URL || "";

// Common foot-gun: people paste the whole "SUPABASE_DB_URL=..." line into
// the value field, doubling the prefix. Detect and strip it so the user
// gets a working push instead of a mystifying error from cmd.exe.
const dupPrefix = /^\s*SUPABASE_DB_URL\s*=\s*/i;
if (dupPrefix.test(dbUrl)) {
  dbUrl = dbUrl.replace(dupPrefix, "");
}
dbUrl = dbUrl.trim();

if (!dbUrl) {
  console.error(
    [
      red("✖ SUPABASE_DB_URL is not set."),
      "",
      `${bold("Where to find it")}: Supabase Dashboard → your project → ${bold("Connect")} →`,
      `  ${bold("Session pooler")} tab (works on IPv4 networks).`,
      "  Replace [YOUR-PASSWORD] with the database password from",
      `  ${bold("Project Settings → Database → Database password")}.`,
      "",
      `${bold("Then add it to")} ${dim(BACKEND_ENV)} (URL only — no SUPABASE_DB_URL= in front):`,
      `  ${green("SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres")}`,
      "",
      `${dim("Tip:")} you can also export it inline for one run:`,
      isTty
        ? `  ${green("$env:SUPABASE_DB_URL = '<url>'; npm run db:push")}    # PowerShell`
        : `  SUPABASE_DB_URL='<url>' npm run db:push                   # bash/zsh`,
    ].join("\n"),
  );
  process.exit(1);
}

// Catch unsubstituted placeholders before they reach the shell. The
// dashboard uses square-bracket placeholders like [YOUR-PASSWORD] and
// our README uses angle-bracket ones like <region>; both will look
// like literal strings if pasted without substitution. Reject them
// with a clear message rather than handing cmd.exe an angle bracket
// it'll try to interpret as redirection.
const placeholderPatterns = [
  { token: /\[YOUR-PASSWORD\]/, fix: "the database password from Project Settings → Database" },
  { token: /\[YOUR-/, fix: "every [YOUR-…] field with the real value from the Supabase dashboard" },
  { token: /YOUR-PROJECT-REF/, fix: "YOUR-PROJECT-REF with your project ref (e.g. abcdefghijklmnop)" },
  { token: /<region>/i, fix: "<region> with your project's region (e.g. us-east-1, eu-central-1)" },
  { token: /<your-/i, fix: "every <your-…> placeholder with the actual value" },
  { token: /<password>/i, fix: "<password> with the actual database password" },
  { token: /<ref>/i, fix: "<ref> with your project ref (e.g. abcdefghijklmnop)" },
];
for (const { token, fix } of placeholderPatterns) {
  if (token.test(dbUrl)) {
    console.error(
      [
        red("✖ SUPABASE_DB_URL still contains a template placeholder."),
        `  Detected: ${yellow(dbUrl.match(token)[0])}`,
        "",
        `${bold("Fix:")} replace ${fix}.`,
        "",
        "Open Supabase Dashboard → Connect → Session pooler tab and copy",
        "the URL there — it has your real region and project ref pre-filled.",
        "Then paste the password from Project Settings → Database.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// Final guard: refuse any URL that contains characters cmd.exe would
// interpret as redirection / piping. Even with shell quoting these
// would never come from a legitimate Supabase pooler URL — if you see
// one of these, it's a paste mistake.
const shellMetachars = /[<>|&^]/;
if (shellMetachars.test(dbUrl)) {
  const offender = dbUrl.match(shellMetachars)[0];
  console.error(
    [
      red(`✖ SUPABASE_DB_URL contains a shell metacharacter ("${offender}").`),
      "",
      "  This is almost always a copy-paste artifact (an unsubstituted",
      "  placeholder, or stray angle brackets / pipes). The Supabase",
      "  pooler URL never contains these characters in real life.",
      "",
      `  Re-copy from Dashboard → ${bold("Connect → Session pooler")} and try again.`,
    ].join("\n"),
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Make sure the Supabase CLI is installed.
// ─────────────────────────────────────────────────────────────────────────────

function findSupabase() {
  // 1. Prefer the locally-installed devDependency. This is the path
  //    every contributor gets for free after `npm install`, and it
  //    ensures everyone runs the exact CLI version pinned in
  //    package-lock.json.
  if (existsSync(LOCAL_SUPABASE)) {
    return LOCAL_SUPABASE;
  }
  // 2. Fall back to a globally-installed CLI on PATH (scoop / winget /
  //    brew / direct download). Useful for CI agents that share a
  //    pre-baked image and skip `npm install`.
  const probes = process.platform === "win32"
    ? ["supabase.exe", "supabase"]
    : ["supabase"];
  for (const cmd of probes) {
    const r = spawnSync(cmd, ["--version"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    if (r.status === 0) return cmd;
  }
  return null;
}

const supabase = findSupabase();
if (!supabase) {
  console.error(
    [
      red("✖ Supabase CLI is not available."),
      "",
      `${bold("Quickest fix")} — install it as a project devDependency:`,
      `  ${green("npm install")}            (it's already declared in package.json)`,
      "",
      `${bold("Or")} install globally if you'd rather share one CLI across projects:`,
      "  Windows  →  winget install Supabase.CLI   ·  or  ·  scoop install supabase",
      "  macOS    →  brew install supabase/tap/supabase",
      "  Linux    →  https://supabase.com/docs/guides/local-development/cli/getting-started",
      "",
      "Then re-run: npm run db:push",
    ].join("\n"),
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Push migrations.
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry") || args.includes("--dry-run");

const pushArgs = ["db", "push", "--db-url", dbUrl];
if (dryRun) pushArgs.push("--dry-run");
// Always include linked = false; we don't depend on `supabase link` so
// users can drive the CLI purely from this script. Pass --include-all
// is intentionally omitted — Supabase only pushes pending migrations,
// which is exactly what we want.

info(
  `${dryRun ? "Previewing" : "Applying"} pending migrations from ${dim("supabase/migrations/")}…`,
);
info(`Using DB ${dim(dbUrl.replace(/:[^:@/]+@/, ":****@"))}`);

const result = spawnSync(supabase, pushArgs, {
  stdio: "inherit",
  cwd: REPO_ROOT,
  shell: process.platform === "win32",
});

if (result.status === 0) {
  console.log(
    `${green("✔")} ${dryRun ? "Dry run complete." : "Database is up to date."}`,
  );
  process.exit(0);
}

// Common failure: project not yet known to the CLI's migration tracker.
// First push of a project where init.sql + storage.sql were applied
// manually via the SQL editor will trip this. Help the user repair it.
console.error(
  [
    "",
    yellow("ℹ If supabase reported existing-but-untracked migrations:"),
    "  it means earlier migrations were applied manually (e.g. via the SQL editor)",
    "  and the CLI's migration tracker doesn't know about them yet.",
    "",
    bold("  One-time fix") + " — mark the older migrations as already applied:",
    "    supabase migration repair --status applied 20260421120000 \\",
    "      --status applied 20260421120100 \\",
    `      --db-url ${dim("$SUPABASE_DB_URL")}`,
    "",
    "  Then re-run: npm run db:push",
  ].join("\n"),
);
process.exit(result.status ?? 1);
