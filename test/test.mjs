// Tests for the bridge. Run: node test/test.mjs
// Part 1 checks the rules that need no process (queue places, idle limits, the result line).
// Part 2 drives the real server over MCP stdio against test/fake-opencode.mjs, so no model is called.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    this.child = spawn(process.execPath, [serverFile], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        PATH: binDir + delimiter + process.env.PATH,
        OPENCODE_EXE: fakeExe,
        NODE_OPTIONS: `--import ${pathToFileURL(join(here, "fake-opencode.mjs")).href}`,
        FAKE_DIR: fakeDir,
        FAKE_REAL_NODE: process.execPath,
        OPENCODE_STATE_DIR: join(root, name),
        OPENCODE_BRIDGE_NO_MAIN: "",
        OPENCODE_CLAUDE: "0",
        OPENCODE_PROBE_MS: "500",
        ...env,
      },
    });
    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) {
        const m = JSON.parse(l);
        if (m.id !== undefined && this.waiting.has(m.id)) this.waiting.get(m.id)(m);
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
  async start() {
    const init = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
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
    return /started (job_[a-z0-9]+_\d+)/.exec(r.text)[1];
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
  assert.match((await a.call("opencode_list")).text, /^No job is queued or running\.\n\nPlaces:\nthe machine: 0\/1 places held\n\nSessions still busy without a job: none\.$/);
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

for (const pid of strays) {
  try {
    process.kill(pid);
  } catch {
    // stopped by the test, as it should be
  }
}
await sleep(500);
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // a file still open on Windows: the temp folder is cleaned by the system
}
console.log(failed ? `\n${failed} test(s) FAILED` : "\nall tests passed");
process.exit(failed ? 1 : 0);
