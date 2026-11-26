// The worker OpenCode profile. All callers (including Studio's sign-in helper) use the same
// coordinator. Never let automatic CLI discovery start, replace or stop a managed service.
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { request } from "node:http";
import { once } from "node:events";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { birth, independentNode, legacyWorker, matches, ownsPort } from "./process-identity.mjs";

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
  if (!svc?.password || !/^http:\/\/127\.0\.0\.1:\d+$/.test(svc.url) || !await matches(svc))
    throw Error("Worker service listener could not be verified.");
  const port=Number(new URL(svc.url).port), signal=AbortSignal.timeout(timeout);
  const socket=createConnection({host:"127.0.0.1",port,signal});
  socket.on("error",()=>{}); // may close while the OS ownership check is in flight
  try {
    await once(socket,"connect");
    // Authenticate on this exact connection. Checking a listener then opening
    // a second socket would let a port rebound race inherit its Basic header.
    if (!await ownsPort(svc.pid,port,socket.localPort) || !await matches(svc) || socket.destroyed)
      throw Error("Worker service listener could not be verified.");
    const res=await new Promise((ok,fail)=>{
      const req=request(svc.url+path,{method,signal,createConnection:()=>socket,headers:{
        authorization:`Basic ${Buffer.from(`opencode:${svc.password}`).toString("base64")}`,
        "content-type":"application/json",connection:"close",
      }},ok);
      req.on("error",fail); req.end(body ? JSON.stringify(body) : undefined);
    });
    if (res.statusCode<200 || res.statusCode>=300) throw Error(`Worker OpenCode API returned HTTP ${res.statusCode}.`);
    if (res.statusCode===204) return null;
    const chunks=[];
    for await (const chunk of res) chunks.push(chunk);
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Error("Worker OpenCode API returned an invalid response."); }
  } finally { socket.destroy(); }
}
async function listener(address) {
  const server = createServer(socket => socket.destroy());
  await new Promise((ok, fail) => server.once("error", fail).listen({ ...address, exclusive: true }, ok));
  return server;
}
async function locked(action) {
  // Lamport's bakery: per-acquisition, never-reused filenames avoid stealing
  // a successor's lock. Publish choosing (0), then (ticket, unique name).
  const dir = join(root,"admission"), id = randomUUID(), file = join(dir,id);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const self = {pid:process.pid,birth:await selfBirth(), ticket:0};
  const peers = async () => {
    const out = [];
    for (const name of readdirSync(dir)) {
      if (name === id || name.endsWith(".tmp")) continue;
      const path = join(dir,name), rec = optional(path);
      if (!rec) continue;
      if (!await matches(rec)) { rmSync(path,{force:true}); continue; }
      out.push({name,...rec});
    }
    return out;
  };
  atomic(file,self);
  try {
    self.ticket = 1+Math.max(0,...(await peers()).map(x=>x.ticket));
    atomic(file,self);
    // Later contenders necessarily choose a higher ticket.
    for (const until=Date.now()+120000;;) {
      if (!(await peers()).some(x=>!x.ticket || x.ticket<self.ticket || x.ticket===self.ticket && x.name<id)) break;
      if (Date.now()>until) throw Error("Worker profile is blocked by another coordinator.");
      await delay(60);
    }
    return await action();
  } finally { rmSync(file,{force:true}); }
}
let ownBirth;
const selfBirth = () => ownBirth ||= birth(process.pid);
async function healthy(svc, timeout=1500) {
  try { return (await api(svc, "/api/info", { timeout })).pid === svc.pid; } catch { return false; }
}
function publish(svc) {
  const value = { version: 1, env: paths, registration, sourceConfig: src, workers: workerFile, address: svc?.url || null };
  let last;
  try { last=optional(contract); } catch { /* repair derived public state */ }
  if (JSON.stringify(last) !== JSON.stringify(value)) atomic(contract, value);
}
function registered() {
  try { return optional(registration); } catch { return null; } // OpenCode writes in place
}
function endpoint(gen) {
  const r = registered();
  return r?.pid === gen?.pid && r?.url === `http://127.0.0.1:${gen.port}` ? {...r,birth:gen.birth} : null;
}
async function readers(svc) {
  const clients = [], held=new Set(), stale=[];
  for (const f of readdirSync(leases)) {
    if (f.endsWith(".tmp")) continue;
    const file = join(leases,f);
    let rec;
    try { rec = optional(file); } catch { /* legacy empty lease */ }
    if (await matches(rec) || (f.endsWith("-private") && await matches(rec?.child))) {
      clients.push(f); if (rec.session) held.add(rec.session); continue;
    }
    stale.push({file,rec});
  }
  for (const {file,rec} of stale) {
    if ((rec?.session || rec?.title) && !held.has(rec.session)) {
      if (!svc) continue; // replacement services may recover unfinished sessions from jobs.db
      const active = (await api(svc,"/api/session/active")).data;
      let session=rec.session;
      // The bridge may die before `run` emits its first event. A unique
      // pre-recorded title identifies that run without touching other jobs.
      if (!session) for (const id of Object.keys(active)) {
        if (!held.has(id) && (await api(svc,`/api/session/${encodeURIComponent(id)}`)).data?.title===rec.title) { session=id; break; }
      }
      if (session && Object.hasOwn(active,session)) {
        await interrupt(svc,session);
        if (Object.hasOwn((await api(svc,"/api/session/active")).data,session))
          throw Error("Worker service is blocked by a previous session still stopping.");
      } else if (await matches(rec.child)) continue;
    }
    rmSync(file,{force:true});
  }
  return clients;
}
export const interrupt = (svc,id) => api(svc,`/api/session/${encodeURIComponent(id)}/interrupt`,{method:"POST"});
async function stopIdle(svc) {
  if (Object.keys((await api(svc,"/api/session/active")).data).length) return false;
  await promisify(execFile)(exe,["service","stop"],{cwd:root,env:environment(null,root,false),timeout:12000,windowsHide:true});
  for (const end=Date.now()+3000; await matches(svc) && Date.now()<end;) await delay(80);
  return !await matches(svc);
}
// An independent supervisor owns the actual child handle and idle clock even
// after every bridge exits. Admission fences delayed/superseded launch requests.
async function supervise(token) {
  let child, gen;
  await locked(async()=>{
    gen=optional(manifest);
    if (gen?.launch!==token) return;
    // If the supervisor itself is hard-killed between spawn and recording
    // the child's creation time, no successor can know jobs.db is free.
    gen.spawning=true; atomic(manifest,gen);
    child=spawn(exe,["serve","--service","--hostname","127.0.0.1","--port",String(gen.port)],
      {cwd:root,env:environment(null,root),stdio:"ignore",windowsHide:true});
    child.on("error",()=>{});
    gen.pid=child.pid || null; gen.birth=await birth(gen.pid);
    gen.launch=null; delete gen.spawning; atomic(manifest,gen);
  });
  if (!child?.pid || !gen.birth) return;
  const idleMs=Number(process.env.BRIDGE_SERVICE_IDLE_MS)||600000;
  let idleSince=Date.now();
  const stopped=new AbortController();
  child.once("exit",()=>stopped.abort());
  while (child.exitCode===null && child.signalCode===null) {
    try { await delay(Math.min(30000,idleMs),undefined,{signal:stopped.signal}); }
    catch (e) { if (stopped.signal.aborted) return; throw e; }
    try { await locked(async()=>{
      if (!await matches(gen)) return;
      const svc=endpoint(gen);
      if (!svc || (await readers(svc)).length || Object.keys((await api(svc,"/api/session/active")).data).length) idleSince=null;
      else {
        idleSince ??= Date.now();
        if (Date.now()-Math.max(idleSince,statSync(leases).mtimeMs)>=idleMs && await stopIdle(svc)) publish(null);
      }
    }); } catch { idleSince=null; }
  }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url) && process.argv[2]==="supervise")
  await supervise(process.argv[3]);

export async function acquire() {
  let attempted=false, waited=0;
  const deadline=Date.now()+60000;
  const admit=async () => {
    for (const source of [src, join(homedir(), ".config", "opencode")].map(canonical)) {
      const dest = canonical(dst);
      if (inside(source, dest) || inside(dest, source) || inside(source, canonical(root)))
        throw Error("The worker profile and personal config directories must be separate.");
    }
    mkdirSync(leases, { recursive: true, mode: 0o700 });
    let gen=optional(manifest), svc=null, note="";
    if (gen?.spawning) throw Error("Worker launch was interrupted before ownership was recorded. Verify the worker service is stopped before resetting its generation.");
    if (gen?.launch) {
      if (Date.now()-gen.requested<30000) return null;
      gen.launch=null; atomic(manifest,gen); attempted=true;
    }
    if (await matches(gen)) {
      svc=endpoint(gen);
      if (!svc || !await healthy(svc,waited ? 6000 : 1500)) {
        waited++;
        if (Date.now()<deadline) return null;
        throw Error("Worker service is alive but not responding; jobs.db is reserved. Retry when it is ready.");
      }
    } else {
      // An active pre-upgrade listener cannot be adopted on PID alone.
      const r=registered();
      if (!gen?.birth && r?.url===`http://127.0.0.1:${gen?.port}` && await legacyWorker(r.pid,gen.port))
        throw Error("A worker listener without matching creation time still owns the profile port. Close it before retrying.");
      if (gen?.pid) {gen.pid=null; gen.birth=null; atomic(manifest,gen);}
    }
    const clients=await readers(svc);
    let snap;
    try { if (!gen || !clients.length) snap=snapshot(); }
    catch (e) { if (!gen) throw e; note="Worker config could not be refreshed; using its last installed copy."; }
    if (svc && snap && gen.hash !== snap.hash) {
      try { if (await stopIdle(svc)) svc=null; else note="Worker config refresh deferred while the service is busy."; }
      catch { note="Worker service did not confirm an idle stop; config refresh deferred."; if (!await healthy(svc)) return null; }
    }
    if (!svc) {
      if (snap && (!gen || gen.hash !== snap.hash)) {
        install(snap, gen);
        gen = { hash: snap.hash, files: [...snap.files.keys()], pid: null };
        atomic(manifest, gen);
      }
      if (clients.some(f=>f.endsWith("-private"))) note="A standalone worker holds jobs.db; waiting for it to finish.";
      else if (!attempted) {
        attempted=true;
        const sock=await listener({host:"127.0.0.1",port:0}); gen.port=sock.address().port; await new Promise(ok=>sock.close(ok));
        gen.launch=randomUUID(); gen.requested=Date.now(); atomic(manifest,gen);
        const env={...process.env}; delete env.OPENCODE_PASSWORD; delete env.OPENCODE_SERVER_PASSWORD;
        try { await independentNode(fileURLToPath(import.meta.url),["supervise",gen.launch],root,env); return null; }
        catch { gen.launch=null; atomic(manifest,gen); }
      }
      if (!note) note="Worker service failed to start; using standalone for this job.";
      // Do not extend a chain of overlapping private leases indefinitely.
      if (clients.some(f=>f.endsWith("-private"))) {
        if (++waited<100) return null;
        throw Error(note);
      }
    }
    if (!gen) throw Error("Cannot establish ownership of the worker service profile.");
    publish(svc);
    const file = join(leases, `${process.pid}-${randomUUID()}-${svc ? "service" : "private"}`);
    const rec={pid:process.pid,birth:await selfBirth()};
    atomic(file,rec);
    let abandoned=false, released=false;
    return {svc,note, track(session) { if (svc && session!==rec.session) { rec.session=session; atomic(file,rec); } },
      starting(title,session) { if (svc) { Object.assign(rec,{title,session}); atomic(file,rec); } },
      async bindClient(pid) {
        const stamp=await birth(pid); if (!released && !abandoned && stamp) { rec.child={pid,birth:stamp}; atomic(file,rec); }
      },
      abandon() { abandoned=true; atomic(file,{...rec,pid:null}); },
      release() { released=true; if (!abandoned) rmSync(file,{force:true}); }};
  };
  for (;;) {
    const result=await locked(admit);
    if (result) return result;
    await delay(200);
  }
}
export async function using(fn) {
  const lease = await acquire();
  try { return await fn(lease.svc,lease); } finally { lease.release(); }
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
    if (!svc || (await readers(svc)).length !== 1 || Object.keys((await api(svc, "/api/session/active")).data).length)
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
