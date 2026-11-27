import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const win = process.platform === "win32";
const run = promisify(execFile);
const sysEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(path|systemroot|windir|temp|tmp|home|userprofile|psmodulepath)$/i.test(k)));
const ps = win && join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const opts = { env: sysEnv, windowsHide: true, timeout: 8000 };
// Cache a promise, but never its failure: one bad probe must not fail every later caller.
export const memo = fn => { let p; return () => p ||= fn().catch(e => { p = null; throw e; }); };
// A long-lived child that answers one line per line asked. It amortizes its startup across a
// burst of questions and exits on EOF (including abrupt bridge death) or after inactivity.
// Answers are positional, so a helper that fails or stops answering is dropped whole and every
// waiter gets "?".
export function lineHelper(file, args, options = {}, timeout = 8000) {
  let query, idle;
  return line => {
    if (!query) {
      const proc = spawn(file, args, { ...options, stdio:["pipe","pipe","ignore"] });
      const waiting = [];
      const q = query = { proc, waiting, fail() {
        if (query === q) query = null;
        proc.kill();
        while (waiting.length) waiting.shift()("?");
      } };
      proc.on("error", q.fail); proc.stdin.on("error", q.fail); proc.on("close", q.fail);
      createInterface({input:proc.stdout}).on("line", l => waiting.shift()?.(l.trim()));
    }
    clearTimeout(idle);
    const q = query;
    q.proc.ref(); q.proc.stdout.ref(); q.proc.stdin.ref();
    return new Promise(resolve => {
      const timer = setTimeout(q.fail, timeout);
      q.waiting.push(value => { clearTimeout(timer); resolve(value); });
      q.proc.stdin.write(`${line}\n`);
    }).then(value => {
      if (!q.waiting.length && q === query) {
        clearTimeout(idle);
        idle = setTimeout(() => { query = null; q.proc.stdin.end(); }, 3000).unref();
        q.proc.unref(); q.proc.stdout.unref(); q.proc.stdin.unref();
      }
      return value;
    });
  };
}
// The helper sees only PIDs. Process.StartTime needs a handle this user may not get (another
// user's process, or an elevated one); CIM still knows such a process's creation time, to the
// microsecond: "~ticks". "-" is no such process, "x" one whose time nothing can tell.
const askBirth = win && lineHelper(ps, ["-NoProfile","-NonInteractive","-Command",
  `while ($null -ne ($line=[Console]::ReadLine())) { try { $id=[int]$line; $p=[Diagnostics.Process]::GetProcessById($id); try { $t=$p.StartTime.ToUniversalTime().Ticks; [Console]::WriteLine($t) } catch { $c=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -Property CreationDate -ErrorAction Stop; if ($null -eq $c) { [Console]::WriteLine('-') } elseif ($null -eq $c.CreationDate) { [Console]::WriteLine('x') } else { [Console]::WriteLine('~' + $c.CreationDate.ToUniversalTime().Ticks) } } finally { $p.Dispose() } } catch [ArgumentException] { [Console]::WriteLine('-') } catch { [Console]::WriteLine('?') } }`],
  { ...opts, timeout: 0 });
async function windowsBirth(pid) {
  const value = await askBirth(pid);
  // A process nobody can date is not one this bridge started.
  if (value === "-" || value === "x") return null;
  if (!/^~?\d+$/.test(value)) throw Error("Cannot verify worker process creation time.");
  return value;
}
export async function birth(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") return null; }
  if (win) return windowsBirth(pid);
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
      if (fields[0]==="Z" || fields[0]==="X") return null;
      return readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()+":"+fields[19];
    } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  try { return (await run("ps", ["-o","lstart=","-p",String(pid)],opts)).stdout.trim() || null; }
  catch (e) { if (e.code === 1) return null; throw Error("Cannot verify worker process creation time."); }
}
// An approximate ("~", microseconds) time equals an exact one that truncates to it.
const coarse = stamp => stamp.replace(/^~/, "").slice(0, -1);
export const sameBirth = (a, b) => !!a && !!b && (a === b ||
  ((a[0] === "~" || b[0] === "~") && /^~?\d+$/.test(a) && /^~?\d+$/.test(b) && coarse(a) === coarse(b)));
export async function matches(record) {
  return !!record?.birth && sameBirth(await birth(record.pid), record.birth);
}
async function commandLine(pid) {
  if (win) return (await run(ps,["-NoProfile","-NonInteractive","-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],opts)).stdout;
  if (process.platform==="linux") return readFileSync(`/proc/${pid}/cmdline`,"utf8").replaceAll("\0"," ");
  return (await run("ps",["-o","command=","-p",String(pid)],opts)).stdout;
}
// A 3.4.0 bridge left only an empty lease named after its PID. Tell a live one from a reused PID.
export async function legacyBridge(pid) {
  try {
    return !!await birth(pid) && /(^|[\\/\s"'])(server|bridge-auth)\.mjs(["'\s]|$)/.test(await commandLine(pid));
  } catch { return false; }
}
// Only used for unversioned (3.4.0) manifests: distinguish an old server
// that must drain from a reused PID/port. Never adopt it or send its password.
export async function legacyWorker(pid, port) {
  if (!await ownsPort(pid,port)) return false;
  const cmd=await commandLine(pid);
  return new RegExp(`\\sserve\\s+--service\\s+--hostname\\s+127\\.0\\.0\\.1\\s+--port\\s+${port}$`).test(cmd.replaceAll('"',"").trim());
}
export async function ownsPort(pid, port, peerPort) {
  if (!Number.isSafeInteger(pid) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (win) {
    // A busy machine's connection table passes execFile's default 1 MB.
    const {stdout} = await run(join(process.env.SystemRoot,"System32/netstat.exe"), ["-ano","-p","tcp"],{...opts,maxBuffer:64*1024*1024});
    return stdout.split("\n").some(l => {
      const [proto, local, peer,, owner] = l.trim().split(/\s+/);
      return proto === "TCP" && local === `127.0.0.1:${port}` &&
        peer === (peerPort ? `127.0.0.1:${peerPort}` : "0.0.0.0:0") && Number(owner) === pid;
    });
  }
  if (process.platform === "linux") {
    const addr = p=>"0100007F:"+p.toString(16).padStart(4,"0").toUpperCase();
    const inode = readFileSync("/proc/net/tcp","utf8").split("\n").map(l=>l.trim().split(/\s+/))
      .find(c=>c[1]===addr(port) && (peerPort ? c[3]==="01" && c[2]===addr(peerPort) : c[3]==="0A"))?.[9];
    return !!inode && readdirSync(`/proc/${pid}/fd`).some(f=>{
      try { return readlinkSync(`/proc/${pid}/fd/${f}`) === `socket:[${inode}]`; } catch { return false; }
    });
  }
  try {
    const state=peerPort ? "ESTABLISHED" : "LISTEN";
    const {stdout}=await run("lsof",["-nP","-a","-p",String(pid),`-iTCP@127.0.0.1:${port}`,`-sTCP:${state}`,"-Fn"],opts);
    return stdout.split("\n").includes(`n127.0.0.1:${port}`+(peerPort?`->127.0.0.1:${peerPort}`:""));
  }
  catch { return false; }
}

// Win32_Process.Create runs in WMI's process tree, outside the calling host's kill-on-close job.
// PowerShell is given only the command line, the folder and the system variables, as raw text
// that no cmdlet touches (module logging records what cmdlets are given). The real environment,
// provider keys included, goes from this process straight to the new one over loopback: once,
// and only for a one-time token.
export const launchRequest = (script, args, cwd) => [
  [process.execPath,script,...args].map(s=>`"${s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`).join(" "),
  cwd, ...Object.entries(sysEnv).map(([k,v])=>`${k}=${v}`)].join("\0");
export async function offerEnvironment(env, timeout = 20000) {
  const token = randomBytes(32).toString("hex");
  let served = false, done;
  const taken = new Promise(ok => { done = ok; });
  const server = createServer(socket => {
    let got = "";
    socket.setEncoding("utf8"); socket.on("error",()=>{});
    socket.on("data", chunk => {
      got += chunk;
      if (got.length > token.length + 2) return socket.destroy();
      if (!got.endsWith("\n")) return;
      const sent = Buffer.from(got.trim());
      if (served || sent.length !== token.length || !timingSafeEqual(sent, Buffer.from(token))) return socket.destroy();
      served = true;
      socket.end(JSON.stringify(env), () => done(true));
    });
  });
  await new Promise((ok,fail)=>server.once("error",fail).listen({host:"127.0.0.1",port:0,exclusive:true},ok));
  const timer = setTimeout(() => done(false), timeout);
  return { port: server.address().port, token, taken, close() { clearTimeout(timer); done(false); server.close(); } };
}
export async function takeEnvironment(port, token) {
  const socket = createConnection({host:"127.0.0.1",port:Number(port)});
  socket.setEncoding("utf8");
  let text = "";
  await new Promise((ok,fail)=>{
    socket.on("error",fail).on("data",d=>{text+=d;}).on("end",ok).on("connect",()=>socket.write(token+"\n"));
  });
  const env = JSON.parse(text);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
}
export async function independentNode(script, args, cwd, env) {
  if (!win) {
    const p = spawn(process.execPath,[script,...args],{cwd,env,stdio:"ignore",detached:true});
    await new Promise((ok,fail)=>p.once("spawn",ok).once("error",fail)); p.unref(); return;
  }
  const offer = await offerEnvironment(env);
  try {
    const code = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$p=[Console]::In.ReadToEnd().Split([char]0);$s=([wmiclass]'Win32_ProcessStartup').CreateInstance();$s.ShowWindow=0;$s.EnvironmentVariables=[string[]]($p[2..($p.Length-1)]);$r=([wmiclass]'Win32_Process').Create($p[0],$p[1],$s);if($r.ReturnValue -ne 0){exit 1}`;
    const p = spawn(ps,["-NoProfile","-NonInteractive","-Command",code],{...opts,timeout:20000,stdio:["pipe","ignore","ignore"]});
    const done = new Promise((ok,fail)=>{p.on("error",fail); p.stdin.on("error",fail); p.on("exit",c=>c===0?ok():fail(Error("Cannot launch independent worker service.")));});
    p.stdin.end(launchRequest(script,[...args,String(offer.port),offer.token],cwd));
    await done;
    if (!await offer.taken) throw Error("Cannot launch independent worker service.");
  } finally { offer.close(); }
}
