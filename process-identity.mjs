import { execFile, spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const win = process.platform === "win32";
const run = promisify(execFile);
const sysEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(path|systemroot|windir|temp|tmp|home|userprofile|psmodulepath)$/i.test(k)));
const ps = win && join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const opts = { env: sysEnv, windowsHide: true, timeout: 8000 };
let query, idle;
// Amortize PowerShell startup across a burst of probes. The helper sees only PIDs
// and exits on EOF (including abrupt bridge death) or after inactivity.
function windowsBirth(pid) {
  if (!query) {
    const proc = spawn(ps, ["-NoProfile","-NonInteractive","-Command",
      `while ($null -ne ($line=[Console]::ReadLine())) { try { $p=[Diagnostics.Process]::GetProcessById([int]$line); [Console]::WriteLine($p.StartTime.ToUniversalTime().Ticks); $p.Dispose() } catch [ArgumentException] { [Console]::WriteLine('-') } catch { [Console]::WriteLine('?') } }`],
      { ...opts, timeout: 0, stdio:["pipe","pipe","ignore"] });
    const waiting = [];
    query = { proc, waiting };
    const fail = () => {
      if (query?.proc === proc) query = null;
      while (waiting.length) waiting.shift()("?");
    };
    proc.on("error", fail); proc.stdin.on("error", fail); proc.on("close", fail);
    createInterface({input:proc.stdout}).on("line", l => waiting.shift()?.(l.trim()));
  }
  clearTimeout(idle);
  const q = query;
  q.proc.ref(); q.proc.stdout.ref(); q.proc.stdin.ref();
  return new Promise(resolve => { q.waiting.push(resolve); q.proc.stdin.write(`${pid}\n`); }).then(value => {
    if (!q.waiting.length && q === query) {
      clearTimeout(idle);
      idle = setTimeout(() => { query = null; q.proc.stdin.end(); }, 3000).unref();
      q.proc.unref(); q.proc.stdout.unref(); q.proc.stdin.unref();
    }
    if (value === "-") return null;
    if (!/^\d+$/.test(value)) throw Error("Cannot verify worker process creation time.");
    return value;
  });
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
export async function matches(record) {
  return !!record?.birth && await birth(record.pid) === record.birth;
}
// Only used for unversioned (3.4.0) manifests: distinguish an old server
// that must drain from a reused PID/port. Never adopt it or send its password.
export async function legacyWorker(pid, port) {
  if (!await ownsPort(pid,port)) return false;
  let cmd;
  if (win) {
    const result=await run(ps,["-NoProfile","-NonInteractive","-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],opts);
    cmd=result.stdout;
  } else if (process.platform==="linux") cmd=readFileSync(`/proc/${pid}/cmdline`,"utf8").replaceAll("\0"," ");
  else cmd=(await run("ps",["-o","command=","-p",String(pid)],opts)).stdout;
  return new RegExp(`\\sserve\\s+--service\\s+--hostname\\s+127\\.0\\.0\\.1\\s+--port\\s+${port}$`).test(cmd.replaceAll('"',"").trim());
}
export async function ownsPort(pid, port, peerPort) {
  if (!Number.isSafeInteger(pid) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (win) {
    const {stdout} = await run(join(process.env.SystemRoot,"System32/netstat.exe"), ["-ano","-p","tcp"],opts);
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

// Win32_Process.Create runs in WMI's process tree, outside the calling host's
// kill-on-close job. Pass the environment through stdin, never a command line.
export async function independentNode(script, args, cwd, env) {
  if (!win) {
    const p = spawn(process.execPath,[script,...args],{cwd,env,stdio:"ignore",detached:true});
    await new Promise((ok,fail)=>p.once("spawn",ok).once("error",fail)); p.unref(); return;
  }
  const code = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$j=([Console]::In.ReadToEnd() | ConvertFrom-Json);$s=([wmiclass]'Win32_ProcessStartup').CreateInstance();$s.ShowWindow=0;$s.EnvironmentVariables=[string[]]$j.env;$r=([wmiclass]'Win32_Process').Create($j.cmd,$j.cwd,$s);if($r.ReturnValue -ne 0){exit 1}`;
  const p = spawn(ps,["-NoProfile","-NonInteractive","-Command",code],{...opts,stdio:["pipe","ignore","ignore"]});
  const done = new Promise((ok,fail)=>{p.on("error",fail); p.stdin.on("error",fail); p.on("exit",c=>c===0?ok():fail(Error("Cannot launch independent worker service.")));});
  const cmd = [process.execPath,script,...args].map(s=>`"${s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`).join(" ");
  p.stdin.end(JSON.stringify({cmd,cwd,env:Object.entries(env).map(([k,v])=>`${k}=${v}`)}));
  await done;
}
