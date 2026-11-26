// Regression tests for coordination faults. Each process, registration and password is a scratch fake.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { birth } from "../process-identity.mjs";

const base=mkdtempSync(join(tmpdir(),"bridge-coordination-"));
const exe=join(base,process.platform==="win32"?"opencode.exe":"opencode");
try { linkSync(process.execPath,exe); } catch { copyFileSync(process.execPath,exe); }
const home=join(base,"worker"), src=join(base,"src"), root=join(home,"job-service"), fake=join(base,"fake");
Object.assign(process.env,{BRIDGE_JOB_HOME:home, OPENCODE_CONFIG_DIR:src, BRIDGE_JOB_CONFIG_DIR:join(root,"config"),
  OPENCODE_EXE:exe, NODE_OPTIONS:`--import ${new URL("./fake-opencode.mjs",import.meta.url)}`, FAKE_DIR:fake});
const {acquire, api, paths, signInStatus}=await import("../job-service.mjs");
const reg=join(paths.XDG_STATE_HOME,"opencode","service.json"), manifest=join(root,"generation.json"), leases=join(root,"clients");
const json=p=>JSON.parse(readFileSync(p,"utf8")), put=(p,o)=>writeFileSync(p,JSON.stringify(o));
const linked=join(base,"definitions");
mkdirSync(src); mkdirSync(linked); writeFileSync(join(linked,"agent.md"),"linked agent");
symlinkSync(linked,join(src,"agents"),"junction"); symlinkSync(src,join(linked,"cycle"),"junction");
mkdirSync(leases,{recursive:true});
put(join(leases,"reused-private"),{pid:process.pid,birth:"other incarnation"});
const trap=createServer((req,res)=>{requests++; res.writeHead(401).end();});
let requests=0, lease, svc;
await new Promise(ok=>trap.listen(0,"127.0.0.1",ok));
try {
  process.env.FAKE_NO_SERVICE="1";
  lease=await acquire();
  assert.equal(lease.svc,null); assert.match(lease.note,/standalone/);
  assert.equal(readFileSync(join(paths.OPENCODE_CONFIG_DIR,"agents","agent.md"),"utf8"),"linked agent");
  assert.ok(!existsSync(join(leases,"reused-private")));
  lease.release();
  writeFileSync(join(linked,"agent.md"),"new config");
  lease=await acquire(); assert.equal(lease.svc,null); lease.release();
  assert.equal(readFileSync(join(paths.OPENCODE_CONFIG_DIR,"agents","agent.md"),"utf8"),"new config");
  delete process.env.FAKE_NO_SERVICE;

  const port=trap.address().port, stale={pid:process.pid,birth:"wrong",port};
  put(manifest,{...json(manifest),...stale});
  mkdirSync(join(paths.XDG_STATE_HOME,"opencode"),{recursive:true});
  put(reg,{pid:process.pid,url:`http://127.0.0.1:${port}`,password:"placeholder"});
  lease=await acquire(); svc=lease.svc; assert.ok(svc); lease.release();
  assert.notEqual(json(manifest).port,port); assert.equal(requests,0);
  await assert.rejects(api({...svc,url:`http://127.0.0.1:${port}`},"/api/info"),/verified/);
  assert.equal(requests,0,"no Basic header to unrelated listener");

  const valid=readFileSync(reg);
  writeFileSync(reg,"{");
  const restoring=setTimeout(()=>writeFileSync(reg,valid),700);
  try { lease=await acquire(); assert.equal(lease.svc.pid,svc.pid); lease.release(); }
  finally { clearTimeout(restoring); writeFileSync(reg,valid); }
  writeFileSync(join(fake,"slow-probe"),"");
  lease=await acquire(); assert.equal(lease.svc.pid,svc.pid); lease.release();
  rmSync(join(fake,"slow-probe"));

  writeFileSync(join(src,"opencode.json"),"{");
  lease=await acquire(); assert.equal(lease.svc.pid,svc.pid); assert.match(lease.note,/last installed/); lease.release();
  put(join(src,"opencode.json"),{});
  for (const fault of ["active-unavailable","stop-unavailable"]) {
    writeFileSync(join(fake,fault),"");
    lease=await acquire(); assert.equal(lease.svc.pid,svc.pid); assert.match(lease.note,/deferred/); lease.release();
    rmSync(join(fake,fault));
  }
  const ses="ses_fake123";
  put(join(fake,"active",ses),{scope:svc.pid});
  put(join(leases,"lost-service"),{pid:process.pid,birth:"dead incarnation",session:ses});
  lease=await acquire(); svc=lease.svc; lease.release();
  assert.ok(!existsSync(join(fake,"active",ses))); assert.ok(!existsSync(join(leases,"lost-service")));
  assert.equal(signInStatus([{id:"deepseek",connections:[{type:"env"}]}],"deepseek"),"Signed in via environment");
  assert.equal(signInStatus([{id:"deepseek",connections:[]}],"deepseek",new Set(["deepseek"])),"No sign-in required");
  console.log("coordination regression tests passed");
} finally {
  lease?.release();
  if (svc && svc.birth===await birth(svc.pid)) await api(svc,"/test/stop");
  trap.close();
  await delay(250);
  rmSync(base,{force:true,recursive:true,maxRetries:5,retryDelay:200});
}
