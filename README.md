# OpenCode bridge for Claude Code

A small MCP server (no dependencies, one file) that lets Claude hand work to **workers**: other models working on
their own. A worker runs either an agent in [OpenCode](https://opencode.ai) (DeepSeek Flash by default, on DeepSeek's
API, which doesn't count against your Claude usage limits) or Claude Code itself in the background (which does).
Claude plans and reviews; the workers do the hands-on work.

## What does what

| Piece | What it is |
|---|---|
| **OpenCode** | A separate coding agent with its own models, agents and plugins. Its configuration is its own. |
| **Workers** | The list of what Claude may run, in `~/.config/opencode-bridge/workers.json`. Each worker runs one OpenCode agent, or Claude Code itself. |
| **The bridge** | This server. Claude asks it for a worker by name. Anything that is not on the list is refused: no other OpenCode agent or model can be reached. |

[OpenCode Config Studio](https://github.com/Kaan88/opencode-config-studio) edits all of it: OpenCode's models and
agents, the worker list, and it installs and updates this bridge.

## Tools

| Tool | What it does |
|---|---|
| `opencode_run` | Starts a job on a worker and returns **at once** with a job id (`job_k3x_2`). Inputs: `prompt`, `worker` (one of the listed names; the default worker when left out), `directory`, `allow_edits`, `session`, `effort` (one of that worker's model's levels), `files`, `timeout_seconds`, `idle_seconds`, `tool_idle_seconds`. |
| `opencode_result` | `{ job }` or `{ jobs: [...] }`, plus `wait_seconds?`. **One call waits** for the job, or for **any** of the jobs (up to 25 minutes in Claude Code, see "Waiting"), then returns each finished reply (ending in `session: ses_…`) and one progress line per job still running (elapsed time, last output, last tool, the tool call in flight, files edited, why it is queued). With `jobs`, each reply is returned once; call again only while it says jobs are still running. |
| `opencode_cancel` | `{ job }`. Stops a queued or running job of **any** session: kills its process tree and interrupts its OpenCode session, so builds and tests it started stop too. The reply's `resume:` line says whether the session is idle or still busy. On a job that already timed out or failed it interrupts a session that is still busy. Edits stay on disk; the session can be continued. |
| `opencode_list` | No input. The workers, how long a wait may be, and every queued and running job on the machine, from all sessions: id, state, model, owner process (alive or gone), start time, running time, last tool, last output, the tool call in flight, queue place; then who holds the places of each pool, and the sessions an ended job left busy in OpenCode. |

### Workers

```json
{
  "default": "deepseek-flash",
  "workers": {
    "deepseek-flash": { "runs": "opencode", "agent": "deepseek-flash", "effort": "high", "description": "Default implementer." },
    "astra": { "runs": "opencode", "agent": "deepseek-flash", "model": "openai/gpt-6.2-astra", "description": "A stronger model for hard tasks." },
    "cc-reviewer": { "runs": "claude", "model": "opus", "effort": "high", "readOnly": true,
      "description": "Reviews code for correctness bugs.", "instructions": "Report correctness bugs only, file:line first." }
  }
}
```

- `runs: "opencode"` needs an `agent` (its instructions and permissions apply; it may be hidden in OpenCode, which
  suits an agent made only for a worker) and may name a `model` (`provider/id`)
  to run that agent on, and a usual `effort`.
- `runs: "claude"` runs Claude Code's own CLI: `model` is fable, opus, sonnet or haiku, `effort` the usual level,
  `instructions` are appended to its system prompt.
- `readOnly` workers are refused for edit jobs, `disabled: true` hides one, `description` is what Claude reads when
  it chooses. `default` runs when a call names no worker; without it, the first OpenCode worker does.

The tool's `worker` parameter lists exactly these names, each with what runs it and whether it uses the Claude plan,
so "ask cc-reviewer to check src/" is enough. There is no `model` or `agent` parameter: a call that names one is
refused with the list of workers. A continued `session` goes back to the worker that started it. The bridge re-reads
the file when it changes and tells Claude to refresh its tool list, so no restart is needed.

While `workers.json` does not exist, the list is the default OpenCode agent (`OPENCODE_AGENT`, `deepseek-flash`) plus
the workers of the older `~/.claude/claude-workers.json`, so an install from before the list keeps working. Calls
written for older versions that name a worker with `agent` still run; `model: "claude-code/opus"` and other models no
longer do. `OPENCODE_ALLOW_ANY=1` brings the old behaviour back: every OpenCode model and agent is listed and can be
asked for with `model` and `agent`.

For an OpenCode worker the bridge reads the agent's model and its effort levels from OpenCode
(`opencode api model.list` / `agent.list`, cached per project folder), so `effort` is checked per model and a wrong
level is refused with the valid ones. `OPENCODE_MODEL_EXCLUDE` and the blocklist file still switch a model off for
every worker that would run on it.

### Waiting

A wait is one tool call, and a tool call that is waiting costs nothing. A poll every 55 seconds, which is what this
bridge asked for before, costs one model request each time, with the whole conversation read again. So
`opencode_result` now waits until a job ends:

- in Claude Code up to 25 minutes per call (a minute under `MCP_TOOL_TIMEOUT` when that is shorter). Claude Code moves
  a call that runs longer than two minutes to the background and tells the session when it settles, so Claude can go
  on with other work, or end its turn, meanwhile;
- in other clients 150 seconds, because they cut a tool call short (Claude Desktop's chat: 180 s by default);
- `OPENCODE_WAIT_SECONDS` sets it for every client; `wait_seconds: 0` in a call only looks.

While it waits it sends a progress message every 20 seconds to a client that asked for progress. A call the client
gave up on (the user interrupted it, or its own limit ran out) is not answered, so a reply is never counted as
delivered without having been read; the next call returns it.

The call returns at once so that a long job can never hit a tool-call timeout (it used to, and lost the reply
while the edits landed anyway). At most 10 jobs run at once on the machine, across every Claude session (`OPENCODE_MAX_CONCURRENT`), and at most 6 on any one
local model (`OPENCODE_LOCAL_CONCURRENT`), further jobs queue. Lower it for a server that answers one request at a time.
The slots are files in `<state folder>/slots`. A server touches its slot files every 5 seconds; a slot is freed automatically when its server exited, stopped touching it for 30 seconds (Windows reuses process ids, so a live id alone proves nothing), or its job already finished. Only a queued or running job holds a place: a finished one gives it back at once, whether its reply was fetched or not. A queued job says which jobs hold the places (`waiting: 2 job(s) already on this local model: job_a_1 (running 340s), ...`), `opencode_list` shows the whole queue, and `opencode_cancel` on any of those ids stops it and, if its server is gone or it has no record, frees its place. A cancel from another session is a file (`<job>.cancel`) that the job's own server honours within a second.

**Limits.** A job is stopped after `timeout_seconds` (default `OPENCODE_TIMEOUT_MS`, 60 min, max 4 h) or when
it prints nothing for `idle_seconds` (default `OPENCODE_IDLE_MS`, 20 min). While a tool call is in flight (a shell
running a build or a test suite prints nothing through OpenCode until it ends) the idle limit is
`tool_idle_seconds` instead (default `OPENCODE_TOOL_IDLE_SECONDS`, 45 min; never shorter than the plain limit,
never longer than the wall-clock limit). The timeout reason names the tool and how long it ran:
`no output for 2700s while tool shell "cargo build --release" was in flight for 2710s`.

How a tool in flight is known: Claude Code's event stream shows a tool call starting and ending. OpenCode's
shows it only when it has ended, so a job that went silent inside a step is asked every 30 s
(`opencode api session.messages`, the newest three assistant messages) whether a tool call is `running`. If
OpenCode can't answer, an open step counts as a tool in flight, so a healthy build is not cut short.

**Stopping.** `opencode run` is only a client of OpenCode's background service (`opencode serve --service`):
the session and the processes its tools start live in the service, so killing the `run` process tree leaves a
build running and the session busy. On a timeout or a cancel the bridge therefore also asks the service to
interrupt the session (`opencode api session.interrupt`) and then looks whether it went idle
(`session.active`). The result says which it is in a `resume:` line: the session can be continued right away,
or it is still busy (check `opencode_list`, or call `opencode_cancel` on the ended job again), or OpenCode could
not be asked. A job that continues a session which is still busy says so in its progress line. Claude Code
jobs run their tools under the `claude` process, so killing its tree is enough there.

**Short replies.** No reply carries OpenCode's raw event log. A timed-out, cancelled or failed job returns a short
summary: status and reason, a `stats:` line, the session id (to continue it or ask what it got done), the
`resume:` line, the files it edited, the tail of its last text (2 KB) and the path of the full log. Every reply
is capped at `OPENCODE_MAX_REPLY_CHARS` (20 000; head and tail kept, the full text stays in the log).

Every finished job, successful or not, carries one `stats:` line: the number of tool calls, the total running
time, the longest silent stretch and the last tool, e.g.
`stats: 14 tool calls · total 512s · peak idle 203s · last tool shell` (plus `queued 40s first` when it waited).

**Shared jobs.** Each session runs its own copy of the server, so jobs are kept in a state folder
(`OPENCODE_STATE_DIR`, default `<tmp>/opencode-agent`): `<job>.json` (status, session, progress, the reply) and
`<job>.jsonl` (the raw event stream), plus `<job>.cancel` while a cancel from another copy is pending. Any copy can report on, list or cancel any job; ids carry the server's pid, so two
copies never hand out the same one. If the server that ran a job exits, the job is reported as `lost` (with its
session and edited files) instead of "unknown"; when a session closes, its server stops its running jobs.
Finished jobs are kept in memory for 24 hours; their files are deleted after 3 days (`OPENCODE_KEEP_DAYS`, 0 keeps them).

The `deepseek-flash` agent's edits and shell commands are set to **ask**. Without `allow_edits` a job runs without
`--auto`, and OpenCode rejects every ask when nobody can answer it, so the agent can read files and run the allowed
read-only commands (git status/diff/log/show, cargo check/clippy/test) but can't change anything. With `allow_edits` the job
runs with `--auto`, which approves them. The same holds for any agent whose edits are "ask" or "deny"; an agent that edits
or runs shell commands freely is refused for read-only jobs. An older install's `deepseek-flash-ro` twin is
still used while it exists; the installer removes it.

## Claude Code workers

A worker with `runs: "claude"` runs Claude Code's own CLI (`claude -p`) through the same jobs: `opencode_result`,
`opencode_cancel`, the shared limits, and `session` to continue.

- It runs on your Claude plan with Claude Code's full toolset and your CLAUDE.md files, but loads no MCP servers
  (`--strict-mcp-config`), so a worker can't start this bridge again.
- Read-only jobs run in "don't ask" mode, allowed only to read, search, fetch web pages and run git status/diff/log/show;
  anything else is denied. Edit jobs run in Claude's `auto` permission mode, where Claude's own safety check approves actions.
- The calling session's `CLAUDE_*` environment variables are not passed on, so the worker is a separate session.
- Set `OPENCODE_CLAUDE=0` to switch these workers off, or `CLAUDE_EXE` when `claude` isn't found.

## Install or update in one step

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.ps1 | iex
```

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.sh | bash
```

The same command installs and updates. It:

1. installs what is missing: Node.js (winget on Windows, Homebrew on macOS), Git (Windows; otherwise the repo
   comes as an archive), Claude Code (its official installer) and OpenCode (`npm i -g @opencode/cli`);
2. uses the bridge that is already installed: the copy Claude Code or Claude Desktop is registered with,
   wherever it lives, otherwise `~/.claude/mcp-servers/opencode-agent`. A git clone gets a fast-forward
   `git pull` (skipped with a warning if it has local changes or there's no network); any other copy is used as
   it is. Only when there is no bridge is this repo installed there;
3. asks for a DeepSeek API key only when OpenCode has none: it runs `opencode auth login deepseek`, so the key
   goes straight into OpenCode's own store and never through the script, a file or the command line;
4. runs `node install.mjs` (below).

Anything already installed is left as it is. Set `FLASH_BRIDGE_UPGRADE=1` (`$env:FLASH_BRIDGE_UPGRADE = "1"`)
to also upgrade OpenCode to its latest release.

## Install by hand

Needs Node 18+, OpenCode, and Claude Code and/or Claude Desktop.

1. Install OpenCode and sign in to the DeepSeek provider: `opencode auth login` (the API key stays in
   OpenCode's own store, never in this repo).
2. Clone this repo to `~/.claude/mcp-servers/opencode-agent`.
3. Run `node install.mjs` in that folder. It:
   - adds the `deepseek-flash` agent (asks before edits and shell commands) to `~/.config/opencode/opencode.json` and removes the old `deepseek-flash-ro`,
   - removes the server's old name, `deepseek-flash`, wherever Claude Code holds it: user scope, and local scope
     in every project of `~/.claude.json` (a project's own `.mcp.json` file is left alone: remove it there by hand),
   - registers the server in Claude Code (user scope) without time-limit settings, so every client uses the server's own defaults (it sets `OPENCODE_EXE` only when OpenCode isn't on PATH),
   - adds it to Claude Desktop's `claude_desktop_config.json`,
   - sets `MCP_TOOL_TIMEOUT=1800000` in `~/.claude/settings.json` (a safety net),
   - backs up every file it changes (`.bak-<time>`) and ends with a PONG test.
4. Restart Claude Code / the desktop app.

## Updating sessions that are already open

Each session runs its own copy of the server. After changing `server.mjs`: in a session type `/mcp`, pick
**opencode**, then **Reconnect**, or quit and reopen the app (conversations stay).

## Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `OPENCODE_EXE` | found on PATH | full path to `opencode.exe` when it's not on PATH |
| `OPENCODE_AGENT` | `deepseek-flash` | agent for edit jobs |
| `OPENCODE_READONLY_AGENT` | `<agent>-ro` | agent for read-only jobs |
| `OPENCODE_MODEL` | `deepseek/deepseek-flash` | model used for the `effort` variants |
| `OPENCODE_TIMEOUT_MS` | 60 min | default wall-clock limit per job; normally left unset (pass `timeout_seconds` per job instead, max 4 h) |
| `OPENCODE_IDLE_MS` | 20 min | default limit without any output while no tool call is in flight (`idle_seconds` overrides) |
| `OPENCODE_TOOL_IDLE_SECONDS` | 2700 (45 min) | default limit without any output while a tool call is in flight (`tool_idle_seconds` overrides) |
| `OPENCODE_PROBE_MS` | 30000 | how often a silent OpenCode job is asked which tool call is running |
| `OPENCODE_MAX_CONCURRENT` | 10 | jobs running at once on this machine, all sessions together |
| `OPENCODE_LOCAL_CONCURRENT` | 6 | jobs running at once on one local model |
| `CLAUDE_EXE` | found on PATH or in `~/.local/bin` | Claude Code CLI for workers that run Claude Code |
| `OPENCODE_CLAUDE` | on | `0` switches off the workers that run Claude Code |
| `OPENCODE_MAX_REPLY_CHARS` | 20000 | cap on any reply |
| `OPENCODE_INCLUDE_FREE` | off | `1` lists OpenCode's own free models too |
| `OPENCODE_KEEP_OLD_MODELS` | off | `1` lists older versions of each model line too |
| `OPENCODE_MODEL_EXCLUDE` | none | regex on `provider/id`: those models are left out of the tool description **and refused** when a job asks for them (by name, by alias or through an agent's own model), e.g. `deepseek-v4-pro` or `-(flex|ultrafast)$`. Fixed at start; for a switch you can flip while sessions run, use the blocklist file below |
| `OPENCODE_BLOCKLIST` | `~/.config/opencode-bridge/blocked-models.json` | `{"blocked": ["deepseek/deepseek-v4-pro"]}`: exact `provider/id` names, refused like the regex above but read again on every call, so editing the file takes effect at once in every running session, with no restart. A missing or broken file blocks nothing |
| `OPENCODE_STATE_DIR` | `<tmp>/opencode-agent` | job state and raw logs, shared by every server copy |
| `OPENCODE_KEEP_DAYS` | 3 | job files older than this are deleted when a server starts; 0 keeps them all |
| `BRIDGE_WORKERS_FILE` | `~/.config/opencode-bridge/workers.json` | the worker list |
| `CLAUDE_WORKERS_FILE` | `~/.claude/claude-workers.json` | the older Claude workers file, read only while the worker list does not exist |
| `OPENCODE_WAIT_SECONDS` | 1500 in Claude Code, 150 elsewhere | how long one `opencode_result` call may wait |
| `OPENCODE_ALLOW_ANY` | off | `1`: no worker list; any OpenCode agent or model can be asked for with `agent` and `model`, as before 3.0 |

## Tests

`node test/test.mjs` (no dependencies, about a minute). It checks the rules on their own (queue places, idle
limits, the stats line) and then drives the server over MCP stdio against `test/fake-opencode.mjs`, a stand-in
for the `opencode` executable, so no model is called.

## The working-mode prompt

[WORKING-MODE.md](WORKING-MODE.md) is the prompt to paste into a Claude session (or a CLAUDE.md) so it routes work to the
workers, waits with one call and keeps its own tokens for planning and review.
