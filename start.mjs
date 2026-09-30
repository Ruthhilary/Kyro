#!/usr/bin/env node
// Kyro launcher — one command, no babysitting.
//
//   node start.mjs                run here; Ctrl+C stops everything
//   node start.mjs --background   run silently, open the browser, free the terminal
//   node start.mjs --stop         stop a background run
//   node start.mjs --status       show what is running
//   node start.mjs --clean        wipe the dashboard build cache first
//   node start.mjs --no-open      don't open the browser
//
// Logs are always in ./logs (backend.log, dashboard.log, setup.log).
// The dashboard can also start the backend by itself, so `npm run dev` alone works too.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, openSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBackend, whenSettled, getStatus, stopBackend, probeHealth, readPids, writePids,
} from "./dashboard/src/server/backendManager.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url)); // handles spaces in the path
process.env.KYRO_ROOT = ROOT;
// start.mjs always runs the backend on this machine, whatever BACKEND_URL the shell happens to have.
process.env.BACKEND_URL = `http://127.0.0.1:${process.env.KYRO_BACKEND_PORT || 8000}`;
const win = process.platform === "win32";
const flags = new Set(process.argv.slice(2));
const BACKGROUND = flags.has("--background") || flags.has("-b");
const NO_OPEN = flags.has("--no-open");
const DASH_PORT = 3000;
const DASH_URL = `http://127.0.0.1:${DASH_PORT}`;
const LOG_DIR = join(ROOT, "logs");
const npm = win ? "npm.cmd" : "npm";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log("▶ " + m);
let dashChild = null;
let dashExit = null;

function killTree(pid) {
  if (!pid) return;
  try {
    if (win) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); } }
  } catch { /* already gone */ }
}
async function stopAll() {
  killTree(dashChild?.pid);
  if (!BACKGROUND) await stopBackend({ root: ROOT });
}
const die = async (m) => {
  console.error("\n✖ " + m + "\n");
  killTree(dashChild?.pid);
  await stopBackend({ root: ROOT }).catch(() => {});
  process.exit(1);
};

async function dashState() {
  try {
    const r = await fetch(`${DASH_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json().catch(() => null);
    return j?.service === "kyro-backend" ? "kyro" : "other";
  } catch { return null; }
}
function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    const [c, a] = win ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(c, a, { stdio: "ignore", detached: true }).unref();
  } catch { /* URL is printed anyway */ }
}
const tail = (f, n = 25) => { try { return readFileSync(join(LOG_DIR, f), "utf8").trimEnd().split("\n").slice(-n).join("\n"); } catch { return ""; } };

// ─── --stop / --status ───────────────────────────────────────────────────────
if (flags.has("--stop")) {
  const p = readPids(ROOT);
  killTree(p.dashboard);
  await stopBackend({ root: ROOT });
  writePids(ROOT, { dashboard: null });
  console.log(p.backend || p.dashboard ? "✅ Kyro stopped." : "Nothing was running in the background.");
  process.exit(0);
}
if (flags.has("--status")) {
  const b = await probeHealth(); const d = await dashState();
  console.log(`Backend   (8000): ${b === "kyro" ? "running" : b === "other" ? "port used by another app" : "stopped"}`);
  console.log(`Dashboard (${DASH_PORT}): ${d === "kyro" ? "running" : d === "other" ? "port used by another app" : d === null ? "stopped" : "running (backend not connected)"}`);
  process.exit(0);
}

// ─── preflight ───────────────────────────────────────────────────────────────
if (Number(process.versions.node.split(".")[0]) < 18) {
  await die(`Node 18+ is required (you have ${process.versions.node}). Install the LTS version from nodejs.org.`);
}
mkdirSync(LOG_DIR, { recursive: true });

if (!existsSync(join(ROOT, "dashboard", "node_modules", "next"))) {
  step("Installing dashboard packages (one time)…");
  const r = spawnSync(npm, ["install"], { stdio: "inherit", cwd: join(ROOT, "dashboard"), shell: win });
  if (r.status !== 0) await die("npm install failed.");
}

process.on("SIGINT", async () => { await stopAll(); process.exit(0); });
process.on("SIGTERM", async () => { await stopAll(); process.exit(0); });

// ─── 1) backend (waits until it really answers) ──────────────────────────────
let lastPhase = "";
await ensureBackend({
  root: ROOT,
  onProgress: (phase, message) => { if (phase !== lastPhase && phase !== "error") { lastPhase = phase; step(message); } },
});
await whenSettled();
const bs = await getStatus({ root: ROOT });
if (bs.state !== "online") {
  await die(`${bs.message}${bs.detail ? "\n\n" + bs.detail : ""}\n\nFull logs: ${LOG_DIR}`);
}
console.log("  ✔ Backend ready");

// ─── 2) dashboard ────────────────────────────────────────────────────────────
const ds = await dashState();
if (ds === "other") await die(`Port ${DASH_PORT} is already used by another program. Close it (or run "node start.mjs --stop") and try again.`);
if (ds === "kyro") {
  step("Kyro dashboard is already running — reusing it.");
} else {
  if (flags.has("--clean")) rmSync(join(ROOT, "dashboard", ".next"), { recursive: true, force: true });
  step("Starting Kyro dashboard…");
  const env = { ...process.env, BACKEND_URL: "http://127.0.0.1:8000", KYRO_ROOT: ROOT };
  delete env.NEXT_PUBLIC_API_URL; delete env.NEXT_PUBLIC_WS_URL; // never bake in a stale API URL
  const fd = openSync(join(LOG_DIR, "dashboard.log"), "w");
  dashChild = spawn(npm, ["run", "dev", "--", "-p", String(DASH_PORT)], {
    cwd: join(ROOT, "dashboard"), shell: win, env, windowsHide: true,
    detached: BACKGROUND || !win, stdio: ["ignore", fd, fd],
  });
  dashChild.on("exit", (c) => { dashExit = c ?? 0; });
  let up = false;
  for (let i = 0; i < 120 && dashExit === null; i++) {
    if ((await dashState()) === "kyro") { up = true; break; }
    await sleep(1000);
  }
  if (!up) await die("The dashboard did not start." + (tail("dashboard.log") ? `\n\nLast log lines:\n${tail("dashboard.log")}` : ""));
  try { await fetch(`${DASH_URL}/login`, { signal: AbortSignal.timeout(60000) }); } catch {} // pre-compile so it opens instantly
  console.log("  ✔ Dashboard ready");
}

const OPEN = `http://localhost:${DASH_PORT}/login`;
console.log(`\n✅ Kyro is ready →  ${OPEN}\n`);
openBrowser(OPEN);

if (BACKGROUND) {
  if (dashChild) { writePids(ROOT, { dashboard: dashChild.pid ?? null }); dashChild.unref(); }
  console.log("Running in the background — you can close this window.");
  console.log("Stop it any time with:  node start.mjs --stop     (logs are in ./logs)\n");
  process.exit(0);
}

console.log("Kyro is running. Press Ctrl+C to stop.\n");
setInterval(async () => {
  if (dashExit !== null) await die(`The dashboard stopped unexpectedly (exit ${dashExit}).\n\n${tail("dashboard.log")}`);
}, 1500);
