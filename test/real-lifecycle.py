"""Exercise worker tree-kill survival and idle retirement on Windows with the installed CLI."""
import ctypes, json, os, pathlib, shutil, subprocess, tempfile, time
from ctypes import wintypes as w

repo = pathlib.Path(__file__).resolve().parents[1]
exe = shutil.which("opencode.exe")
node = shutil.which("node.exe")
assert exe and node and os.name == "nt"
kernel=ctypes.WinDLL("kernel32",use_last_error=True)
def win(name, result, *args):
    f=getattr(kernel,name); f.argtypes=args; f.restype=result
    return f
open_process=win("OpenProcess",w.HANDLE,w.DWORD,w.BOOL,w.DWORD)
wait_process=win("WaitForSingleObject",w.DWORD,w.HANDLE,w.DWORD)
terminate=win("TerminateProcess",w.BOOL,w.HANDLE,w.UINT)
create_job=win("CreateJobObjectW",w.HANDLE,ctypes.c_void_p,w.LPCWSTR)
assign_job=win("AssignProcessToJobObject",w.BOOL,w.HANDLE,w.HANDLE)
terminate_job=win("TerminateJobObject",w.BOOL,w.HANDLE,w.UINT)
close=win("CloseHandle",w.BOOL,w.HANDLE)

def wait(check, timeout=40):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            result=check()
            if result: return result
        except (OSError, ValueError): pass
        time.sleep(.1)
    raise AssertionError("scratch lifecycle timed out")

def exercise(old, job_kill=False):
    base=pathlib.Path(tempfile.mkdtemp(prefix="bridge-tree-"))
    env={k:v for k,v in os.environ.items() if not k.startswith(("BRIDGE_", "OPENCODE_", "XDG_")) and not any(s in k for s in ("KEY","TOKEN","PASSWORD"))}
    for k in ["USERPROFILE","HOME","XDG_DATA_HOME","XDG_STATE_HOME","XDG_CONFIG_HOME","XDG_CACHE_HOME","OPENCODE_CONFIG_DIR","BRIDGE_JOB_HOME"]:
        (base/k).mkdir()
        env[k]=str(base/k)
    env.update(OPENCODE_DB=str(base/"scratch.db"), OPENCODE_EXE=exe, BRIDGE_SERVICE_IDLE_MS="4000", PWD=str(base))
    reg=base/"XDG_STATE_HOME"/"opencode"/"service.json" if old else base/"BRIDGE_JOB_HOME"/"job-service"/"state"/"opencode"/"service.json"
    code=("import {spawn} from 'node:child_process'; spawn(process.env.OPENCODE_EXE,['serve','--service','--hostname','127.0.0.1','--port','0'],{detached:true,stdio:'ignore'}).unref();" if old else
          f"import {{acquire}} from '{(repo/'job-service.mjs').as_uri()}'; const lease=await acquire(); if (!lease.svc) process.exit(2);")
    p=subprocess.Popen([node,"--input-type=module","-e","await new Promise(ok=>process.stdin.once('data',ok));"+code+"console.log('ready');setInterval(()=>{},10000);"],cwd=base,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
    handle=job=None
    try:
        if job_kill:
            job=create_job(None,None)
            assert job and assign_job(job,int(p._handle)), ctypes.get_last_error()
        p.stdin.write(b"go\n"); p.stdin.flush()
        assert p.stdout.readline().strip()==b"ready"
        s=wait(lambda: json.loads(reg.read_bytes()))
        handle=open_process(0x100001,False,s["pid"])
        assert handle
        def alive(): return wait_process(handle,0)==258
        if not old:
            time.sleep(5)
            assert alive(), "retired with a live lease"
        if job_kill: assert terminate_job(job,1)
        else: subprocess.run(["taskkill","/PID",str(p.pid),"/T","/F"],stdout=subprocess.DEVNULL,check=True)
        p.wait()
        if old:
            assert wait(lambda:not alive(),3)
        else:
            assert alive(), "parent termination reached the worker"
            wait(lambda:not alive(),15)
        print("original tree kill reproduced" if old else f"worker survived {'job' if job_kill else 'tree'} termination and retired after lease expiry",flush=True)
    finally:
        if p.poll() is None: p.kill()
        if handle:
            if alive(): terminate(handle,1)
            close(handle)
        if job: close(job)
        shutil.rmtree(base,ignore_errors=True)
exercise(True)
exercise(False)
exercise(False,True)
