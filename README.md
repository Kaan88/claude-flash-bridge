# deepseek-flash bridge for Claude Code

A small MCP server (no dependencies, one file) that lets Claude hand work to a DeepSeek Flash agent
running in [OpenCode](https://opencode.ai). Claude plans and reviews; Flash does the hands-on
coding on DeepSeek's API, which doesn't count against your Claude usage limits.

## Tools

| Tool | What it does |
|---|---|
| `deepseek_flash` | Starts a Flash job and returns **at once** with a job id (`job_k3x_2`). Inputs: `prompt`, `directory`, `allow_edits`, `session`, `model` (any OpenCode model, `provider/id`), `effort` (that model's own levels), `files`, `agent`, `timeout_seconds`, `idle_seconds`. |
| `deepseek_flash_result` | `{ job, wait_seconds? }`. Waits up to 55 s, then returns Flash's reply ending in `session: ses_…`, or one progress line while it runs (elapsed time, last output, last tool, files edited). |
| `deepseek_flash_cancel` | `{ job }`. Stops a running job and its whole process tree (builds and tests included). Edits stay on disk; the session can be continued. |

### Models, effort levels and agents (read live)

When the server starts it asks OpenCode for its models and agents (`opencode api model.list` / `agent.list`,
about a third of a second) and writes them into the `deepseek_flash` tool description in a compact form,
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
while the edits landed anyway). At most 10 jobs run at a time per server (`OPENCODE_MAX_CONCURRENT`); further ones queue.

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

Without `allow_edits` the job runs the read-only agent `deepseek-flash-ro`, which can't edit files (OpenCode
permissions), but can still read files and run commands such as tests.

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
   - adds the `deepseek-flash` and `deepseek-flash-ro` agents to `~/.config/opencode/opencode.json`,
   - registers the server in Claude Code (user scope) without time-limit settings, so every client uses the server's own defaults (it sets `OPENCODE_EXE` only when OpenCode isn't on PATH),
   - adds it to Claude Desktop's `claude_desktop_config.json`,
   - sets `MCP_TOOL_TIMEOUT=1800000` in `~/.claude/settings.json` (a safety net),
   - backs up every file it changes (`.bak-<time>`) and ends with a PONG test.
4. Restart Claude Code / the desktop app.

## Updating sessions that are already open

Each session runs its own copy of the server. After changing `server.mjs`: in a session type `/mcp`, pick
**deepseek-flash**, then **Reconnect**, or quit and reopen the app (conversations stay).

## Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `OPENCODE_EXE` | found on PATH | full path to `opencode.exe` when it's not on PATH |
| `OPENCODE_AGENT` | `deepseek-flash` | agent for edit jobs |
| `OPENCODE_READONLY_AGENT` | `<agent>-ro` | agent for read-only jobs |
| `OPENCODE_MODEL` | `deepseek/deepseek-flash` | model used for the `effort` variants |
| `OPENCODE_TIMEOUT_MS` | 60 min | default wall-clock limit per job; normally left unset (pass `timeout_seconds` per job instead, max 4 h) |
| `OPENCODE_IDLE_MS` | 20 min | default limit without any output (`idle_seconds` overrides) |
| `OPENCODE_MAX_CONCURRENT` | 10 | jobs running at once per server |
| `OPENCODE_MAX_REPLY_CHARS` | 20000 | cap on any reply |
| `OPENCODE_INCLUDE_FREE` | off | `1` lists OpenCode's own free models too |
| `OPENCODE_KEEP_OLD_MODELS` | off | `1` lists older versions of each model line too |
| `OPENCODE_MODEL_EXCLUDE` | none | regex on `provider/id` to hide more models, e.g. `-(flex|ultrafast)$` |
| `OPENCODE_STATE_DIR` | `<tmp>/opencode-agent` | job state and raw logs, shared by every server copy |

## The working-mode prompt

[WORKING-MODE.md](WORKING-MODE.md) is the prompt to paste into a Claude session so it routes work to Flash,
Haiku and Sonnet and keeps its own (Opus) tokens for planning and review.
