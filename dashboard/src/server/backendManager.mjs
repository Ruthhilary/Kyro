// Kyro backend manager — starts, watches and stops the Python backend for you.
//
// Used by:
//   • the dashboard  (src/app/kyro-control/route.ts) so Live mode brings the backend up by itself
//   • start.mjs      (the one-command launcher)
//
// Plain Node (no dependencies, Node 18+). Never blocks the event loop: every step is async.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, appendFileSync, rmSync,
} from "node:fs";
import { join, resolve, dirname, parse as parsePath } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Where the backend lives. Read lazily so it always matches the dashboard's BACKEND_URL
// (the same address Next proxies /api/* and /health to). In Docker that is http://backend:8000,
// locally it is http://127.0.0.1:8000.
const backendUrl = () => {
  const raw = process.env.BACKEND_URL || `http://127.0.0.1:${process.env.KYRO_BACKEND_PORT || 8000}`;
  try { return new URL(raw); } catch { return new URL("http://127.0.0.1:8000"); }
};
const LOCAL_BACKEND_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);
/** True when the backend is on this machine, i.e. this process is allowed to start it. */
const isLocalBackend = () => LOCAL_BACKEND_HOSTS.has(backendUrl().hostname.toLowerCase());
const backendPort = () => Number(backendUrl().port || (backendUrl().protocol === "https:" ? 443 : 80));
const healthUrl = () => new URL("/health", backendUrl()).toString();
const backendLabel = () => backendUrl().origin;
const win = process.platform === "win32";
const READY_TIMEOUT_S = 120;

// One state object per Node process, shared across Next.js hot-reloads.
const S = (globalThis.__kyroBackend ??= {
  phase: "idle",     // idle | python | venv | deps | launching | waiting | error
  message: "",
  detail: "",        // log tail shown when phase === "error"
  job: null,         // in-flight start promise
  token: null,       // cancellation flag for the in-flight start
  child: null,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRoot = (d) => {
  try { return !!d && existsSync(join(d, "backend", "main.py")); } catch { return false; }
};

// Where we remember the project location, so a launch from anywhere (desktop icon,
// service, wrong working directory) still finds it after it has been found once.
const hintFile = () => join(homedir(), ".kyro", "root");

function walkUp(start, levels = 8) {
  const out = [];
  let d = start;
  for (let i = 0; i < levels && d; i++) {
    out.push(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

function moduleDirs() {
  const out = [];
  try {
    const u = import.meta.url;
    if (u && u.startsWith("file:")) out.push(dirname(fileURLToPath(u)));
  } catch { /* bundled */ }
  try { if (typeof __dirname === "string" && __dirname.length > 1) out.push(resolve(__dirname)); } catch { /* ESM */ }
  return out;
}

/**
 * Finds the Kyro project folder (the one containing backend/main.py).
 * Order: explicit option, KYRO_ROOT, then a search upward from the working directory,
 * from this file's own location, and finally the remembered location.
 * Never relies on the working directory being right — that's what broke launches
 * that didn't start from a terminal (cwd was "/").
 */
export function findRoot(opts = {}) {
  const tried = [];
  const candidates = [];
  if (opts.root) candidates.push(resolve(opts.root));
  if (process.env.KYRO_ROOT) candidates.push(resolve(process.env.KYRO_ROOT));
  try { candidates.push(...walkUp(process.cwd())); } catch { /* cwd deleted */ }
  for (const here of moduleDirs()) candidates.push(...walkUp(here));
  try { candidates.push(readFileSync(hintFile(), "utf8").trim()); } catch { /* no hint yet */ }

  for (const c of candidates) {
    if (!c || tried.includes(c)) continue;
    tried.push(c);
    if (isRoot(c)) {
      try { mkdirSync(dirname(hintFile()), { recursive: true }); writeFileSync(hintFile(), c); } catch { /* non-fatal */ }
      return { root: c, tried };
    }
  }
  return { root: null, tried };
}

export function rootDir(opts = {}) {
  return findRoot(opts).root || opts.root || process.env.KYRO_ROOT || resolve(process.cwd(), "..");
}

const paths = (root) => ({
  venvDir: join(root, ".venv"),
  venvPy: join(root, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python"),
  marker: join(root, ".venv", ".kyro_deps_ok"),
  req: join(root, "backend", "requirements.txt"),
  logs: join(root, "logs"),
  pids: join(root, ".kyro.pids"),
});

function logTail(file, lines = 20) {
  try { return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n"); }
  catch { return ""; }
}

/** "kyro" if our backend answers, "other" if something else holds the port, null if nothing does. */
export async function probeHealth() {
  try {
    const r = await fetch(healthUrl(), { signal: AbortSignal.timeout(1500), cache: "no-store" });
    try { const j = await r.json(); return j?.service === "kyro-backend" ? "kyro" : "other"; }
    catch { return "other"; }
  } catch { return null; }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (win) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); } }
  } catch { /* already gone */ }
}

export function readPids(root) {
  try { return JSON.parse(readFileSync(paths(root).pids, "utf8")); } catch { return {}; }
}
export function writePids(root, patch) {
  const p = paths(root);
  try { writeFileSync(p.pids, JSON.stringify({ ...readPids(root), ...patch })); } catch { /* non-fatal */ }
}

// Run a command, capture its (short) stdout. Resolves { code, out } — never throws.
function capture(cmd, args, opts = {}) {
  return new Promise((done) => {
    let out = "";
    let child;
    try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...opts }); }
    catch { return done({ code: -1, out: "" }); }
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => done({ code: -1, out: "" }));
    child.on("close", (code) => done({ code: code ?? -1, out: out.trim() }));
  });
}

// Run a command, appending all its output to a log file. Resolves the exit code.
function runLogged(cmd, args, logPath, opts = {}) {
  return new Promise((done) => {
    let fd;
    try { fd = openSync(logPath, "a"); } catch { fd = "ignore"; }
    let child;
    try { child = spawn(cmd, args, { stdio: ["ignore", fd, fd], windowsHide: true, ...opts }); }
    catch (e) { if (typeof fd === "number") closeSync(fd); return done(-1); }
    const fin = (code) => { if (typeof fd === "number") try { closeSync(fd); } catch {} done(code); };
    child.on("error", (e) => { try { appendFileSync(logPath, `\n[spawn error] ${e.message}\n`); } catch {} fin(-1); });
    child.on("close", (code) => fin(code ?? -1));
  });
}

function set(phase, message, onProgress) {
  S.phase = phase; S.message = message;
  if (onProgress) try { onProgress(phase, message); } catch {}
}

class StartError extends Error {
  constructor(message, detail = "", cancelled = false) { super(message); this.detail = detail; this.cancelled = cancelled; }
}

async function findPython() {
  const candidates = win
    ? [["py", "-3"], ["python"], ["python3"]]
    : [["python3"], ["python"]];
  for (const c of candidates) {
    const r = await capture(c[0], [...c.slice(1), "-c", "import sys;print('%d.%d' % sys.version_info[:2])"]);
    if (r.code !== 0) continue;
    const [maj, min] = r.out.split(".").map(Number);
    if (maj === 3 && min >= 10) return c;
  }
  return null;
}

async function runJob(root, opts, token) {
  const p = paths(root);
  const checkCancel = () => { if (token.cancelled) throw new StartError("Cancelled", "", true); };
  const onProgress = opts.onProgress;
  if (!isLocalBackend()) {
    throw new StartError(
      `Kyro's server at ${backendLabel()} isn't answering.`,
      "The dashboard is set to use a backend on another machine/container (BACKEND_URL), so it can't start it from here.\n" +
      "Start that backend (for Docker: docker compose -f docker/docker-compose.yml up backend) and this page will connect by itself."
    );
  }
  if (!isRoot(root)) {
    const { tried } = findRoot(opts);
    throw new StartError(
      "This dashboard can't start the Kyro server because the Kyro project files aren't here.",
      "Live mode auto-start needs backend/main.py on the same computer as the dashboard. " +
      "This dashboard is running somewhere that only has the dashboard (a Docker image or a host), so there is nothing to launch.\n\n" +
      "Fix (pick one):\n" +
      "  • Run Kyro from the full project folder:  node start.mjs\n" +
      "  • Or run the backend separately and point BACKEND_URL at it (e.g. Docker: http://backend:8000)\n" +
      "  • Or set KYRO_ROOT to the folder that contains backend/main.py\n\n" +
      `Looked in ${tried.length} places:\n` + tried.map((t) => "  " + t).join("\n")
    );
  }
  mkdirSync(p.logs, { recursive: true });
  const setupLog = join(p.logs, "setup.log");
  const backendLog = join(p.logs, "backend.log");

  if (!existsSync(join(root, ".env"))) {
    writeFileSync(join(root, ".env"), "KYRO_DASHBOARD_USER=admin\nKYRO_DASHBOARD_PASS=kyro-admin-change-me\n");
  }

  // 1) Python environment
  checkCancel();
  if (!existsSync(p.venvPy)) {
    set("python", "Looking for Python…", onProgress);
    const py = await findPython();
    if (!py) {
      throw new StartError(
        "Python 3.10 or newer is required but wasn't found. Install it from python.org " +
        (win ? '(tick "Add python.exe to PATH"), ' : "") + "then reopen Kyro."
      );
    }
    set("venv", "Creating Kyro's Python environment (first run only)…", onProgress);
    writeFileSync(setupLog, "");
    const code = await runLogged(py[0], [...py.slice(1), "-m", "venv", ".venv"], setupLog, { cwd: root });
    if (code !== 0 || !existsSync(p.venvPy)) {
      throw new StartError("Couldn't create the Python environment.", logTail(setupLog));
    }
  }

  // 2) Backend packages — re-run whenever requirements.txt changes
  checkCancel();
  const reqText = readFileSync(p.req, "utf8");
  const reqHash = createHash("sha1").update(reqText).digest("hex");
  const have = existsSync(p.marker) ? readFileSync(p.marker, "utf8").trim() : "";
  if (!have.startsWith(reqHash)) {
    set("deps", "Installing Kyro's components — first run only, this can take a few minutes…", onProgress);
    writeFileSync(setupLog, "");
    const pipArgs = ["-m", "pip", "install", "--disable-pip-version-check", "-r"];
    let code = await runLogged(p.venvPy, [...pipArgs, "backend/requirements.txt"], setupLog, { cwd: root });
    let stamp = reqHash;
    if (code !== 0) {
      // asyncpg (Postgres driver) is the usual one to fail to build and Kyro's local SQLite mode doesn't use it.
      const trimmed = reqText.split(/\r?\n/).filter((l) => !/^\s*asyncpg\b/i.test(l)).join("\n");
      if (trimmed !== reqText) {
        appendFileSync(setupLog, "\n[kyro] Install failed — retrying without the optional Postgres driver (asyncpg)…\n");
        const alt = join(p.logs, "requirements.local.txt");
        writeFileSync(alt, trimmed);
        code = await runLogged(p.venvPy, [...pipArgs, alt], setupLog, { cwd: root });
        stamp = reqHash + ":no-asyncpg";
      }
    }
    if (code !== 0) throw new StartError("Installing Kyro's components failed.", logTail(setupLog, 25));
    writeFileSync(p.marker, stamp);
  }

  // 3) Launch — or reuse what's already there
  checkCancel();
  const pre = await probeHealth();
  if (pre === "kyro") return;
  if (pre === "other") {
    throw new StartError(`Port ${backendPort()} is already used by another program. Close it and Kyro will connect.`);
  }
  set("launching", "Starting Kyro server…", onProgress);
  writeFileSync(backendLog, "");
  const fd = openSync(backendLog, "a");
  const child = spawn(
    p.venvPy,
    ["-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", String(backendPort())],
    {
      cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    }
  );
  closeSync(fd);
  let spawnErr = null;
  let exited = false;
  child.on("error", (e) => { spawnErr = e; exited = true; });
  child.on("exit", () => { exited = true; });
  child.unref();
  S.child = child;
  writePids(root, { backend: child.pid ?? null });

  // 4) Wait until it really answers /health
  set("waiting", "Waiting for the server to be ready…", onProgress);
  for (let i = 0; i < READY_TIMEOUT_S * 2; i++) {
    checkCancel();
    if ((await probeHealth()) === "kyro") return;
    if (exited) {
      throw new StartError(
        "The Kyro server crashed while starting.",
        logTail(backendLog, 25) || (spawnErr ? String(spawnErr.message) : "")
      );
    }
    await sleep(500);
  }
  throw new StartError("The Kyro server didn't become ready in time.", logTail(backendLog, 25));
}

/** Idempotent: starts the backend if it isn't up. Returns a status snapshot immediately. */
export async function ensureBackend(opts = {}) {
  const root = rootDir(opts);
  if (S.job) return getStatus({ root });
  if ((await probeHealth()) === "kyro") { S.phase = "idle"; S.detail = ""; return getStatus({ root }); }
  if (S.phase === "error" && !opts.force) return getStatus({ root });
  if (!isLocalBackend()) return getStatus({ root }); // remote backend: nothing to start, just report

  S.detail = "";
  const token = (S.token = { cancelled: false });
  S.job = runJob(root, opts, token)
    .then(() => { S.phase = "idle"; S.message = ""; S.detail = ""; })
    .catch((e) => {
      if (e?.cancelled) { S.phase = "idle"; S.message = ""; S.detail = ""; return; }
      S.phase = "error";
      S.message = e instanceof StartError ? e.message : `Unexpected error: ${e?.message ?? e}`;
      S.detail = e instanceof StartError ? e.detail : String(e?.stack ?? e);
      if (opts.onProgress) try { opts.onProgress("error", S.message); } catch {}
    })
    .finally(() => { S.job = null; if (S.token === token) S.token = null; });
  return getStatus({ root });
}

/** Resolves when any in-flight start has finished (success or error). */
export function whenSettled() { return S.job ?? Promise.resolve(); }

export async function getStatus(opts = {}) {
  const h = await probeHealth();
  if (h === "kyro") return { state: "online", message: "", detail: "" };
  if (h === "other") {
    return { state: "error", message: `Port ${backendPort()} is already used by another program. Close it and Kyro will connect.`, detail: "" };
  }
  if (S.job) return { state: "starting", phase: S.phase, message: S.message, detail: "" };
  if (!isLocalBackend()) {
    return {
      state: "error",
      message: `Kyro's server at ${backendLabel()} isn't answering.`,
      detail: "The dashboard uses a backend on another machine/container (BACKEND_URL), so it can't start it. Start that backend and this page will connect by itself.",
    };
  }
  if (S.phase === "error") return { state: "error", message: S.message, detail: S.detail };
  return { state: "stopped", message: "Kyro server is not running.", detail: "" };
}

export async function stopBackend(opts = {}) {
  const root = rootDir(opts);
  const pids = readPids(root);
  if (S.token) S.token.cancelled = true;
  killTree(S.child?.pid); killTree(pids.backend);
  S.child = null; S.phase = "idle"; S.message = ""; S.detail = "";
  writePids(root, { backend: null });
  return { stopped: !!(pids.backend) };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Transport-agnostic handler for the dashboard's /kyro-control endpoint.
 *   GET                       -> status
 *   POST {action:"start"}     -> start if needed (idempotent), returns status
 *   POST {action:"start", force:true} -> retry after an error
 * Only answers requests addressed to localhost (unless KYRO_AUTOSTART=on).
 */
export async function handleControl(method, hostHeader, body, opts = {}) {
  const host = String(hostHeader || "").replace(/:\d+$/, "").toLowerCase();
  if (process.env.KYRO_AUTOSTART === "off" || (!LOCAL_HOSTS.has(host) && process.env.KYRO_AUTOSTART !== "on")) {
    return { status: 404, json: { error: "not available" } };
  }
  if (method === "GET") return { status: 200, json: await getStatus(opts) };
  if (method === "POST") {
    const action = body?.action ?? "start";
    if (action === "start") return { status: 200, json: await ensureBackend({ ...opts, force: !!body?.force }) };
    return { status: 400, json: { error: "unknown action" } };
  }
  return { status: 405, json: { error: "method not allowed" } };
}
