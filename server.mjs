#!/usr/bin/env node
// Minimal stdio MCP server: delegates a task to an OpenCode agent (default deepseek-flash)
// by running `opencode run --agent <agent>`. No dependencies.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
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
const TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 15 * 60 * 1000);
const MAX_CONCURRENT = Math.max(1, Number(process.env.OPENCODE_MAX_CONCURRENT || 3));

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
    `At most ${MAX_CONCURRENT} calls run at once; extra calls wait. Without \`allow_edits\` the agent cannot edit files (enforced by OpenCode permissions).`,
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
      agent: { type: "string", description: `OpenCode agent name for a new session. Default ${DEFAULT_AGENT}.` },
    },
    required: ["prompt"],
  },
};

const RESULT_TOOL = {
  name: "deepseek_flash_result",
  description:
    "Get the answer of a job started with `deepseek_flash`. Returns the full reply and session id when done, or 'still running'. " +
    "`wait_seconds` (default 50, max 55) waits up to that long for it to finish before answering.",
  inputSchema: {
    type: "object",
    properties: {
      job: { type: "string", description: "The job id deepseek_flash returned (e.g. job_3)." },
      wait_seconds: { type: "number", description: "Wait up to this many seconds for the job to finish. Default 50." },
    },
    required: ["job"],
  },
};

// Jobs live in memory: id -> { started, done, result, promise }. Finished ones are kept 6 hours.
const jobs = new Map();
let nextJob = 1;
const KEEP_MS = 6 * 60 * 60 * 1000;
function startJob(args) {
  const id = `job_${nextJob++}`;
  const job = { started: Date.now(), done: false, result: null };
  job.promise = limited(() => runAgent(args)).then((r) => {
    job.done = true;
    job.result = r;
    job.finished = Date.now();
    return r;
  });
  jobs.set(id, job);
  for (const [k, j] of jobs) if (j.done && Date.now() - j.finished > KEEP_MS) jobs.delete(k);
  return id;
}

// child.kill() leaves opencode's own children running on Windows: kill the whole tree.
function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else child.kill();
}

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

function parseEvents(out) {
  let sessionID = "";
  let cost = 0;
  let reasoning = 0;
  const texts = [];
  const errors = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.sessionID) sessionID = ev.sessionID;
    if (ev.type === "text" && ev.part?.text) texts.push(ev.part.text);
    if (ev.type === "step_finish" && typeof ev.part?.cost === "number") cost += ev.part.cost;
    if (ev.type === "step_finish") reasoning += ev.part?.tokens?.reasoning || 0;
    if (ev.type === "error") errors.push(JSON.stringify(ev.error ?? ev.part ?? ev));
  }
  return { sessionID, cost, reasoning, text: texts.join("\n\n").replace(/§\d+§ ?/g, "").trim(), errors };
}

function runAgent({ prompt, directory, files = [], allow_edits = false, agent, session, effort }) {
  return new Promise((resolve) => {
    if (isAbsolute(OPENCODE_EXE) && !existsSync(OPENCODE_EXE)) {
      return resolve({ ok: false, text: `opencode executable not found: ${OPENCODE_EXE} (set OPENCODE_EXE)` });
    }
    const chosen = agent || (allow_edits ? DEFAULT_AGENT : READONLY_AGENT);
    const args = ["run", "--format", "json", "--archived", "--agent", chosen];
    if (session) args.push("--session", session);
    else args.push("--title", "claude-delegate");
    if (effort && effort !== "high") args.push("--model", `${MODEL}#${effort}`);
    if (allow_edits) args.push("--auto");
    for (const f of files) args.push("--file", f);
    const child = spawn(OPENCODE_EXE, args, {
      cwd: directory && existsSync(directory) ? directory : process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ ok: false, text: `timed out after ${TIMEOUT_MS / 1000}s\n${stripAnsi(out)}` });
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `spawn failed: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const r = parseEvents(out);
      let text = r.text || "(empty reply)";
      if (r.errors.length) text += `\n\nerrors: ${r.errors.join("\n")}`;
      if (code !== 0) text = `opencode exited ${code}\n${text}\n${stripAnsi(err).trim()}`.trim();
      const footer = r.sessionID
        ? `\n\n---\nsession: ${r.sessionID} (pass as \`session\` to continue this conversation) · cost $${r.cost.toFixed(4)} · reasoning ${r.reasoning} tok`
        : "";
      resolve({ ok: code === 0 && !!r.text && !r.errors.length, text: text + footer });
    });
    child.stdin.end(
      allow_edits ? prompt : `READ-ONLY TASK: do not create, modify or delete any files and do not run state-changing commands.\n\n${prompt}`,
    );
  });
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
        serverInfo: { name: "opencode-agent", version: "1.1.0" },
      },
    });
  }
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [TOOL, RESULT_TOOL] } });
  if (method === "tools/call") {
    const reply = (text, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
    if (params?.name === TOOL.name) {
      const job = startJob(params.arguments || {});
      const waiting = running >= MAX_CONCURRENT ? ` (queued: ${MAX_CONCURRENT} jobs already running)` : "";
      return reply(`started ${job}${waiting}. Get the answer with deepseek_flash_result { job: "${job}" }.`);
    }
    if (params?.name === RESULT_TOOL.name) {
      const { job: jid, wait_seconds = 50 } = params.arguments || {};
      const job = jobs.get(jid);
      if (!job) return reply(`unknown job ${jid} (the server may have restarted; any edits it made are still on disk)`, true);
      if (!job.done) {
        const ms = Math.max(0, Math.min(55, Number(wait_seconds) || 0)) * 1000;
        await Promise.race([job.promise, new Promise((r) => setTimeout(r, ms))]);
      }
      if (!job.done) return reply(`${jid} still running (${Math.round((Date.now() - job.started) / 1000)}s so far)`);
      return reply(job.result.text, !job.result.ok);
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch (e) {
    process.stderr.write(`bad message: ${e.message}\n`);
  }
});
