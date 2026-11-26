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
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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

  const state = process.env.XDG_STATE_HOME, db = process.env.OPENCODE_DB;
  const regFile = state && join(state, "opencode", "service.json");
  const missing = db && `${db}.missing`;
  const scope = cmd === "serve" ? process.pid : rest.includes("--server") ? readJson(regFile).pid : rest.includes("--standalone") ? process.pid : "personal";
  const belongs = file => { try { return readJson(file).scope === scope; } catch { return false; } };
  const rows = () => ["fake", "deepseek", "openai"].map(id => ({ id, methods: [{ type: "key" }],
    connections: existsSync(missing) && readFileSync(missing, "utf8") === id ? [] : [{ type: "credential" }] }));
  function operation(op, params, out) {
    appendFileSync(join(dir, "api.log"), `${op} ${params.sessionID || ""}\n`);
    const ses = params.sessionID;
    if (op === "integration.list") return out({data:rows()});
    if (op === "model.list")
      return out({
        data: [
          { providerID: "fake", id: "model", type: "chat", status: "active", variants: [{ id: "low" }, { id: "high" }], cost: [{ input: 1, output: 1 }], settings: {} },
          { providerID: "lan", id: "local", type: "chat", status: "active", variants: [], cost: [], settings: { baseURL: "http://127.0.0.1:9/v1" } },
        ].filter(m => !existsSync(missing) || m.providerID !== readFileSync(missing,"utf8")),
      });
    if (op === "agent.list")
      return out({ data: [{ id: "deepseek-flash", mode: "primary", description: "Fake agent.", model: { providerID: "fake", id: "model" }, permissions: [{ action: "edit", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" }] }] });
    if (op === "model.default") return out({ data: { providerID: "fake", id: "model" } });
    if (op === "session.active") return out({ data: Object.fromEntries(readdirSync(join(dir, "active")).filter(s => belongs(join(dir,"active",s))).map((s) => [s, { type: "running" }])) });
    if (op === "session.interrupt") {
      const file = join(dir, "active", ses);
      if (!belongs(file)) return out({ interrupted: false });
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
      if (!belongs(join(dir,"active",ses)) || !existsSync(file)) return out({ data: [{ type: "assistant", content: [{ type: "text", text: "thinking" }] }], cursor: {} });
      const tool = readJson(file);
      if (tool.fail) throw Error("tool unavailable");
      return out({
        data: [{ type: "assistant", content: [{ type: "tool", id: "tool_1", name: tool.name, state: { status: "running", input: tool.input, metadata: {} }, time: { created: tool.created, ran: tool.created } }] }],
        cursor: {},
      });
    }
    throw Error(`fake opencode: unknown operation ${op}`);
  }
  if (cmd === "serve") {
    if (process.env.FAKE_NO_SERVICE) process.exit(1);
    const password = randomUUID();
    const http = createServer(async (req, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
        res.writeHead(401).end(); return;
      }
      const url = new URL(req.url, "http://localhost"), path = url.pathname;
      const send = o => res.end(JSON.stringify(o));
      try {
        if (path === "/api/info") {
          if (existsSync(join(dir,"slow-probe"))) await sleep(1900);
          return send({pid:process.pid});
        }
        if (path === "/api/plugin") return send({data:[{id:"fake"}]});
        if (path === "/api/integration") return send({data:rows()});
        if (path === "/api/agent") return operation("agent.list", {}, send);
        if (path === "/api/model") return operation("model.list", {}, send);
        if (path === "/api/model/default") return operation("model.default", {}, send);
        if (/^\/api\/integration\/[\w.-]+\/connect\/key$/.test(path)) {
          let body = ""; for await (const chunk of req) body += chunk;
          if (!JSON.parse(body).key) throw Error();
          rmSync(missing, {force:true}); res.writeHead(204).end(); return;
        }
        if (path === "/test/stop") {
          rmSync(regFile, {force:true}); send({}); setImmediate(() => process.exit(0)); return;
        }
        if (path === "/api/session/active") {
          if (existsSync(join(dir,"active-unavailable"))) return res.writeHead(503).end();
          return operation("session.active", {}, send);
        }
        const history = `${db}.sessions`;
        if (path === "/api/session") {
          const all = existsSync(history) ? readJson(history) : [];
          return send({data:all.filter(s => url.searchParams.has("parentID") ? s.parentID === url.searchParams.get("parentID") : s.time.archived)});
        }
        if (req.method === "DELETE" && path.startsWith("/api/session/")) {
          writeFileSync(history,JSON.stringify(readJson(history).filter(s => s.id !== path.split("/").at(-1))));
          res.writeHead(204).end(); return;
        }
        const match = path.match(/^\/api\/session\/(ses_fake\d+)\/(interrupt|message)$/);
        if (match) return operation(match[2] === "interrupt" ? "session.interrupt" : "session.message.list", {sessionID:match[1]}, send);
        res.writeHead(404).end();
      } catch { res.writeHead(503).end(); }
    });
    await new Promise(r => http.listen(Number(rest[rest.indexOf("--port")+1]), "127.0.0.1", r));
    mkdirSync(dirname(regFile), {recursive:true});
    writeFileSync(regFile, JSON.stringify({url:`http://127.0.0.1:${http.address().port}`, pid:process.pid, password}));
    appendFileSync(join(dir, "services.log"), `${JSON.stringify({db,pid:process.pid})}\n`);
    await new Promise(() => {});
  }
  if (cmd === "service" && rest[0] === "stop") {
    if (existsSync(join(dir,"stop-unavailable"))) process.exit(1);
    const s = readJson(regFile);
    await fetch(s.url+"/test/stop",{headers:{authorization:`Basic ${Buffer.from("opencode:"+s.password).toString("base64")}`}});
    return;
  }
  if (db && ["api","auth","run"].includes(cmd) && !rest.includes("--standalone")) {
    const s = readJson(regFile);
    if (!rest.includes("--server") || rest[rest.indexOf("--server")+1] !== s.url || s.password !== process.env.OPENCODE_PASSWORD)
      throw Error("client targeted the wrong service");
  }
  if (cmd === "auth") {
    if (rest.includes("--format")) return out(rows().filter(r => r.connections.length));
    appendFileSync(join(dir,"auth.log"), JSON.stringify({action:rest[0], provider:rest[1], db})+"\n");
    return;
  }
  if (cmd === "models") {
    operation("model.list",{},r=>process.stdout.write(r.data.map(m=>`${m.providerID}/${m.id}`).join("\n")));
    return;
  }
  if (cmd === "api") {
    const params = Object.fromEntries(rest.flatMap((a, i) => (rest[i - 1] === "--param" ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
    return operation(rest[0], params, out);
  }

  if (cmd !== "run") {
    process.stderr.write(`fake opencode: unknown command ${cmd}\n`);
    process.exit(1);
  }
  appendFileSync(join(dir, "run.log"), JSON.stringify({ args: rest, db, configDir: process.env.OPENCODE_CONFIG_DIR || "" }) + "\n");
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
  if (kind === "drop" || kind === "busy") writeFileSync(dropFile, arg);
  if (!existsSync(active)) writeFileSync(active, JSON.stringify({scope})); // a session an earlier run left busy stays as it is
  ev("step_start", { type: "step-start" });
  const drops = existsSync(dropFile) ? Number(readFileSync(dropFile, "utf8")) : 0;
  if (drops > 0) {
    writeFileSync(dropFile, String(drops - 1));
    if (kind==="busy") writeFileSync(active,JSON.stringify({scope,stubborn:true}));
    else rmSync(active, { force: true }); // the service that ran it is gone
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
    writeFileSync(active, JSON.stringify({ pid, scope, stubborn: kind === "stubborn" }));
    writeFileSync(toolFile, JSON.stringify({ name: "shell", input: { command }, created: Date.now() }));
    await sleep(600000);
  }
}
