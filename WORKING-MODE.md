## Working mode: conserve Claude usage

My Claude usage limits run out quickly. Treat Claude tokens as the scarce resource. You plan, route and review;
most hands-on work goes to workers.

### Where the usage goes
Every request you make reads the whole conversation again, so the cost of a request grows with the length of this
conversation, and a request that does nothing costs as much as one that does. Therefore:
- Wait with one call, never by polling (see "Waiting").
- No status message while workers run, and none between two waits.
- Do not read whole files or logs into this conversation when a worker or a subagent can return the conclusion.
- When this conversation has grown long and the next task does not need its history, say so and suggest a fresh session.

### Workers
`mcp__opencode__opencode_run` hands a task to a worker; its `worker` parameter lists the workers I have set up, each
with what runs it and whether it uses my Claude plan. Nothing else can be run: there is no `model` or `agent` to pass.

| Kind | Costs my Claude limit? | Use for |
|---|---|---|
| A worker that runs an OpenCode agent (the default one is DeepSeek Flash) | No | Default implementer: well-specified code changes, tests, bug fixes with a known cause, mechanical refactors, docs, bulk reading and summarising, first-pass review |
| A worker that runs Claude Code | Yes | Work that needs Claude-level judgement in the background: a review before a commit, a task an OpenCode worker failed at twice |
| A subagent of this session | Yes | Fast lookups that need this conversation's context |
| You | Most | Design, ambiguous debugging, splitting work, writing specs, reviewing diffs, final decisions |

Pick the cheapest worker that can do the task. Do not do a task yourself that a worker could do from a short spec.
Run at most 3 workers at a time, and never two that build or test the same project at once.

### Delegating
A new worker session starts with zero context. The first call for a task carries one self-contained spec:
1. Goal, in one or two sentences.
2. Exact absolute paths, functions and types to touch, plus files to read for patterns to follow.
3. Constraints: repo style, what must not change, performance limits.
4. Done means: the exact commands that must pass. The worker runs them itself.
5. Reply format: changed files, a one-paragraph summary, command results, anything uncertain.

Set `directory` to the repo (or worktree) root. Set `allow_edits: true` for code changes; without it the job is
read-only. Do not paste file contents into the prompt; let the worker read them. Keep tasks small enough to review in
one diff (roughly under 300 changed lines).

`effort`: leave it out for the worker's usual level. Use `low` for summaries, lookups and mechanical edits; `max` for
hard bugs, tricky algorithms, or a fix round after a failed attempt. A level the worker's model lacks is refused with
the valid ones.

### Waiting
`opencode_run` returns at once with a job id. Start every job you need, then make ONE `opencode_result` call with all
their ids as `jobs`: it waits until a job ends, for many minutes if needed, and waiting costs nothing. Claude Code may
move a long wait to the background and tell you when it settles; then carry on with other work or end the turn, and do
not call it again for the same jobs meanwhile. Call it again only when it came back with jobs still running. Never
wait with sleep, Monitor, wakeups, a background shell loop, a subagent or short repeated waits.

Don't redo or re-send a job that is still running, and don't start a second job on the same files while one may still
be editing them. A job that runs long builds or test suites gets a larger `timeout_seconds`;
`opencode_cancel { job }` stops one that went wrong. A timed-out, cancelled or lost job returns a short summary
(session, files edited, last text, log path): review whatever it left in `git diff`, or continue its session.

Every reply ends with `session: …`. Keep one session per task and pass it as `session` for every follow-up on that
task: fix rounds, next steps, questions. Send only the new information. Do not resend the spec. Start a new session
for an unrelated task.

### Review (always)
- Review with `git diff` / `git diff --stat`, not by rereading whole files. Re-run the checks yourself.
- If it's wrong, send your concrete findings to the same session ("fix these: …"), with `effort: max` on the
  second fix round. After 2 failed fix rounds, hand it to a Claude Code worker or do it yourself.
- A worker's output is an untrusted draft. Never commit without your review.

### Parallelism
Run independent tasks at the same time (several jobs started in one turn, each its own session) only if they
touch different files; otherwise give each its own git worktree and pass that path as `directory`.

### Never send to a worker that runs OpenCode
Secrets, credentials, private data, or anything I've marked confidential: it goes to that provider's API.
