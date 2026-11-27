// Regression tests for coordination faults. Each process, registration and password is a scratch fake.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { birth, launchRequest, lineHelper, matches, memo, offerEnvironment, sameBirth } from "../process-identity.mjs";

const base=mkdtempSync(join(tmpdir(),"bridge-coordination-"));
const exe=join(base,process.platform==="win32"?"opencode.exe":"opencode");
try { linkSync(process.execPath,exe); } catch { copyFileSync(process.execPath,exe); }
const home=join(base,"worker"), src=join(base,"src"), root=join(home,"job-service"), fake=join(base,"fake");
Object.assign(process.env,{BRIDGE_JOB_HOME:home, OPENCODE_CONFIG_DIR:src, BRIDGE_JOB_CONFIG_DIR:join(root,"config"),
  OPENCODE_EXE:exe, FAKE_MARK:"handed over", NODE_OPTIONS:`--import ${new URL("./fake-opencode.mjs",import.meta.url)}`, FAKE_DIR:fake});
const {acquire, api, atomic, availableProviders, configSignIn, paths, signInStatus}=await import("../job-service.mjs");
const until=async(what,fn,ms=20000)=>{
  for (const end=Date.now()+ms; Date.now()<end; await delay(100)) { const v=await fn(); if (v) return v; }
  throw Error("timed out waiting for "+what);
};
const node=(...args)=>spawn(process.execPath,args,{stdio:"ignore",env:{...process.env,NODE_OPTIONS:""}});
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
  assert.equal(signInStatus([{id:"deepseek",connections:[]}],"deepseek",new Map([["deepseek",true]])),"No sign-in required");

  // A process whose creation time this user cannot read exactly is dated approximately, never an error.
  assert.ok(sameBirth("639313328597334684","~639313328597334680") && sameBirth("~10","19") && !sameBirth("~10","20") && !sameBirth("11","12") && !sameBirth(null,null));
  if (process.platform==="win32") assert.equal(await matches({pid:4,birth:"1"}),false);
  let calls=0; const flaky=memo(async()=>{ if (!calls++) throw Error("once"); return "stamp"; });
  await assert.rejects(flaky()); assert.equal(await flaky(),"stamp"); assert.equal(await flaky(),"stamp"); assert.equal(calls,2);
  const silent=lineHelper(process.execPath,["-e","setInterval(()=>{},1000)"],{env:{...process.env,NODE_OPTIONS:""}},400);
  let asked=Date.now(); assert.deepEqual(await Promise.all([silent(1),silent(2)]),["?","?"]); assert.ok(Date.now()-asked<3000);
  const echo=lineHelper(process.execPath,["-e","require('readline').createInterface({input:process.stdin}).on('line',l=>console.log('got '+l))"],{env:{...process.env,NODE_OPTIONS:""}});
  assert.deepEqual(await Promise.all([echo(1),echo(2)]),["got 1","got 2"]);

  // Replacing a file that other processes keep reading (Windows refuses for an instant).
  const busy=join(base,"busy.json"); put(busy,{});
  const loop="const fs=require('fs');for(const end=Date.now()+2500;Date.now()<end;){try{JSON.parse(fs.readFileSync(process.argv[1],'utf8'))}catch{}}";
  const readers=[node("-e",loop,busy),node("-e",loop,busy)];
  await delay(300);
  for (let n=0;n<400;n++) atomic(busy,{n});
  await Promise.all(readers.map(p=>new Promise(ok=>p.once("exit",ok))));
  assert.deepEqual(json(busy),{n:399}); assert.deepEqual(readdirSync(base).filter(f=>f.endsWith(".tmp")),[]);

  // The environment reaches the supervisor from the bridge itself, once, for the token; the launcher is given no secret.
  assert.equal(readFileSync(join(fake,"services.log"),"utf8").trim().split("\n").map(l=>JSON.parse(l).mark).at(-1),"handed over");
  const [, cwd, ...vars]=launchRequest("s.mjs",["a"],"C:\\x").split("\0");
  assert.equal(cwd,"C:\\x"); assert.ok(vars.every(v=>/^(path|systemroot|windir|temp|tmp|home|userprofile|psmodulepath)=/i.test(v)),vars.join());
  const offer=await offerEnvironment({SECRET_API_KEY:"s3cret"});
  const take=token=>new Promise(ok=>execFile(process.execPath,["--input-type=module","-e",
    "import {takeEnvironment} from "+JSON.stringify(new URL("../process-identity.mjs",import.meta.url).href)+";await takeEnvironment(process.argv[1],process.argv[2]);console.log(Object.keys(process.env).length,process.env.SECRET_API_KEY)",
    String(offer.port),token],{encoding:"utf8",env:{...process.env,NODE_OPTIONS:""}},(error,stdout)=>ok({error,stdout})));
  assert.ok((await take("0".repeat(64))).error,"a wrong token gets nothing");
  assert.equal((await take(offer.token)).stdout.trim(),"1 s3cret"); assert.equal(await offer.taken,true);
  assert.ok((await take(offer.token)).error,"served once"); offer.close();

  // The catalog lists a provider as soon as a config mentions it: only a key or an own endpoint counts.
  assert.equal(configSignIn({models:{x:{}}}),undefined); assert.equal(configSignIn({options:{timeout:1}}),undefined);
  assert.equal(configSignIn({options:{baseURL:"http://127.0.0.1:9/v1"}}),true);
  assert.equal(configSignIn({options:{apiKey:"{env:BRIDGE_PROVIDER_abc}"}}),true);
  assert.equal(configSignIn({options:{baseURL:"https://x.invalid",apiKey:"{env:UNSET_SCRATCH_KEY}"}}),false);
  assert.equal(configSignIn({options:{headers:{Authorization:"{env:SET_KEY}"}}},{SET_KEY:"v"}),true);
  put(join(src,"opencode.json"),{provider:{fake:{models:{model:{}}},lan:{options:{baseURL:"http://127.0.0.1:9/v1",apiKey:"{env:UNSET_SCRATCH_KEY}"}},absent:{options:{apiKey:"k"}}}});
  lease=await acquire(); svc=lease.svc; assert.ok(svc);
  const configured=await availableProviders(svc,base); lease.release();
  assert.deepEqual([...configured],[["lan",false]]);
  assert.equal(signInStatus([{id:"fake",methods:[{type:"key"}],connections:[]}],"fake",configured),"Missing");
  assert.equal(signInStatus([],"lan",configured),"Missing");

  // An interrupt that takes effect a moment after it is accepted is waited for.
  put(join(fake,"active","ses_fake124"),{scope:svc.pid,slow:900});
  put(join(leases,"lost-slow"),{pid:process.pid,birth:"dead incarnation",session:"ses_fake124"});
  lease=await acquire(); lease.release();
  assert.ok(!existsSync(join(fake,"active","ses_fake124")) && !existsSync(join(leases,"lost-slow")));

  // A service that was asked to stop is given to nobody while it goes; a stop that did not take is forgotten.
  put(manifest,{...json(manifest),stopping:Date.now()-13200});
  asked=Date.now(); lease=await acquire(); lease.release();
  assert.ok(Date.now()-asked>=1500,"waited for the stop"); assert.equal(lease.svc.pid,svc.pid); assert.equal(json(manifest).stopping,undefined);

  // A 3.4.0 bridge (an empty lease of a live bridge process) is named, not silently overruled.
  const old=node("-e","setTimeout(()=>{},60000)",join(base,"server.mjs"));
  await until("the old bridge",()=>birth(old.pid));
  writeFileSync(join(leases,old.pid+"-legacy-service"),""); writeFileSync(join(leases,process.pid+"-legacy-service"),"");
  try { await assert.rejects(acquire(),new RegExp("older bridge \\(3\\.4\\.0, process "+old.pid+"\\)")); }
  finally { old.kill(); }
  await until("its exit",async()=>!await birth(old.pid));
  lease=await acquire(); lease.release();
  assert.deepEqual(readdirSync(leases).filter(f=>f.includes("legacy")),[],"a dead or unrelated process's empty lease is dropped");

  // A server that stops answering is ended by its supervisor, and its identity forgotten.
  await api(svc,"/test/stop");
  await until("a service that exited by itself to be forgotten",()=>json(manifest).pid===null);
  Object.assign(process.env,{BRIDGE_SERVICE_IDLE_MS:"700",BRIDGE_SERVICE_HUNG_MS:"1500"}); // read by the next supervisor
  lease=await acquire(); svc=lease.svc; assert.ok(svc);
  await delay(2500); assert.ok(await birth(svc.pid),"a leased service is not idle");
  writeFileSync(join(fake,"hung"),"");
  await until("the supervisor to end the silent service",async()=>!await birth(svc.pid) && json(manifest).pid===null);
  assert.equal(json(manifest).birth,null);
  rmSync(join(fake,"hung")); lease.release();
  const before=svc.pid; lease=await acquire(); svc=lease.svc; lease.release(); assert.ok(svc && svc.pid!==before);

  // After an idle stop nothing of the process is remembered, so a reused PID cannot be taken for it.
  await until("the idle stop",async()=>!await birth(svc.pid) && json(manifest).pid===null);
  assert.equal(json(manifest).birth,null); assert.equal(json(manifest).stopping,undefined);
  svc=null;

  // An unsupervised listener on the profile's port (what a 3.4.0 bridge leaves) is refused by name.
  const legacyPort=json(manifest).port;
  const legacy=node("-e","require('http').createServer().listen(+process.argv.at(-1),'127.0.0.1')","serve","--service","--hostname","127.0.0.1","--port",String(legacyPort));
  try {
    await until("the listener",async()=>{ try { await fetch("http://127.0.0.1:"+legacyPort,{signal:AbortSignal.timeout(300)}); } catch (e) { return e.name==="TimeoutError"; } return true; });
    put(manifest,{hash:json(manifest).hash,files:json(manifest).files,port:legacyPort,pid:legacy.pid});
    put(reg,{pid:legacy.pid,url:"http://127.0.0.1:"+legacyPort,password:"placeholder"});
    await assert.rejects(acquire(),new RegExp("unsupervised \\(process "+legacy.pid+", port "+legacyPort+"\\).*older bridge \\(3\\.4\\.0\\)"));
  } finally { legacy.kill(); rmSync(reg,{force:true}); }

  // A launch that fails inside the supervisor does not leave the interrupted-launch guard behind.
  const other=join(base,"failed-launch"), otherManifest=join(other,"job-service","generation.json");
  mkdirSync(join(other,"job-service"),{recursive:true});
  put(otherManifest,{hash:"h",files:[],pid:null,port:"1\u0000",launch:"tok",requested:Date.now()});
  spawnSync(process.execPath,[fileURLToPath(new URL("../supervisor.mjs",import.meta.url)),"tok"],{env:{...process.env,BRIDGE_JOB_HOME:other,BRIDGE_JOB_CONFIG_DIR:"",NODE_OPTIONS:""},timeout:30000});
  assert.deepEqual([json(otherManifest).spawning,json(otherManifest).launch,json(otherManifest).pid],[undefined,null,null]);
  console.log("coordination regression tests passed");
} finally {
  lease?.release();
  if (svc && svc.birth===await birth(svc.pid)) await api(svc,"/test/stop");
  trap.close();
  await delay(250);
  rmSync(base,{force:true,recursive:true,maxRetries:5,retryDelay:200});
}
