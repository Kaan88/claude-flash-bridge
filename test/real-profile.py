"""Optional Windows v2.4.1 integration probe. Only scratch paths and a local model endpoint."""
import base64, http.server, json, os, pathlib, shutil, subprocess, sys, tempfile, threading, time, urllib.request, urllib.parse

exe = shutil.which("opencode.exe") or shutil.which("opencode")
base = pathlib.Path(tempfile.mkdtemp(prefix="oc-profile-probe-"))
env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENCODE_", "BRIDGE_", "XDG_")) and not any(s in k for s in ("KEY", "TOKEN", "PASSWORD"))}
for k in ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_DIR"]:
    p = base / k
    p.mkdir()
    env[k] = str(p)
env.update(OPENCODE_DB=str(base / "scratch.db"), DEEPSEEK_API_KEY="test-placeholder", PWD=str(base))
def cli(*args, **opts):
    return subprocess.Popen([exe, *args], env=env, cwd=base, stderr=subprocess.DEVNULL, **opts)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        assert self.headers.get("Authorization")=="Bearer test-placeholder", "expected scratch key"
        seen.set()
        release.wait(60)
seen, release = threading.Event(), threading.Event()
http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=http.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{http.server_port}/v1"
cfg = {"provider":{"deepseek":{"options":{"baseURL":url}}, "openai":{"options":{"apiKey":"test-placeholder", "baseURL":url}}}}
if "--config-key" in sys.argv:
    del env["DEEPSEEK_API_KEY"]
    cfg["provider"]["deepseek"]["options"]["apiKey"]="test-placeholder"
(base/"OPENCODE_CONFIG_DIR"/"opencode.json").write_text(json.dumps(cfg))
# Probe standalone before starting any process that owns this DB.
standalone=json.loads(cli("auth","list","--format","json","--standalone",stdout=subprocess.PIPE).communicate(timeout=30)[0])
assert isinstance(standalone,list)
assert ("deepseek" in [r["id"] for r in standalone]) == ("--config-key" not in sys.argv)
assert b"deepseek/deepseek-flash" in cli("models","--standalone",stdout=subprocess.PIPE).communicate(timeout=30)[0].splitlines()
bridge="--bridge" in sys.argv
if bridge:
    env.update(BRIDGE_JOB_HOME=str(base/"bridge"),OPENCODE_EXE=exe,BRIDGE_SERVICE_IDLE_MS="2000")
    module=(pathlib.Path(__file__).resolve().parents[1]/"job-service.mjs").as_uri()
    code=f"import {{acquire}} from '{module}'; const l=await acquire(); if(!l.svc) process.exit(2);console.log(l.svc.pid);process.stdin.resume();process.stdin.on('end',()=>l.release());"
    holder=subprocess.Popen([shutil.which("node"),"--input-type=module","-e",code],cwd=base,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    pid=int(holder.stdout.readline())
    reg=base/"bridge"/"job-service"/"state"/"opencode"/"service.json"
    worker_cfg=(base/"bridge"/"job-service"/"config"/"opencode.json").read_text()
    assert "test-placeholder" not in worker_cfg
else:
    svc = cli("serve","--service","--hostname","127.0.0.1","--port","0", stdout=subprocess.DEVNULL)
    pid=svc.pid
    reg = base/"XDG_STATE_HOME"/"opencode"/"service.json"
try:
    for i in range(300):
        if reg.exists(): break
        time.sleep(.1)
    s = json.loads(reg.read_bytes())
    assert s["pid"] == pid
    print("registration keys:", list(s), flush=True)
    def api(path, post=False):
        header = base64.b64encode(("opencode:"+s["password"]).encode()).decode()
        req = urllib.request.Request(s["url"]+path, headers={"Authorization":"Basic "+header}, method="POST" if post else "GET")
        return json.load(urllib.request.urlopen(req, timeout=5))
    env["OPENCODE_PASSWORD"] = s["password"]
    rows = json.loads(cli("auth","list","--format","json","--server",s["url"], stdout=subprocess.PIPE).communicate(timeout=30)[0])
    print("auth list:", type(rows).__name__, [r["id"] for r in rows], flush=True)
    assert isinstance(rows,list)
    assert ("deepseek" in [r["id"] for r in rows]) == ("--config-key" not in sys.argv)
    directory="?directory="+urllib.parse.quote(str(base))
    for r in api("/api/integration"+directory)["data"]:
        if r["id"] in ("openai","deepseek"): print(r["id"], [c["type"] for c in r["connections"]],flush=True)
    for r in api("/api/provider"+directory)["data"]:
        if r["id"] in ("openai","deepseek"): print("provider",r["id"],list(r),flush=True)
    models=cli("models","--server",s["url"],stdout=subprocess.PIPE).communicate(timeout=30)[0].splitlines()
    print("model available:", b"deepseek/deepseek-flash" in models, flush=True)
    assert b"deepseek/deepseek-flash" in models
    for r in api("/api/integration"+directory)["data"]:
        if r["id"]=="deepseek": print("warm connections:", [c["type"] for c in r["connections"]], flush=True)
    client = cli("run","--server",s["url"],"--model","deepseek/deepseek-flash","test", stdout=subprocess.DEVNULL)
    try:
        assert seen.wait(45), "local model not contacted"
        client.kill()
        client.wait()
        time.sleep(1)
        active = api("/api/session/active")["data"]
        print("active after killed CLI:",len(active),flush=True)
        assert active
        if bridge:
            holder.stdin.close(); holder.wait(timeout=10)
            time.sleep(4.5) # over two idle checks, with no lease
            assert api("/api/session/active")["data"].keys()==active.keys()
        for session in active: api("/api/session/"+session+"/interrupt",True)
    finally:
        if client.poll() is None: client.kill()
finally:
    release.set()
    if bridge:
        if not holder.stdin.closed: holder.stdin.close()
        holder.wait(timeout=10)
        for _ in range(150):
            if not reg.exists(): break
            time.sleep(.1)
        assert not reg.exists(), "scratch service did not retire"
    else:
        svc.kill()
        svc.wait()
    shutil.rmtree(base, ignore_errors=True)
