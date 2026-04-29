#!/usr/bin/env node
// Show which migrations are local-only (not yet applied to the remote
// database). Wraps `supabase migration list --db-url ...` so users get
// the same automatic SUPABASE_DB_URL loading and friendly errors as
// `npm run db:push`.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BACKEND_ENV = resolve(REPO_ROOT, "backend", ".env");
// Locally-installed CLI (`supabase` devDependency) wins over PATH so
// every contributor runs the same pinned version after `npm install`.
const LOCAL_SUPABASE = resolve(
  REPO_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "supabase.cmd" : "supabase",
);

const isTty = process.stdout.isTTY;
const red = (s) => (isTty ? `\x1b[31m${s}\x1b[0m` : s);
const bold = (s) => (isTty ? `\x1b[1m${s}\x1b[0m` : s);

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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

const dbUrl = process.env.SUPABASE_DB_URL || loadEnvFile(BACKEND_ENV).SUPABASE_DB_URL;
if (!dbUrl || dbUrl.includes("YOUR-PROJECT-REF")) {
  console.error(`${red("✖ SUPABASE_DB_URL is not set.")} See npm run db:push for setup.`);
  process.exit(1);
}

function findSupabase() {
  if (existsSync(LOCAL_SUPABASE)) return LOCAL_SUPABASE;
  const probes = process.platform === "win32" ? ["supabase.exe", "supabase"] : ["supabase"];
  for (const cmd of probes) {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    if (r.status === 0) return cmd;
  }
  return null;
}

const supabase = findSupabase();
if (!supabase) {
  console.error(`${red("✖ Supabase CLI is not available.")} Run ${bold("npm install")} (it's a devDependency) or install globally per the README.`);
  process.exit(1);
}

const result = spawnSync(supabase, ["migration", "list", "--db-url", dbUrl], {
  stdio: "inherit",
  cwd: REPO_ROOT,
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
