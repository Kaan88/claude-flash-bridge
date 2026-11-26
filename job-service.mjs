// The worker OpenCode profile. All callers (including Studio's sign-in helper) use the same
// coordinator. Never let automatic CLI discovery start, replace or stop a managed service.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export function findOpencode() {
  if (process.env.OPENCODE_EXE) return process.env.OPENCODE_EXE;
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  for (const dir of [...(process.env.PATH || "").split(delimiter), join(homedir(), ".local", "bin")].filter(Boolean)) {
    for (const file of [join(dir, "node_modules", "@opencode", "cli", "bin", exe), join(dir, exe)])
      if (existsSync(file)) return file;
  }
  return exe;
}
export const home = resolve(process.env.BRIDGE_JOB_HOME || join(homedir(), ".config", "opencode-bridge"));
const root = join(home, "job-service");
export const paths = {
  OPENCODE_CONFIG_DIR: resolve(process.env.BRIDGE_JOB_CONFIG_DIR || join(root, "config")),
  XDG_STATE_HOME: join(root, "state"),
  XDG_DATA_HOME: join(root, "data"), // in particular, never import a legacy auth.json from personal data
  OPENCODE_DB: join(root, "jobs.db"),
};
const src = resolve(process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode"));
const dst = paths.OPENCODE_CONFIG_DIR;
const registration = join(paths.XDG_STATE_HOME, "opencode", "service.json");
const contract = join(home, "job-service.json");
const manifest = join(root, "generation.json");
const leases = join(root, "clients");
export const workerFile = resolve(process.env.BRIDGE_WORKERS_FILE || join(home, "workers.json"));
const exe = findOpencode();
const json = file => JSON.parse(readFileSync(file, "utf8"));
const optional = file => {
  try { return json(file); } catch (e) { if (e.code === "ENOENT") return null; throw Error(`Invalid worker profile file: ${basename(file)}`); }
};
const atomic = (file, value) => {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
};
const live = pid => {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const magic = "@cortexkit/opencode-magic-context";
export function withoutMagic(config) {
  const isMagic = e => {
    const name = typeof e === "string" ? e : Array.isArray(e) ? e[0] : e?.name || e?.package;
    return name === magic || name?.startsWith?.(`${magic}@`);
  };
  const keys = ["plugins", "plugin"].filter(k => config[k]?.some?.(isMagic));
  if (!keys.length) return null;
  const lean = { ...config, compaction: { ...config.compaction, auto: true } };
  delete lean.compaction.prune;
  for (const k of keys) {
    lean[k] = config[k].filter(e => !isMagic(e));
    if (!lean[k].length) delete lean[k];
  }
  return lean;
}
// Strip comments and trailing commas without changing strings (URLs and instructions often contain both).
function parseConfig(text) {
  const strings = /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  return JSON.parse(text.replace(/^\uFEFF/, "").replace(strings, s => s[0] === '"' ? s : " ")
    .replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, s => s === "," ? "" : s));
}
const skip = /^(auth\.json|service(?:-[\w-]+)?\.json|node_modules|\.git)$|\.(bak|backup)|\.lock$|\.(db|sqlite)(-wal|-shm)?$/i;
function canonical(file) {
  if (existsSync(file)) return realpathSync.native(file);
  const parent = dirname(file);
  if (parent === file) throw Error("Worker profile drive is unavailable.");
  return join(canonical(parent), basename(file));
}
const inside = (dir, file) => {
  const p = relative(dir, file);
  return !p || !(p === ".." || p.startsWith(`..${sep}`) || isAbsolute(p));
};
// Keep literal provider keys in the user's original config only. OpenCode
// expands the references in its private server, just like user-written {env:...}.
function providerSecrets(cfg, name) {
  const values={};
  function visit(obj, path) {
    if (!obj || typeof obj!=="object") return;
    for (const [k,v] of Object.entries(obj)) {
      const parts=[...path,k];
      if (typeof v==="string" && /^(apiKey|api[_-]key|x-api-key|authorization|authToken|accessToken|password)$/i.test(k) && v && !/^\{(?:env|file):[^}]+\}$/.test(v)) {
        const key="BRIDGE_PROVIDER_"+createHash("sha256").update(JSON.stringify([name,...parts])).digest("hex").slice(0,24);
        values[key]=v; obj[k]=`{env:${key}}`;
      } else visit(v,parts);
    }
  }
  for (const k of ["providers","provider"]) visit(cfg[k],[k]);
  return values;
}
function snapshot() {
  const files = new Map(), digest = createHash("sha256").update(JSON.stringify([src, dst]));
  function walk(dir, prefix, parents = new Set()) {
    const real = canonical(dir);
    if (parents.has(real) || [root,dst].some(p=>inside(canonical(p),real) || (prefix && inside(real,canonical(p))))) return;
    parents = new Set([...parents, real]);
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(prefix, e.name), file = join(dir, e.name);
      if (skip.test(e.name)) continue;
      const entry = e.isSymbolicLink() ? statSync(file, {throwIfNoEntry:false}) : e;
      if (e.isSymbolicLink() && entry && (skip.test(basename(canonical(file))) ||
          [root,dst].some(dir=>inside(canonical(dir),canonical(file))))) continue;
      if (entry?.isDirectory()) { walk(file, name, parents); continue; }
      if (!entry?.isFile()) continue;
      let bytes = readFileSync(file);
      if (/^opencode\.jsonc?$/.test(name)) {
        let cfg;
        try { cfg = parseConfig(bytes.toString()); } catch { throw Error(`Could not parse ${name} for workers.`); }
        const lean = withoutMagic(cfg), doc=lean || cfg;
        const values=providerSecrets(doc,name);
        digest.update(JSON.stringify(values));
        if (lean || Object.keys(values).length) bytes = Buffer.from(JSON.stringify(doc, null, 2) + "\n");
      }
      digest.update(JSON.stringify([name, bytes.length])).update(bytes);
      files.set(name, bytes);
    }
  }
  if (existsSync(src)) walk(src, "");
  return { files, hash: digest.digest("hex") };
}
function install(snap, previous) {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const name of previous?.files || []) {
    if (!snap.files.has(name) && inside(canonical(dst), canonical(dirname(join(dst, name)))) && !skip.test(name))
      rmSync(join(dst, name), { force: true });
  }
  for (const [name, bytes] of snap.files) {
    const file = join(dst, name);
    if (!inside(canonical(dst), canonical(dirname(file)))) throw Error("Unexpected link in the generated worker config.");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 }); renameSync(tmp, file);
  }
}
export function environment(svc, cwd, loadKeys=!svc) {
  const env = { ...process.env, ...paths, PWD: cwd };
  // Credentials for this connection only; don't inherit a calling OpenCode client's endpoint.
  for (const key of ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SESSION_ID", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"]) delete env[key];
  if (svc || !loadKeys) for (const k of Object.keys(env))
    if (/(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN)$|^BRIDGE_PROVIDER_/i.test(k)) delete env[k];
  if (svc) env.OPENCODE_PASSWORD = svc.password;
  if (loadKeys) for (const name of ["opencode.json","opencode.jsonc"]) {
    const file=join(src,name);
    if (!existsSync(file)) continue;
    try { Object.assign(env,providerSecrets(parseConfig(readFileSync(file,"utf8")),name)); }
    catch { /* a malformed edit can still use the last installed worker config */ }
  }
  return env;
}
export const targetArgs = svc => svc ? ["--server", svc.url] : ["--standalone"];
export async function api(svc, path, { method = "GET", body, timeout = 8000 } = {}) {
  if (!svc || !/^http:\/\/127\.0\.0\.1:\d+$/.test(svc.url) || !svc.password) throw Error("Worker service is unavailable.");
  const res = await fetch(svc.url + path, { method, redirect: "error", signal: AbortSignal.timeout(timeout),
    headers: { authorization: `Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) throw Error(`Worker OpenCode API returned HTTP ${res.status}.`); // response bodies can hold secrets
  return res.status === 204 ? null : res.json();
}
// A kernel-held cross-process lock: no stale lock to steal on crash. A Windows named pipe,
// or a loopback listener on Unix. It accepts no commands and is never a service address.
const lockID = createHash("sha256").update(canonical(root).toLowerCase()).digest("hex");
const lockAddress = process.platform === "win32" ? { path: `\\\\.\\pipe\\opencode-bridge-${lockID}` }
  : { host: "127.0.0.1", port: 18000 + parseInt(lockID.slice(0, 4), 16) % 10000 };
async function listener(address) {
  const server = createServer(socket => socket.destroy());
  await new Promise((ok, fail) => server.once("error", fail).listen({ ...address, exclusive: true }, ok));
  return server;
}
async function locked(action) {
  let lock;
  for (const until = Date.now() + 30000; !lock;) {
    try { lock = await listener(lockAddress); }
    catch (e) { if (e.code !== "EADDRINUSE" || Date.now() >= until) throw Error("Worker service coordinator lock unavailable."); await delay(60); }
  }
  try { return await action(); } finally { await new Promise(ok => lock.close(ok)); }
}
async function healthy(svc) {
  try { return (await api(svc, "/api/info", { timeout: 1500 })).pid === svc.pid; } catch { return false; }
}
function publish(svc) {
  const value = { version: 1, env: paths, registration, sourceConfig: src, workers: workerFile, address: svc?.url || null };
  if (JSON.stringify(optional(contract)) !== JSON.stringify(value)) atomic(contract, value);
}
async function start(gen) {
  // Reuse the same port across crashes: even if a bridge dies between spawn and recording the
  // PID, a successor cannot start another listening service while the first is registering.
  const child = spawn(exe, ["serve", "--service", "--hostname", "127.0.0.1", "--port", String(gen.port)],
    { env: environment(null, root), cwd: root, stdio: "ignore", windowsHide: true, detached: true });
  let failed = false;
  child.once("error", () => { failed = true; }); child.unref();
  gen.pid = child.pid || null; atomic(manifest, gen);
  for (const until = Date.now() + 12000; !failed && child.exitCode === null && Date.now() < until;) {
    const svc = optional(registration);
    if (svc?.pid === child.pid && await healthy(svc)) return svc;
    await delay(100);
  }
  if (child.pid && child.exitCode === null) child.kill();
  return null;
}
function readers() {
  return readdirSync(leases).filter(f => {
    if (live(Number(f.split("-")[0]))) return true;
    rmSync(join(leases, f), { force: true }); return false;
  });
}
export async function acquire() {
  return locked(async () => {
    for (const source of [src, join(homedir(), ".config", "opencode")].map(canonical)) {
      const dest = canonical(dst);
      if (inside(source, dest) || inside(dest, source) || inside(source, canonical(root)))
        throw Error("The worker profile and personal config directories must be separate.");
    }
    mkdirSync(leases, { recursive: true, mode: 0o700 });
    const clients = readers();
    let gen = optional(manifest), reg = optional(registration);
    let svc = reg && gen?.pid === reg.pid && live(reg.pid) && await healthy(reg) ? reg : null;
    const snap = !gen || !clients.length ? snapshot() : null;
    if (svc && snap && gen.hash !== snap.hash) {
      const active = (await api(svc, "/api/session/active")).data;
      if (active && !Object.keys(active).length) {
        // Authenticated PID + private registration + our recorded child. Never stop a process
        // merely because a stale PID is alive, or because its health probe timed out.
        await promisify(execFile)(exe, ["service", "stop"], { cwd: root, env: environment(null, root), timeout: 12000, windowsHide: true });
        for (const end = Date.now() + 2000; live(svc.pid) && Date.now() < end;) await delay(50);
        svc = null;
      }
    }
    const blocked = live(gen?.pid) || live(reg?.pid);
    if (!svc && !blocked && !clients.some(f => f.endsWith("-private"))) {
      if (snap && (!gen || gen.hash !== snap.hash)) {
        const port = gen?.port || await (async () => { const sock = await listener({host:"127.0.0.1",port:0}); const n = sock.address().port; await new Promise(ok => sock.close(ok)); return n; })();
        install(snap, gen);
        gen = { hash: snap.hash, files: [...snap.files.keys()], port, pid: null };
        atomic(manifest, gen);
      }
      svc = await start(gen);
    }
    if (!gen) throw Error("Cannot establish ownership of the worker service profile.");
    publish(svc);
    const file = join(leases, `${process.pid}-${randomUUID()}-${svc ? "service" : "private"}`);
    writeFileSync(file, "", { flag: "wx" });
    return { svc, release: () => rmSync(file, { force: true }) };
  });
}
export async function using(fn) {
  const lease = await acquire();
  try { return await fn(lease.svc); } finally { lease.release(); }
}
// Use the integration list, NOT credential.list/auth export (those can return secret values).
export async function integrations(svc, cwd) {
  if (svc) {
    await warm(svc, cwd);
    return (await api(svc, `/api/integration?directory=${encodeURIComponent(cwd)}`)).data;
  }
  // auth list itself waits for cold provider plugins, unlike `api integration.list`.
  const { stdout } = await promisify(execFile)(exe, ["auth", "list", "--format", "json", "--standalone"],
    { env: environment(null, cwd), cwd, timeout: 15000, windowsHide: true, maxBuffer: 8e6 });
  const result = JSON.parse(stdout); return result.data ?? result;
}
export async function warm(svc, cwd) {
  // Same cold-location barrier as v2.4.1's auth list. Otherwise a fresh service
  // transiently reports zero integrations, even when this DB has saved keys.
  for (const until = Date.now() + 5000; Date.now() < until;) {
    if ((await api(svc, `/api/plugin?directory=${encodeURIComponent(cwd)}`)).data?.length) break;
    await delay(50);
  }
}
// `auth list` excludes providers supplied solely by config. Consult the
// warmed model catalog before refusing one, including project overrides.
export async function availableProviders(svc,cwd) {
  if (svc) return new Set((await api(svc,`/api/model?directory=${encodeURIComponent(cwd)}`)).data.map(m=>m.providerID));
  const {stdout}=await promisify(execFile)(exe,["models","--standalone"],{cwd,env:environment(null,cwd),timeout:20000,windowsHide:true,maxBuffer:8e6});
  return new Set(stdout.split(/\r?\n/).filter(l=>l.includes("/")).map(l=>l.split("/")[0]));
}
export function signInStatus(rows, provider, available) {
  const row = rows.find(r => r.id === provider);
  if (row?.connections?.some(c=>c.type==="env")) return "Signed in via environment";
  const selected = row?.connections?.find(c => c.type === "credential");
  if (selected?.status?.status === "needs_auth") return "Sign in again";
  if (selected) return "Signed in";
  if (available?.has(provider)) return "No sign-in required";
  if (row?.methods?.length || row?.connections?.length || ["openai", "deepseek", "anthropic"].includes(provider)) return "Missing";
  return "No sign-in required";
}
export function configModel(agent) {
  const files = ["opencode.json", "opencode.jsonc"].map(n => join(dst, n)).filter(existsSync);
  let model, agentModel;
  for (const file of files) {
    const cfg = parseConfig(readFileSync(file, "utf8"));
    model = cfg.model ?? model;
    agentModel = (cfg.agents || cfg.agent)?.[agent]?.model ?? agentModel;
  }
  const ref = agentModel || model;
  return (typeof ref === "string" ? ref : ref?.providerID && (ref.id || ref.model) ? `${ref.providerID}/${ref.id || ref.model}` : "").split("#")[0];
}

// Explicit, bounded retention: only old archived histories, only in our DB, under
// the admission lock so a queued continuation cannot start during a deletion.
export async function pruneArchived(days) {
  if (!Number.isInteger(days) || days < 1) throw Error("Specify a positive number of days.");
  return using(svc => locked(async () => {
    if (!svc || readers().length !== 1 || Object.keys((await api(svc, "/api/session/active")).data).length)
      throw Error("Prune needs an idle worker service.");
    const rows = (await api(svc, "/api/session?archived=true&order=asc&limit=100")).data;
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (const s of rows) {
      if (!s.time?.archived || !(s.time.updated < cutoff && s.time.archived < cutoff)) continue;
      const id = encodeURIComponent(s.id);
      // OpenCode removal cascades. Never delete a younger or unarchived child.
      if ((await api(svc, `/api/session?parentID=${id}&limit=1`)).data.length) continue;
      await api(svc, `/api/session/${id}`, { method: "DELETE" });
      n++;
    }
    return n;
  }));
}
