#!/usr/bin/env node
// Minimal stdio MCP server: delegates a task to an OpenCode agent (default deepseek-flash)
// by running `opencode run --agent <agent>`. No dependencies.
//
// Jobs are shared between server instances through a state folder (OPENCODE_STATE_DIR, default
// <tmp>/opencode-agent): every job writes <id>.json (status, session, progress, the capped reply) and
// <id>.jsonl (OpenCode's raw event stream). Any instance can answer or cancel any job, and a reply
// never carries the raw log: a timed-out or failed job returns a short summary plus the log's path.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
const MAX_CONCURRENT = Math.max(1, Number(process.env.OPENCODE_MAX_CONCURRENT || 3));
const MAX_REPLY = Number(process.env.OPENCODE_MAX_REPLY_CHARS || 20000);
const LAST_TEXT = 2000;
const KEEP_MS = 24 * 60 * MIN;
const STATE_DIR = process.env.OPENCODE_STATE_DIR || join(tmpdir(), "opencode-agent");
mkdirSync(STATE_DIR, { recursive: true });

let running = 0;
const queue = [];
async function limited(fn) {
  if (running >= MAX_CONCURRENT) await new Promise((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

const TOOL = {
  name: "deepseek_flash",
  description:
    "Start a task on the DeepSeek Flash agent (run through OpenCode). Returns AT ONCE with a job id; get the answer (plus its session id) with `deepseek_flash_result`. " +
    "A new session starts with NO context: put everything it needs in `prompt` (paths, goal, constraints, expected output format). " +
    "Pass `session` to continue an earlier conversation (fix rounds, follow-ups) without resending context. " +
    `At most ${MAX_CONCURRENT} calls run at once per server; extra calls wait. Without \`allow_edits\` the agent cannot edit files (enforced by OpenCode permissions). ` +
    `A job is stopped after \`timeout_seconds\` (default ${TIMEOUT_MS / 1000}) or after \`idle_seconds\` without any output (default ${IDLE_MS / 1000}).`,
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
      effort: {
        type: "string",
        enum: ["none", "low", "high", "max"],
        description:
          "Reasoning effort. Default high (implementation, review, debugging). low: summaries, lookups, mechanical edits. max: hard bugs, tricky algorithms, a second attempt after a failed fix round. none: trivial formatting/extraction.",
      },
      timeout_seconds: {
        type: "number",
        description: `Wall-clock limit for this job. Default ${TIMEOUT_MS / 1000}, max ${MAX_TIMEOUT_MS / 1000}. Raise it for jobs that run long builds or test suites.`,
      },
      idle_seconds: {
        type: "number",
        description: `Stop the job when OpenCode prints nothing for this long. Default ${IDLE_MS / 1000}, at most the wall-clock limit.`,
      },
      agent: { type: "string", description: `OpenCode agent name for a new session. Default ${DEFAULT_AGENT}.` },
    },
    required: ["prompt"],
  },
};

const RESULT_TOOL = {
  name: "deepseek_flash_result",
  description:
    "Get the answer of a job started with `deepseek_flash`. Returns the reply and session id when done, or a one-line progress report while running. " +
    "A timed-out, cancelled or failed job returns a short summary (session, files touched, last text, log path), never the raw log. " +
    "`wait_seconds` (default 50, max 55) waits up to that long for it to finish before answering.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The job id deepseek_flash returned (e.g. job_k3x_2)." },
      wait_seconds: { type: "number", description: "Wait up to this many seconds for the job to finish. Default 50." },
    },
    required: ["job"],
  },
};

const CANCEL_TOOL = {
  name: "deepseek_flash_cancel",
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
  job.promise = limited(() => (job.cancelled ? finish(job, "cancelled", "cancelled before it started") : runAgent(job, args)));
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

function runAgent(job, { prompt, directory, files = [], allow_edits = false, agent, session, effort }) {
  return new Promise((resolve) => {
    const s = job.state;
    if (isAbsolute(OPENCODE_EXE) && !existsSync(OPENCODE_EXE)) {
      return resolve(finish(job, "failed", `opencode executable not found: ${OPENCODE_EXE} (set OPENCODE_EXE)`));
    }
    const chosen = agent || (allow_edits ? DEFAULT_AGENT : READONLY_AGENT);
    const args = ["run", "--format", "json", "--archived", "--agent", chosen];
    if (session) args.push("--session", session);
    else args.push("--title", "claude-delegate");
    if (effort && effort !== "high") args.push("--model", `${MODEL}#${effort}`);
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
    job.cancel = () => end("cancelled", "stopped by deepseek_flash_cancel");

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
  const since = s.status === "queued" ? "queued" : `running ${Math.round((now - (s.running || s.started)) / 1000)}s`;
  const quiet = s.lastEvent ? `, last output ${Math.round((now - s.lastEvent) / 1000)}s ago` : "";
  const tool = s.lastTool ? `, last tool ${s.lastTool}` : "";
  const files = s.files?.length ? `, ${s.files.length} file(s) edited` : "";
  return `${s.id} still ${since}${quiet}${tool}${files} (limit ${s.timeoutMs / 1000}s, idle ${s.idleMs / 1000}s)`;
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
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-agent", version: "1.2.0" },
      },
    });
  }
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [TOOL, RESULT_TOOL, CANCEL_TOOL] } });
  if (method === "tools/call") {
    const reply = (text, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
    const a = params?.arguments || {};
    if (params?.name === TOOL.name) {
      if (!a.prompt) return reply("prompt is required", true);
      const waiting = running >= MAX_CONCURRENT ? ` (queued: ${MAX_CONCURRENT} jobs already running)` : "";
      const job = startJob(a);
      const s = jobs.get(job).state;
      return reply(`started ${job}${waiting}, limit ${s.timeoutMs / 1000}s, idle ${s.idleMs / 1000}s. Get the answer with deepseek_flash_result { job: "${job}" }.`);
    }
    if (params?.name === RESULT_TOOL.name) {
      const { job: jid, wait_seconds = 50 } = a;
      let found = current(jid);
      if (!found) return reply(`unknown job ${jid} (no state in ${STATE_DIR}; any edits it made are still on disk)`, true);
      const ms = Math.max(0, Math.min(55, Number(wait_seconds) || 0)) * 1000;
      const pending = (s) => s.status === "running" || s.status === "queued";
      if (pending(found.state) && ms > 0) {
        if (found.job) await Promise.race([found.job.promise, new Promise((r) => setTimeout(r, ms))]);
        else {
          // another instance's job: watch its state file
          const until = Date.now() + ms;
          while (Date.now() < until && pending(found.state)) {
            await new Promise((r) => setTimeout(r, 2000));
            found = current(jid) || found;
          }
        }
        found = current(jid) || found;
      }
      const s = found.state;
      if (pending(s)) return reply(progress(s));
      return reply(s.reply || `${jid} ${s.status}`, !s.ok);
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

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`bad message: ${e.message}\n`);
  }
});
