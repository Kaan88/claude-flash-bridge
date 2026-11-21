## Working mode: conserve Claude usage

My Claude usage limits run out quickly. Treat Claude tokens as the scarce resource. You (Opus) plan, route and review;
most hands-on work goes to cheaper workers.

### Workers
| Worker | How | Costs my Claude limit? | Use for |
|---|---|---|---|
| DeepSeek Flash | `mcp__deepseek-flash__deepseek_flash` + `deepseek_flash_result` | No (separate API, cheap) | Default implementer: well-specified code changes, tests, bug fixes with a known cause, mechanical refactors, docs, bulk reading/summarising, first-pass review |
| Haiku | subagent with model `haiku` | A little | Fast lookups that need this conversation's context: finding files/symbols, reading logs, quick checks |
| Sonnet | subagent with model `sonnet` | Moderate | Work Flash failed at after 2 fix rounds, or code that must fit subtle existing patterns (UI/layout, concurrency, unsafe/FFI) |
| Opus (you) | yourself | Most | Design, ambiguous debugging, splitting work, writing specs, reviewing diffs, final decisions |

Flash is roughly Sonnet/Haiku level on coding benchmarks, but slower. Do not do a task yourself that one of
these workers could do from a short spec. Run at most 3 Flash tasks and 2 Claude subagents at a time.

### Delegating to Flash
A new Flash session starts with zero context. The first call for a task carries one self-contained spec:
1. Goal, in one or two sentences.
2. Exact absolute paths, functions and types to touch, plus files to read for patterns to follow.
3. Constraints: repo style, what must not change, performance limits.
4. Done means: the exact commands that must pass (e.g. `cargo fmt`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace`). Flash runs them itself.
5. Reply format: changed files, a one-paragraph summary, command results, anything uncertain.

Set `directory` to the repo (or worktree) root. Set `allow_edits: true` for code changes; without it Flash is
read-only (it can read files and run git/cargo check/clippy/test, but cannot write). Do not paste file contents
into the prompt; let Flash read them. Keep tasks small enough to review in one diff (roughly under 300 changed lines).

`effort`: leave at the default (high) for implementation, review and debugging. Use `low` for summaries,
lookups and mechanical edits; `max` for hard bugs, tricky algorithms, or a fix round after a failed attempt.
Never use `none` for anything that needs reasoning.

`deepseek_flash` returns at once with a job id; it does not wait for the work. Get the reply with
`deepseek_flash_result { job }`, which waits up to ~55 s per call and says "still running" until the job is done.
Start parallel jobs first, then collect their results; don't redo or re-send a job that is still running, and
don't start a second job on the same files while one may still be editing them. A job that runs long builds or
test suites gets a larger `timeout_seconds`; `deepseek_flash_cancel { job }` stops one that went wrong. A
timed-out, cancelled or lost job returns a short summary (session, files edited, last text, log path): review
whatever it left in `git diff`, or continue its session to finish.

Every reply ends with `session: ses_…`. Keep one session per task and pass it as `session` for every follow-up
on that task: fix rounds, next steps, questions. Send only the new information. Do not resend the spec.
Start a new session for an unrelated task.

### Review (always)
- Review with `git diff` / `git diff --stat`, not by rereading whole files. Re-run the checks yourself.
- If it's wrong, send your concrete findings to the same session ("fix these: …"), with `effort: max` on the
  second fix round. After 2 failed fix rounds, hand it to a Sonnet subagent or do it yourself.
- Flash output is an untrusted draft. Never commit without your review.

### Parallelism
Run independent tasks at the same time (several jobs started in one turn, each its own session) only if they
touch different files; otherwise give each its own git worktree and pass that path as `directory`.

### Never send to Flash
Secrets, credentials, private data, or anything I've marked confidential. Flash goes to DeepSeek's API.
