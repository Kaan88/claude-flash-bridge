# OpenCode bridge for Claude Code

A small MCP server (no dependencies, one file) that lets Claude hand work to a DeepSeek Flash agent
running in [OpenCode](https://opencode.ai). Claude plans and reviews; Flash does the hands-on
coding on DeepSeek's API, which doesn't count against your Claude usage limits.

## Tools

| Tool | What it does |
|---|---|
| `opencode_run` | Starts a job and returns **at once** with a job id (`job_k3x_2`). Inputs: `prompt`, `directory`, `allow_edits`, `session`, `model` (any OpenCode model, `provider/id`), `effort` (that model's own levels), `files`, `agent`, `timeout_seconds`, `idle_seconds`. |
| `opencode_result` | `{ job }` or `{ jobs: [...] }`, plus `wait_seconds?`. Waits up to 55 s for the job, or for **any** of the jobs, then returns each finished reply (ending in `session: ses_…`) and one progress line per job still running (elapsed time, last output, last tool, files edited, why it is queued). With `jobs`, each reply is returned once; repeat the call until it says all are done. |
| `opencode_cancel` | `{ job }`. Stops a running job and its whole process tree (builds and tests included). Edits stay on disk; the session can be continued. |

### Models, effort levels and agents (read live)

When the server starts it asks OpenCode for its models and agents (`opencode api model.list` / `agent.list`,
about a third of a second) and writes them into the `opencode_run` tool description in a compact form,
grouped by provider and effort levels, e.g. `anthropic: [low-max] claude-opus-5-5{,-fast} ...`
(about 500 tokens for ~30 models; Claude Code loads the schema only when the tool is used). The levels are each model's
real OpenCode variants, so `effort` is checked per model and a wrong level or unknown model is refused with the valid
choices. The list:

- leaves out OpenCode's own free models (provider `opencode`, `-free` or zero cost; `OPENCODE_INCLUDE_FREE=1` keeps them).
  Zero cost alone isn't "free": subscription and local providers report $0 and stay listed;
- shows only the newest version of each model line (`claude-opus-5-5` hides `claude-opus-5`, `4-8`, ...;
  `gpt-6.2-sol` hides `gpt-6.1-sol`); `OPENCODE_KEEP_OLD_MODELS=1` lists them all. Older ones can still be passed by name;
- keeps every local model (localhost / private-network base URL), marked `(local)`, or `(local, OFFLINE at startup)`
  when its server didn't answer a 1.5 s probe;
- lists the visible agents with the model each runs on.

The result is cached per project folder in the state folder, so a restart answers at once; when the live list differs,
the server sends `tools/list_changed` and Claude re-reads it. An unknown model triggers one live re-read before it's refused.
Passing `effort` without `model` now applies it to the chosen agent's own model (it used to always apply to `OPENCODE_MODEL`).

The call returns at once so that a long job can never hit a tool-call timeout (it used to, and lost the reply
while the edits landed anyway). At most 10 jobs run at once on the machine, across every Claude session (`OPENCODE_MAX_CONCURRENT`), and at most 2 on any one
local model (`OPENCODE_LOCAL_CONCURRENT`), since a local server mostly answers one request at a time; further jobs queue.
The slots are files in `<state folder>/slots`; a slot left by a server that exited is freed automatically.

**Limits.** A job is stopped after `timeout_seconds` (default `OPENCODE_TIMEOUT_MS`, 60 min, max 4 h) or when
OpenCode prints nothing for `idle_seconds` (default `OPENCODE_IDLE_MS`, 20 min: one silent build or test run can
take that long). Either way the whole process tree is killed, so no `dotnet`/build process keeps folders locked.

**Short replies.** No reply carries OpenCode's raw event log. A timed-out, cancelled or failed job returns a short
summary: status and reason, elapsed time, the session id (to continue it or ask what it got done), the last tool,
the files it edited, the tail of its last text (2 KB) and the path of the full log. Every reply is capped at
`OPENCODE_MAX_REPLY_CHARS` (20 000; head and tail kept, the full text stays in the log).

**Shared jobs.** Each session runs its own copy of the server, so jobs are kept in a state folder
(`OPENCODE_STATE_DIR`, default `<tmp>/opencode-agent`): `<job>.json` (status, session, progress, the reply) and
`<job>.jsonl` (the raw event stream). Any copy can report on or cancel any job; ids carry the server's pid, so two
copies never hand out the same one. If the server that ran a job exits, the job is reported as `lost` (with its
session and edited files) instead of "unknown"; when a session closes, its server stops its running jobs.
Finished jobs are kept in memory for 24 hours, and their files stay in the state folder.

The `deepseek-flash` agent's edits and shell commands are set to **ask**. Without `allow_edits` a job runs without
`--auto`, and OpenCode rejects every ask when nobody can answer it, so the agent can read files and run the allowed
read-only commands (git status/diff/log/show, cargo check/clippy/test) but can't change anything. With `allow_edits` the job
runs with `--auto`, which approves them. The same holds for any agent whose edits are "ask" or "deny"; an agent that edits
freely is refused for read-only jobs (use `model` to pick a model instead). An older install's `deepseek-flash-ro` twin is
still used while it exists; the installer removes it.

## Claude Code as a worker

`model: "claude-code/fable"` (or `opus`, `sonnet`, `haiku`) runs Claude Code's own CLI (`claude -p`) instead of OpenCode,
through the same jobs: `opencode_result` (one job or several), `opencode_cancel`, the shared limits, and `session` to continue.
`effort` takes low, medium, high, xhigh or max.

- It runs on your Claude plan with Claude Code's full toolset and your CLAUDE.md files, but loads no MCP servers
  (`--strict-mcp-config`), so a worker can't start this bridge again.
- Read-only jobs run in "don't ask" mode, allowed only to read, search, fetch web pages and run git status/diff/log/show;
  anything else is denied. Edit jobs run in Claude's `auto` permission mode, where Claude's own safety check approves actions.
- The calling session's `CLAUDE_*` environment variables are not passed on, so the worker is a separate session.
- Its session ids are UUIDs (OpenCode's start with `ses_`), so passing `session` alone picks the right worker.
- `agent` doesn't apply. Set `OPENCODE_CLAUDE=0` to hide these models, or `CLAUDE_EXE` when `claude` isn't found.

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
| `OPENCODE_IDLE_MS` | 20 min | default limit without any output (`idle_seconds` overrides) |
| `OPENCODE_MAX_CONCURRENT` | 10 | jobs running at once on this machine, all sessions together |
| `OPENCODE_LOCAL_CONCURRENT` | 2 | jobs running at once on one local model |
| `CLAUDE_EXE` | found on PATH or in `~/.local/bin` | Claude Code CLI for `claude-code/*` jobs |
| `OPENCODE_CLAUDE` | on | `0` hides the `claude-code/*` models |
| `OPENCODE_MAX_REPLY_CHARS` | 20000 | cap on any reply |
| `OPENCODE_INCLUDE_FREE` | off | `1` lists OpenCode's own free models too |
| `OPENCODE_KEEP_OLD_MODELS` | off | `1` lists older versions of each model line too |
| `OPENCODE_MODEL_EXCLUDE` | none | regex on `provider/id` to hide more models, e.g. `-(flex|ultrafast)$` |
| `OPENCODE_STATE_DIR` | `<tmp>/opencode-agent` | job state and raw logs, shared by every server copy |

## The working-mode prompt

[WORKING-MODE.md](WORKING-MODE.md) is the prompt to paste into a Claude session so it routes work to Flash,
Haiku and Sonnet and keeps its own (Opus) tokens for planning and review.
