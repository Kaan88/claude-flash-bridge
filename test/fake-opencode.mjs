// A stand-in for the `opencode` executable, for the tests: no model is ever called.
//
// The tests copy the Node binary to a file named opencode(.exe) and set NODE_OPTIONS=--import <this file>, so this
// code runs first in that copy and exits before Node looks for a script. In any other Node process it does nothing.
//
// It mimics what the bridge uses: `opencode run --format json` (events on stdout, the prompt on stdin) and
// `opencode api <operation> [--param k=v]`. Like the real thing, a session "runs in a background service": its state
// lives in files under FAKE_DIR, and a tool's process is not a child of the `run` process.
//
// The prompt picks the behaviour with a marker:
//   FAKE:quick          one shell tool call, the text PONG, done
//   FAKE:hang:<ms>      an open step with no tool running, silent for <ms>, then done
//   FAKE:tool:<ms>      a shell tool call that runs silently for <ms>, then done
//   FAKE:unknown:<ms>   the same, but `session.messages` fails, so nobody can say which tool runs
//   FAKE:daemon         a tool whose process belongs to "the service" and never ends; `session.interrupt` stops it
//   FAKE:stubborn       the same, but the interrupt does not stop it and the session stays busy
//   FAKE:drop:<n>       the service "restarts" under the run: a transport error and exit 1, for the first <n> runs
//                       in the session; the run after those answers PONG
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

if (/^opencode(\.exe)?$/i.test(basename(process.execPath))) {
  await main();
  await new Promise((r) => process.stdout.write("", r)); // a pipe may still hold the last lines
  process.exit(0);
}

async function main() {
  const dir = process.env.FAKE_DIR;
  const [cmd, ...rest] = [basename(process.argv[1] || ""), ...process.argv.slice(2)];
  for (const d of ["active", "tool", "drop"]) mkdirSync(join(dir, d), { recursive: true });
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

  if (cmd === "api") {
    const op = rest[0];
    const params = Object.fromEntries(rest.flatMap((a, i) => (rest[i - 1] === "--param" ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
    appendFileSync(join(dir, "api.log"), `${op} ${params.sessionID || ""}\n`);
    const ses = params.sessionID;
    if (op === "model.list")
      return out({
        data: [
          { providerID: "fake", id: "model", type: "chat", status: "active", variants: [{ id: "low" }, { id: "high" }], cost: [{ input: 1, output: 1 }], settings: {} },
          { providerID: "lan", id: "local", type: "chat", status: "active", variants: [], cost: [], settings: { baseURL: "http://127.0.0.1:9/v1" } },
        ],
      });
    if (op === "agent.list")
      return out({ data: [{ id: "deepseek-flash", mode: "primary", description: "Fake agent.", model: { providerID: "fake", id: "model" }, permissions: [{ action: "edit", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" }] }] });
    if (op === "model.default") return out({ data: { providerID: "fake", id: "model" } });
    if (op === "session.active") return out({ data: Object.fromEntries(readdirSync(join(dir, "active")).map((s) => [s, { type: "running" }])) });
    if (op === "session.interrupt") {
      const file = join(dir, "active", ses);
      if (!existsSync(file)) return out({ interrupted: false });
      const info = readJson(file);
      if (info.stubborn) return out({ interrupted: false });
      try {
        if (info.pid) process.kill(info.pid);
      } catch {
        // gone already
      }
      rmSync(file, { force: true });
      rmSync(join(dir, "tool", ses), { force: true });
      return out({ interrupted: true });
    }
    if (op === "session.messages" || op === "session.message.list") {
      const file = join(dir, "tool", ses);
      if (!existsSync(file)) return out({ data: [{ type: "assistant", content: [{ type: "text", text: "thinking" }] }], cursor: {} });
      const tool = readJson(file);
      if (tool.fail) process.exit(1);
      return out({
        data: [{ type: "assistant", content: [{ type: "tool", id: "tool_1", name: tool.name, state: { status: "running", input: tool.input, metadata: {} }, time: { created: tool.created, ran: tool.created } }] }],
        cursor: {},
      });
    }
    process.stderr.write(`fake opencode: unknown operation ${op}\n`);
    process.exit(1);
  }

  if (cmd !== "run") {
    process.stderr.write(`fake opencode: unknown command ${cmd}\n`);
    process.exit(1);
  }
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const [, kind = "quick", arg = "0"] = /FAKE:([a-z]+)(?::(\d+))?/.exec(prompt) || [];
  const given = rest.indexOf("--session");
  const ses = given >= 0 ? rest[given + 1] : `ses_fake${process.pid}`;
  const ev = (type, part) => out({ type, timestamp: Date.now(), sessionID: ses, part: { id: `prt_${type}`, sessionID: ses, messageID: "msg_1", ...part } });
  const active = join(dir, "active", ses);
  const toolFile = join(dir, "tool", ses);
  const command = "cargo build --release --manifest-path some/very/long/path/that/goes/on/and/on/and/on/and/on/Cargo.toml --features everything";
  const toolDone = () => ev("tool_use", { type: "tool", tool: "shell", state: { status: "completed", input: { command }, output: "ok", title: "", metadata: {}, time: { start: 1, end: 2 } } });
  const finishStep = (text) => {
    ev("text", { type: "text", text, time: { start: 1, end: 2 } });
    ev("step_finish", { type: "step-finish", reason: "stop", cost: 0.001, tokens: { reasoning: 5 } });
    rmSync(active, { force: true });
    rmSync(toolFile, { force: true });
  };

  const dropFile = join(dir, "drop", ses);
  if (kind === "drop") writeFileSync(dropFile, arg);
  if (!existsSync(active)) writeFileSync(active, "{}"); // a session an earlier run left busy stays as it is
  ev("step_start", { type: "step-start" });
  const drops = existsSync(dropFile) ? Number(readFileSync(dropFile, "utf8")) : 0;
  if (drops > 0) {
    writeFileSync(dropFile, String(drops - 1));
    rmSync(active, { force: true }); // the service that ran it is gone
    out({ type: "error", timestamp: Date.now(), sessionID: ses, error: { type: "unknown", message: "Transport: ECONNRESET: The socket connection was closed unexpectedly." } });
    await new Promise((r) => process.stdout.write("", r));
    process.exit(1);
  }
  if (kind === "drop") return finishStep("PONG");
  if (kind === "quick") {
    toolDone();
    return finishStep("PONG");
  }
  if (kind === "hang") {
    await sleep(Number(arg));
    return finishStep("woke up");
  }
  if (kind === "tool" || kind === "unknown") {
    writeFileSync(toolFile, JSON.stringify({ name: "shell", input: { command }, created: Date.now(), fail: kind === "unknown" }));
    await sleep(Number(arg));
    toolDone();
    return finishStep("built");
  }
  if (kind === "daemon" || kind === "stubborn") {
    // the tool's process: started through a parent that exits at once, so it is no descendant of this `run`
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref()";
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const pid = Number(execFileSync(process.env.FAKE_REAL_NODE, ["-e", script], { env, encoding: "utf8" }).trim());
    writeFileSync(active, JSON.stringify({ pid, stubborn: kind === "stubborn" }));
    writeFileSync(toolFile, JSON.stringify({ name: "shell", input: { command }, created: Date.now() }));
    await sleep(600000);
  }
}
