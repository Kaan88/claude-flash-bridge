// Tests for the bridge. Run: node test/test.mjs
// Part 1 checks the rules that need no process (queue places, idle limits, the result line).
// Part 2 drives the real server over MCP stdio against test/fake-opencode.mjs, so no model is called.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { birth } from "../process-identity.mjs";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverFile = join(here, "..", "server.mjs");
const root = mkdtempSync(join(tmpdir(), "bridge-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
async function test(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.stack || e).split("\n").join("\n     ")}`);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
async function until(what, fn, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------- part 1: the rules ----------

process.env.OPENCODE_BRIDGE_NO_MAIN = "1";
process.env.OPENCODE_STATE_DIR = join(root, "unit-state");
process.env.OPENCODE_CLAUDE = "0";
process.env.OPENCODE_CONFIG_DIR = join(root, "no-oc-config");
process.env.BRIDGE_JOB_HOME = join(root, "workers");
delete process.env.OPENCODE_DB;
delete process.env.BRIDGE_JOB_CONFIG_DIR;
const bridge = await import(pathToFileURL(serverFile).href);

await test("a queue place is free when its heartbeat stopped, its server died or its job ended", () => {
  const live = { ageMs: 1000, ownerAlive: true, jobStatus: "running" };
  assert.equal(bridge.slotIsStale(live), false);
  assert.equal(bridge.slotIsStale({ ...live, jobStatus: "queued" }), false);
  assert.equal(bridge.slotIsStale({ ...live, jobStatus: "" }), false, "a job with no state file yet keeps its place");
  assert.equal(bridge.slotIsStale({ ...live, ageMs: 31000 }), true, "no heartbeat for 30 s");
  assert.equal(bridge.slotIsStale({ ...live, ownerAlive: false }), true);
  for (const status of ["done", "failed", "timeout", "cancelled", "lost"]) assert.equal(bridge.slotIsStale({ ...live, jobStatus: status }), true, `${status} never holds a place`);
});

await test("the idle limit is the longer one only while a tool call is in flight", () => {
  const limits = { idleMs: 1200e3, toolIdleMs: 2700e3 };
  const flight = { label: 'shell "cargo build"', since: 0 };
  assert.deepEqual(bridge.idleVerdict({ ...limits, quietMs: 1199e3, flight: null }), { limitMs: 1200e3, expired: false });
  assert.deepEqual(bridge.idleVerdict({ ...limits, quietMs: 1201e3, flight: null }), { limitMs: 1200e3, expired: true });
  assert.deepEqual(bridge.idleVerdict({ ...limits, quietMs: 1201e3, flight }), { limitMs: 2700e3, expired: false });
  assert.deepEqual(bridge.idleVerdict({ ...limits, quietMs: 2701e3, flight }), { limitMs: 2700e3, expired: true });
  assert.equal(bridge.idleVerdict({ idleMs: 3000e3, toolIdleMs: 2700e3, quietMs: 2800e3, flight }).expired, false, "never shorter than the plain limit");
});

await test("the timeout reason names the tool in flight and for how long", () => {
  assert.equal(bridge.idleReason({ limitMs: 1200e3, flight: null }), "no output for 1200s, no tool call in flight");
  assert.equal(
    bridge.idleReason({ limitMs: 2700e3, flight: { label: 'shell "cargo build"', since: 1000 }, now: 2711e3 }),
    'no output for 2700s while tool shell "cargo build" was in flight for 2710s',
  );
  assert.match(bridge.idleReason({ limitMs: 2700e3, flight: { unknown: true, label: "x", since: 0 } }), /open step \(OpenCode could not say which tool/);
});

await test("a tool is labelled with its name and the first 80 characters of its command", () => {
  assert.equal(bridge.toolLabel("shell", { command: "cargo   build\n --release" }), 'shell "cargo build --release"');
  assert.equal(bridge.toolLabel("shell", { command: "x".repeat(200) }), `shell "${"x".repeat(80)}"`);
  assert.equal(bridge.toolLabel("read", { path: "a/b.rs" }), 'read "a/b.rs"');
  assert.equal(bridge.toolLabel("ctx_reduce", {}), "ctx_reduce");
  assert.equal(bridge.toolLabel("task", undefined), "task");
});

await test("a running tool call is found in a session's newest messages", () => {
  const tool = (status, name = "shell") => ({ type: "tool", id: "t", name, state: { status, input: { command: "cargo test" } }, time: { created: 5e12, ran: 6e12 } });
  assert.equal(bridge.findRunningTool([{ type: "assistant", content: [{ type: "text", text: "hi" }, tool("completed")] }]), null);
  assert.equal(bridge.findRunningTool([{ type: "assistant", content: [tool("streaming")] }]), null, "input still being written is the model's turn");
  assert.deepEqual(bridge.findRunningTool([{ type: "assistant", content: [tool("completed", "read"), tool("running")] }]), { label: 'shell "cargo test"', since: 6e12 });
  assert.equal(bridge.findRunningTool([{ content: [{ ...tool("running"), time: {} }] }], 42).since, 42);
  assert.equal(bridge.findRunningTool(null), null);
  assert.equal(bridge.findRunningTool("nonsense"), null);
});

await test("the result line gives tool calls, total time, peak idle and the last tool", () => {
  assert.equal(bridge.statsLine({ tools: 14, totalMs: 512400, peakIdleMs: 203000, lastTool: "shell" }), "14 tool calls · total 512s · peak idle 203s · last tool shell");
  assert.equal(bridge.statsLine({ tools: 1, totalMs: 900, peakIdleMs: 0, lastTool: "" }), "1 tool call · total 1s · peak idle 0s · last tool (none)");
});

await test("the resume note says whether the session can be continued", () => {
  assert.match(bridge.resumeNote({ session: "ses_1", interrupted: true, busy: false }), /idle \(its run was interrupted\); it can be continued right away/);
  assert.match(bridge.resumeNote({ session: "ses_1", interrupted: false, busy: true }), /STILL BUSY.*opencode_list.*opencode_cancel/);
  assert.match(bridge.resumeNote({ session: "ses_1", interrupted: null, busy: null }), /could not be asked.*wait a minute/);
  assert.match(bridge.resumeNote({ claude: true, session: "0b7e0000-0000-4000-8000-000000000000" }), /process tree was killed.*right away/);
  assert.match(bridge.resumeNote({ session: "" }), /no session was created/);
});

await test("a queued job's line gives its place among those waiting for the same pool", () => {
  const q = (id, started, waitPool) => ({ id, status: "queued", owner: process.pid, model: "fake/model", started, waitPool });
  const queued = [q("job_a_1", 1000, "all"), q("job_b_1", 2000, "local-x"), q("job_a_2", 3000, "all")];
  assert.match(bridge.listLine(queued[2], queued, 13000), /^job_a_2 queued · fake\/model · owner pid \d+ alive · started \d\d:\d\d:\d\d · queued 10s, place 2\/2 waiting for the machine$/);
  assert.match(bridge.listLine({ ...queued[0], owner: 0 }, queued, 13000), /GONE/);
  const run = { id: "job_a_3", status: "running", owner: process.pid, model: "m", started: 0, running: 1000, lastEvent: 9000, lastTool: "shell", session: "ses_1", inFlight: { label: 'shell "x"', since: 4000 } };
  assert.match(bridge.listLine(run, [], 13000), /running 12s · last tool shell · last output 4s ago · in flight: shell "x" for 9s · session ses_1$/);
});

// ---------- part 2: the server over MCP stdio, against the fake opencode ----------

const fakeDir = join(root, "fake");
const binDir = join(root, "bin");
mkdirSync(fakeDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
const fakeExe = join(binDir, process.platform === "win32" ? "opencode.exe" : "opencode");
try {
  linkSync(process.execPath, fakeExe);
} catch {
  copyFileSync(process.execPath, fakeExe); // another volume
}

class Server {
  constructor(name, env = {}) {
    this.next = 1;
    this.waiting = new Map();
    this.notes = []; // notifications from the server
    this.env = {
        ...process.env,
        PATH: binDir + delimiter + process.env.PATH,
        OPENCODE_EXE: fakeExe,
        NODE_OPTIONS: `--import ${pathToFileURL(join(here, "fake-opencode.mjs")).href}`,
        FAKE_DIR: fakeDir,
        FAKE_REAL_NODE: process.execPath,
        OPENCODE_STATE_DIR: join(root, name),
        OPENCODE_BRIDGE_NO_MAIN: "",
        OPENCODE_TASKS: "",
        OPENCODE_CLAUDE: "0",
        OPENCODE_PROBE_MS: "500",
        OPENCODE_SERVICE_FILE: join(root, "no-service.json"),
        OPENCODE_RESUME_WAIT_MS: "200",
        OPENCODE_ALLOW_ANY: "1",
        BRIDGE_WORKERS_FILE: join(root, "no-workers.json"),
        CLAUDE_WORKERS_FILE: join(root, "no-claude-workers.json"),
        OPENCODE_CONFIG_DIR: join(root, "no-oc-config"), // the user's real OpenCode config stays out of the tests
        ...env,
    };
    this.child = spawn(process.execPath, [serverFile], { stdio: ["pipe", "pipe", "inherit"], env: this.env });
    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) {
        const m = JSON.parse(l);
        if (m.id !== undefined && this.waiting.has(m.id)) this.waiting.get(m.id)(m);
        else if (m.id === undefined) this.notes.push(m);
      }
    });
  }
  rpc(method, params) {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async start(client = "test") {
    const init = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return init.result;
  }
  async call(name, args = {}) {
    const r = (await this.rpc("tools/call", { name, arguments: args })).result;
    return { text: r.content[0].text, isError: !!r.isError };
  }
  async run(args) {
    const r = await this.call("opencode_run", args);
    assert.equal(r.isError, false, r.text);
    return /started (job_[a-z0-9]+_\d+(?:-[a-z0-9-]+)?)/.exec(r.text)[1];
  }
  // waits as a client must: opencode_result until the job is no longer running
  async result(job) {
    for (;;) {
      const r = await this.call("opencode_result", { job, wait_seconds: 20 });
      if (!/ still (running|queued)/.test(r.text)) return r;
    }
  }
  stop() {
    this.child.stdin.end();
  }
}
const fakeSession = (text) => /session:? (ses_fake\d+)/.exec(text)?.[1];
const toolPid = (ses) => JSON.parse(readFileSync(join(fakeDir, "active", ses), "utf8")).pid;
const apiLog = () => (existsSync(join(fakeDir, "api.log")) ? readFileSync(join(fakeDir, "api.log"), "utf8") : "");
const strays = [];

const one = new Server("state-one");
await test("initialize and tools/list: four tools, each description under Claude Code's 2048-character cut", async () => {
  const init = await one.start();
  assert.equal(init.serverInfo.name, "opencode-agent");
  const tools = (await one.rpc("tools/list", {})).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ["opencode_run", "opencode_result", "opencode_cancel", "opencode_list"]);
  for (const t of tools) {
    assert.ok(t.description.length < 2048, `${t.name}: ${t.description.length} characters`);
    console.log(`     ${t.name}: description ${t.description.length} characters`);
  }
  assert.ok(tools[0].inputSchema.properties.tool_idle_seconds);
  assert.match(tools[0].inputSchema.properties.model.description, /fake: \[low,high\] model/);
});

await test("a job runs, and its reply ends with session and one stats line", async () => {
  const job = await one.run({ prompt: "FAKE:quick" });
  const r = await one.result(job);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^PONG\n\n---\nsession: ses_fake\d+ .* · cost \$0\.0010 · reasoning 5 tok\nstats: 1 tool call · total \d+s · peak idle \d+s · last tool shell$/);
});

await test("a job whose connection OpenCode's service dropped goes on in the same session", async () => {
  const job = await one.run({ prompt: "FAKE:drop:1" });
  const r = await one.result(job);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^PONG\n\n---\nsession: ses_fake\d+ /);
  assert.match(r.text, /\nnote: OpenCode's service dropped this job's connection once; it went on in the same session each time$/);
});

await test("after two such drops the job is given up, with the error and the session", async () => {
  const job = await one.run({ prompt: "FAKE:drop:5" });
  const r = await one.result(job);
  assert.equal(r.isError, true);
  assert.match(r.text, /^status: failed \(opencode exited 1\)/);
  assert.match(r.text, /\nnote: OpenCode's service dropped this job's connection 2 times/);
  assert.match(r.text, /\nerrors: .*Transport: ECONNRESET/);
});

await test("the plain idle limit ends a silent job with no tool in flight", async () => {
  const job = await one.run({ prompt: "FAKE:hang:60000", idle_seconds: 3, tool_idle_seconds: 30 });
  const t = Date.now();
  const r = await one.result(job);
  assert.ok(Date.now() - t < 12000, "ended by the plain limit, not the tool limit");
  assert.equal(r.isError, true);
  assert.match(r.text, /^status: timeout \(no output for 3s, no tool call in flight\)\nstats: 0 tool calls · total \d+s · peak idle [3-6]s · last tool \(none\)\n/);
  assert.match(r.text, /\nresume: OpenCode reports the session idle/);
});

await test("a tool call in flight keeps a silent job alive past the plain idle limit", async () => {
  const [known, unknown] = [await one.run({ prompt: "FAKE:tool:7000", idle_seconds: 3, tool_idle_seconds: 30 }), await one.run({ prompt: "FAKE:unknown:7000", idle_seconds: 3, tool_idle_seconds: 30 })];
  const progress = await until("the tool to show as in flight", async () => {
    const p = await one.call("opencode_result", { job: known, wait_seconds: 0 });
    return /in flight: shell "cargo build/.test(p.text) && p.text;
  });
  assert.match(progress, /\(limit 3600s, idle 3s, 30s with a tool in flight\)/);
  assert.match((await one.call("opencode_list")).text, new RegExp(`${known} running · .* · in flight: shell "cargo build --release[^"]{0,60}" for \\d+s · session ses_fake`));
  for (const job of [known, unknown]) {
    const r = await one.result(job);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^built\n/);
    assert.match(r.text, /stats: 1 tool call · total \d+s · peak idle [6-9]s · last tool shell$/);
  }
});

await test("the tool idle limit ends it, names the tool, interrupts the session and so stops the tool's process", async () => {
  const job = await one.run({ prompt: "FAKE:daemon", idle_seconds: 2, tool_idle_seconds: 5 });
  const ses = await until("the session", async () => fakeSession((await one.call("opencode_list")).text.split("\n").find((l) => l.startsWith(job)) || ""));
  const pid = await until("the tool's process", () => existsSync(join(fakeDir, "active", ses)) && toolPid(ses));
  strays.push(pid);
  assert.ok(alive(pid));
  const r = await one.result(job);
  assert.equal(r.isError, true);
  const first = r.text.split("\n")[0];
  assert.match(first, /^status: timeout \(no output for 5s while tool shell "cargo build --release --manifest-path [^"]*" was in flight for [5-9]s\)$/);
  assert.equal(/shell "([^"]*)"/.exec(first)[1].length, 80);
  assert.match(r.text, /\nresume: OpenCode reports the session idle \(its run was interrupted\); it can be continued right away\n/);
  assert.match(apiLog(), new RegExp(`session\\.interrupt ${ses}`));
  await until("the tool's process to be gone", () => !alive(pid), 5000);
});

await test("when the interrupt does not take, the reply says the session is still busy and opencode_list shows it", async () => {
  const job = await one.run({ prompt: "FAKE:stubborn", idle_seconds: 2, tool_idle_seconds: 4 });
  const r = await one.result(job);
  const ses = fakeSession(r.text);
  const pid = toolPid(ses);
  strays.push(pid);
  assert.match(r.text, /\nresume: the session is STILL BUSY in OpenCode after an interrupt request/);
  // what the report described: the `run` process tree was killed, the tool's process was not among it
  assert.ok(alive(pid), "killing the run process does not reach a process of the service");
  const list = (await one.call("opencode_list")).text;
  assert.match(list, new RegExp(`Sessions still busy without a job[^\\n]*\\n${ses} · ${job} timeout \\d+s ago`));
  // a continued job is told that its session was busy
  const next = await one.run({ prompt: "FAKE:hang:60000", session: ses, idle_seconds: 30 });
  await until("the busy note", async () => /NOTE: its session was still busy/.test((await one.call("opencode_result", { job: next, wait_seconds: 0 })).text));
  assert.match((await one.call("opencode_cancel", { job })).text, new RegExp(`already timeout\\nits session ${ses} is in use by ${next}`));
  await one.call("opencode_cancel", { job: next });
  // cancelling the ended job asks again; the fake still refuses, so it is still reported busy
  assert.match((await one.call("opencode_cancel", { job })).text, /already timeout\nresume: the session is STILL BUSY/);
  process.kill(pid);
  rmSync(join(fakeDir, "active", ses), { force: true });
});

await test("opencode_cancel stops a running job, interrupts its session, and the result is a short summary", async () => {
  const job = await one.run({ prompt: "FAKE:daemon" });
  const ses = await until("the session", async () => fakeSession((await one.call("opencode_list")).text.split("\n").find((l) => l.startsWith(job)) || ""));
  const pid = await until("the tool's process", () => existsSync(join(fakeDir, "active", ses)) && toolPid(ses));
  strays.push(pid);
  const c = await one.call("opencode_cancel", { job });
  assert.match(c.text, new RegExp(`^${job} stopped \\(process tree \\d+ killed\\)\\. Edits it made stay on disk; session ${ses}\\.\\nresume: OpenCode reports the session idle \\(its run was interrupted\\)`));
  await until("the tool's process to be gone", () => !alive(pid), 5000);
  const r = await one.result(job);
  assert.match(r.text, /^status: cancelled \(stopped by opencode_cancel\)\nstats: 0 tool calls · total \d+s · peak idle \d+s · last tool \(none\)\nsession: /);
  assert.equal((await one.call("opencode_cancel", { job: "job_zz_1" })).isError, true);
});
one.stop();

// two servers on one state folder, one place on the machine: what two Claude sessions see of each other
const shared = { OPENCODE_MAX_CONCURRENT: "1" };
const a = new Server("state-shared", shared);
const b = new Server("state-shared", shared);
await a.start();
await b.start();

await test("a finished job whose reply was never fetched holds no place", async () => {
  const first = await a.run({ prompt: "FAKE:quick" });
  await until("the first job to end, unfetched", async () => /No job is queued or running/.test((await a.call("opencode_list")).text));
  assert.match((await b.call("opencode_list")).text, /the machine: 0\/1 places held\n/);
  assert.equal(readdirSync(join(root, "state-shared", "slots")).length, 0, "no slot file is left");
  const second = await b.run({ prompt: "FAKE:quick" });
  assert.match((await b.result(second)).text, /^PONG/);
  assert.match((await a.result(first)).text, /^PONG/, "the unfetched reply is still there");
});

await test("opencode_list shows every session's jobs, and any of them can be cancelled from any session", async () => {
  const runs = await a.run({ prompt: "FAKE:daemon" });
  const ses = await until("the session", async () => fakeSession((await b.call("opencode_list")).text.split("\n").find((l) => l.startsWith(runs)) || ""));
  const pid = await until("the tool's process", () => existsSync(join(fakeDir, "active", ses)) && toolPid(ses));
  strays.push(pid);
  const waits = await b.run({ prompt: "FAKE:quick" });
  const third = await b.run({ prompt: "FAKE:quick" });
  const list = await until("both queued jobs to be listed", async () => {
    const t = (await a.call("opencode_list")).text;
    return /place 2\/2/.test(t) && t;
  });
  const owner = (srv) => `owner pid ${srv.child.pid} alive`;
  assert.match(list, new RegExp(`^${runs} running · fake/model · ${owner(a)} · started \\d\\d:\\d\\d:\\d\\d · running \\d+s · last tool \\(none\\) · last output \\d+s ago`, "m"));
  assert.match(list, new RegExp(`^${waits} queued · fake/model · ${owner(b)} · started \\d\\d:\\d\\d:\\d\\d · queued \\d+s, place 1/2 waiting for the machine$`, "m"));
  assert.match(list, new RegExp(`^${third} queued .* place 2/2 waiting for the machine$`, "m"));
  assert.match(list, new RegExp(`^the machine: 1/1 places held by ${runs}$`, "m"));
  // the waiting job names who is in its way
  assert.match((await b.call("opencode_result", { job: waits, wait_seconds: 0 })).text, new RegExp(`waiting: 1 jobs already running on this machine: ${runs} \\(running \\d+s\\)\\. opencode_cancel on one of these ids frees its place`));

  // a queued job of the other server
  const c1 = await a.call("opencode_cancel", { job: third });
  assert.equal(c1.isError, false, c1.text);
  assert.match(c1.text, new RegExp(`^${third} cancelled by its own server \\(pid ${b.child.pid}\\)`));
  assert.match((await b.result(third)).text, /cancelled before it started \(asked by another session\)/);

  // a running job of the other server: its own server ends it, session interrupt included
  const c2 = await b.call("opencode_cancel", { job: runs });
  assert.match(c2.text, new RegExp(`^${runs} cancelled by its own server \\(pid ${a.child.pid}\\)\\. Edits it made stay on disk; session ${ses}\\.\\nresume: OpenCode reports the session idle`));
  await until("the tool's process to be gone", () => !alive(pid), 5000);
  assert.match((await a.result(runs)).text, /^status: cancelled \(stopped by opencode_cancel from another session\)/);

  // its place is free: the job that waited now runs
  assert.match((await b.result(waits)).text, /^PONG/);
  assert.match((await a.call("opencode_list")).text, /^No job is queued or running\.\n\nPlaces:\nthe machine: 0\/1 places held\n\nSessions still busy without a job: none\.\n\nWorkers: any OpenCode agent or model \(OPENCODE_ALLOW_ANY\)\n\nThis server: client "test" 0, protocol 2025-06-18, MCP tasks not offered; one opencode_result call waits up to 50 s\.$/);
});

await test("a job whose server died is listed as gone, and cancelling it frees its place", async () => {
  const job = await b.run({ prompt: "FAKE:hang:60000" });
  await until("it to run", async () => new RegExp(`${job} running`).test((await a.call("opencode_list")).text));
  b.child.kill("SIGKILL"); // no shutdown code runs: its slot file and its `run` process stay behind
  await until("the server to be gone", () => !alive(b.child.pid));
  assert.match((await a.call("opencode_list")).text, new RegExp(`${job} running · fake/model · owner pid ${b.child.pid} GONE`));
  const c = await a.call("opencode_cancel", { job });
  assert.match(c.text, new RegExp(`^${job} stopped \\(its server is gone; process tree \\d+ killed\\)`));
  assert.match((await a.result(await a.run({ prompt: "FAKE:quick" }))).text, /^PONG/);
});
a.stop();

const hidden = new Server("state-hidden", { OPENCODE_MODEL_EXCLUDE: "^lan/" });
await test("a model switched off by OPENCODE_MODEL_EXCLUDE is hidden and refused, by name, with or without an effort, and others still run", async () => {
  await hidden.start();
  const tools = (await hidden.rpc("tools/list", {})).result.tools;
  assert.doesNotMatch(tools[0].inputSchema.properties.model.description, /lan/, "not offered in the description");
  for (const model of ["lan/local", "LAN/Local", "lan/local#high"]) {
    const r = await hidden.call("opencode_run", { prompt: "FAKE:quick", model });
    assert.equal(r.isError, true, model);
    assert.match(r.text, /model "lan\/local" is switched off on this machine \(OPENCODE_MODEL_EXCLUDE\)\. Use one of: /i, `${model}: ${r.text}`);
  }
  assert.match((await hidden.result(await hidden.run({ prompt: "FAKE:quick" }))).text, /^PONG/, "the default model still runs");
  assert.match((await hidden.result(await hidden.run({ prompt: "FAKE:quick", model: "fake/model" }))).text, /^PONG/);
});
hidden.stop();
const hiddenAgent = new Server("state-hidden-agent", { OPENCODE_MODEL_EXCLUDE: "^fake/model$" });
await test("an agent whose own model is switched off is refused too", async () => {
  await hiddenAgent.start();
  const r = await hiddenAgent.call("opencode_run", { prompt: "FAKE:quick" });
  assert.equal(r.isError, true);
  assert.match(r.text, /model "fake\/model" is switched off/);
});
hiddenAgent.stop();

const blockFile = join(root, "blocked-models.json");
const live = new Server("state-blocklist", { OPENCODE_BLOCKLIST: blockFile });
await test("the blocklist file switches a model off and on while the server runs, no restart", async () => {
  await live.start();
  const ask = () => live.run({ prompt: "FAKE:quick", model: "fake/model" });
  const put = async (x) => {
    writeFileSync(blockFile, x);
    await sleep(30);
  };
  // no file: nothing is blocked
  assert.match((await live.result(await live.run({ prompt: "FAKE:quick", model: "fake/model" }))).text, /^PONG/);
  // block it: refused at once, with the reason, by name, another case and an effort; an agent default is refused too
  await put(JSON.stringify({ blocked: ["Fake/Model"] }));
  for (const model of ["fake/model", "FAKE/MODEL", "fake/model#high"]) {
    const r = await live.call("opencode_run", { prompt: "FAKE:quick", model });
    assert.equal(r.isError, true, model);
    assert.match(r.text, /model "fake\/model" is switched off on this machine \(the blocklist\)/i, `${model}: ${r.text}`);
  }
  const byDefault = await live.call("opencode_run", { prompt: "FAKE:quick" });
  assert.equal(byDefault.isError, true, "the default model is fake/model here: refused too");
  // a broken file blocks nothing, a file without the entry blocks nothing
  await put("{ not json");
  assert.match((await live.result(await ask())).text, /^PONG/, "broken file");
  await put(JSON.stringify({ blocked: ["other/thing"] }));
  assert.match((await live.result(await ask())).text, /^PONG/, "other entry");
  // block again, then clear the list
  await put(JSON.stringify({ blocked: ["fake/model"] }));
  assert.equal((await live.call("opencode_run", { prompt: "FAKE:quick", model: "fake/model" })).isError, true);
  await put(JSON.stringify({ blocked: [] }));
  assert.match((await live.result(await ask())).text, /^PONG/, "cleared");
});
live.stop();

// ---- the worker list: the only things a caller can run ----

const workersFile = join(root, "workers.json");
writeFileSync(
  workersFile,
  JSON.stringify({
    default: "flash",
    workers: {
      flash: { runs: "opencode", agent: "deepseek-flash", description: "Cheap worker." },
      ro: { runs: "opencode", agent: "deepseek-flash", readOnly: true },
      ghost: { runs: "opencode", agent: "no-such-agent" },
      off: { runs: "opencode", agent: "deepseek-flash", disabled: true },
      cc: { runs: "claude", model: "sonnet" },
    },
  }),
);
const listed = new Server("state-workers", { OPENCODE_ALLOW_ANY: "", BRIDGE_WORKERS_FILE: workersFile, OPENCODE_PROGRESS_MS: "300", OPENCODE_WAIT_SECONDS: "1500" });
const started = (text) => /started (job_[a-z0-9]+_\d+(?:-[a-z0-9-]+)?)/.exec(text)[1];
await test("with a worker list the tool offers the workers and nothing else", async () => {
  await listed.start("claude-code");
  const { tools } = (await listed.rpc("tools/list", {})).result;
  const props = tools[0].inputSchema.properties;
  assert.deepEqual(props.worker.enum, ["flash", "ro", "ghost", "cc"]);
  assert.equal("model" in props || "agent" in props, false, "no model or agent to choose");
  assert.match(props.worker.description, /^flash \(OpenCode agent deepseek-flash on fake\/model, not the Claude plan, efforts low,high, the default\): Cheap worker\.$/m);
  assert.match(props.worker.description, /^cc \(Claude Code sonnet, uses the Claude plan\)$/m);
  assert.doesNotMatch(JSON.stringify(tools), /Models \(provider\/id/, "no model catalog");
  for (const t of tools) assert.ok(t.description.length < 2048, `${t.name}: ${t.description.length}`);
  assert.match(tools[1].description, /up to 1500 s/, "OPENCODE_WAIT_SECONDS sets the wait");
});
await test("a call runs the default worker, a named one, or is refused: no other agent or model gets through", async () => {
  const first = await listed.call("opencode_run", { prompt: "FAKE:quick" });
  assert.match(first.text, /^started job_\w+ on worker flash \(fake\/model\)/);
  assert.match((await listed.result(started(first.text))).text, /^PONG/);
  const old = await listed.call("opencode_run", { prompt: "FAKE:quick", agent: "flash" });
  assert.match(old.text, /on worker flash/, "an older call may name a worker with agent");
  await listed.result(started(old.text));
  const refused = async (args, re) => {
    const r = await listed.call("opencode_run", { prompt: "FAKE:quick", ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  };
  await refused({ model: "fake/model" }, /^model "fake\/model" is not a worker\..* Workers: flash, ro, ghost, cc$/);
  await refused({ agent: "deepseek-flash" }, /^agent "deepseek-flash" is not a worker\./);
  await refused({ model: "claude-code/opus" }, /is not a worker/);
  await refused({ worker: "nope" }, /^unknown worker "nope"\. Workers: flash, ro, ghost, cc$/);
  await refused({ worker: "off" }, /^unknown worker "off"/);
  await refused({ worker: "flash", model: "fake/model" }, /`model` is not accepted/);
  await refused({ worker: "ro", allow_edits: true }, /^worker "ro" is read-only/);
  await refused({ worker: "ghost" }, /^worker "ghost": unknown agent "no-such-agent"/);
  await refused({ worker: "flash", effort: "max" }, /^worker "flash": fake\/model has effort levels low, high/);
  await refused({ worker: "flash", session: "0f8fad5b-d9cb-469f-a165-70867728950e" }, /is a Claude Code session and worker "flash" runs OpenCode/);
});
await test("a continued session goes back to the worker that started it", async () => {
  const r = await listed.result(await listed.run({ prompt: "FAKE:quick", worker: "ro" }));
  const again = await listed.call("opencode_run", { prompt: "FAKE:quick", session: fakeSession(r.text) });
  assert.match(again.text, /on worker ro /, again.text);
  await listed.result(started(again.text));
});
await test("a wait the client gave up on answers nothing and keeps the reply for the next call", async () => {
  const job = await listed.run({ prompt: "FAKE:hang:1500" });
  const other = await listed.run({ prompt: "FAKE:hang:1500" });
  const id = listed.next++;
  let answered = false;
  listed.waiting.set(id, () => (answered = true));
  listed.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "opencode_result", arguments: { jobs: [job, other] }, _meta: { progressToken: "p1" } } }) + "\n");
  await until("a progress message", () => listed.notes.some((n) => n.method === "notifications/progress" && n.params.progressToken === "p1" && n.params.message.includes(job)));
  listed.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }) + "\n");
  await sleep(3500);
  assert.equal(answered, false, "no answer to a cancelled call");
  const r = await listed.call("opencode_result", { jobs: [job, other] });
  assert.match(r.text, new RegExp(`## ${job} · done\\nwoke up`), r.text);
  assert.match(r.text, /All done\.$/);
  const second = (await listed.call("opencode_result", { jobs: [job, other] })).text;
  assert.ok(second.includes(`${job}: done, reply already returned (opencode_result { job: "${job}" } returns it again)`), second);
});
await test("opencode_list names the workers and how long a wait may be", async () => {
  const list = (await listed.call("opencode_list")).text;
  assert.match(list, /^Workers:\nflash \(OpenCode agent deepseek-flash/m);
  assert.match(list, /This server: client "claude-code" 0, protocol 2025-06-18, MCP tasks not offered; one opencode_result call waits up to 1500 s\.$/);
});
await test("opencode_list names this session's ended jobs whose reply nobody collected", async () => {
  const started = (await listed.call("opencode_run", { prompt: "FAKE:quick" })).text;
  assert.match(started, /Nothing wakes you when a job ends: do not end your turn before you have its reply\.$/);
  const job = /job_[a-z0-9]+_\d+(?:-[a-z0-9-]+)?/.exec(started)[0];
  let list = "";
  await until("the ended job is listed as not collected", async () => {
    list = (await listed.call("opencode_list")).text;
    return list.includes("Ended, reply NOT collected yet (yours):");
  });
  assert.ok(list.includes(`${job} done: call opencode_result { job: "${job}" } for its reply`), list);
  await listed.call("opencode_result", { job });
  assert.ok(!(await listed.call("opencode_list")).text.includes("NOT collected"));
});
listed.stop();

await test("without OPENCODE_TASKS the newer protocol is unknown, so a client falls back to initialize", async () => {
  const off = new Server("state-tasks-off");
  const r = await off.rpc("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } });
  assert.equal(r.error.code, -32601);
  off.stop();
});

await test("with OPENCODE_TASKS a job is an MCP task: the run returns at once and tasks/get carries the reply", async () => {
  const t = new Server("state-tasks", { OPENCODE_TASKS: "1" });
  const meta = (caps = { extensions: { "io.modelcontextprotocol/tasks": {} } }, version = "2026-07-28") => ({
    _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientInfo": { name: "modern", version: "1" }, "io.modelcontextprotocol/clientCapabilities": caps },
  });
  const d = (await t.rpc("server/discover", meta())).result;
  assert.equal(d.resultType, "complete");
  assert.deepEqual(d.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(d.capabilities.extensions, { "io.modelcontextprotocol/tasks": {} });
  assert.match(d.instructions, /background task/);
  assert.equal((await t.rpc("server/discover", meta({}, "2030-01-01"))).error.code, -32022);
  const tools = (await t.rpc("tools/list", meta())).result;
  assert.equal(tools.resultType, "complete");
  assert.match(tools.tools[0].description, /^Hands a task to a worker .* as a background task: .* Do not call `opencode_result` to wait for it\. Models: /);
  assert.ok(tools.tools[0].description.length < 2048, String(tools.tools[0].description.length));
  assert.doesNotMatch((await t.rpc("tools/list", meta({}))).result.tools[0].description, /as a background task/);

  const made = (await t.rpc("tools/call", { name: "opencode_run", arguments: { prompt: "FAKE:hang:1500" }, ...meta() })).result;
  assert.equal(made.resultType, "task");
  assert.equal(made.status, "working");
  assert.match(made.taskId, /^job_[a-z0-9]+_\d+(?:-[a-z0-9-]+)?$/);
  assert.ok(made.ttlMs > 3600000 && made.pollIntervalMs === 5000 && made.createdAt && made.lastUpdatedAt);
  const now = (await t.rpc("tasks/get", { taskId: made.taskId, ...meta() })).result;
  assert.equal(now.resultType, "complete");
  assert.equal(now.status, "working");
  assert.equal(now.result, undefined);
  let done;
  await until("the task completes", async () => {
    done = (await t.rpc("tasks/get", { taskId: made.taskId, ...meta() })).result;
    return done.status === "completed";
  });
  assert.equal(done.result.isError, false);
  assert.match(done.result.content[0].text, /^woke up\n\n---\nsession: /);
  assert.equal((await t.rpc("tasks/get", { taskId: "job_nope_1", ...meta() })).error.code, -32602);

  // a client without the extension gets the plain reply, with resultType
  const plain = (await t.rpc("tools/call", { name: "opencode_run", arguments: { prompt: "FAKE:quick" }, ...meta({}) })).result;
  assert.equal(plain.resultType, "complete");
  assert.match(plain.content[0].text, /^started job_/);

  // a task that is cancelled ends with what it left, as its result
  const long = (await t.rpc("tools/call", { name: "opencode_run", arguments: { prompt: "FAKE:hang:60000" }, ...meta() })).result;
  // looking at a running task never waits; the first look says what it is doing, a second one only "do not look"
  const before = Date.now();
  const look = () => t.rpc("tools/call", { name: "opencode_result", arguments: { job: long.taskId }, ...meta() });
  const first = (await look()).result.content[0].text;
  assert.match(first, /Its reply is delivered to you when it ends\. Do not look again/);
  assert.ok(first.split("\n").length > 1, first);
  const second = (await look()).result.content[0].text;
  assert.equal(second, `${long.taskId} still running. Its reply is delivered to you when it ends. Do not look again: carry on with other work, or end the turn if nothing else is left.`);
  assert.ok(Date.now() - before < 3000, "a look does not wait");
  await until("task's client to start", () => JSON.parse(readFileSync(join(root,"state-tasks",`${long.taskId}.json`))).status === "running");
  assert.deepEqual((await t.rpc("tasks/cancel", { taskId: long.taskId, ...meta() })).result, { resultType: "complete" });
  const gone = (await t.rpc("tasks/get", { taskId: long.taskId, ...meta() })).result;
  assert.equal(gone.status, "completed");
  assert.equal(gone.result.isError, true);
  assert.match(gone.result.content[0].text, /^status: cancelled/);

  // the older protocol still works on the same server
  assert.equal((await t.start()).serverInfo.version, "3.4.0");
  t.stop();
});

await test("a Claude worker's account follows the setting: same, other, or a named folder", () => {
  const home = join(root, "home");
  const std = join(home, ".claude");
  const work = join(home, ".claude-accounts", "work", "cli");
  const accounts = [std, work];
  const uuidOf = (d) => (d === std ? "uuid-main" : d === work ? "uuid-work" : "");
  const pick = (o) => bridge.workerConfigDir({ accounts, home, uuidOf, ...o });
  // "" is the standard login, with no CLAUDE_CONFIG_DIR at all
  assert.equal(pick({ use: "same" }), "");
  assert.equal(pick({ use: "same", hostDir: work }), work);
  assert.equal(pick({ use: "same", hostUuid: "uuid-work" }), work);
  assert.equal(pick({ use: "same", hostUuid: "uuid-unknown" }), "");
  assert.equal(pick({ use: "other" }), work);
  assert.equal(pick({ use: "other", hostDir: work }), "");
  // a desktop session of the second account runs on the standard folder: its account id tells
  assert.equal(pick({ use: "other", hostUuid: "uuid-work" }), "");
  assert.equal(pick({ use: "other", hostUuid: "uuid-main" }), work);
  assert.equal(pick({ use: "other", hostUuid: "uuid-unknown" }), work);
  assert.equal(pick({ use: work }), work);
  assert.equal(pick({ use: std.toUpperCase(), hostDir: work }), "");
  // a folder that is not one of the accounts is not used
  assert.equal(pick({ use: join(home, "elsewhere"), hostDir: work }), work);
  // nothing to choose from: the host's own
  assert.equal(bridge.workerConfigDir({ accounts: [], use: "other", hostDir: work, home }), work);
  assert.equal(bridge.workerConfigDir({ accounts: [std], use: "other", home, uuidOf }), "");
  assert.equal(bridge.workerConfigDir(), "");
});
await test("the wait is 50 s unless set, and a worker entry is read strictly", () => {
  assert.equal(bridge.serviceDropped(['{"type":"unknown","message":"Transport: ECONNRESET: The socket connection was closed unexpectedly."}']), true);
  assert.equal(bridge.serviceDropped(['{"name":"APIError","message":"Insufficient balance"}', ""]), false);
  assert.equal(bridge.waitLimit({ env: NaN }), 50, "under the 60 s after which the desktop app drops a call and closes the server");
  assert.equal(bridge.waitLimit({ env: 600 }), 600, "OPENCODE_WAIT_SECONDS decides");
  assert.equal(bridge.readWorker("x", { runs: "opencode" }), null, "an OpenCode worker needs an agent");
  assert.equal(bridge.readWorker("bad name", { runs: "claude", model: "opus" }), null);
  assert.equal(bridge.readWorker("x", { model: "opus" }), null, "no runs: not a worker of the new list");
  assert.deepEqual(bridge.readWorker("x", { model: "opus", effort: "high" }, true), { name: "x", runs: "claude", readOnly: false, description: "", model: "opus", effort: "high", instructions: "" });
  assert.deepEqual(bridge.readWorker("y", { runs: "opencode", agent: "a", model: "p/m#high" }), { name: "y", runs: "opencode", readOnly: false, description: "", agent: "a", model: "p/m", effort: "" });
});

await test("the job's config leaves Magic Context out and turns OpenCode's own compaction on", () => {
  const magic = "@cortexkit/opencode-magic-context@latest";
  assert.equal(bridge.withoutMagic({ plugins: ["other"] }), null, "no plugin: nothing to change");
  const lean = bridge.withoutMagic({ model: "m", plugins: [magic, "other"], compaction: { auto: false, prune: false, keep: 3 } });
  assert.deepEqual(lean, { model: "m", plugins: ["other"], compaction: { auto: true, keep: 3 } });
  assert.deepEqual(bridge.withoutMagic({ plugin: [["@cortexkit/opencode-magic-context", {}]] }), { compaction: { auto: true } }, "the older key, an entry with options, an emptied list dropped");
});

await test("two bridges share one worker service, defer config changes until idle, and keep personal mode separate", async () => {
  const ocDir = join(root, "oc-config");
  const jobs = join(root, "oc-jobs");
  mkdirSync(ocDir, { recursive: true });
  writeFileSync(join(ocDir, "opencode.json"), JSON.stringify({ plugins: ["@cortexkit/opencode-magic-context@latest"], compaction: { auto: false } }));
  writeFileSync(join(ocDir, "cli.json"), "{}");
  writeFileSync(join(ocDir, "service.json"), "{}");
  const definitions=join(root,"linked-definitions"); mkdirSync(definitions);
  symlinkSync(definitions,join(ocDir,"skills"),"junction");
  symlinkSync(ocDir,join(definitions,"cycle"),"junction");
  writeFileSync(join(definitions,"SKILL.md"),"linked skill");
  const dir = join(root,"lean-fake");
  const runLog = () => readFileSync(join(dir, "run.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const env = { FAKE_DIR:dir, OPENCODE_CONFIG_DIR: ocDir, BRIDGE_JOB_CONFIG_DIR: jobs, BRIDGE_JOB_HOME:join(root,"lean-profile") };
  const lean = new Server("state-lean", env), peer = new Server("state-peer", env);
  const ids = await Promise.all([lean.run({prompt:"FAKE:hang:3000"}), peer.run({prompt:"FAKE:quick"})]);
  assert.match((await peer.result(ids[1])).text,/PONG/);
  const count = () => readFileSync(join(dir,"services.log"),"utf8").split("\n").filter(l => l.includes("lean-profile")).length;
  const contract = JSON.parse(readFileSync(join(env.BRIDGE_JOB_HOME,"job-service.json")));
  assert.ok(contract.address && contract.env.OPENCODE_DB.startsWith(env.BRIDGE_JOB_HOME));
  assert.ok(!/password|token/i.test(JSON.stringify(contract)));
  writeFileSync(join(ocDir,"cli.json"), '{"new":true}');
  assert.match((await peer.result(await peer.run({prompt:"FAKE:quick"}))).text,/PONG/);
  assert.equal(count(),1);
  assert.equal(readFileSync(join(jobs,"cli.json"),"utf8"),"{}");
  await lean.result(ids[0]);
  await lean.result(await lean.run({prompt:"FAKE:quick"}));
  assert.equal(count(),2);
  assert.equal(readFileSync(join(jobs,"cli.json"),"utf8"),'{"new":true}');
  lean.stop(); peer.stop();
  const last = runLog().at(-1);
  assert.ok(last.args.includes("--server") && !last.args.includes("--standalone"), last.args.join(" "));
  assert.equal(last.configDir, jobs);
  assert.deepEqual(JSON.parse(readFileSync(join(jobs, "opencode.json"), "utf8")), { compaction: { auto: true } });
  assert.ok(existsSync(join(jobs, "cli.json")), "the other config files come along");
  assert.ok(!existsSync(join(jobs, "service.json")), "the service's password does not");
  assert.equal(readFileSync(join(jobs,"skills","SKILL.md"),"utf8"),"linked skill");
  assert.ok(!existsSync(join(jobs,"skills","cycle")));
  const keep = join(root, "keep-workers.json");
  writeFileSync(keep, JSON.stringify({ magicContextInJobs: true, workers: { w: { runs: "opencode", agent: "deepseek-flash" } } }));
  const kept = new Server("state-kept", { ...env, OPENCODE_ALLOW_ANY: "", BRIDGE_WORKERS_FILE: keep });
  await kept.result(await kept.run({ prompt: "FAKE:quick" }));
  kept.stop();
  const plain = runLog().at(-1);
  assert.ok(!plain.args.includes("--standalone"), plain.args.join(" "));
  assert.equal(plain.configDir, ocDir, "the user's own config, as before");
});

await test("unavailable service falls back to standalone with worker DB; sign-in commands and missing-key errors are scoped", async () => {
  const fallback = new Server("fallback", { BRIDGE_JOB_HOME:join(root,"fallback-profile"), FAKE_NO_SERVICE:"1" });
  assert.match((await fallback.result(await fallback.run({prompt:"FAKE:quick"}))).text,/^PONG/);
  const last = JSON.parse(readFileSync(join(fakeDir,"run.log"),"utf8").trim().split("\n").at(-1));
  assert.ok(last.args.includes("--standalone") && last.db.startsWith(fallback.env.BRIDGE_JOB_HOME));
  writeFileSync(`${last.db}.missing`,"fake");
  assert.match((await fallback.result(await fallback.run({prompt:"FAKE:quick"}))).text,/provider "fake".*bridge-auth.mjs/);
  fallback.stop();
  const srv = new Server("signin", { BRIDGE_JOB_HOME:join(root,"signin-profile") });
  await srv.rpc("tools/list",{});
  const db = join(srv.env.BRIDGE_JOB_HOME, "job-service","jobs.db"), helper = join(here,"..","bridge-auth.mjs");
  const auth = (...args) => promisify(execFile)(process.execPath,[helper,...args],{env:srv.env,timeout:15000});
  writeFileSync(`${db}.missing`,"fake");
  const before = readFileSync(join(fakeDir,"run.log"),"utf8");
  const result = await srv.result(await srv.run({prompt:"FAKE:quick"}));
  assert.match(result.text,/provider "fake".*Config Studio › Workers.*bridge-auth.mjs" login fake/);
  assert.equal(readFileSync(join(fakeDir,"run.log"),"utf8"),before);
  assert.deepEqual(JSON.parse((await auth("status")).stdout).providers,[{id:"fake",status:"Missing",key:true,stored:false}]);
  const key = randomBytes(32);
  const sent = execFile(process.execPath,[helper,"key","fake"],{env:srv.env},()=>{});
  sent.stdin.end(key.toString("hex")); key.fill(0);
  assert.equal(await new Promise(done=>sent.on("exit",done)),0);
  assert.match((await auth("status")).stdout,/Signed in/);
  const overrideFile = join(root, "worker-auth-status.json");
  writeFileSync(overrideFile,JSON.stringify({workers:{
    inherited:{runs:"opencode",agent:"deepseek-flash"}, override:{runs:"opencode",agent:"deepseek-flash",model:"openai/gpt"},
    off:{runs:"opencode",disabled:true,model:"other/model"},claude:{runs:"claude",model:"opus"},
  }}));
  const status = await promisify(execFile)(process.execPath,[helper,"status"],{env:{...srv.env, BRIDGE_WORKERS_FILE:overrideFile}});
  assert.deepEqual(JSON.parse(status.stdout).providers.map(p=>p.id),["fake","openai"]);
  for (const a of [["list"],["login","fake"],["logout","fake"]]) await auth(...a);
  const actions = readFileSync(join(fakeDir,"auth.log"),"utf8").trim().split("\n").map(x=>JSON.parse(x));
  assert.deepEqual(actions.map(a=>a.action),["list","login","logout"]); assert.ok(actions.every(a=>a.db===db));
  assert.match((await srv.result(await srv.run({prompt:"FAKE:quick"}))).text,/^PONG/);
  const history = `${db}.sessions`, old = {archived:1,updated:1};
  writeFileSync(history,JSON.stringify([{id:"old",time:old},{id:"parent",time:old},
    {id:"child",parentID:"parent",time:{updated:1}},{id:"recent",time:{archived:1,updated:Date.now()}}]));
  assert.match((await auth("prune","30")).stdout,/Removed 1/);
  assert.deepEqual(JSON.parse(readFileSync(history)).map(s=>s.id),["parent","child","recent"]);
  srv.stop();
});

await test("shutdown interrupts all held sessions even with coordinator admission blocked",async()=>{
  const dir=join(root,"close-fake"), home=join(root,"close-profile");
  const srv=new Server("close-state",{FAKE_DIR:dir,BRIDGE_JOB_HOME:home});
  const lock=join(home,"job-service","admission","test-holder");
  try {
    const ids=await Promise.all(Array.from({length:5},()=>srv.run({prompt:"FAKE:hang:60000"})));
    const sessions=await until("all sessions recorded",()=>{
      const states=ids.map(id=>JSON.parse(readFileSync(join(root,"close-state",id+".json"))));
      return states.every(s=>s.status==="running" && s.session) && states.map(s=>s.session);
    });
    writeFileSync(lock,JSON.stringify({pid:process.pid,birth:await birth(process.pid),ticket:1}));
    const exit=new Promise(ok=>srv.child.once("exit",ok));
    srv.stop(); await Promise.race([exit,sleep(10000)]);
    assert.equal(srv.child.exitCode,0);
    for (const id of sessions) assert.ok(!existsSync(join(dir,"active",id)),`session ${id} left running`);
  } finally { rmSync(lock,{force:true}); if (srv.child.exitCode===null) srv.child.kill(); }
});
await test("refuses a duplicate resume and routes pre-upgrade leftovers to personal mode",async()=>{
  const dir=join(root,"resume-fake"), state=join(root,"resume-check-state");
  const srv=new Server("resume-check-state",{FAKE_DIR:dir,BRIDGE_JOB_HOME:join(root,"resume-profile")});
  try {
    const result=await srv.result(await srv.run({prompt:"FAKE:busy:1"}));
    assert.ok(result.isError); assert.equal(readFileSync(join(dir,"run.log"),"utf8").trim().split("\n").length,1);
    const ses="ses_fake999";
    writeFileSync(join(state,"job_old_1.json"),JSON.stringify({id:"job_old_1",owner:process.pid,started:1,running:1,finished:2,status:"failed",session:ses,magicContext:false}));
    assert.match((await srv.result(await srv.run({prompt:"FAKE:quick",session:ses}))).text,/personal database/);
    const active=join(dir,"active",ses); writeFileSync(active,JSON.stringify({scope:"personal"}));
    await srv.call("opencode_cancel",{job:"job_old_1"}); assert.ok(!existsSync(active));
  } finally { srv.stop(); }
});

await test("a label becomes the tail of the job id; the job answers to both forms and an unlabelled id is as before", async () => {
  assert.equal(bridge.labelSlug("Card fixes"), "card-fixes");
  assert.equal(bridge.labelSlug("  --Öğe düzeltme: #2!  "), "oge-duzeltme-2");
  assert.equal(bridge.labelSlug("x".repeat(40) + " y"), "x".repeat(32));
  assert.equal(bridge.labelSlug("a".repeat(31) + " b c"), "a".repeat(31), "no hyphen left at the cut");
  for (const none of ["", "   ", "!!!", undefined, 7, null]) assert.equal(bridge.labelSlug(none), "");
  const srv = new Server("label-state", { FAKE_DIR: join(root, "label-fake"), BRIDGE_JOB_HOME: join(root, "label-profile") });
  const peer = new Server("label-state", { FAKE_DIR: join(root, "label-fake"), BRIDGE_JOB_HOME: join(root, "label-profile") });
  try {
    const text = (await srv.call("opencode_run", { prompt: "FAKE:hang:4000", label: "Card fixes" })).text;
    const id = /started ([a-z0-9_-]+)/.exec(text)[1];
    assert.match(id, /^job_[a-z0-9]+_1-card-fixes$/);
    const bare = id.replace(/-.*/, "");
    assert.ok(existsSync(join(root, "label-state", id + ".json")), "the state file carries the full id");
    await until("it to run", async () => new RegExp("^" + id + " running", "m").test((await srv.call("opencode_list")).text), 30000);
    assert.match((await srv.call("opencode_result", { job: bare, wait_seconds: 0 })).text, new RegExp("^" + id + " "), "the bare id finds it, the answer names it in full");
    assert.match((await peer.call("opencode_result", { job: bare, wait_seconds: 0 })).text, new RegExp("^" + id + " "), "from another session too");
    assert.match((await srv.call("opencode_cancel", { job: bare })).text, new RegExp(id));
    assert.match((await srv.result(id)).text, /cancelled/);
    const plain = await srv.run({ prompt: "FAKE:quick" });
    assert.match(plain, /^job_[a-z0-9]+_2$/);
    assert.match((await srv.result(plain)).text, /^PONG/);
    assert.match(await srv.run({ prompt: "FAKE:quick", label: "?!" }), /^job_[a-z0-9]+_3$/, "a label with nothing usable is no label");
  } finally {
    srv.stop();
    peer.stop();
  }
});

await test("standalone runs overlap when the service cannot start; past the chain limit a newcomer waits instead of failing", async () => {
  const dir = join(root, "par-fake");
  const env = { FAKE_DIR: dir, BRIDGE_JOB_HOME: join(root, "par-profile"), FAKE_NO_SERVICE: "1" };
  const runs = () => (existsSync(join(dir, "run.log")) ? readFileSync(join(dir, "run.log"), "utf8").trim().split("\n").length : 0);
  const srv = new Server("par-state", env);
  try {
    const a = await srv.run({ prompt: "FAKE:hang:6000" });
    await until("the first standalone run", () => runs() === 1, 30000);
    const b = await srv.run({ prompt: "FAKE:hang:2000" });
    await until("both runs at once", () => readdirSync(join(dir, "active")).length === 2, 30000);
    const second = await srv.result(b);
    assert.match(second.text, /^woke up/);
    assert.match(second.text, /worker service: Worker service is unavailable while standalone workers run; using standalone for this job\.$/);
    assert.match((await srv.result(a)).text, /^woke up/);
  } finally {
    srv.stop();
  }
  const late = new Server("par-late", { ...env, BRIDGE_STANDALONE_CHAIN_MS: "1" });
  try {
    const a = await late.run({ prompt: "FAKE:hang:5000" });
    await until("its run", () => runs() === 3, 30000);
    const b = await late.run({ prompt: "FAKE:quick" });
    await until("the wait to be noted", () => {
      try {
        return /^Waiting for standalone workers to finish/.test(JSON.parse(readFileSync(join(root, "par-late", b + ".json"), "utf8")).profileNote);
      } catch {
        return false;
      }
    }, 30000);
    assert.equal(runs(), 3, "the newcomer has not started");
    const c = await late.run({ prompt: "FAKE:quick" });
    await sleep(1500);
    assert.match((await late.call("opencode_cancel", { job: c })).text, /cancel/i);
    assert.match((await late.result(c)).text, /cancelled/, "a waiting job can be cancelled");
    assert.match((await late.result(b)).text, /^PONG/);
    assert.match((await late.result(a)).text, /^woke up/);
  } finally {
    late.stop();
  }
});

await test("a session no job here remembers is looked up in the database before it is continued, standalone too", async () => {
  const dir = join(root, "get-fake");
  const env = { FAKE_DIR: dir, BRIDGE_JOB_HOME: join(root, "get-profile"), FAKE_NO_SERVICE: "1" };
  const first = new Server("get-one", env);
  const ses = fakeSession((await first.result(await first.run({ prompt: "FAKE:quick" }))).text);
  first.stop();
  const next = new Server("get-two", env); // another machine state: nothing remembers the session
  try {
    assert.match((await next.result(await next.run({ prompt: "FAKE:quick", session: ses }))).text, new RegExp("^PONG\\n\\n---\\nsession: " + ses));
    assert.match(readFileSync(join(dir, "api.log"), "utf8"), new RegExp("session\\.get " + ses));
    assert.match((await next.result(await next.run({ prompt: "FAKE:quick", session: "ses_fake1" }))).text, /Could not verify this session/);
  } finally {
    next.stop();
  }
  const dir2 = join(root, "get-fake-service");
  const shared = { FAKE_DIR: dir2, BRIDGE_JOB_HOME: join(root, "get-profile-service") };
  const one = new Server("get-three", shared);
  const ses2 = fakeSession((await one.result(await one.run({ prompt: "FAKE:quick" }))).text);
  one.stop();
  const two = new Server("get-four", shared);
  try {
    assert.match((await two.result(await two.run({ prompt: "FAKE:quick", session: ses2 }))).text, /^PONG/);
    assert.match((await two.result(await two.run({ prompt: "FAKE:quick", session: "ses_fake1" }))).text, /Could not verify this session/);
  } finally {
    two.stop();
  }
});

await test("closing does not wait for an interrupt that hangs: the session stays on its lease", async () => {
  const dir = join(root, "deadline-fake"), home = join(root, "deadline-profile");
  const srv = new Server("deadline-state", { FAKE_DIR: dir, BRIDGE_JOB_HOME: home, OPENCODE_SHUTDOWN_MS: "1500" });
  try {
    const id = await srv.run({ prompt: "FAKE:hang:60000" });
    await until("its session", () => {
      try {
        return JSON.parse(readFileSync(join(root, "deadline-state", id + ".json"))).session;
      } catch {
        return false;
      }
    });
    writeFileSync(join(dir, "interrupt-hangs"), "");
    const exit = new Promise((ok) => srv.child.once("exit", ok));
    const t = Date.now();
    srv.stop();
    await Promise.race([exit, sleep(7000)]);
    assert.equal(srv.child.exitCode, 0);
    assert.ok(Date.now() - t < 5000, "left after " + (Date.now() - t) + " ms");
    const left = readdirSync(join(home, "job-service", "clients")).filter((f) => !f.endsWith(".tmp")).map((f) => JSON.parse(readFileSync(join(home, "job-service", "clients", f), "utf8")));
    assert.ok(left.length === 1 && left[0].pid === null && /^ses_fake/.test(left[0].session), JSON.stringify(left));
  } finally {
    rmSync(join(dir, "interrupt-hangs"), { force: true });
    if (srv.child.exitCode === null) srv.child.kill();
  }
});

await test("the coordination regressions (test/coordination.mjs)", async () => {
  const env = { ...process.env };
  for (const k of ["OPENCODE_BRIDGE_NO_MAIN", "OPENCODE_STATE_DIR", "OPENCODE_CLAUDE", "BRIDGE_JOB_HOME"]) delete env[k];
  const { stdout } = await promisify(execFile)(process.execPath, [join(here, "coordination.mjs")], { env, timeout: 240000 });
  assert.match(stdout, /coordination regression tests passed/);
});

for (const pid of strays) {
  try {
    process.kill(pid);
  } catch {
    // stopped by the test, as it should be
  }
}
await sleep(500);
// Only the fakes with a registration created in this test's unique scratch root.
for (const folder of ["workers","lean-profile","signin-profile","close-profile","resume-profile","get-profile-service","deadline-profile","label-profile"]) {
  const file = join(root,folder,"job-service","state","opencode","service.json");
  if (!existsSync(file)) continue;
  const svc = JSON.parse(readFileSync(file,"utf8"));
  await fetch(svc.url+"/test/stop",{headers:{authorization:`Basic ${Buffer.from("opencode:"+svc.password).toString("base64")}`}});
}
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // a file still open on Windows: the temp folder is cleaned by the system
}
console.log(failed ? `\n${failed} test(s) FAILED` : "\nall tests passed");
process.exit(failed ? 1 : 0);
