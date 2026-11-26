#!/usr/bin/env node
// Minimal stdio MCP server: delegates a task to an OpenCode agent (default deepseek-flash)
// by running `opencode run --agent <agent>`. No dependencies.
//
// Jobs are shared between server instances through a state folder (OPENCODE_STATE_DIR, default
// <tmp>/opencode-agent): every job writes <id>.json (status, session, progress, the capped reply) and
// <id>.jsonl (OpenCode's raw event stream). Any instance can answer, list or cancel any job, and a reply
// never carries the raw log: a timed-out or failed job returns a short summary plus the log's path.
//
// The models, their real effort levels (OpenCode "variants") and the agents are read from OpenCode when the
// server starts (`opencode api model.list` / `agent.list`), cached per project folder, and written compactly
// into the tool description; Claude is told (tools/list_changed) when a refresh changes them.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, watchFile, writeFileSync } from "node:fs";
import * as profile from "./job-service.mjs";
import { fileURLToPath } from "node:url";
export { withoutMagic } from "./job-service.mjs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const OPENCODE_EXE = profile.findOpencode();

// Claude Code's own CLI as a second kind of worker: model "claude-code/<alias>" runs `claude -p`.
function findClaude() {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  if (process.env.OPENCODE_CLAUDE === "0") return "";
  const names = process.platform === "win32" ? ["claude.exe"] : ["claude"];
  const dirs = [...(process.env.PATH || "").split(delimiter), join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local")];
  for (const dir of dirs) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  return "";
}
const CLAUDE_EXE = findClaude();
const CLAUDE_PROVIDER = "claude-code";
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS = CLAUDE_EXE
  ? ["fable", "opus", "sonnet", "haiku"].map((id) => ({ ref: `${CLAUDE_PROVIDER}/${id}`, provider: CLAUDE_PROVIDER, id, efforts: CLAUDE_EFFORTS, free: false, local: false }))
  : [];
// Claude sessions are UUIDs, OpenCode's start with "ses_": a session alone says which worker continues it.
const CLAUDE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_AGENT = process.env.OPENCODE_AGENT || "deepseek-flash";

// ---- workers: the one list of what a caller may run ----
// A caller (Claude) sees and can run only the workers the user set up, each picked by name with `worker`. A worker
// runs either an OpenCode agent or Claude Code itself. The list is ~/.config/opencode-bridge/workers.json
// (BRIDGE_WORKERS_FILE), edited on OpenCode Config Studio's Workers page:
// { "default": "deepseek-flash", "workers": {
//     "deepseek-flash": { "runs": "opencode", "agent": "deepseek-flash", "effort": "high", "description": "…" },
//     "cc-reviewer":    { "runs": "claude", "model": "opus", "effort": "high", "readOnly": true, "instructions": "…" } } }
// An OpenCode worker may also name a `model` (provider/id) to run its agent on. While the file does not exist the
// list is one OpenCode worker for the default agent plus the older Claude workers file (~/.claude/claude-workers.json),
// so an install from before the list keeps working. OPENCODE_ALLOW_ANY=1 brings back the older behaviour, where
// any OpenCode agent or model can be asked for with `agent` and `model`.
const ALLOW_ANY = process.env.OPENCODE_ALLOW_ANY === "1";
const WORKERS_FILE = profile.workerFile;
const LEGACY_WORKERS_FILE = process.env.CLAUDE_WORKERS_FILE || join(homedir(), ".claude", "claude-workers.json");
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];
const WORKER_NAME = /^[A-Za-z0-9][\w.-]*$/;
const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
// One entry of a workers file as the bridge uses it, or null when it is switched off or incomplete.
export function readWorker(name, w, legacy = false) {
  if (!WORKER_NAME.test(name) || !w || typeof w !== "object" || w.disabled) return null;
  const runs = legacy ? "claude" : w.runs;
  const base = { name, runs, readOnly: !!w.readOnly, description: String(w.description || "").slice(0, 200) };
  if (runs === "claude")
    return { ...base, model: CLAUDE_ALIASES.includes(w.model) ? w.model : "sonnet", effort: CLAUDE_EFFORTS.includes(w.effort) ? w.effort : "", instructions: String(w.instructions || "") };
  if (runs !== "opencode" || typeof w.agent !== "string" || !w.agent) return null;
  return { ...base, agent: w.agent, model: typeof w.model === "string" ? w.model.replace(/#.*$/, "") : "", effort: typeof w.effort === "string" ? w.effort : "" };
}
let workersCache = { key: "", list: {}, def: "", accounts: [], use: "same", magic: false };
function workerSet() {
  const mtime = mtimeOf(WORKERS_FILE);
  const legacy = mtime ? 0 : mtimeOf(LEGACY_WORKERS_FILE);
  const key = `${mtime}:${legacy}`;
  if (key === workersCache.key) return workersCache;
  let list = {};
  let def = "";
  let accounts = [];
  let use = "same";
  let magic = false;
  try {
    if (mtime) {
      const raw = JSON.parse(readFileSync(WORKERS_FILE, "utf8"));
      accounts = Array.isArray(raw.claudeAccounts) ? raw.claudeAccounts.filter((d) => typeof d === "string" && d) : [];
      use = typeof raw.claudeWorkersUse === "string" && raw.claudeWorkersUse ? raw.claudeWorkersUse : "same";
      magic = raw.magicContextInJobs === true;
      for (const [name, w] of Object.entries(raw.workers || {})) {
        const entry = readWorker(name, w);
        if (entry) list[name] = entry;
      }
      def = typeof raw.default === "string" && list[raw.default] ? raw.default : "";
    } else {
      list[DEFAULT_AGENT] = { name: DEFAULT_AGENT, runs: "opencode", agent: DEFAULT_AGENT, model: "", effort: "", readOnly: false, description: "" };
      if (legacy)
        for (const [name, w] of Object.entries(JSON.parse(readFileSync(LEGACY_WORKERS_FILE, "utf8")).workers || {})) {
          const entry = name === DEFAULT_AGENT ? null : readWorker(name, w, true);
          if (entry) list[name] = entry;
        }
    }
    // no default named: the first OpenCode worker (work that leaves the Claude plan alone), else the first one
    def ||= Object.values(list).find((w) => w.runs === "opencode")?.name || Object.keys(list)[0] || "";
  } catch {
    ({ list, def, accounts, use, magic } = workersCache); // half-written or invalid: keep the last good list
  }
  workersCache = { key, list, def, accounts, use, magic };
  return workersCache;
}
// The Claude Code workers alone, by name (what `agent` could name before there was one list).
const workers = () => (CLAUDE_EXE ? Object.fromEntries(Object.entries(workerSet().list).filter(([, w]) => w.runs === "claude")) : {});
// `_w` is the worker a call was resolved to; without it (OPENCODE_ALLOW_ANY) the arguments say what runs.
const isClaudeJob = (a) =>
  a._w ? a._w.runs === "claude" : String(a.model || "").startsWith(`${CLAUDE_PROVIDER}/`) || CLAUDE_SESSION.test(String(a.session || "")) || !!(a.agent && workers()[a.agent]);
// What a read-only Claude job may do: read, search, look things up, and run read-only git commands.
const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)"];
// Which Claude account a Claude Code worker runs on, for someone with several (workers.json: "claudeAccounts", the
// accounts' config folders with the standard one first, and "claudeWorkersUse": "same", "other" or one of the
// folders). The answer is the folder to pass as CLAUDE_CONFIG_DIR; "" means the standard login (~/.claude).
// "same" is the host session's own folder. "other" is the first account that is not the host's: the host is known by
// its account id when the app gave one (a desktop session of any account uses the standard folder, so the folder
// alone would not tell), else by its folder. With nothing to choose from the answer is the host's.
const sameDir = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
export function workerConfigDir({ accounts = [], use = "same", hostDir = "", hostUuid = "", uuidOf = () => "", home = homedir() } = {}) {
  const standard = join(home, ".claude");
  const out = (dir) => (!dir || sameDir(dir, standard) ? "" : dir);
  const host = hostDir || standard;
  if (!accounts.length) return out(host);
  const byUuid = hostUuid ? accounts.find((d) => uuidOf(d) === hostUuid) : undefined;
  if (use === "same") return out(byUuid || host);
  if (use !== "other") return accounts.some((d) => sameDir(d, use)) ? out(use) : out(host);
  const mine = byUuid || accounts.find((d) => sameDir(d, host));
  const other = accounts.find((d) => !(mine && sameDir(d, mine)) && !(hostUuid && uuidOf(d) === hostUuid));
  return out(other || host);
}
// The account id a config folder is signed in as: "oauthAccount.accountUuid" of its .claude.json (which for the
// standard folder lies beside it). Only that one value is read; the login itself is never opened.
function accountUuidOf(dir) {
  try {
    const file = sameDir(dir, join(homedir(), ".claude")) ? join(homedir(), ".claude.json") : join(dir, ".claude.json");
    return String(JSON.parse(readFileSync(file, "utf8")).oauthAccount?.accountUuid || "");
  } catch {
    return "";
  }
}
// The host session's CLAUDE_* variables would tie the worker to it (its session id, messaging socket, and in the
// desktop app its login): drop them, then name the account's folder.
function claudeEnv(cwd) {
  const env = { ...process.env, PWD: cwd };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  const { accounts, use } = workerSet();
  const dir = workerConfigDir({
    accounts,
    use,
    hostDir: process.env.CLAUDE_CONFIG_DIR || "",
    hostUuid: process.env.CLAUDE_CODE_ACCOUNT_UUID || "",
    uuidOf: accountUuidOf,
  });
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  return env;
}
// Read-only jobs run without --auto, so an agent whose edits and shell commands are "ask" can't change anything:
// OpenCode rejects every ask when nobody can answer. Such an agent serves both kinds of job. An older install's
// separate read-only twin (<agent>-ro, edits denied) is still used when it exists.
const READONLY_AGENT = process.env.OPENCODE_READONLY_AGENT || `${DEFAULT_AGENT}-ro`;
const MODEL = process.env.OPENCODE_MODEL || "deepseek/deepseek-flash";
const MIN = 60 * 1000;
// Wall-clock backstop per job, and the longer a job may go without a single event from OpenCode.
// A full build or test run inside one tool call can be silent for many minutes, so the idle limit is generous.
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 60 * MIN);
const IDLE_MS = Number(process.env.OPENCODE_IDLE_MS || 20 * MIN);
// While a tool call is in flight (a shell running a build) silence is expected, so a longer idle limit applies.
const TOOL_IDLE_MS = Number(process.env.OPENCODE_TOOL_IDLE_SECONDS || 45 * 60) * 1000;
// OpenCode's event stream reports a tool call only when it ends: a silent job is asked this often what it is doing.
const PROBE_MS = Math.max(250, Number(process.env.OPENCODE_PROBE_MS || 30000));
const MAX_TIMEOUT_MS = 4 * 60 * MIN;
const MAX_CONCURRENT = Math.max(1, Number(process.env.OPENCODE_MAX_CONCURRENT || 10));
const MAX_REPLY = Number(process.env.OPENCODE_MAX_REPLY_CHARS || 20000);
const LAST_TEXT = 2000;
const KEEP_MS = 24 * 60 * MIN;
const STATE_DIR = process.env.OPENCODE_STATE_DIR || join(tmpdir(), "opencode-agent");
mkdirSync(STATE_DIR, { recursive: true });
// Job files (state, raw event log) older than this many days are deleted when a server starts; 0 keeps them all.
const KEEP_DAYS = Number(process.env.OPENCODE_KEEP_DAYS ?? 3);
function pruneFiles(now = Date.now()) {
  if (!(KEEP_DAYS > 0)) return 0;
  let n = 0;
  try {
    // the record of what each client offered: only the recent ones matter
    const seen = join(STATE_DIR, "clients.jsonl");
    if (existsSync(seen) && statSync(seen).size > 256 * 1024) unlinkSync(seen);
  } catch {
    // next time
  }
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!/^job_[a-z0-9]+_\d+\.(json|jsonl|cancel)$/.test(f)) continue;
      const p = join(STATE_DIR, f);
      try {
        if (now - statSync(p).mtimeMs > KEEP_DAYS * 24 * 60 * MIN) {
          unlinkSync(p);
          n++;
        }
      } catch {
        // gone, or in use
      }
    }
  } catch {
    // no state folder
  }
  return n;
}

// ---- how long one opencode_result call may wait ----
// A wait is one tool call, and a tool call that is waiting costs the caller nothing, where every repeated call costs
// one model request with the whole conversation read again. So the longer one call may wait, the better, up to what
// the client allows.
const WAIT_ENV = Number(process.env.OPENCODE_WAIT_SECONDS);
let clientName = "";
// 50 s unless OPENCODE_WAIT_SECONDS says otherwise. A longer default was tried (3.0.0) and withdrawn: the Claude
// desktop app gives up on a tool call after about 60 s and then closes the server, which cancels every job it runs.
// The CLI does wait longer (a 154 s wait worked there), so a long wait is something to switch on, not the default.
export function waitLimit({ env = WAIT_ENV } = {}) {
  return Number.isFinite(env) && env > 0 ? env : 50;
}
const PROGRESS_MS = Math.max(250, Number(process.env.OPENCODE_PROGRESS_MS || 20000));

// ---- job slots, shared by every server instance on this machine ----
// OPENCODE_MAX_CONCURRENT jobs run at once machine-wide (all Claude sessions together), and at most
// OPENCODE_LOCAL_CONCURRENT at once on any one local model, which a local server mostly runs one request at a time.
// A slot is a file created exclusively in <state>/slots; a slot whose owner process has exited is free again.
const LOCAL_CONCURRENT = Math.max(1, Number(process.env.OPENCODE_LOCAL_CONCURRENT || 6));
const SLOT_DIR = join(STATE_DIR, "slots");
mkdirSync(SLOT_DIR, { recursive: true });
const held = new Map(); // slot path -> the job it is held for
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slotInfo(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // being written, or just released
  }
}
function slotOwner(path) {
  return slotInfo(path)?.pid ?? null;
}
// A slot is only held while its server keeps touching the file (every SLOT_BEAT_MS). A process id alone proves
// nothing: Windows reuses ids, so a slot left by a dead server could look alive for ever. A slot whose job already
// finished is also stale (a release that never ran).
const SLOT_BEAT_MS = 5000;
const SLOT_STALE_MS = 30000;
// The rule itself, without the file system: `ageMs` since the last heartbeat, `jobStatus` of the job it names
// ("" when unknown). Only a running or queued job holds a place: a finished one never does, fetched or not.
export function slotIsStale({ ageMs, ownerAlive, jobStatus }) {
  if (ageMs > SLOT_STALE_MS) return true;
  if (!ownerAlive) return true;
  return !!jobStatus && jobStatus !== "running" && jobStatus !== "queued";
}
function slotStale(path) {
  const info = slotInfo(path);
  if (!info) return false; // being written, or just released
  let ageMs;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  const state = info.job ? jobs.get(info.job)?.state || readState(info.job) : null;
  return slotIsStale({ ageMs, ownerAlive: alive(info.pid), jobStatus: state?.status || "" });
}
setInterval(() => {
  const now = new Date();
  for (const p of held.keys()) {
    try {
      utimesSync(p, now, now);
    } catch {
      // released meanwhile
    }
  }
}, SLOT_BEAT_MS).unref();
// the jobs holding the slots of a pool, for the waiting message
function holders(pool) {
  try {
    return readdirSync(SLOT_DIR)
      .filter((f) => f.startsWith(`${pool}.`))
      .map((f) => ({ path: join(SLOT_DIR, f), info: slotInfo(join(SLOT_DIR, f)) }))
      .filter((h) => h.info && !slotStale(h.path))
      .map((h) => {
        const st = h.info.job ? readState(h.info.job) : null;
        const age = st?.started ? ` ${Math.round((Date.now() - st.started) / 1000)}s` : "";
        return `${h.info.job || "unknown job"} (${st?.status || "no state"}${age})`;
      });
  } catch {
    return [];
  }
}
// Frees the slots a job holds (opencode_cancel on a holder that cannot release them itself).
function freeSlots(jobId) {
  let n = 0;
  try {
    for (const f of readdirSync(SLOT_DIR)) {
      const p = join(SLOT_DIR, f);
      if (slotInfo(p)?.job === jobId && !held.has(p)) {
        try {
          unlinkSync(p);
          n++;
        } catch {
          // gone already
        }
      }
    }
  } catch {
    // no slot folder
  }
  return n;
}
function tryTake(pool, size, jobId) {
  for (let i = 0; i < size; i++) {
    const path = join(SLOT_DIR, `${pool}.${i}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, JSON.stringify({ pid: process.pid, job: jobId }), { flag: "wx" });
        held.set(path, jobId);
        return path;
      } catch (e) {
        if (e.code !== "EEXIST") break;
        if (!slotStale(path)) break;
        try {
          unlinkSync(path); // left behind by a server that exited, stopped beating, or whose job finished
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
function release(path) {
  if (!path) return;
  held.delete(path);
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}
// A job that ended gives its places back at once, whatever happens to the code that was waiting on it.
function releaseJob(jobId) {
  for (const [p, j] of held) if (j === jobId) release(p);
}
// slots of a pool currently held by a live server
function inUse(pool) {
  try {
    return readdirSync(SLOT_DIR).filter((f) => f.startsWith(`${pool}.`) && !slotStale(join(SLOT_DIR, f))).length;
  } catch {
    return 0;
  }
}
const localPool = (ref) => `local-${createHash("sha1").update(ref.toLowerCase()).digest("hex").slice(0, 12)}`;

// Waits for a machine-wide slot (and a slot on its local model, if any), then runs fn.
async function limited(job, local, fn) {
  let all = null, own = null;
  try {
    while (!job.cancelled) {
      // another session's opencode_cancel reaches a queued job through its cancel file
      if (cancelAsked(job.state.id)) {
        job.cancelled = true;
        finish(job, "cancelled", "cancelled before it started (asked by another session)");
        break;
      }
      own = local ? tryTake(local, LOCAL_CONCURRENT, job.state.id) : null;
      if (!local || own) {
        all = tryTake("all", MAX_CONCURRENT, job.state.id);
        if (all) break;
        release(own);
        own = null;
      }
      const who = holders(local && !own ? local : "all");
      const why = (local && !own ? `waiting: ${LOCAL_CONCURRENT} job(s) already on this local model` : `waiting: ${MAX_CONCURRENT} jobs already running on this machine`) +
        (who.length ? `: ${who.join(", ")}. opencode_cancel on one of these ids frees its place` : "");
      if (job.state.waiting !== why) {
        job.state.waiting = why;
        job.state.waitPool = local && !own ? local : "all";
        saveState(job.state);
      }
      await sleep(1000);
    }
    job.state.waiting = "";
    job.state.waitPool = "";
    return await fn();
  } finally {
    release(all);
    release(own);
  }
}
process.on("exit", () => {
  for (const p of held.keys()) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
});

// ---- model and agent catalog, read live from OpenCode ----

const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const FALLBACK_EFFORTS = ["none", "low", "high", "max"];
// OpenCode's own free models (opencode provider, "-free" or zero cost) are left out unless OPENCODE_INCLUDE_FREE=1.
// Zero cost alone is not "free": subscription and local providers report $0 too, and are kept.
const INCLUDE_FREE = process.env.OPENCODE_INCLUDE_FREE === "1";
// Optional regex on "provider/id" to hide more models, e.g. "-(fast|flex|ultrafast)$|^openai/gpt-5".
// It also refuses a job that asks for such a model, by name, by alias or through an agent's own model: hiding a model
// from the description alone does not stop a caller that names it.
const EXCLUDE_RE = process.env.OPENCODE_MODEL_EXCLUDE ? new RegExp(process.env.OPENCODE_MODEL_EXCLUDE, "i") : null;
// The same switch, but changeable while the server runs: a JSON file {"blocked": ["provider/id", ...]} read again whenever
// it changes (checked on every call, no restart). Exact "provider/id" names, any case. A missing or unreadable file blocks nothing.
const BLOCK_FILE = process.env.OPENCODE_BLOCKLIST || join(homedir(), ".config", "opencode-bridge", "blocked-models.json");
let blockMtime = -1;
let blocked = new Set();
function blockedRefs() {
  let m = 0;
  try {
    m = statSync(BLOCK_FILE).mtimeMs;
  } catch {
    m = 0;
  }
  if (m !== blockMtime) {
    blockMtime = m;
    blocked = new Set();
    if (m) {
      try {
        const list = JSON.parse(readFileSync(BLOCK_FILE, "utf8")).blocked;
        if (Array.isArray(list)) blocked = new Set(list.filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()));
      } catch {
        // half-written or broken: keep nothing blocked rather than guess
      }
    }
  }
  return blocked;
}
// Why a model is switched off: "OPENCODE_MODEL_EXCLUDE", "the blocklist", or "" when it is not.
function offReason(ref) {
  const r = String(ref || "");
  if (!r) return "";
  if (EXCLUDE_RE?.test(r)) return "OPENCODE_MODEL_EXCLUDE";
  if (blockedRefs().has(r.toLowerCase())) return "the blocklist";
  return "";
}
const catalogFile = (personal) => join(STATE_DIR, `catalog-${createHash("sha1").update(JSON.stringify([process.cwd().toLowerCase(), personal ? "personal" : profile.paths.OPENCODE_DB])).digest("hex").slice(0, 10)}.json`);
const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|[^.]+$|.*\.local$)/i;

// OpenCode's background service, asked directly where its address is known. `opencode api` starts a CLI for every
// question, and a CLI that gets no answer within a few seconds restarts the service, which cuts every job running
// on this machine. A direct question that gets no answer only fails.
const SERVICE_FILE = process.env.OPENCODE_SERVICE_FILE || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json");
const SERVICE_OPS = {
  "session.active": () => ["GET", "/api/session/active"],
  "session.interrupt": (p) => ["POST", `/api/session/${encodeURIComponent(p.sessionID)}/interrupt`],
  "session.message.list": ({ sessionID, ...q }) => ["GET", `/api/session/${encodeURIComponent(sessionID)}/message?${new URLSearchParams(q)}`],
};
// The answer, or null when the service can't be asked this way (then the CLI is). Throws when it does not answer.
async function ocService(op, params, timeout) {
  const route = SERVICE_OPS[op];
  if (!route) return null;
  let svc;
  try {
    svc = JSON.parse(readFileSync(SERVICE_FILE, "utf8"));
  } catch {
    return null;
  }
  if (!svc?.url || !svc.password) return null;
  const [method, path] = route(Object.fromEntries(params.map((p) => p.split(/=(.*)/s).slice(0, 2))));
  const res = await fetch(svc.url + path, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(timeout),
  });
  if ([401, 403, 404, 405].includes(res.status)) return null;
  if (!res.ok) throw new Error(`OpenCode's service answered ${res.status}`);
  const j = await res.json();
  return { data: j && typeof j === "object" && "data" in j ? j.data : j };
}

async function ocApi(op, params = [], timeout = 20000, mode = workerSet().magic ? "owner" : "worker") {
  if (mode === "standalone") throw Error("A private fallback run has no shared session API.");
  if (mode === "worker") return profile.using(async svc => {
    const route = SERVICE_OPS[op];
    if (!svc && op.startsWith("session.")) throw Error("Worker session service is unavailable.");
    if (svc && route) {
      const [method, path] = route(Object.fromEntries(params.map(p => p.split(/=(.*)/s).slice(0, 2))));
      const result = await profile.api(svc, path, { method, timeout });
      return result.data ?? result;
    }
    return ocCli(op, params, timeout, svc);
  });
  const direct = await ocService(op, params, timeout);
  return direct ? direct.data : ocCli(op, params, timeout);
}

function ocCli(op, params = [], timeout = 20000, svc) {
  return new Promise((resolve, reject) => {
    const args = ["api", op, ...params.flatMap((p) => ["--param", p])];
    if (svc !== undefined) args.push(...profile.targetArgs(svc));
    execFile(OPENCODE_EXE, args, { env: svc !== undefined ? profile.environment(svc, process.cwd()) : process.env, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      try {
        const j = JSON.parse(out);
        resolve(j && typeof j === "object" && "data" in j ? j.data : j);
      } catch (e) {
        reject(e);
      }
    });
  });
}

const refOf = (m) => `${m.providerID}/${m.id}`;
const isFree = (m) => m.providerID === "opencode" && (/-free$/i.test(m.id) || (m.cost || []).every((c) => !c.input && !c.output));
function isLocal(m) {
  try {
    return LOCAL_HOST.test(new URL(m.settings?.baseURL || "").hostname);
  } catch {
    return false;
  }
}

function guardedAgent(a) {
  // Both edits and shell commands must need approval for a read-only job (last matching rule wins).
  const last = (action) => (a.permissions || a.permission || []).filter((r) => (r.action === action || r.action === "*") && r.resource === "*").at(-1);
  return [last("edit"), last("shell")].every((r) => r && r.effect !== "allow");
}

async function fetchCatalog() {
  const [models, agents, def] = workerSet().magic
    ? await Promise.all([ocApi("model.list"), ocApi("agent.list"), ocApi("model.default").catch(() => null)])
    : await profile.using(async svc => {
      const endpoints = [["model.list","/api/model"],["agent.list","/api/agent"],["model.default","/api/model/default"]];
      if (svc) await profile.warm(svc, process.cwd());
      const ask = ([op, path]) => svc
        ? profile.api(svc, `${path}?directory=${encodeURIComponent(process.cwd())}`, {timeout:20000}).then(r => r.data ?? r)
        : ocCli(op, [`directory=${process.cwd()}`], 20000, null);
      return Promise.all(endpoints.map((entry, i) => i === 2 ? ask(entry).catch(() => null) : ask(entry)));
    });
  const all = new Map();
  for (const m of models) {
    if (m.enabled === false || (m.type && m.type !== "chat") || (m.status && !/^(active|beta)$/.test(m.status))) continue;
    all.set(refOf(m), { ref: refOf(m), provider: m.providerID, id: m.id, efforts: (m.variants || []).map((v) => v.id), free: isFree(m), local: isLocal(m) });
  }
  // local servers come and go: probe each one (any HTTP answer = up), in parallel, 1.5 s at most
  const bases = new Map();
  for (const m of models) if (all.get(refOf(m))?.local && m.settings?.baseURL) bases.set(refOf(m), m.settings.baseURL.replace(/\/+$/, ""));
  const up = new Map();
  await Promise.all(
    [...new Set(bases.values())].map((b) =>
      fetch(`${b}/models`, { signal: AbortSignal.timeout(1500) }).then(
        () => up.set(b, true),
        () => up.set(b, false),
      ),
    ),
  );
  for (const [ref, b] of bases) all.get(ref).offline = !up.get(b);
  // what an agent runs on: its own model and variant, else OpenCode's default model
  const agentModel = (a) => (a.model?.id ? `${a.model.providerID}/${a.model.id}${a.model.variant ? `#${a.model.variant}` : ""}` : def ? `${refOf(def)} (default)` : "default model");
  return {
    at: Date.now(),
    // every enabled model, free ones included, so a job on an agent's own (possibly free) model still validates
    models: [...all.values()],
    // hidden agents too: a worker may run an agent that OpenCode's own picker does not show
    agents: agents
      .map((a) => ({ name: a.id, hidden: !!a.hidden, mode: a.mode, guarded: guardedAgent(a), model: agentModel(a), description: (a.description || "").split(/(?<=\.)\s/)[0].slice(0, 90) })),
    defaultModel: def ? refOf(def) : null,
  };
}

function readCachedCatalog() {
  try {
    const c = JSON.parse(readFileSync(catalogFile(workerSet().magic), "utf8"));
    return Array.isArray(c.models) && Array.isArray(c.agents) ? c : null;
  } catch {
    return null;
  }
}

let catalog = readCachedCatalog();
let catalogError = "";
let refreshing = null;
let catalogMode;
function demandCatalog() {
  const mode = workerSet().magic;
  if (catalogMode !== mode) {
    if (catalogMode !== undefined) catalog = null;
    catalogMode = mode;
    refreshCatalog();
  }
}
let clientReady = false;

// Refreshes the catalog; when it changed after Claude already listed the tools, tells it to list them again.
function refreshCatalog() {
  const personal = workerSet().magic;
  refreshing ??= fetchCatalog()
    .then((fresh) => {
      if (workerSet().magic !== personal) { catalogMode = undefined; return; }
      catalogError = "";
      const same = catalog && JSON.stringify({ ...catalog, at: 0 }) === JSON.stringify({ ...fresh, at: 0 });
      catalog = fresh;
      try {
        writeFileSync(catalogFile(personal), JSON.stringify(fresh));
      } catch {
        // cache is best effort
      }
      if (!same && clientReady) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    })
    .catch((e) => {
      catalogError = e.message.split("\n")[0].slice(0, 200);
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// A model's line and version: "claude-opus-4-5-20251101" -> line "claude-opus", version [4,5], date 20251101;
// "gpt-6.2-sol-fast" -> line "gpt-sol-fast", version [6,2]. Only the newest version of each line is listed.
const KEEP_OLD = process.env.OPENCODE_KEEP_OLD_MODELS === "1";
function lineOf(m) {
  const line = [];
  const version = [];
  let date = 0;
  for (const t of m.id.split("-")) {
    if (/^\d{8}$/.test(t)) date = Number(t);
    else if (/^v?\d+(\.\d+)*$/i.test(t)) version.push(...t.replace(/^v/i, "").split(".").map(Number));
    else line.push(t);
  }
  return { key: `${m.provider}/${line.join("-")}`, version, date };
}
function newer(a, b) {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const d = (a.version[i] || 0) - (b.version[i] || 0);
    if (d) return d > 0;
  }
  return a.version.length !== b.version.length ? a.version.length > b.version.length : !a.date && !!b.date; // undated alias beats dated
}
function latestOnly(models) {
  const best = new Map();
  for (const m of models) {
    if (m.local) continue; // local models are whatever the user loaded: all listed
    const l = lineOf(m);
    const cur = best.get(l.key);
    if (!cur || newer(l, cur.l)) best.set(l.key, { m, l });
  }
  const keep = new Set([...best.values()].map((b) => b.m));
  return models.filter((m) => m.local || keep.has(m));
}

const allModels = () => [...(catalog?.models || []), ...CLAUDE_MODELS];
const shownModels = () => {
  const list = allModels().filter((m) => (INCLUDE_FREE || !m.free) && !offReason(m.ref));
  return KEEP_OLD ? list : latestOnly(list);
};
const findModel = (ref) => allModels().find((m) => m.ref.toLowerCase() === String(ref).toLowerCase());

// "low-max" for a contiguous run of the ladder, else the levels listed
function effortLabel(levels) {
  if (!levels.length) return "no effort levels";
  // "minimal" is rare: none,low,...,max still reads as none-max
  const ladder = levels.includes("minimal") ? EFFORT_LADDER : EFFORT_LADDER.filter((l) => l !== "minimal");
  const idx = levels.map((l) => ladder.indexOf(l));
  const contiguous = idx.every((v, i) => v >= 0 && (i === 0 || v === idx[i - 1] + 1));
  return contiguous && levels.length > 2 ? `${levels[0]}-${levels.at(-1)}` : levels.join(",");
}

// gpt-6-sol, gpt-6-sol-fast, gpt-6-sol-flex -> gpt-6-sol{,-fast,-flex}
const SPEED_SUFFIX = /-(fast|flex|ultrafast|turbo|mini|nano|lite)$/;
function compactIds(ids) {
  const groups = new Map();
  for (const id of ids) {
    const base = id.replace(SPEED_SUFFIX, "");
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(id.slice(base.length));
  }
  return [...groups].map(([base, sfx]) => (sfx.length === 1 ? base + sfx[0] : `${base}{${sfx.join(",")}}`));
}

// Claude Code shows only the first ~2048 characters of a tool's description, so the description stays short and
// leads with the named workers; the model catalog and the agent list go in the `model` and `agent` parameters.
function modelsText() {
  const models = shownModels();
  if (!models.length) return catalogError ? ` (Model list unavailable: ${catalogError}; pass provider/id anyway.)` : "";
  const byProvider = new Map();
  for (const m of models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, { local: m.local, offline: m.offline, groups: new Map() });
    const p = byProvider.get(m.provider);
    p.local &&= m.local;
    p.offline &&= m.offline;
    const key = effortLabel(m.efforts);
    if (!p.groups.has(key)) p.groups.set(key, []);
    p.groups.get(key).push(m.id);
  }
  const lines = [...byProvider].map(
    ([prov, p]) => `${prov}${p.local ? (p.offline ? " (local, OFFLINE at startup)" : " (local)") : ""}: ` + [...p.groups].map(([lvl, ids]) => `[${lvl}] ${compactIds(ids).join(" ")}`).join("; "),
  );
  return "\nModels (provider/id; {,-fast} = id and id-fast; `effort` must be one of the levels in brackets):\n" + lines.join("\n");
}
function agentsText() {
  const agents = (catalog?.agents || [])
    .filter((a) => !a.hidden)
    .map((a) => `${a.name} (${a.mode}, ${a.model}${a.guarded === false ? ", edit jobs only" : ""})${a.description ? `: ${a.description}` : ""}`);
  return agents.length ? `\nOpenCode agents:\n${agents.join("\n")}` : "";
}

// The agent a job runs: the one asked for, else the default agent (its read-only twin, where one exists, for read-only jobs).
function pickAgent(args) {
  if (args.agent) return args.agent;
  if (args.allow_edits) return DEFAULT_AGENT;
  return !catalog || catalog.agents.some((a) => a.name === READONLY_AGENT) ? READONLY_AGENT : DEFAULT_AGENT;
}

function workersText() {
  const list = Object.entries(workers());
  if (!list.length) return "";
  return (
    "NAMED WORKERS: when the user names one of these, call this tool with its name as `agent` (no `model` needed; `effort` overrides its default). They run Claude Code itself:\n" +
    list.map(([n, w]) => `${n} (${w.model}${w.effort ? ` ${w.effort}` : ""}${w.readOnly ? ", read-only" : ""})${w.description ? `: ${w.description.slice(0, 90)}` : ""}`).join("\n") +
    "\n\n"
  );
}

// The model a job runs on, for checking `effort`: the explicit `model`, else the agent's own model.
function resolveModel(args) {
  if (args.model) return String(args.model).replace(/#.*$/, "");
  const w = args.agent && workers()[args.agent];
  if (w) return `${CLAUDE_PROVIDER}/${w.model}`;
  const name = pickAgent(args);
  const a = catalog?.agents.find((x) => x.name === name);
  if (a) return a.model.replace(/#.*$|\s.*$/, "");
  return name === DEFAULT_AGENT || name === READONLY_AGENT ? MODEL : catalog?.defaultModel || MODEL;
}

// The refusal for a model that OPENCODE_MODEL_EXCLUDE or the blocklist file switches off, with the models of the same provider that are left, or any others when that provider has none.
function switchedOff(ref) {
  const provider = String(ref).split("/")[0];
  const same = shownModels().filter((x) => x.ref.split("/")[0] === provider);
  const left = (same.length ? same : shownModels()).slice(0, 6).map((x) => x.ref);
  return `model "${ref}" is switched off on this machine (${offReason(ref)})${left.length ? `. Use one of: ${left.join(", ")}` : ""}`;
}
// Checks `model`, `effort` and `agent` against the catalog (refreshed once on a miss); returns an error text or "".
async function validate(args) {
  if (args.model && String(args.model).includes("#") && !args.effort) {
    const [m, e] = String(args.model).split("#");
    args.model = m;
    args.effort = e;
  }
  // a model named in the call is checked before anything is read from OpenCode
  if (args.model && offReason(args.model)) return switchedOff(args.model);
  if (isClaudeJob(args)) {
    if (!CLAUDE_EXE) return "Claude Code's CLI (claude) was not found; set CLAUDE_EXE";
    const w = args.agent ? workers()[args.agent] : null;
    if (args.agent && !w) return `"${args.agent}" is an OpenCode agent; a claude-code/* job runs Claude Code itself. Claude workers: ${Object.keys(workers()).join(", ") || "(none defined)"}`;
    if (w?.readOnly && args.allow_edits) return `worker "${args.agent}" is read-only; run it without allow_edits, or pick another worker`;
    if (args.model && !findModel(args.model)) return `unknown model "${args.model}". Claude Code models: ${CLAUDE_MODELS.map((m) => m.ref).join(", ")}`;
    if (args.effort && !CLAUDE_EFFORTS.includes(args.effort)) return `Claude Code effort levels are ${CLAUDE_EFFORTS.join(", ")}`;
    if (args.session && !CLAUDE_SESSION.test(args.session)) return "that session is an OpenCode one; continue it without a claude-code model";
    return "";
  }
  demandCatalog();
  if (!catalog && refreshing) await Promise.race([refreshing, new Promise((r) => setTimeout(r, 10000))]);
  if (!catalog) return ""; // no catalog: let OpenCode judge
  const check = () => {
    if (args.agent && !catalog.agents.some((a) => a.name === args.agent)) return `unknown agent "${args.agent}". Agents: ${catalog.agents.filter((a) => !a.hidden).map((a) => a.name).join(", ")}`;
    const info = catalog.agents.find((a) => a.name === pickAgent(args));
    if (!args.allow_edits && info?.guarded === false)
      return `agent "${info.name}" can edit files and run commands without asking, so it can't run a read-only job. Pass allow_edits: true, or ${args._w ? "pick another worker" : "leave `agent` out and choose the model with `model` instead"}.`;
    const ref = resolveModel(args);
    const m = findModel(ref);
    // the model that will run, whether named, an alias, or an agent's own: the same switch applies
    if (offReason(m?.ref || ref)) return switchedOff(m?.ref || ref);
    if (args.model && !m) {
      // rank listed models by the name parts they share with the request
      const parts = String(args.model).toLowerCase().split(/[/\-.]/).filter(Boolean);
      const near = shownModels()
        .map((x) => ({ ref: x.ref, n: parts.filter((p) => x.ref.toLowerCase().split(/[/\-.]/).includes(p)).length }))
        .filter((x) => x.n)
        .sort((a, b) => b.n - a.n)
        .slice(0, 5)
        .map((x) => x.ref);
      return `unknown model "${args.model}"${near.length ? `. Close matches: ${near.join(", ")}` : ""}`;
    }
    if (m) args.model &&= m.ref; // exact casing
    if (args.effort && m && !m.efforts.includes(args.effort))
      return m.efforts.length ? `${m.ref} has effort levels ${m.efforts.join(", ")}; "${args.effort}" is not one of them` : `${m.ref} has no effort levels; leave \`effort\` out`;
    return "";
  };
  let err = check();
  if (err && (Date.now() - catalog.at > 10000 || (!workerSet().magic && err.startsWith("unknown model")))) {
    await refreshCatalog();
    err = check();
  }
  if (err?.startsWith("unknown model") && !workerSet().magic) {
    try {
      const fix = await profile.using(svc => missingSignIn(svc, resolveModel(args), resolve(args.directory || ".")));
      if (fix) return fix;
    } catch { /* keep the original validation error */ }
  }
  return err;
}

// ---- picking the worker of a call ----

// The model an OpenCode worker runs on: its own `model`, else its agent's.
function workerModel(w) {
  if (w.runs === "claude") return `${CLAUDE_PROVIDER}/${w.model}`;
  if (w.model) return w.model;
  const a = catalog?.agents.find((x) => x.name === w.agent);
  return a ? a.model.replace(/#.*$|\s.*$/, "") : "";
}
// One line per worker for the caller: what runs it, whose bill it is, its effort levels and what it is for.
function workerLine(w, isDefault) {
  const facts = [];
  if (w.runs === "claude") {
    facts.push(`Claude Code ${w.model}`, "uses the Claude plan");
    if (w.effort) facts.push(`effort ${w.effort}`);
  } else {
    const ref = workerModel(w);
    const levels = ref ? findModel(ref)?.efforts || [] : [];
    facts.push(`OpenCode agent ${w.agent}${ref ? ` on ${ref}` : ""}`, "not the Claude plan");
    if (levels.length) facts.push(`efforts ${effortLabel(levels)}`);
    if (w.effort) facts.push(`usually ${w.effort}`);
  }
  if (w.readOnly) facts.push("read-only");
  if (isDefault) facts.push("the default");
  return `${w.name} (${facts.join(", ")})${w.description ? `: ${w.description}` : ""}`;
}
function workerLines() {
  const { list, def } = workerSet();
  return Object.values(list).map((w) => workerLine(w, w.name === def));
}
// every effort level any worker's model has, in ladder order
function workerEfforts() {
  const used = new Set();
  for (const w of Object.values(workerSet().list)) for (const e of w.runs === "claude" ? CLAUDE_EFFORTS : findModel(workerModel(w))?.efforts || []) used.add(e);
  const levels = EFFORT_LADDER.filter((l) => used.has(l));
  return levels.length ? levels : FALLBACK_EFFORTS;
}
// The worker that ran a session, from the jobs this machine remembers (newest first).
function workerOfSession(session) {
  let best = null;
  const see = (s) => {
    if (s?.session === session && s.worker && (!best || s.started > best.started)) best = s;
  };
  for (const j of jobs.values()) see(j.state);
  if (!best)
    try {
      for (const f of readdirSync(STATE_DIR)) {
        if (!/^job_[a-z0-9]+_\d+\.json$/.test(f)) continue;
        const raw = readFileSync(join(STATE_DIR, f), "utf8");
        if (raw.includes(JSON.stringify(session))) see(JSON.parse(raw));
      }
    } catch {
      // a file being rewritten: the default worker is tried instead
    }
  return best?.worker;
}
// Resolves a call to one worker and rewrites its arguments to what that worker runs. Returns an error text or "".
// `worker` names it; a call written for an older version may name a worker with `agent`; a continued session goes
// back to the worker that ran it; otherwise the default worker. Any other `agent` or `model` is refused: the list
// is the only way in.
function useWorker(a) {
  const { list, def } = workerSet();
  const offer = `Workers: ${Object.keys(list).join(", ") || "(none set up; add one in OpenCode Config Studio)"}`;
  let name = a.worker;
  if (name !== undefined && !list[name]) return `unknown worker "${name}". ${offer}`;
  if (name === undefined && a.agent && list[a.agent]) name = a.agent;
  if (name === undefined && (a.agent || a.model))
    return `${a.model ? `model "${a.model}"` : `agent "${a.agent}"`} is not a worker. This bridge runs only the workers its user set up; pick one with \`worker\`. ${offer}`;
  if (a.worker !== undefined && a.model) return `\`model\` is not accepted: worker "${name}" decides what it runs on. ${offer}`;
  if (name === undefined && a.session) name = workerOfSession(a.session);
  if (name === undefined || !list[name]) name = def;
  const w = list[name];
  if (!w) return `no worker is set up. ${offer}`;
  const claudeSession = CLAUDE_SESSION.test(String(a.session || ""));
  if (a.session && claudeSession !== (w.runs === "claude"))
    return `session ${a.session} is ${claudeSession ? "a Claude Code" : "an OpenCode"} session and worker "${name}" runs ${w.runs === "claude" ? "Claude Code" : "OpenCode"}; pass the worker that started it as \`worker\`. ${offer}`;
  if (w.readOnly && a.allow_edits) return `worker "${name}" is read-only; run it without allow_edits, or pick another worker. ${offer}`;
  a._w = w;
  a.agent = w.runs === "claude" ? undefined : w.agent;
  a.model = w.runs === "claude" ? `${CLAUDE_PROVIDER}/${w.model}` : w.model || undefined;
  a.effort ||= w.effort || undefined;
  return "";
}

const TOOL_TAIL = () =>
  "A new session starts with NO context: put everything it needs in `prompt` (paths, goal, constraints, output format). Pass `session` to continue an earlier one instead. " +
  "Without `allow_edits` the job is read-only (enforced, not just asked): it can read, search and run read-only commands. " +
  `At most ${MAX_CONCURRENT} jobs run at once on this machine and ${LOCAL_CONCURRENT} per local model; more queue (\`opencode_list\` shows them). A job stops after \`timeout_seconds\` (default ${TIMEOUT_MS / 1000}), or \`idle_seconds\` without output (default ${IDLE_MS / 1000}; ${TOOL_IDLE_MS / 1000} while a tool call such as a build is in flight).`;
const COMMON_PROPS = () => ({
  prompt: { type: "string", description: "Full, self-contained task description." },
  directory: { type: "string", description: "Working directory for the worker (absolute path). Defaults to this server's cwd." },
  files: { type: "array", items: { type: "string" }, description: "Absolute paths of files to attach to the prompt." },
  allow_edits: { type: "boolean", description: "Let the worker modify files and run commands (also approves its permission prompts). Default false: a read-only job." },
  session: {
    type: "string",
    description: "Session id returned by an earlier call (the `session:` line). Continues that conversation with all its context: send only the follow-up (review findings, next step), not the whole spec again.",
  },
  timeout_seconds: { type: "number", description: `Wall-clock limit for this job. Default ${TIMEOUT_MS / 1000}, max ${MAX_TIMEOUT_MS / 1000}. Raise it for jobs that run long builds or test suites.` },
  idle_seconds: { type: "number", description: `Stop the job when it prints nothing for this long and no tool call is in flight. Default ${IDLE_MS / 1000}, at most the wall-clock limit.` },
  tool_idle_seconds: { type: "number", description: `The idle limit while a tool call (a build, a test run) is in flight. Default ${TOOL_IDLE_MS / 1000}, at least idle_seconds, at most the wall-clock limit.` },
});
// What a caller sees: the workers, by name. No model catalog and no agent list: those are not for it to choose from.
const buildWorkerTool = () => {
  const { list, def } = workerSet();
  const { prompt, ...rest } = COMMON_PROPS();
  return {
    name: "opencode_run",
    description:
      "Hands a task to a worker (another model working on its own) and returns AT ONCE with a job id. Get the answer, and its session id, with ONE `opencode_result` call, which waits until the job ends; to run several, start them all, then pass every id to it as `jobs`. " +
      "The workers are the ones the user set up, listed under `worker`: nothing else can be run, and each line says whether it uses the Claude plan. " +
      TOOL_TAIL(),
    inputSchema: {
      type: "object",
      properties: {
        prompt,
        worker: {
          type: "string",
          enum: Object.keys(list),
          description: `Which worker does the job${def ? ` (default ${def})` : ""}. When the user names one, use it.\n${workerLines().join("\n")}`,
        },
        ...rest,
        effort: {
          type: "string",
          enum: workerEfforts(),
          description: "Reasoning effort, one of the worker's own levels. Omit for the worker's usual one. low: summaries, lookups, mechanical edits. max: hard bugs, a second attempt after a failed fix round.",
        },
      },
      required: ["prompt"],
    },
  };
};

const buildTool = () => (ALLOW_ANY ? buildOpenTool() : buildWorkerTool());
// OPENCODE_ALLOW_ANY=1: every OpenCode model and agent is listed and can be asked for.
const buildOpenTool = () => ({
  name: "opencode_run",
  description:
    workersText() +
    "Starts a task on another model and returns AT ONCE with a job id. Not a Claude Code background task: no notification comes when it ends; wait for the answer (and its session id) by calling `opencode_result` until it is done. To run several, start them all, then pass every id to `opencode_result` as `jobs`. " +
    "Models: OpenCode's (default DeepSeek Flash; any other via `model`, listed in its description), or Claude Code itself via `model` claude-code/fable, opus, sonnet or haiku (" +
    "your Claude plan, Claude Code's tools and CLAUDE.md, no MCP servers). " +
    "A new session starts with NO context: put everything it needs in `prompt` (paths, goal, constraints, output format). Pass `session` to continue an earlier one instead. " +
    "Without `allow_edits` the job is read-only (enforced, not just asked): it can read, search and run read-only commands. " +
    `At most ${MAX_CONCURRENT} jobs run at once on this machine and ${LOCAL_CONCURRENT} per local model; more queue (\`opencode_list\` shows them). A job stops after \`timeout_seconds\` (default ${TIMEOUT_MS / 1000}), or \`idle_seconds\` without output (default ${IDLE_MS / 1000}; ${TOOL_IDLE_MS / 1000} while a tool call such as a build is in flight).`,
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Full, self-contained task description." },
      directory: {
        type: "string",
        description: "Working directory for the agent (absolute path). Defaults to this server's cwd.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Absolute paths of files to attach to the prompt.",
      },
      allow_edits: {
        type: "boolean",
        description: "Let the agent modify files (also auto-approves permission prompts). Default false: runs the read-only agent, which can still read files and run commands such as tests.",
      },
      session: {
        type: "string",
        description:
          "Session id returned by an earlier call (the `session:` line). Continues that conversation with all its context: send only the follow-up (review findings, next step), not the whole spec again.",
      },
      model: {
        type: "string",
        description:
          `provider/id. Default: the agent's own model (${MODEL}#high for ${DEFAULT_AGENT}). claude-code/fable, opus, sonnet or haiku run Claude Code itself (efforts low-max; edit jobs in its auto permission mode).` +
          modelsText(),
      },
      effort: {
        type: "string",
        enum: effortEnum(),
        description:
          "Reasoning effort, one of the model's own levels (listed below). Omit for the agent's/model's default. low: summaries, lookups, mechanical edits. max: hard bugs, a second attempt after a failed fix round. none: trivial formatting/extraction.",
      },
      timeout_seconds: {
        type: "number",
        description: `Wall-clock limit for this job. Default ${TIMEOUT_MS / 1000}, max ${MAX_TIMEOUT_MS / 1000}. Raise it for jobs that run long builds or test suites.`,
      },
      idle_seconds: {
        type: "number",
        description: `Stop the job when it prints nothing for this long and no tool call is in flight. Default ${IDLE_MS / 1000}, at most the wall-clock limit.`,
      },
      tool_idle_seconds: {
        type: "number",
        description: `The idle limit while a tool call (a build, a test run) is in flight. Default ${TOOL_IDLE_MS / 1000}, at least idle_seconds, at most the wall-clock limit.`,
      },
      agent: {
        type: "string",
        description:
          `A named worker (listed in the tool description), or an OpenCode agent for its own instructions and permissions. Default ${DEFAULT_AGENT}. To pick a model, use \`model\`, not an agent.` +
          agentsText(),
      },
    },
    required: ["prompt"],
  },
});

// every level any listed model has, in ladder order
function effortEnum() {
  const used = new Set(shownModels().flatMap((m) => m.efforts));
  const levels = EFFORT_LADDER.filter((l) => used.has(l));
  return levels.length ? levels : FALLBACK_EFFORTS;
}

const cancelledCalls = new Set(); // ids of tool calls the client gave up on
const resultTool = () => ({
  name: "opencode_result",
  description:
    `Waits for jobs started with \`opencode_run\` and returns their answers. Pass one \`job\`, or several as \`jobs\`: ONE call waits until any of them ends (up to ${waitLimit()} s), ` +
    "then returns each finished one's reply and session id, and a one-line progress report for each still running. Waiting costs nothing; calling again and again does, so make one call and let it wait. " +
    "With `jobs`, a reply is returned once: call again only while it says jobs are still running; finished ones then show as one line. " +
    "A timed-out, cancelled or failed job returns a short summary (session, files touched, last text, log path), never the raw log.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "A job id opencode_run returned (e.g. job_k3x_2)." },
      jobs: { type: "array", items: { type: "string" }, description: "Several job ids: wait for whichever finishes first." },
      wait_seconds: { type: "number", description: `Leave it out to wait as long as allowed (${waitLimit()} s). 0 looks without waiting.` },
    },
  },
});

const CANCEL_TOOL = {
  name: "opencode_cancel",
  description:
    "Stop a queued or running job from any session (any id `opencode_list` shows): kills its process tree and interrupts its OpenCode session, builds and tests it started included. " +
    "The reply's `resume:` line says whether the session is idle or still busy. On a job that already timed out or failed it interrupts a session that is still busy. Edits already made stay on disk.",
  inputSchema: {
    type: "object",
    properties: { job: { type: "string", description: "The job id to stop." } },
    required: ["job"],
  },
};

const LIST_TOOL = {
  name: "opencode_list",
  description:
    "Lists every queued and running job on this machine, from all sessions: id, owner process (alive or gone), model, state, start time, running time, last tool, " +
    "tool call in flight, queue place, which jobs hold the places of each pool, and sessions an ended job left busy in OpenCode. Any listed id can be passed to `opencode_cancel`.",
  inputSchema: { type: "object", properties: {} },
};

// ---- job state, shared through STATE_DIR ----

// Ids carry this instance's pid so two servers never hand out the same one.
const PREFIX = `job_${process.pid.toString(36)}`;
let nextJob = 1;
const jobs = new Map(); // this instance's jobs: id -> { state, promise, child, cancel }
const delivered = new Set(); // jobs whose reply a multi-job result call already returned
const collected = new Set(); // jobs whose reply reached the caller in any way: the list names the others

const statePath = (id) => join(STATE_DIR, `${id}.json`);
const logPath = (id) => join(STATE_DIR, `${id}.jsonl`);
const validId = (id) => typeof id === "string" && /^job_[a-z0-9]+_\d+$/.test(id);
// A cancel asked from another server instance: a file the job's owner looks for once a second.
const cancelPath = (id) => join(STATE_DIR, `${id}.cancel`);
const cancelAsked = (id) => existsSync(cancelPath(id));
function askCancel(id) {
  try {
    writeFileSync(cancelPath(id), String(process.pid));
    return true;
  } catch {
    return false;
  }
}
function clearCancel(id) {
  try {
    unlinkSync(cancelPath(id));
  } catch {
    // none was asked
  }
}
const isPending = (s) => s.status === "running" || s.status === "queued";

function saveState(state) {
  const tmp = `${statePath(state.id)}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, statePath(state.id));
  } catch {
    // the state folder is best effort: this instance still answers from memory
  }
}

function readState(id) {
  if (!validId(id)) return null;
  try {
    return JSON.parse(readFileSync(statePath(id), "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function prune() {
  for (const [k, j] of jobs) if (j.state.status !== "running" && j.state.status !== "queued" && Date.now() - j.state.finished > KEEP_MS) jobs.delete(k);
}

function startJob(args) {
  const id = `${PREFIX}_${nextJob++}`;
  const wall = clampMs(args.timeout_seconds, TIMEOUT_MS, MAX_TIMEOUT_MS);
  const idle = Math.min(clampMs(args.idle_seconds, IDLE_MS, MAX_TIMEOUT_MS), wall);
  const toolIdle = Math.min(Math.max(idle, clampMs(args.tool_idle_seconds, TOOL_IDLE_MS, MAX_TIMEOUT_MS)), wall);
  const state = {
    id,
    owner: process.pid,
    status: "queued",
    started: Date.now(),
    directory: args.directory || process.cwd(),
    session: args.session || "",
    timeoutMs: wall,
    idleMs: idle,
    toolIdleMs: toolIdle,
    lastTool: "",
    files: [],
    reply: "",
    ok: false,
    log: logPath(id),
  };
  const job = { state, child: null, cancelled: false };
  if (args._w) state.worker = args._w.name; // a continued session goes back to this worker
  const ref = resolveModel(args);
  const local = findModel(ref)?.local ? localPool(ref) : null;
  state.model = ref;
  job.promise = limited(job, local, () => (job.cancelled ? finish(job, "cancelled", "cancelled before it started") : runAgent(job, args)));
  jobs.set(id, job);
  saveState(state);
  prune();
  return id;
}

function clampMs(seconds, fallback, max) {
  const s = Number(seconds);
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, max) : fallback;
}

// child.kill() leaves opencode's own children (dotnet, builds) running on Windows: kill the whole tree.
function killPidTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // the child is spawned detached, so it leads its own group
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
const clean = (s) => s.replace(/§\d+§ ?/g, "").trim();

// Keeps the head and the tail of a long text; the full text stays in the job's files.
function cap(text, max, where) {
  if (text.length <= max) return text;
  const half = Math.floor((max - 200) / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - 2 * half} characters cut; full output in ${where} …]\n\n${text.slice(-half)}`;
}

// ---- idle limits, tool calls in flight, and the one-line statistics (no file or process access: tested directly) ----

// `shell "cargo build --release"`: the tool and the first 80 characters of what it runs or reads.
export function toolLabel(name, input) {
  const i = input && typeof input === "object" ? input : {};
  const what = [i.command, i.cmd, i.description, i.filePath, i.file_path, i.path, i.pattern].find((v) => typeof v === "string" && v.trim());
  return what ? `${name} "${what.replace(/\s+/g, " ").trim().slice(0, 80)}"` : String(name);
}

// Which idle limit applies and whether it has run out. A tool call that started and has not ended (`flight`) is
// activity in itself: a build prints nothing through OpenCode for many minutes, so the longer limit applies then.
export function idleVerdict({ quietMs, idleMs, toolIdleMs, flight }) {
  const limitMs = flight ? Math.max(idleMs, toolIdleMs) : idleMs;
  return { limitMs, expired: quietMs > limitMs };
}

export function idleReason({ limitMs, flight, now = Date.now() }) {
  const base = `no output for ${Math.round(limitMs / 1000)}s`;
  if (!flight) return `${base}, no tool call in flight`;
  if (flight.unknown) return `${base} inside an open step (OpenCode could not say which tool was running)`;
  return `${base} while tool ${flight.label} was in flight for ${Math.round((now - flight.since) / 1000)}s`;
}

// Searches the newest messages of an OpenCode session (`session.messages`) for a tool call that is running:
// { type: "tool", name, state: { status: "running", input }, time: { created, ran } }.
export function findRunningTool(data, now = Date.now()) {
  const when = (v) => (typeof v === "number" && v > 1e11 ? v : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : 0);
  let found = null;
  const walk = (v, depth) => {
    if (found || !v || typeof v !== "object" || depth > 8) return;
    if (!Array.isArray(v) && v.type === "tool" && typeof v.name === "string" && v.state?.status === "running") {
      found = { label: toolLabel(v.name, v.state.input), since: when(v.time?.ran) || when(v.time?.created) || now };
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(data, 0);
  return found;
}

const secs = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;
export function statsLine({ tools, totalMs, peakIdleMs, lastTool }) {
  return `${tools} tool call${tools === 1 ? "" : "s"} · total ${secs(totalMs)} · peak idle ${secs(peakIdleMs)} · last tool ${lastTool || "(none)"}`;
}

// What to tell the caller about continuing the session of a job that was stopped.
export function resumeNote({ claude, session, interrupted, busy }) {
  if (!session) return "resume: no session was created; start a new job";
  if (claude) return "resume: its process tree was killed; the session can be continued right away";
  if (busy === false) return `resume: OpenCode reports the session idle${interrupted ? " (its run was interrupted)" : ""}; it can be continued right away`;
  if (busy === true)
    return (
      "resume: the session is STILL BUSY in OpenCode after an interrupt request: a tool it started (a build) may still be running, and a continued job would wait behind it in silence. " +
      'Before continuing, check opencode_list ("Sessions still busy") or call opencode_cancel on this job again'
    );
  return (
    `resume: OpenCode could not be asked whether the session is still busy${interrupted ? " (it accepted the interrupt)" : ""}. ` +
    "If a continued job stays silent, the old run is still going: wait a minute, look at opencode_list, or call opencode_cancel on this job again"
  );
}

// ---- stopping a session inside OpenCode's background service ----
// `opencode run` only talks to the service (`opencode serve --service`); the session's loop and the processes its
// tools start live there, not under the `run` process this server spawned and can kill.

const ocSession = (s) => (s.session && !CLAUDE_SESSION.test(s.session) && !String(s.model || "").startsWith(`${CLAUDE_PROVIDER}/`) ? s.session : "");

// The ids of the sessions the service is executing now (`session.active`), or null when it can't be asked.
async function activeSessions(mode) {
  try {
    const act = await ocApi("session.active", [], 8000, mode);
    if (Array.isArray(act)) return act.map((x) => (typeof x === "string" ? x : x?.sessionID || x?.id)).filter(Boolean);
    return act && typeof act === "object" ? Object.keys(act) : null;
  } catch {
    return null;
  }
}
const sessionBusy = async (session, mode) => (await activeSessions(mode))?.includes(session) ?? null;

// The session's newest assistant messages. OpenCode 2.3 names the operation `session.message.list`; older ones
// `session.messages`. The name that answered is kept, so the other is not asked again.
let messagesOp = "session.message.list";
async function sessionMessages(session, mode) {
  const ask = (op) => ocApi(op, [`sessionID=${session}`, "limit=3", "order=desc", "type=assistant"], 8000, mode);
  try {
    return await ask(messagesOp);
  } catch (e) {
    if (!/not found|unknown operation/i.test(String(e?.message))) throw e;
    messagesOp = messagesOp === "session.messages" ? "session.message.list" : "session.messages";
    return ask(messagesOp);
  }
}

// OpenCode's service went away under a job (it restarted, or another OpenCode version took it over): the `run`
// client reports a transport error and exits. The session and what it did are intact, so the job can go on in it.
export const serviceDropped = (errors) => errors.some((e) => /Transport: |ECONNRESET|ECONNREFUSED|socket connection was closed|Background service/i.test(e));
const RESUMES = Math.max(0, Number(process.env.OPENCODE_RESUMES ?? 2));
const RESUME_WAIT_MS = Math.max(0, Number(process.env.OPENCODE_RESUME_WAIT_MS ?? 5000));
const RESUME_PROMPT =
  "The connection to OpenCode's service was lost while you were working on this task, and it is back now. " +
  "A command that was running at that moment did not finish: check what it left behind before relying on it. " +
  "Then carry on with the task from where you stopped, and reply as the task asked.";

async function missingSignIn(svc, model, cwd) {
  const provider = model.split("/")[0];
  if (!provider || findModel(model)?.local || findModel(model)?.free) return "";
  const rows = await profile.integrations(svc, cwd);
  const status = profile.signInStatus(rows, provider);
  // The standalone auth list contains only connected integrations. A remote worker
  // still needs an actionable error when its provider is absent from that list.
  if (status !== "Missing" && status !== "Sign in again" && (svc || rows.some(r => r.id === provider))) return "";
  const helper = fileURLToPath(new URL("./bridge-auth.mjs", import.meta.url));
  return `Worker provider "${provider}" ${status === "Sign in again" ? "needs a fresh sign-in" : "has no sign-in"}. Sign in for workers in OpenCode Config Studio › Workers, or run: node "${helper}" login ${provider}`;
}

// Asks the service to interrupt the session's run (`session.interrupt`), then looks whether it went idle.
async function stopSession(session, mode) {
  let interrupted = null;
  try {
    interrupted = !!(await ocApi("session.interrupt", [`sessionID=${session}`], 8000, mode))?.interrupted;
  } catch {
    // an OpenCode without this call, or no service running
  }
  let busy = null;
  for (let i = 0; i < 4; i++) {
    await sleep(i ? 1500 : 400);
    busy = await sessionBusy(session, mode);
    if (busy !== true) break;
  }
  return { interrupted, busy };
}

// Reads one OpenCode JSON event into the job's running summary.
function absorb(job, acc, ev) {
  const s = job.state;
  if (ev.sessionID && !s.session) s.session = ev.sessionID;
  const part = ev.part || {};
  if (ev.type === "text" && part.text) acc.texts.push(part.text);
  if (ev.type === "step_finish") {
    if (typeof part.cost === "number") acc.cost += part.cost;
    acc.reasoning += part.tokens?.reasoning || 0;
  }
  // a provider that can't be reached shows up as retries, not errors: keep the latest so it's visible
  if (ev.type === "retry") s.retry = `attempt ${ev.attempt}: ${String(ev.error?.message || "").slice(0, 160)}`;
  else if (ev.type === "step_finish" || ev.type === "text") s.retry = "";
  if (ev.type === "error") acc.errors.push(cap(JSON.stringify(ev.error ?? part ?? ev), 1000, s.log));
  // a step is the model's turn plus the tool calls it made: between its start and its finish a tool may be running
  if (ev.type === "step_start") acc.stepOpen = true;
  if (ev.type === "step_finish") acc.stepOpen = false;
  const tool = part.tool || (ev.type === "tool_use" ? ev.tool : "");
  if (tool) {
    s.lastTool = tool;
    const input = part.state?.input || part.input || {};
    // OpenCode 2.x reports a tool call once, when it has ended; a version that also reports the start is followed too
    const key = part.id || part.callID || `${tool}#${acc.tools}`;
    if (/^(running|pending)$/.test(part.state?.status || "")) acc.flights.set(key, { label: toolLabel(tool, input), since: Date.now() });
    else {
      acc.flights.delete(key);
      acc.tools++;
    }
    const file = input.filePath || input.file_path || input.path;
    if (typeof file === "string" && /^(edit|write|patch|multiedit|apply_patch)$/i.test(tool) && !s.files.includes(file)) s.files.push(file);
  }
}

// Counts the job's tool calls, total time and longest silent stretch into its state; returns them as one line.
function stats(job, acc) {
  const s = job.state;
  const now = Date.now();
  s.tools = acc.tools;
  s.peakIdleMs = Math.max(acc.peakIdle, now - (s.lastEvent || now));
  const waited = (s.running || now) - s.started;
  return statsLine({ tools: s.tools, totalMs: now - (s.running || s.started), peakIdleMs: s.peakIdleMs, lastTool: s.lastTool }) + (waited >= 1000 ? ` · queued ${secs(waited)} first` : "");
}

function summary(job, acc, status, reason, note = "") {
  const s = job.state;
  const last = clean(acc.texts.join("\n\n"));
  const lines = [
    `status: ${status} (${reason})`,
    `stats: ${stats(job, acc)}`,
    `session: ${s.session || "(none)"}${s.session ? " (pass as `session` to continue or ask what it got done)" : ""}`,
    `files edited: ${s.files.length ? s.files.join(", ") : "(none reported)"}`,
  ];
  if (note) lines.splice(3, 0, note);
  if (s.note) lines.push(`note: ${s.note}`);
  if (acc.errors.length) lines.push(`errors: ${acc.errors.slice(-3).join("\n")}`);
  if (s.retry) lines.push(`provider retrying (${s.retry})`);
  if (acc.stderr.trim()) lines.push(`stderr (tail): ${stripAnsi(acc.stderr).trim().slice(-800)}`);
  lines.push(`last text: ${last ? (last.length > LAST_TEXT ? "…" + last.slice(-LAST_TEXT) : last) : "(none)"}`);
  lines.push(`log: ${s.log}`);
  return lines.join("\n");
}

function finish(job, status, reply, ok = false) {
  const s = job.state;
  if (s.status !== "running" && s.status !== "queued") return s;
  s.status = status;
  s.ok = ok;
  s.reply = cap(reply, MAX_REPLY, s.log);
  s.finished = Date.now();
  saveState(s);
  releaseJob(s.id);
  clearCancel(s.id);
  return s;
}

// Reads one Claude Code stream-json event into the job's running summary.
function absorbClaude(job, acc, ev) {
  const s = job.state;
  if (ev.session_id && !s.session) s.session = ev.session_id;
  if (ev.type === "assistant")
    for (const c of ev.message?.content || []) {
      if (c.type === "text" && c.text) acc.texts.push(c.text);
      if (c.type === "tool_use") {
        s.lastTool = c.name;
        acc.tools++;
        if (c.id) acc.flights.set(c.id, { label: toolLabel(c.name, c.input), since: Date.now() });
        const file = c.input?.file_path || c.input?.notebook_path;
        if (typeof file === "string" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && !s.files.includes(file)) s.files.push(file);
      }
    }
  // a tool call ends with its result, which comes back as a user message
  if (ev.type === "user" && Array.isArray(ev.message?.content)) for (const c of ev.message.content) if (c.type === "tool_result") acc.flights.delete(c.tool_use_id);
  if (ev.type === "result") acc.flights.clear();
  if (ev.type === "system" && ev.subtype === "api_retry") s.retry = `attempt ${ev.attempt}: ${String(ev.error || "").slice(0, 160)}`;
  else if (ev.type === "assistant") s.retry = "";
  if (ev.type === "result") {
    if (typeof ev.result === "string") acc.final = ev.result;
    acc.cost += ev.total_cost_usd || 0;
    if (ev.is_error) acc.errors.push(String(ev.result || ev.subtype || "error").slice(0, 1000));
  }
}

async function runAgent(job, args) {
  let lease;
  try {
    if (!isClaudeJob(args) && !workerSet().magic) {
      lease = await profile.acquire();
      const cwd = args.directory && existsSync(args.directory) ? resolve(args.directory) : process.cwd();
      let ref = args.model;
      if (lease.svc) {
        // The job's directory can override a global agent's model and permissions.
        await profile.warm(lease.svc, cwd);
        const name = args.agent || pickAgent(args);
        const agents = (await profile.api(lease.svc, `/api/agent?directory=${encodeURIComponent(cwd)}`)).data;
        const agent = agents.find(a => a.id === name);
        if (!agent) return finish(job, "failed", `Unknown worker agent "${name}" in ${cwd}.`);
        if (!args.allow_edits && !guardedAgent(agent)) return finish(job, "failed", `Agent "${name}" can edit without asking in ${cwd}; it cannot run a read-only job.`);
        if (!ref && agent.model?.providerID && agent.model?.id) ref = refOf(agent.model);
      }
      ref ||= profile.configModel(args.agent || pickAgent(args)) || resolveModel(args);
      if (offReason(ref)) return finish(job, "failed", switchedOff(ref));
      const missing = await missingSignIn(lease.svc, ref, cwd);
      if (missing) return finish(job, "failed", missing);
      if (args.effort && !args.model) args.model = ref; // use the same project model that we checked
    }
    if (job.cancelled || cancelAsked(job.state.id)) return finish(job, "cancelled", "cancelled before it started");
    return await runClient(job, args, lease);
  } catch (e) {
    return finish(job, "failed", `Could not prepare OpenCode worker: ${e.message.split("\n")[0]}`);
  } finally { lease?.release(); }
}

function runClient(job, { prompt, directory, files = [], allow_edits = false, agent, session, effort, model, _w }, lease) {
  return new Promise((resolve) => {
    const s = job.state;
    const claude = isClaudeJob({ model, session, agent, _w });
    const worker = _w ? (claude ? _w : null) : claude && agent ? workers()[agent] : null;
    if (worker) {
      model ||= `${CLAUDE_PROVIDER}/${worker.model}`;
      effort ||= worker.effort;
      allow_edits = allow_edits && !worker.readOnly;
    }
    let exe = OPENCODE_EXE;
    let args;
    let ocArgs;
    if (claude) {
      exe = CLAUDE_EXE;
      // headless, JSON events, no MCP servers (so a worker never starts this bridge again);
      // edit jobs use auto mode (Claude's own safety check approves actions), read-only jobs don't-ask mode
      args = ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--permission-mode", allow_edits ? "auto" : "dontAsk"];
      if (model) args.push("--model", String(model).slice(CLAUDE_PROVIDER.length + 1));
      if (effort) args.push("--effort", effort);
      if (session) args.push("--resume", session);
      if (worker?.instructions) args.push("--append-system-prompt", worker.instructions);
      if (!allow_edits) args.push("--allowedTools", ...CLAUDE_READ_TOOLS); // variadic: keep it last
      if (files.length) prompt = `${prompt}\n\nFiles to read first:\n${files.join("\n")}`;
    } else {
      if (isAbsolute(OPENCODE_EXE) && !existsSync(OPENCODE_EXE)) {
        return resolve(finish(job, "failed", `opencode executable not found: ${OPENCODE_EXE} (set OPENCODE_EXE)`));
      }
      const chosen = pickAgent({ agent, allow_edits });
      // effort alone applies to the agent's own model, not always to OPENCODE_MODEL
      const ref = model || (effort ? resolveModel({ agent, allow_edits }) : "");
      s.serviceMode = lease ? (lease.svc ? "worker" : "standalone") : "owner";
      s.magicContext = !lease;
      ocArgs = (ses, attach) => {
        const a = ["run", "--format", "json", "--archived", "--agent", chosen];
        if (lease) a.push(...profile.targetArgs(lease.svc));
        if (ses) a.push("--session", ses);
        else a.push("--title", "claude-delegate");
        if (ref) a.push("--model", effort ? `${ref}#${effort}` : ref);
        if (allow_edits) a.push("--auto");
        for (const f of attach) a.push("--file", f);
        return a;
      };
      args = ocArgs(session, files);
    }
    const stdinFor = (text) => (allow_edits ? text : `READ-ONLY TASK: do not create, modify or delete any files and do not run state-changing commands.\n\n${text}`);
    const take = claude ? absorbClaude : absorb;

    const acc = { texts: [], errors: [], cost: 0, reasoning: 0, stderr: "", tools: 0, peakIdle: 0, stepOpen: false, flights: new Map() };
    const log = createWriteStream(s.log);
    let child;
    const cwd = directory && existsSync(directory) ? directory : process.cwd();
    const start = (withArgs) =>
      spawn(exe, withArgs, {
        cwd,
        // OpenCode takes its working folder from PWD when set, and an inherited PWD is this server's folder
        env: claude ? claudeEnv(cwd) : lease ? profile.environment(lease.svc, cwd) : { ...process.env, PWD: cwd },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    try {
      child = start(args);
    } catch (e) {
      log.end();
      return resolve(finish(job, "failed", `spawn failed: ${e.message}`));
    }
    job.child = child;
    s.status = "running";
    s.childPid = child.pid;
    s.running = Date.now();
    s.lastEvent = Date.now();
    saveState(s);

    // continuing a session whose earlier run never stopped would wait behind it without a word: say so
    if (!claude && session)
      sessionBusy(session, s.serviceMode).then((busy) => {
        if (busy && !ended) {
          s.note = "its session was still busy with an earlier run when this job started; opencode_cancel on the earlier job interrupts that run";
          saveState(s);
        }
      });

    let ended = false;
    // `fast` (the server is closing): no time to wait for OpenCode's answer
    const end = (status, reason, fast = false) => {
      if (ended) return;
      ended = true;
      clearTimeout(wallTimer);
      clearInterval(idleTimer);
      if (child.exitCode === null && child.signalCode === null) killPidTree(child.pid);
      log.end();
      s.inFlight = null;
      const done =(note) => resolve(finish(job, status, summary(job, acc, status, reason, note)));
      // `opencode run` is a client of OpenCode's background service: the session and its tools (a build) run
      // there, so killing the client is not enough. Ask the service to interrupt the session, and report the outcome.
      if (claude || !s.session) return done(resumeNote({ claude, session: s.session }));
      const stopping = stopSession(s.session, s.serviceMode);
      if (fast) return done(resumeNote({ session: s.session, interrupted: null, busy: null }));
      stopping.then((r) => done(resumeNote({ session: s.session, ...r })));
    };
    job.cancel = (fast = false) => end("cancelled", fast ? "its Claude session closed" : "stopped by opencode_cancel", fast);

    const wallTimer = setTimeout(() => {
      const flight = flightNow();
      end("timeout", `wall-clock limit ${s.timeoutMs / 1000}s${flight && !flight.unknown ? `; tool ${flight.label} was in flight for ${secs(Date.now() - flight.since)}` : ""}`);
    }, s.timeoutMs);

    // What is in flight now: a tool call the event stream showed starting (Claude Code), else what OpenCode's
    // service last said about this session. OpenCode's stream names a tool only when it has ended, so a job that
    // went silent inside a step is asked (`session.messages`) every `probeEvery`; any new event voids the answer.
    const probeEvery = Math.min(PROBE_MS, Math.max(250, s.idleMs / 2));
    const probe = { busy: false, at: 0, flight: null, answered: -1 };
    const askFlight = () => {
      const asked = s.lastEvent;
      probe.busy = true;
      sessionMessages(s.session, s.serviceMode)
        .then(
          (data) => findRunningTool(data),
          () => ({ unknown: true, label: "a tool call (OpenCode could not say which)", since: asked }),
        )
        .then((flight) => {
          probe.busy = false;
          probe.at = Date.now();
          if (asked !== s.lastEvent) return;
          probe.flight = flight;
          probe.answered = asked;
        });
    };
    const flightNow = () => acc.flights.values().next().value || probe.flight || null;
    const mark = () => {
      const now = Date.now();
      acc.peakIdle = Math.max(acc.peakIdle, now - s.lastEvent);
      s.lastEvent = now;
      probe.flight = null;
    };

    // once a second: write changed progress for other instances, honour a cancel request, check the idle limit
    let dirty = false;
    const idleTimer = setInterval(() => {
      const now = Date.now();
      const quietMs = now - s.lastEvent;
      if (!claude && s.session && acc.stepOpen && !acc.flights.size && !probe.busy && quietMs >= probeEvery && now - probe.at >= probeEvery) askFlight();
      const flight = flightNow();
      if ((s.inFlight?.label || "") !== (flight?.label || "")) {
        s.inFlight = flight ? { label: flight.label, since: flight.since } : null;
        dirty = true;
      }
      if (dirty) {
        dirty = false;
        saveState(s);
      }
      if (cancelAsked(s.id)) return end("cancelled", "stopped by opencode_cancel from another session");
      const verdict = idleVerdict({ quietMs, idleMs: s.idleMs, toolIdleMs: s.toolIdleMs, flight });
      // the first answer about this silence is due within seconds: decide with it
      if (verdict.expired && !(probe.busy && probe.answered !== s.lastEvent)) end("timeout", idleReason({ limitMs: verdict.limitMs, flight, now }));
    }, 1000);

    // After the service dropped the job's connection: wait for it to be back, make sure the old run is not still
    // going there, then go on in the same session. The wall-clock limit keeps counting from the first start.
    const resume = async () => {
      s.resumed = (s.resumed || 0) + 1;
      s.note = `OpenCode's service dropped this job's connection ${s.resumed === 1 ? "once" : `${s.resumed} times`}; it went on in the same session each time`;
      log.write(`${JSON.stringify({ type: "bridge", note: "connection to the service lost; resuming the session", errors: acc.errors.slice(-2) })}\n`);
      acc.errors.length = 0;
      acc.texts.length = 0;
      acc.flights.clear();
      acc.stepOpen = false;
      acc.final = undefined;
      mark();
      saveState(s);
      await sleep(RESUME_WAIT_MS);
      if (ended) return;
      if ((await sessionBusy(s.session, s.serviceMode)) === true) await stopSession(s.session, s.serviceMode);
      if (ended) return;
      mark();
      try {
        if (lease?.svc) {
          const replacement = await profile.acquire();
          lease.release();
          Object.assign(lease, replacement);
          s.serviceMode = lease.svc ? "worker" : "standalone";
          if (ended) { lease.release(); return; }
        }
        child = start(ocArgs(s.session, []));
      } catch (e) {
        acc.errors.push(`spawn failed: ${e.message}`);
        return end("failed", "could not start opencode again after its service dropped the connection");
      }
      job.child = child;
      s.childPid = child.pid;
      saveState(s);
      wire(child, stdinFor(RESUME_PROMPT));
    };

    const wire = (child, text) => {
    let pending = "";
    child.stdout.on("data", (d) => {
      log.write(d);
      mark();
      pending += d;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          take(job, acc, JSON.parse(line));
        } catch {
          // a non-JSON line: kept in the log only
        }
      }
      dirty = true;
    });
    child.stderr.on("data", (d) => {
      acc.stderr = (acc.stderr + d).slice(-4000);
      mark();
    });
    child.on("error", (e) => {
      acc.errors.push(`spawn failed: ${e.message}`);
      end("failed", "could not start opencode");
    });
    child.on("close", (code) => {
      if (ended) return;
      if (pending.trim().startsWith("{")) {
        try {
          take(job, acc, JSON.parse(pending));
        } catch {
          // ignore
        }
      }
      const text = clean(acc.final ?? acc.texts.join("\n\n"));
      const ok = code === 0 && !!text && !acc.errors.length;
      const left = s.timeoutMs - (Date.now() - s.running);
      if (!ok && !claude && s.session && (s.resumed || 0) < RESUMES && left > RESUME_WAIT_MS + 30000 && serviceDropped([...acc.errors, acc.stderr])) return void resume();
      if (!ok) return end("failed", code === 0 ? (text ? "the agent reported errors" : "empty reply") : `opencode exited ${code}`);
      ended = true;
      clearTimeout(wallTimer);
      clearInterval(idleTimer);
      log.end();
      s.inFlight = null;
      const footer =
        "\n\n---\n" +
        (s.session ? `session: ${s.session} (pass as \`session\` to continue this conversation) · cost $${acc.cost.toFixed(4)}${claude ? "" : ` · reasoning ${acc.reasoning} tok`}\n` : "") +
        `stats: ${stats(job, acc)}` +
        (s.resumed ? `\nnote: ${s.note}` : "");
      // the cap keeps the footer: cut the body, then append it
      resolve(finish(job, "done", cap(text, MAX_REPLY - footer.length, s.log) + footer, true));
    });
    child.stdin.end(text);
    };
    wire(child, stdinFor(prompt));
  });
}

// ---- lookups across instances ----

function current(id) {
  const mine = jobs.get(id);
  if (mine) return { state: mine.state, job: mine };
  const state = readState(id);
  if (!state) return null;
  // a job whose server is gone can no longer finish: say so instead of "running" forever
  if ((state.status === "running" || state.status === "queued") && !alive(state.owner)) {
    state.status = "lost";
    state.reply = [
      `status: lost (the server that ran it exited; its process ${alive(state.childPid) ? `${state.childPid} may still be running` : "is gone"})`,
      `session: ${state.session || "(none)"}`,
      `last tool: ${state.lastTool || "(none)"}`,
      `files edited: ${state.files?.length ? state.files.join(", ") : "(none reported)"}`,
      `log: ${state.log}`,
    ].join("\n");
  }
  return { state, job: null };
}

function progress(s) {
  const now = Date.now();
  const since = s.status === "queued" ? `queued${s.waiting ? ` (${s.waiting})` : ""}` : `running ${Math.round((now - (s.running || s.started)) / 1000)}s`;
  const quiet = s.lastEvent ? `, last output ${Math.round((now - s.lastEvent) / 1000)}s ago` : "";
  const tool = s.lastTool ? `, last tool ${s.lastTool}` : "";
  const flight = s.inFlight ? `, in flight: ${s.inFlight.label} for ${secs(now - s.inFlight.since)}` : "";
  const files = s.files?.length ? `, ${s.files.length} file(s) edited` : "";
  const retry = s.retry ? `, provider retrying (${s.retry})` : "";
  const note = s.note ? `, NOTE: ${s.note}` : "";
  return `${s.id} still ${since}${quiet}${tool}${flight}${files}${retry}${note} (limit ${s.timeoutMs / 1000}s, idle ${s.idleMs / 1000}s, ${(s.toolIdleMs || s.idleMs) / 1000}s with a tool in flight)`;
}
// The same in a few words, for the progress message of a waiting call.
const progressShort = (s) =>
  `${s.id} ${s.status === "queued" ? "queued" : `running ${secs(Date.now() - (s.running || s.started))}`}${s.inFlight ? `, ${s.inFlight.label}` : s.lastTool ? `, last tool ${s.lastTool}` : ""}${s.files?.length ? `, ${s.files.length} file(s) edited` : ""}`;
const NO_NOTICE = "Call opencode_result again to keep waiting (one call, no status message in between).";
function progressOne(s) {
  return `${progress(s)}. ${NO_NOTICE}`;
}

// ---- opencode_list: every queued and running job on this machine, read from the shared state folder ----

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function pendingStates() {
  const out = new Map();
  let names = [];
  try {
    names = readdirSync(STATE_DIR);
  } catch {
    // no state folder: only this instance's jobs
  }
  for (const f of names) {
    if (!/^job_[a-z0-9]+_\d+\.json$/.test(f) || jobs.has(f.slice(0, -5))) continue;
    try {
      const raw = readFileSync(join(STATE_DIR, f), "utf8");
      if (!/"status":"(running|queued)"/.test(raw)) continue; // finished jobs are most of the folder
      const s = JSON.parse(raw);
      if (isPending(s)) out.set(s.id, s);
    } catch {
      // being rewritten
    }
  }
  for (const j of jobs.values()) if (isPending(j.state)) out.set(j.state.id, j.state);
  return [...out.values()].sort((a, b) => a.started - b.started);
}

const poolName = (pool) => (pool === "all" ? "the machine" : `local model ${allModels().find((m) => m.local && localPool(m.ref) === pool)?.ref || pool}`);
const poolSize = (pool) => (pool === "all" ? MAX_CONCURRENT : LOCAL_CONCURRENT);

// One line per job. `queued` is every queued job, oldest first: a job's place is its rank among those waiting for the same pool.
export function listLine(s, queued, now = Date.now()) {
  const owner = `owner pid ${s.owner} ${alive(s.owner) ? "alive" : "GONE (opencode_cancel frees its place)"}`;
  const head = `${s.id} ${s.status} · ${s.model || "model?"} · ${owner} · started ${clock(s.started)}`;
  if (s.status === "queued") {
    if (!s.waitPool) return `${head} · queued ${secs(now - s.started)}, about to start`;
    const peers = queued.filter((q) => q.waitPool === s.waitPool);
    return `${head} · queued ${secs(now - s.started)}, place ${peers.indexOf(s) + 1}/${peers.length} waiting for ${poolName(s.waitPool)}`;
  }
  const flight = s.inFlight ? ` · in flight: ${s.inFlight.label} for ${secs(now - s.inFlight.since)}` : "";
  return (
    `${head} · running ${secs(now - (s.running || s.started))} · last tool ${s.lastTool || "(none)"} · last output ${secs(now - (s.lastEvent || s.started))} ago` +
    `${flight}${s.session ? ` · session ${s.session}` : ""}`
  );
}

function poolLines() {
  const pools = new Map([["all", { live: [], stale: 0 }]]);
  let names = [];
  try {
    names = readdirSync(SLOT_DIR);
  } catch {
    // no slot folder
  }
  for (const f of names) {
    const path = join(SLOT_DIR, f);
    const info = slotInfo(path);
    if (!info) continue;
    const pool = f.replace(/\.\d+$/, "");
    if (!pools.has(pool)) pools.set(pool, { live: [], stale: 0 });
    if (slotStale(path)) pools.get(pool).stale++;
    else pools.get(pool).live.push(info.job || "unknown job");
  }
  return [...pools].map(
    ([pool, p]) =>
      `${poolName(pool)}: ${p.live.length}/${poolSize(pool)} places held${p.live.length ? ` by ${p.live.join(", ")}` : ""}${p.stale ? ` (+${p.stale} stale, freed on the next take)` : ""}`,
  );
}

// Sessions OpenCode is still executing although no listed job runs them: what a stopped job may have left behind.
async function busyLines(states) {
  if (!existsSync(OPENCODE_EXE) && isAbsolute(OPENCODE_EXE)) return [];
  const active = await activeSessions();
  if (!active) return ["Sessions still busy: OpenCode could not be asked."];
  const running = new Set(states.map((s) => s.session).filter(Boolean));
  const left = active.filter((id) => !running.has(id));
  if (!left.length) return ["Sessions still busy without a job: none."];
  // which ended job each belongs to (sessions this bridge never ran, such as the user's own, are not listed)
  const owners = new Map();
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!/^job_[a-z0-9]+_\d+\.json$/.test(f)) continue;
      const raw = readFileSync(join(STATE_DIR, f), "utf8");
      const ses = /"session":"([^"]+)"/.exec(raw)?.[1];
      if (!ses || !left.includes(ses)) continue;
      const s = JSON.parse(raw);
      if (!owners.has(ses) || s.started > owners.get(ses).started) owners.set(ses, s);
    }
  } catch {
    // a file being rewritten: the next call sees it
  }
  if (!owners.size) return ["Sessions still busy without a job: none."];
  return [
    "Sessions still busy without a job (a tool of the ended job may still run; opencode_cancel on that job interrupts it):",
    ...[...owners].map(([ses, s]) => `${ses} · ${s.id} ${s.status}${s.finished ? ` ${secs(Date.now() - s.finished)} ago` : ""}`),
  ];
}

async function listText() {
  const states = pendingStates();
  const queued = states.filter((s) => s.status === "queued");
  const lines = states.length ? states.map((s) => listLine(s, queued)) : ["No job is queued or running."];
  const who = ALLOW_ANY ? ["Workers: any OpenCode agent or model (OPENCODE_ALLOW_ANY)"] : ["Workers:", ...workerLines()];
  // this session's own jobs that ended while nobody was waiting: without tasks nothing else tells the caller
  const ended = [...jobs.values()].map((j) => j.state).filter((st) => !isPending(st) && !collected.has(st.id));
  const uncollected = ended.length
    ? ["", "Ended, reply NOT collected yet (yours):", ...ended.map((st) => `${st.id} ${st.status}: call opencode_result { job: "${st.id}" } for its reply`)]
    : [];
  return [
    ...lines,
    ...uncollected,
    "",
    "Places:",
    ...poolLines(),
    "",
    ...(await busyLines(states)),
    "",
    ...who,
    "",
    `This server: client "${clientName || "unknown"}"${client.version ? ` ${client.version}` : ""}, protocol ${client.protocol || "?"}, MCP tasks ${client.tasks ? "offered" : "not offered"}; one opencode_result call waits up to ${waitLimit()} s.`,
  ].join("\n");
}

// A stopped job's session may still be running inside OpenCode: interrupt it (again) and say how it stands.
async function stopLeftover(s) {
  const ses = ocSession(s);
  if (!ses) return "";
  const user = pendingStates().find((p) => p.session === ses && p.id !== s.id);
  if (user) return `its session ${ses} is in use by ${user.id}; cancel that job to stop it`;
  return resumeNote({ session: ses, ...(await stopSession(ses, s.serviceMode)) });
}
const resumeLine = (reply) => /^resume: .*$/m.exec(reply || "")?.[0] || "";

// Stops a job from any session. Returns [text, isError].
async function cancelJob(id) {
  const found = current(id);
  if (!found) {
    // not a job this server can find, but it may still hold a place in the queue
    const freed = validId(id) ? freeSlots(id) : 0;
    return freed ? [`${id} has no record; its ${freed} held place(s) in the queue are freed`] : [`unknown job ${id}`, true];
  }
  const s = found.state;
  const session = s.session ? `; session ${s.session}` : "";
  if (found.job) {
    if (s.status === "queued") {
      found.job.cancelled = true;
      finish(found.job, "cancelled", "cancelled before it started");
      return [`${id} cancelled before it started`];
    }
    if (s.status === "running") {
      found.job.cancel?.();
      await Promise.race([found.job.promise, sleep(25000)]);
      return [`${id} stopped (process tree ${s.childPid} killed). Edits it made stay on disk${session}.\n${resumeLine(s.reply)}`.trim()];
    }
  } else if (s.status === "lost") {
    // its server is gone: stop what is left of it and free its places
    if (alive(s.childPid)) killPidTree(s.childPid);
    const freed = freeSlots(id);
    const left = await stopLeftover(s);
    return [`${id} stopped (its server is gone; process tree ${s.childPid} killed)${freed ? `; ${freed} held place(s) in the queue freed` : ""}${session}.\n${left}`.trim()];
  } else if (isPending(s)) {
    // owned by another live instance: ask it, so the job ends the same way as with its own cancel
    askCancel(id);
    let now = s;
    for (const until = Date.now() + (s.status === "running" ? 25000 : 5000); Date.now() < until && isPending(now); ) {
      await sleep(250);
      now = readState(id) || now;
    }
    if (!isPending(now)) return [`${id} ${now.status} by its own server (pid ${s.owner}). Edits it made stay on disk${session}.\n${resumeLine(now.reply)}`.trim()];
    // no answer: a server from before cancel requests, or one that is stuck
    if (s.status === "running") {
      if (alive(s.childPid)) killPidTree(s.childPid);
      const left = await stopLeftover(s);
      return [`${id}: its server (pid ${s.owner}) did not answer the cancel request, so process tree ${s.childPid} was killed directly${session}.\n${left}`.trim()];
    }
    return [`${id} is queued in server pid ${s.owner}, which did not answer the cancel request within 5 s (an older version of the server?). The request stays in place and is honoured when that server next looks.`, true];
  }
  // already ended: its session may still be running in OpenCode all the same
  const left = s.status === "done" ? "" : await stopLeftover(s);
  return [`${id} already ${s.status}${left ? `\n${left}` : ""}`];
}

// Shown in the client's system prompt even while the tools are deferred. Claude Code's own background tasks
// (run_in_background, background subagents) notify the session when they end; these jobs never do, and a session
// that treats them that way waits for nothing or polls now and then with sleep, Monitor or wakeups.
const SERVER_INSTRUCTIONS =
  "`opencode_run` hands a task to one of the user's workers (listed in its `worker` parameter; nothing else can be run) and returns a job id at once. " +
  "Wait with `opencode_result`, one call that holds every job id: it waits as long as this client allows and returns when a job ends. " +
  "While it comes back with jobs still running, call it again right away, with no status message in between. Never wait any other way: " +
  "no sleep, Monitor, ScheduleWakeup, cron, background shell loop or subagent, and do not end the turn while a job you need is running.";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// What this client offers, kept for opencode_list and in clients.jsonl: whether a client can take a long job as an
// MCP task (the io.modelcontextprotocol/tasks extension) is known only from what it sends.
const TASKS_EXT = "io.modelcontextprotocol/tasks";
const VERSION = "3.4.0";

// ---- MCP tasks (OPENCODE_TASKS=1) ----
// With protocol 2026-07-28 and the tasks extension a client takes a long job as a task: opencode_run returns at
// once, the client asks tasks/get now and then by itself, and hands the model the job's reply when it has ended.
// No call is held open and the model spends no request on waiting. Claude Code asks for that protocol first
// (server/discover) and falls back to initialize when the server does not know it, so this is behind a switch:
// off, nothing changes. The protocol has no handshake: every request says what the client can do.
const TASKS_ON = process.env.OPENCODE_TASKS === "1";
const MODERN = "2026-07-28";
const PV = "io.modelcontextprotocol/protocolVersion";
const TASK_POLL_MS = Math.max(250, Number(process.env.OPENCODE_TASK_POLL_MS || 5000));
const offersTasks = (params) => !!params?._meta?.["io.modelcontextprotocol/clientCapabilities"]?.extensions?.[TASKS_EXT];
const TASK_INSTRUCTIONS =
  "`opencode_run` hands a task to one of the user's workers (listed in its `worker` parameter; nothing else can be run). " +
  "It runs as a background task: the call returns at once and the job's reply is delivered to you when the job ends. " +
  "Start every job you need, then carry on with other work or end the turn. Do not wait for a job in any way: no `opencode_result` loop, " +
  "sleep, Monitor, ScheduleWakeup or subagent. `opencode_result` with `wait_seconds: 0` only looks at what a job is doing.";
// The run tool's opening, which says how to wait, reworded for a client that takes the job as a task.
// What a look at a running task job ends with, and how soon a second look gets only that.
const TASK_WAIT = "Its reply is delivered to you when it ends. Do not look again: carry on with other work, or end the turn if nothing else is left.";
const LOOK_AGAIN_MS = Math.max(0, Number(process.env.OPENCODE_LOOK_AGAIN_MS || 60000));
const looked = new Map();
const taskDescription = (d) =>
  d.replace(/^.*? as `jobs`. /s, () => "Hands a task to a worker (another model working on its own) as a background task: the call returns at once, and the job's reply, with its session id, is delivered to you when the job ends. Do not call `opencode_result` to wait for it. ");
const iso = (ms) => new Date(ms || Date.now()).toISOString();
// A job as the extension's task. Whatever way it ended, its reply is the tool result ("failed" is for protocol errors).
function taskOf(s) {
  const done = !isPending(s);
  const t = { taskId: s.id, status: done ? "completed" : "working", createdAt: iso(s.started), lastUpdatedAt: iso(done ? s.finished : s.lastEvent || s.started), ttlMs: s.timeoutMs + 60 * MIN, pollIntervalMs: TASK_POLL_MS };
  if (done) t.result = { content: [{ type: "text", text: s.reply || `${s.id} ${s.status}` }], isError: !s.ok };
  else t.statusMessage = progressShort(s).slice(0, 300);
  return t;
}
const client = { protocol: "", version: "", methods: [], tasks: false };
function noteClient(method, params) {
  let changed = false;
  if (method && !client.methods.includes(method) && client.methods.length < 30) {
    client.methods.push(method);
    changed = /^(initialize|server\/|tasks\/)/.test(method);
  }
  const meta = params?._meta || {};
  const caps = [params?.capabilities, meta["io.modelcontextprotocol/clientCapabilities"]];
  const protocol = String(params?.protocolVersion || meta["io.modelcontextprotocol/protocolVersion"] || "");
  if (protocol && protocol !== client.protocol) {
    client.protocol = protocol;
    changed = true;
  }
  if (!client.tasks && caps.some((c) => c?.extensions?.[TASKS_EXT] || c?.tasks)) {
    client.tasks = true;
    changed = true;
  }
  if (params?.clientInfo) {
    client.version = String(params.clientInfo.version || "");
    client.capabilities = params.capabilities;
  }
  if (!changed) return;
  try {
    const line = { at: new Date().toISOString(), pid: process.pid, name: params?.clientInfo?.name || clientName, ...client };
    writeFileSync(join(STATE_DIR, "clients.jsonl"), `${JSON.stringify(line)}\n`, { flag: "a" });
  } catch {
    // a record only
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  noteClient(method, params);
  // a request of the newer protocol says so itself; its results carry resultType
  const modern = TASKS_ON && params?._meta?.[PV] !== undefined;
  const out = (m) => send(modern && m.result && !m.result.resultType ? { ...m, result: { resultType: "complete", ...m.result } } : m);
  if (modern) {
    if (params._meta[PV] !== MODERN)
      return send({ jsonrpc: "2.0", id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN], requested: params._meta[PV] } } });
    clientName = String(params._meta["io.modelcontextprotocol/clientInfo"]?.name || clientName);
    if (method === "server/discover")
      return out({
        jsonrpc: "2.0",
        id,
        result: {
          supportedVersions: [MODERN],
          capabilities: { tools: {}, extensions: { [TASKS_EXT]: {} } },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "opencode-agent", version: VERSION } },
          instructions: offersTasks(params) ? TASK_INSTRUCTIONS : SERVER_INSTRUCTIONS,
        },
      });
    if (method === "tasks/get" || method === "tasks/cancel") {
      const f = current(String(params?.taskId ?? ""));
      if (!f) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown task ${params?.taskId}` } });
      if (method === "tasks/cancel") {
        if (isPending(f.state)) await cancelJob(f.state.id);
        return out({ jsonrpc: "2.0", id, result: {} });
      }
      if (!isPending(f.state)) {
        delivered.add(f.state.id);
        collected.add(f.state.id);
      }
      return out({ jsonrpc: "2.0", id, result: taskOf(f.state) });
    }
  }
  if (method === "initialize") {
    clientName = String(params?.clientInfo?.name || "");
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "opencode-agent", version: VERSION },
        instructions: SERVER_INSTRUCTIONS,
      },
    });
  }
  if (method === "notifications/initialized") {
    clientReady = true;
    return;
  }
  // the client gave up on a call (the user interrupted, or its own limit ran out): a wait must not answer it,
  // or the reply it carries would count as delivered without anyone having read it
  if (method === "notifications/cancelled") {
    if (params?.requestId !== undefined) cancelledCalls.add(params.requestId);
    return;
  }
  if (method === "tools/list") {
    demandCatalog();
    // first run in this folder: wait (bounded) for the live list; otherwise the cache answers at once
    if (!catalog && refreshing) await Promise.race([refreshing, new Promise((r) => setTimeout(r, 10000))]);
    const run = buildTool();
    return out({ jsonrpc: "2.0", id, result: { tools: [modern && offersTasks(params) ? { ...run, description: taskDescription(run.description) } : run, resultTool(), CANCEL_TOOL, LIST_TOOL] } });
  }
  if (method === "tools/call") {
    const reply = (text, isError = false) => out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
    const a = params?.arguments || {};
    if (params?.name === "opencode_run") {
      if (!a.prompt) return reply("prompt is required", true);
      if (!ALLOW_ANY) {
        const refused = useWorker(a);
        if (refused) return reply(refused, true);
      }
      const bad = await validate(a);
      if (bad) return reply(a._w ? `worker "${a._w.name}": ${bad}` : bad, true);
      const waiting = inUse("all") >= MAX_CONCURRENT ? ` (queued: ${MAX_CONCURRENT} jobs already running on this machine)` : "";
      const job = startJob(a);
      const s = jobs.get(job).state;
      const model = `${a.model || resolveModel(a)}${a.effort ? `#${a.effort}` : ""}`;
      const on = a._w ? ` on worker ${a._w.name} (${model})` : a.model || a.effort ? ` on ${model}` : "";
      if (modern && offersTasks(params))
        return out({ jsonrpc: "2.0", id, result: { resultType: "task", ...taskOf(s), statusMessage: `started ${job}${on}${waiting}; its reply is delivered when it ends` } });
      return reply(`started ${job}${on}${waiting}, limit ${s.timeoutMs / 1000}s, idle ${s.idleMs / 1000}s. Wait for it with one call: opencode_result { job: "${job}" } (or several ids at once as \`jobs\`); it returns when the job ends. Nothing wakes you when a job ends: do not end your turn before you have its reply.`);
    }
    if (params?.name === "opencode_result") {
      const ids = [...new Set([...(Array.isArray(a.jobs) ? a.jobs : []), ...(a.job ? [a.job] : [])].map(String))];
      if (!ids.length) return reply("pass `job` or `jobs`", true);
      const pending = (s) => s.status === "running" || s.status === "queued";
      const look = () => new Map(ids.map((jid) => [jid, current(jid)]));
      let found = look();
      if (ids.every((jid) => !found.get(jid))) return reply(`unknown job${ids.length > 1 ? "s" : ""} ${ids.join(", ")} (no state in ${STATE_DIR}; any edits made are still on disk)`, true);
      // with several jobs, one already returned is not news
      const fresh = (jid) => ids.length === 1 || !delivered.has(jid);
      const ready = () => ids.some((jid) => found.get(jid) && !pending(found.get(jid).state) && fresh(jid));
      const anyPending = () => ids.some((jid) => found.get(jid) && pending(found.get(jid).state));
      // A client that takes jobs as tasks is handed each reply by itself: a call here never waits, and looking at
      // the same running jobs again within a minute gets one line, so a loop of looks has nothing to feed on.
      const asTask = modern && offersTasks(params);
      if (asTask && !ready() && anyPending()) {
        const running = ids.filter((jid) => found.get(jid) && pending(found.get(jid).state));
        const now = Date.now();
        const again = running.every((jid) => now - (looked.get(jid) || 0) < LOOK_AGAIN_MS);
        for (const jid of running) if (!again) looked.set(jid, now);
        if (again) return reply(`${running.join(", ")} still running. ${TASK_WAIT}`);
      }
      const most = asTask ? 0 : waitLimit();
      const asked = Number(a.wait_seconds);
      const until = Date.now() + Math.max(0, Math.min(most, a.wait_seconds === undefined || !Number.isFinite(asked) ? most : asked)) * 1000;
      // a progress message now and then: the caller's user sees what the jobs are doing, and a client that ends a
      // silent call (Claude Code: after 30 minutes) sees that this one is alive
      const token = params?._meta?.progressToken;
      let told = Date.now();
      let beat = 0;
      while (!ready() && anyPending() && Date.now() < until) {
        if (cancelledCalls.delete(id)) return; // the client gave up on this call: no answer, nothing counted as delivered
        if (token !== undefined && Date.now() - told >= PROGRESS_MS) {
          told = Date.now();
          const running = ids.map((jid) => found.get(jid)?.state).filter((s) => s && pending(s));
          send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++beat, message: running.map(progressShort).join(" | ").slice(0, 300) } });
        }
        // only jobs still pending: a settled promise would end the race at once, every time
        const mine = ids.filter((jid) => found.get(jid) && pending(found.get(jid).state)).map((jid) => found.get(jid).job?.promise).filter(Boolean);
        await Promise.race([...mine, sleep(Math.min(2000, PROGRESS_MS, Math.max(0, until - Date.now())))]);
        found = look();
      }
      if (cancelledCalls.delete(id)) return;
      if (ids.length === 1) {
        const s = found.get(ids[0]).state;
        if (pending(s)) return reply(asTask ? `${progressOne(s)}
${TASK_WAIT}` : progressOne(s));
        collected.add(ids[0]);
        return reply(s.reply || `${ids[0]} ${s.status}`, !s.ok);
      }
      const parts = [];
      const lines = [];
      for (const jid of ids) {
        const f = found.get(jid);
        if (!f) lines.push(`${jid}: unknown`);
        else if (pending(f.state)) lines.push(progress(f.state));
        else if (!fresh(jid)) lines.push(`${jid}: ${f.state.status}, reply already returned (opencode_result { job: "${jid}" } returns it again)`);
        else {
          delivered.add(jid);
          collected.add(jid);
          parts.push(`## ${jid} · ${f.state.status}\n${f.state.reply || f.state.status}`);
        }
      }
      const left = ids.filter((jid) => found.get(jid) && pending(found.get(jid).state)).length;
      lines.push(left ? `${left} still running. ${asTask ? TASK_WAIT : NO_NOTICE}` : "All done.");
      return reply([...parts, lines.join("\n")].join("\n\n"));
    }
    if (params?.name === CANCEL_TOOL.name) return reply(...(await cancelJob(a.job)));
    if (params?.name === LIST_TOOL.name) return reply(await listText());
    return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
  }
  if (method === "ping") return out({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

// Stop this instance's running jobs when the session closes, so no build is left behind.
function shutdown() {
  for (const j of jobs.values()) if (j.state.status === "running") j.cancel?.(true);
  setTimeout(() => process.exit(0), 300);
}

// OPENCODE_BRIDGE_NO_MAIN=1 (the tests) loads this file for its functions without serving stdin.
if (process.env.OPENCODE_BRIDGE_NO_MAIN !== "1") {
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);

  setTimeout(pruneFiles, 5000).unref();
  // the worker list is the tool's description: tell the client when the user changes it
  for (const file of [WORKERS_FILE, LEGACY_WORKERS_FILE])
    watchFile(file, { interval: 3000, persistent: false }, () => {
      if (clientReady) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    });

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`bad message: ${e.message}\n`);
    }
  });
}
