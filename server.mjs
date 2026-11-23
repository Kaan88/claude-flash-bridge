#!/usr/bin/env node
// Minimal stdio MCP server: delegates a task to an OpenCode agent (default deepseek-flash)
// by running `opencode run --agent <agent>`. No dependencies.
//
// Jobs are shared between server instances through a state folder (OPENCODE_STATE_DIR, default
// <tmp>/opencode-agent): every job writes <id>.json (status, session, progress, the capped reply) and
// <id>.jsonl (OpenCode's raw event stream). Any instance can answer or cancel any job, and a reply
// never carries the raw log: a timed-out or failed job returns a short summary plus the log's path.
//
// The models, their real effort levels (OpenCode "variants") and the agents are read from OpenCode when the
// server starts (`opencode api model.list` / `agent.list`), cached per project folder, and written compactly
// into the tool description; Claude is told (tools/list_changed) when a refresh changes them.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

// The npm shim (opencode.cmd / opencode.ps1) mangles stdin, so find the real binary next to it.
function findOpencode() {
  if (process.env.OPENCODE_EXE) return process.env.OPENCODE_EXE;
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    const real = join(dir, "node_modules", "@opencode", "cli", "bin", exe);
    if (existsSync(real)) return real;
    if (existsSync(join(dir, exe))) return join(dir, exe);
  }
  return exe;
}
const OPENCODE_EXE = findOpencode();
const DEFAULT_AGENT = process.env.OPENCODE_AGENT || "deepseek-flash";
// Read-only twin of the default agent: OpenCode denies its edit tools (see opencode.json).
const READONLY_AGENT = process.env.OPENCODE_READONLY_AGENT || `${DEFAULT_AGENT}-ro`;
const MODEL = process.env.OPENCODE_MODEL || "deepseek/deepseek-flash";
const MIN = 60 * 1000;
// Wall-clock backstop per job, and the longer a job may go without a single event from OpenCode.
// A full build or test run inside one tool call can be silent for many minutes, so the idle limit is generous.
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 60 * MIN);
const IDLE_MS = Number(process.env.OPENCODE_IDLE_MS || 20 * MIN);
const MAX_TIMEOUT_MS = 4 * 60 * MIN;
const MAX_CONCURRENT = Math.max(1, Number(process.env.OPENCODE_MAX_CONCURRENT || 10));
const MAX_REPLY = Number(process.env.OPENCODE_MAX_REPLY_CHARS || 20000);
const LAST_TEXT = 2000;
const KEEP_MS = 24 * 60 * MIN;
const STATE_DIR = process.env.OPENCODE_STATE_DIR || join(tmpdir(), "opencode-agent");
mkdirSync(STATE_DIR, { recursive: true });

// ---- job slots, shared by every server instance on this machine ----
// OPENCODE_MAX_CONCURRENT jobs run at once machine-wide (all Claude sessions together), and at most
// OPENCODE_LOCAL_CONCURRENT at once on any one local model, which a local server mostly runs one request at a time.
// A slot is a file created exclusively in <state>/slots; a slot whose owner process has exited is free again.
const LOCAL_CONCURRENT = Math.max(1, Number(process.env.OPENCODE_LOCAL_CONCURRENT || 2));
const SLOT_DIR = join(STATE_DIR, "slots");
mkdirSync(SLOT_DIR, { recursive: true });
const held = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slotOwner(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).pid;
  } catch {
    return null; // being written, or just released
  }
}
function tryTake(pool, size, jobId) {
  for (let i = 0; i < size; i++) {
    const path = join(SLOT_DIR, `${pool}.${i}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, JSON.stringify({ pid: process.pid, job: jobId }), { flag: "wx" });
        held.add(path);
        return path;
      } catch (e) {
        if (e.code !== "EEXIST") break;
        const owner = slotOwner(path);
        if (owner === null || alive(owner)) break;
        try {
          unlinkSync(path); // left behind by a server that exited
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
// slots of a pool currently held by a live server
function inUse(pool) {
  try {
    return readdirSync(SLOT_DIR).filter((f) => f.startsWith(`${pool}.`) && alive(slotOwner(join(SLOT_DIR, f)))).length;
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
      own = local ? tryTake(local, LOCAL_CONCURRENT, job.state.id) : null;
      if (!local || own) {
        all = tryTake("all", MAX_CONCURRENT, job.state.id);
        if (all) break;
        release(own);
        own = null;
      }
      const why = local && !own ? `waiting: ${LOCAL_CONCURRENT} job(s) already on this local model` : `waiting: ${MAX_CONCURRENT} jobs already running on this machine`;
      if (job.state.waiting !== why) {
        job.state.waiting = why;
        saveState(job.state);
      }
      await sleep(1000);
    }
    job.state.waiting = "";
    return await fn();
  } finally {
    release(all);
    release(own);
  }
}
process.on("exit", () => {
  for (const p of held) {
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
const EXCLUDE_RE = process.env.OPENCODE_MODEL_EXCLUDE ? new RegExp(process.env.OPENCODE_MODEL_EXCLUDE, "i") : null;
const CATALOG_FILE = join(STATE_DIR, `catalog-${createHash("sha1").update(process.cwd().toLowerCase()).digest("hex").slice(0, 10)}.json`);
const LOCAL_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|[^.]+$|.*\.local$)/i;

function ocApi(op) {
  return new Promise((resolve, reject) => {
    execFile(OPENCODE_EXE, ["api", op], { windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
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

async function fetchCatalog() {
  const [models, agents, def] = await Promise.all([ocApi("model.list"), ocApi("agent.list"), ocApi("model.default").catch(() => null)]);
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
    agents: agents
      .filter((a) => !a.hidden || a.id === READONLY_AGENT)
      .map((a) => ({ name: a.id, hidden: !!a.hidden, mode: a.mode, model: agentModel(a), description: (a.description || "").split(/(?<=\.)\s/)[0].slice(0, 90) })),
    defaultModel: def ? refOf(def) : null,
  };
}

function readCachedCatalog() {
  try {
    const c = JSON.parse(readFileSync(CATALOG_FILE, "utf8"));
    return Array.isArray(c.models) && Array.isArray(c.agents) ? c : null;
  } catch {
    return null;
  }
}

let catalog = readCachedCatalog();
let catalogError = "";
let refreshing = null;
let clientReady = false;

// Refreshes the catalog; when it changed after Claude already listed the tools, tells it to list them again.
function refreshCatalog() {
  refreshing ??= fetchCatalog()
    .then((fresh) => {
      catalogError = "";
      const same = catalog && JSON.stringify({ ...catalog, at: 0 }) === JSON.stringify({ ...fresh, at: 0 });
      catalog = fresh;
      try {
        writeFileSync(CATALOG_FILE, JSON.stringify(fresh));
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

const shownModels = () => {
  const list = (catalog?.models || []).filter((m) => (INCLUDE_FREE || !m.free) && !(EXCLUDE_RE && EXCLUDE_RE.test(m.ref)));
  return KEEP_OLD ? list : latestOnly(list);
};
const findModel = (ref) => catalog?.models.find((m) => m.ref.toLowerCase() === String(ref).toLowerCase());

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

function catalogText() {
  const models = shownModels();
  if (!models.length) return catalogError ? ` (Model list unavailable: ${catalogError}; pass \`model\` as provider/id anyway.)` : "";
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
  const agents = (catalog?.agents || []).filter((a) => !a.hidden).map((a) => `${a.name} (${a.mode}, ${a.model})${a.description ? `: ${a.description}` : ""}`);
  return (
    "\n\nModels for `model` (provider/id; {,-fast} = id and id-fast); `effort` must be one of the model's levels in brackets:\n" +
    lines.join("\n") +
    (agents.length ? `\n\nAgents for \`agent\`:\n${agents.join("\n")}` : "")
  );
}

// The model a job runs on, for checking `effort`: the explicit `model`, else the agent's own model.
function resolveModel(args) {
  if (args.model) return String(args.model).replace(/#.*$/, "");
  const name = args.agent || (args.allow_edits ? DEFAULT_AGENT : READONLY_AGENT);
  const a = catalog?.agents.find((x) => x.name === name);
  if (a) return a.model.replace(/#.*$|\s.*$/, "");
  return name === DEFAULT_AGENT || name === READONLY_AGENT ? MODEL : catalog?.defaultModel || MODEL;
}

// Checks `model`, `effort` and `agent` against the catalog (refreshed once on a miss); returns an error text or "".
async function validate(args) {
  if (args.model && String(args.model).includes("#") && !args.effort) {
    const [m, e] = String(args.model).split("#");
    args.model = m;
    args.effort = e;
  }
  if (!catalog && refreshing) await Promise.race([refreshing, new Promise((r) => setTimeout(r, 10000))]);
  if (!catalog) return ""; // no catalog: let OpenCode judge
  const check = () => {
    if (args.agent && !catalog.agents.some((a) => a.name === args.agent)) return `unknown agent "${args.agent}". Agents: ${catalog.agents.filter((a) => !a.hidden).map((a) => a.name).join(", ")}`;
    const ref = resolveModel(args);
    const m = findModel(ref);
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
  if (err && Date.now() - catalog.at > 10000) {
    await refreshCatalog();
    err = check();
  }
  return err;
}

const buildTool = () => ({
  name: "opencode_run",
  description:
    "Start a task on an OpenCode agent (default DeepSeek Flash; any model below via `model`). Returns AT ONCE with a job id; get the answer (plus its session id) with `opencode_result`. To run several, start them all, then wait for them together by passing every id as `jobs`. " +
    "A new session starts with NO context: put everything it needs in `prompt` (paths, goal, constraints, expected output format). " +
    "Pass `session` to continue an earlier conversation (fix rounds, follow-ups) without resending context. " +
    `At most ${MAX_CONCURRENT} jobs run at once on this machine (all sessions together) and ${LOCAL_CONCURRENT} per local model; extra jobs queue. Without \`allow_edits\` the agent cannot edit files (enforced by OpenCode permissions), whatever the model. ` +
    `A job is stopped after \`timeout_seconds\` (default ${TIMEOUT_MS / 1000}) or after \`idle_seconds\` without any output (default ${IDLE_MS / 1000}).` +
    catalogText(),
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
        description: `provider/id from the list below. Default: the agent's own model (${MODEL}#high for ${DEFAULT_AGENT}). Runs with the chosen agent's tools and permissions.`,
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
        description: `Stop the job when OpenCode prints nothing for this long. Default ${IDLE_MS / 1000}, at most the wall-clock limit.`,
      },
      agent: { type: "string", description: `OpenCode agent (list below) for a new session. Default ${DEFAULT_AGENT}, or ${READONLY_AGENT} without allow_edits.` },
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

const RESULT_TOOL = {
  name: "opencode_result",
  description:
    "Get the answers of jobs started with `opencode_run`. Pass one `job`, or several as `jobs`: it waits until ANY of them finishes (up to `wait_seconds`, default 50, max 55), " +
    "then returns each finished one's reply and session id, and a one-line progress report for each still running. " +
    "With `jobs`, a reply is returned once: repeat the same call until it says all are done; finished ones then show as one line. " +
    "A timed-out, cancelled or failed job returns a short summary (session, files touched, last text, log path), never the raw log.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "A job id opencode_run returned (e.g. job_k3x_2)." },
      jobs: { type: "array", items: { type: "string" }, description: "Several job ids: wait for whichever finishes first." },
      wait_seconds: { type: "number", description: "Wait up to this many seconds for a job to finish. Default 50." },
    },
  },
};

const CANCEL_TOOL = {
  name: "opencode_cancel",
  description:
    "Stop a running job and its whole process tree (builds and tests it started included). Edits it already made stay on disk; its session can be continued later.",
  inputSchema: {
    type: "object",
    properties: { job: { type: "string", description: "The job id to stop." } },
    required: ["job"],
  },
};

// ---- job state, shared through STATE_DIR ----

// Ids carry this instance's pid so two servers never hand out the same one.
const PREFIX = `job_${process.pid.toString(36)}`;
let nextJob = 1;
const jobs = new Map(); // this instance's jobs: id -> { state, promise, child, cancel }
const delivered = new Set(); // jobs whose reply a multi-job result call already returned

const statePath = (id) => join(STATE_DIR, `${id}.json`);
const logPath = (id) => join(STATE_DIR, `${id}.jsonl`);
const validId = (id) => typeof id === "string" && /^job_[a-z0-9]+_\d+$/.test(id);

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
  const state = {
    id,
    owner: process.pid,
    status: "queued",
    started: Date.now(),
    directory: args.directory || process.cwd(),
    session: args.session || "",
    timeoutMs: wall,
    idleMs: idle,
    lastTool: "",
    files: [],
    reply: "",
    ok: false,
    log: logPath(id),
  };
  const job = { state, child: null, cancelled: false };
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
  const tool = part.tool || (ev.type === "tool_use" ? ev.tool : "");
  if (tool) {
    s.lastTool = tool;
    const input = part.state?.input || part.input || {};
    const file = input.filePath || input.file_path || input.path;
    if (typeof file === "string" && /^(edit|write|patch|multiedit|apply_patch)$/i.test(tool) && !s.files.includes(file)) s.files.push(file);
  }
}

function summary(job, acc, status, reason) {
  const s = job.state;
  const elapsed = Math.round((Date.now() - s.started) / 1000);
  const last = clean(acc.texts.join("\n\n"));
  const lines = [
    `status: ${status} (${reason})`,
    `elapsed: ${elapsed}s`,
    `session: ${s.session || "(none)"}${s.session ? " (pass as `session` to continue or ask what it got done)" : ""}`,
    `last tool: ${s.lastTool || "(none)"}`,
    `files edited: ${s.files.length ? s.files.join(", ") : "(none reported)"}`,
  ];
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
  return s;
}

function runAgent(job, { prompt, directory, files = [], allow_edits = false, agent, session, effort, model }) {
  return new Promise((resolve) => {
    const s = job.state;
    if (isAbsolute(OPENCODE_EXE) && !existsSync(OPENCODE_EXE)) {
      return resolve(finish(job, "failed", `opencode executable not found: ${OPENCODE_EXE} (set OPENCODE_EXE)`));
    }
    const chosen = agent || (allow_edits ? DEFAULT_AGENT : READONLY_AGENT);
    const args = ["run", "--format", "json", "--archived", "--agent", chosen];
    if (session) args.push("--session", session);
    else args.push("--title", "claude-delegate");
    // effort alone applies to the agent's own model, not always to OPENCODE_MODEL
    const ref = model || (effort ? resolveModel({ agent, allow_edits }) : "");
    if (ref) args.push("--model", effort ? `${ref}#${effort}` : ref);
    if (allow_edits) args.push("--auto");
    for (const f of files) args.push("--file", f);

    const acc = { texts: [], errors: [], cost: 0, reasoning: 0, stderr: "" };
    const log = createWriteStream(s.log);
    let child;
    try {
      child = spawn(OPENCODE_EXE, args, {
        cwd: directory && existsSync(directory) ? directory : process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
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

    let ended = false;
    const end = (status, reason) => {
      if (ended) return;
      ended = true;
      clearTimeout(wallTimer);
      clearInterval(idleTimer);
      if (status !== "done") killPidTree(child.pid);
      log.end();
      resolve(finish(job, status, summary(job, acc, status, reason)));
    };
    job.cancel = () => end("cancelled", "stopped by opencode_cancel");

    const wallTimer = setTimeout(() => end("timeout", `wall-clock limit ${s.timeoutMs / 1000}s`), s.timeoutMs);
    // once a second: write changed progress for other instances, and check the idle limit
    let dirty = false;
    const idleTimer = setInterval(() => {
      if (dirty) {
        dirty = false;
        saveState(s);
      }
      if (Date.now() - s.lastEvent > s.idleMs) end("timeout", `no output for ${s.idleMs / 1000}s`);
    }, 1000);

    let pending = "";
    child.stdout.on("data", (d) => {
      log.write(d);
      s.lastEvent = Date.now();
      pending += d;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          absorb(job, acc, JSON.parse(line));
        } catch {
          // a non-JSON line: kept in the log only
        }
      }
      dirty = true;
    });
    child.stderr.on("data", (d) => {
      acc.stderr = (acc.stderr + d).slice(-4000);
      s.lastEvent = Date.now();
    });
    child.on("error", (e) => {
      acc.errors.push(`spawn failed: ${e.message}`);
      end("failed", "could not start opencode");
    });
    child.on("close", (code) => {
      if (ended) return;
      if (pending.trim().startsWith("{")) {
        try {
          absorb(job, acc, JSON.parse(pending));
        } catch {
          // ignore
        }
      }
      const text = clean(acc.texts.join("\n\n"));
      const ok = code === 0 && !!text && !acc.errors.length;
      if (!ok) return end("failed", code === 0 ? (text ? "the agent reported errors" : "empty reply") : `opencode exited ${code}`);
      ended = true;
      clearTimeout(wallTimer);
      clearInterval(idleTimer);
      log.end();
      const footer = s.session
        ? `\n\n---\nsession: ${s.session} (pass as \`session\` to continue this conversation) · cost $${acc.cost.toFixed(4)} · reasoning ${acc.reasoning} tok`
        : "";
      // the cap keeps the footer: cut the body, then append it
      resolve(finish(job, "done", cap(text, MAX_REPLY - footer.length, s.log) + footer, true));
    });
    child.stdin.end(
      allow_edits ? prompt : `READ-ONLY TASK: do not create, modify or delete any files and do not run state-changing commands.\n\n${prompt}`,
    );
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
  const files = s.files?.length ? `, ${s.files.length} file(s) edited` : "";
  const retry = s.retry ? `, provider retrying (${s.retry})` : "";
  return `${s.id} still ${since}${quiet}${tool}${files}${retry} (limit ${s.timeoutMs / 1000}s, idle ${s.idleMs / 1000}s)`;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "opencode-agent", version: "2.0.0" },
      },
    });
  }
  if (method === "notifications/initialized") {
    clientReady = true;
    return;
  }
  if (method === "tools/list") {
    // first run in this folder: wait (bounded) for the live list; otherwise the cache answers at once
    if (!catalog && refreshing) await Promise.race([refreshing, new Promise((r) => setTimeout(r, 10000))]);
    return send({ jsonrpc: "2.0", id, result: { tools: [buildTool(), RESULT_TOOL, CANCEL_TOOL] } });
  }
  if (method === "tools/call") {
    const reply = (text, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
    const a = params?.arguments || {};
    if (params?.name === "opencode_run") {
      if (!a.prompt) return reply("prompt is required", true);
      const bad = await validate(a);
      if (bad) return reply(bad, true);
      const waiting = inUse("all") >= MAX_CONCURRENT ? ` (queued: ${MAX_CONCURRENT} jobs already running on this machine)` : "";
      const job = startJob(a);
      const s = jobs.get(job).state;
      const on = a.model || a.effort ? ` on ${a.model || resolveModel(a)}${a.effort ? `#${a.effort}` : ""}` : "";
      return reply(`started ${job}${on}${waiting}, limit ${s.timeoutMs / 1000}s, idle ${s.idleMs / 1000}s. Get the answer with opencode_result { job: "${job}" }, or several ids at once as \`jobs\`.`);
    }
    if (params?.name === RESULT_TOOL.name) {
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
      const until = Date.now() + Math.max(0, Math.min(55, Number(a.wait_seconds ?? 50) || 0)) * 1000;
      while (!ready() && anyPending() && Date.now() < until) {
        // only jobs still pending: a settled promise would end the race at once, every time
        const mine = ids.filter((jid) => found.get(jid) && pending(found.get(jid).state)).map((jid) => found.get(jid).job?.promise).filter(Boolean);
        await Promise.race([...mine, sleep(Math.min(2000, Math.max(0, until - Date.now())))]);
        found = look();
      }
      if (ids.length === 1) {
        const s = found.get(ids[0]).state;
        if (pending(s)) return reply(progress(s));
        return reply(s.reply || `${ids[0]} ${s.status}`, !s.ok);
      }
      const parts = [];
      const lines = [];
      for (const jid of ids) {
        const f = found.get(jid);
        if (!f) lines.push(`${jid}: unknown`);
        else if (pending(f.state)) lines.push(progress(f.state));
        else if (!fresh(jid)) lines.push(`${jid}: ${f.state.status}, reply already returned`);
        else {
          delivered.add(jid);
          parts.push(`## ${jid} · ${f.state.status}\n${f.state.reply || f.state.status}`);
        }
      }
      const left = ids.filter((jid) => found.get(jid) && pending(found.get(jid).state)).length;
      lines.push(left ? `${left} still running: repeat this call to wait for the next.` : "All done.");
      return reply([...parts, lines.join("\n")].join("\n\n"));
    }
    if (params?.name === CANCEL_TOOL.name) {
      const found = current(a.job);
      if (!found) return reply(`unknown job ${a.job}`, true);
      const s = found.state;
      if (found.job) {
        if (s.status === "queued") {
          found.job.cancelled = true;
          finish(found.job, "cancelled", "cancelled before it started");
          return reply(`${a.job} cancelled before it started`);
        }
        if (s.status === "running") {
          found.job.cancel?.();
          return reply(`${a.job} stopped (process tree ${s.childPid} killed). Edits it made stay on disk${s.session ? `; session ${s.session}` : ""}.`);
        }
        return reply(`${a.job} already ${s.status}`);
      }
      if (s.status === "running" || s.status === "lost") {
        // owned by another instance (or orphaned): stop the process tree; the owner records the end
        if (alive(s.childPid)) killPidTree(s.childPid);
        return reply(`${a.job} stopped (process tree ${s.childPid} killed)${s.session ? `; session ${s.session}` : ""}.`);
      }
      if (s.status === "queued") return reply(`${a.job} is queued in another server instance; cancel it from that session`, true);
      return reply(`${a.job} already ${s.status}`);
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

// Stop this instance's running jobs when the session closes, so no build is left behind.
function shutdown() {
  for (const j of jobs.values()) if (j.state.status === "running") j.cancel?.();
  setTimeout(() => process.exit(0), 300);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);

// read the live catalog now; with a cached one, tools/list doesn't wait for it
refreshCatalog();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`bad message: ${e.message}\n`);
  }
});
