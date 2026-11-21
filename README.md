# deepseek-flash bridge for Claude Code

A small MCP server (no dependencies, one file) that lets Claude hand work to a DeepSeek Flash agent
running in [OpenCode](https://opencode.ai). Claude plans and reviews; Flash does the hands-on
coding on DeepSeek's API, which doesn't count against your Claude usage limits.

## Tools

| Tool | What it does |
|---|---|
| `deepseek_flash` | Starts a Flash job and returns **at once** with a job id (`job_k3x_2`). Inputs: `prompt`, `directory`, `allow_edits`, `session`, `effort` (`none`/`low`/`high`/`max`), `files`, `agent`, `timeout_seconds`, `idle_seconds`. |
| `deepseek_flash_result` | `{ job, wait_seconds? }`. Waits up to 55 s, then returns Flash's reply ending in `session: ses_…`, or one progress line while it runs (elapsed time, last output, last tool, files edited). |
| `deepseek_flash_cancel` | `{ job }`. Stops a running job and its whole process tree (builds and tests included). Edits stay on disk; the session can be continued. |

The call returns at once so that a long job can never hit a tool-call timeout (it used to, and lost the reply
while the edits landed anyway). At most 3 jobs run at a time per server (`OPENCODE_MAX_CONCURRENT`); further ones queue.

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

## Install on a new PC

Needs Node 18+, OpenCode, and Claude Code and/or Claude Desktop.

1. Install OpenCode and sign in to the DeepSeek provider: `opencode auth login` (the API key stays in
   OpenCode's own store, never in this repo).
2. Clone this repo to `~/.claude/mcp-servers/opencode-agent`.
3. Run `node install.mjs` in that folder. It:
   - adds the `deepseek-flash` and `deepseek-flash-ro` agents to `~/.config/opencode/opencode.json`,
   - registers the server in Claude Code (user scope) with `OPENCODE_TIMEOUT_MS=3600000`,
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
| `OPENCODE_TIMEOUT_MS` | 60 min | default wall-clock limit per job (`timeout_seconds` overrides, max 4 h) |
| `OPENCODE_IDLE_MS` | 20 min | default limit without any output (`idle_seconds` overrides) |
| `OPENCODE_MAX_CONCURRENT` | 3 | jobs running at once per server |
| `OPENCODE_MAX_REPLY_CHARS` | 20000 | cap on any reply |
| `OPENCODE_STATE_DIR` | `<tmp>/opencode-agent` | job state and raw logs, shared by every server copy |

## The working-mode prompt

[WORKING-MODE.md](WORKING-MODE.md) is the prompt to paste into a Claude session so it routes work to Flash,
Haiku and Sonnet and keeps its own (Opus) tokens for planning and review.
