# deepseek-flash bridge for Claude Code

A small MCP server (no dependencies, one file) that lets Claude hand work to a DeepSeek Flash agent
running in [OpenCode](https://opencode.ai). Claude plans and reviews; Flash does the hands-on
coding on DeepSeek's API, which doesn't count against your Claude usage limits.

## Tools

| Tool | What it does |
|---|---|
| `deepseek_flash` | Starts a Flash job and returns **at once** with a job id (`job_3`). Inputs: `prompt`, `directory`, `allow_edits`, `session`, `effort` (`none`/`low`/`high`/`max`), `files`, `agent`. |
| `deepseek_flash_result` | `{ job, wait_seconds? }`. Waits up to 55 s, then returns Flash's full reply ending in `session: ses_…`, or `still running (Ns so far)`. Call it again until it's done. |

The call returns at once so that a long job can never hit a tool-call timeout (it used to, and lost the reply
while the edits landed anyway). At most 3 jobs run at a time (`OPENCODE_MAX_CONCURRENT`); further ones queue.
Finished replies are kept 6 hours. A job is ended after `OPENCODE_TIMEOUT_MS` (installer sets 30 min), and the
whole OpenCode process tree is stopped with it. Jobs live in memory: if the server restarts, running jobs are
forgotten (any edits they made stay on disk).

Without `allow_edits` the job runs the read-only agent `deepseek-flash-ro`, which can't edit files (OpenCode
permissions), but can still read files and run commands such as tests.

## Install on a new PC

Needs Node 18+, OpenCode, and Claude Code and/or Claude Desktop.

1. Install OpenCode and sign in to the DeepSeek provider: `opencode auth login` (the API key stays in
   OpenCode's own store, never in this repo).
2. Clone this repo to `~/.claude/mcp-servers/opencode-agent`.
3. Run `node install.mjs` in that folder. It:
   - adds the `deepseek-flash` and `deepseek-flash-ro` agents to `~/.config/opencode/opencode.json`,
   - registers the server in Claude Code (user scope) with `OPENCODE_TIMEOUT_MS=1800000`,
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
| `OPENCODE_TIMEOUT_MS` | 15 min | per job |
| `OPENCODE_MAX_CONCURRENT` | 3 | jobs running at once |

## The working-mode prompt

[WORKING-MODE.md](WORKING-MODE.md) is the prompt to paste into a Claude session so it routes work to Flash,
Haiku and Sonnet and keeps its own (Opus) tokens for planning and review.
