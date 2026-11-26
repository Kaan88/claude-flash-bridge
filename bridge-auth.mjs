// Worker sign-in entry point, also called by Config Studio. The only input for a key is
// stdin; never put it in argv, the contract, diagnostics, an environment variable or a log.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { api, availableProviders, configModel, environment, findOpencode, integrations, paths, pruneArchived, signInStatus, targetArgs, using, workerFile } from "./job-service.mjs";

const [action, provider, ...extra] = process.argv.slice(2);
const valid = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
async function main() {
  if (action === "prune" && !extra.length) return console.log(`Removed ${await pruneArchived(Number(provider))} archived worker sessions.`);
  if (extra.length || !["login", "logout", "list", "status", "key"].includes(action) ||
      (["login", "logout", "key"].includes(action) ? !valid.test(provider || "") : provider !== undefined))
    throw Error("Usage: node bridge-auth.mjs list | login PROVIDER | logout PROVIDER | prune DAYS");
  const cwd = dirname(paths.OPENCODE_DB);
  await using(async (svc,lease) => {
    if (action === "status") {
      const rows = await integrations(svc, cwd);
      const available = await availableProviders(svc,cwd);
      const file = existsSync(workerFile) ? JSON.parse(readFileSync(workerFile, "utf8")) : {};
      const workers = file.workers ?? { default: { runs: "opencode", agent: process.env.OPENCODE_AGENT || "deepseek-flash" } };
      const names = new Set();
      const agents = svc ? (await api(svc, `/api/agent?directory=${encodeURIComponent(cwd)}`)).data : [];
      const fallback = svc ? (await api(svc, `/api/model/default?directory=${encodeURIComponent(cwd)}`).catch(() => null))?.data : null;
      for (const w of Object.values(workers)) {
        if (w.disabled || w.runs !== "opencode") continue;
        const live = agents.find(a => a.id === w.agent)?.model;
        const ref = w.model || (live?.providerID && `${live.providerID}/${live.id}`) || configModel(w.agent) ||
          (fallback?.providerID && `${fallback.providerID}/${fallback.id}`) || process.env.OPENCODE_MODEL || "deepseek/deepseek-flash";
        if (valid.test(ref.split("/")[0])) names.add(ref.split("/")[0]);
      }
      // Project only public state; integration connection labels/addresses are not needed.
      console.log(JSON.stringify({ personal: file.magicContextInJobs === true, providers: [...names].sort().map(id => ({
        id, status: signInStatus(rows, id, available), key: !!svc && !!rows.find(r => r.id === id)?.methods?.some(m => m.type === "key"),
        stored: !!rows.find(r => r.id === id)?.connections?.some(c => c.type === "credential"),
      })) }));
      return;
    }
    if (action === "key") {
      if (!svc || process.stdin.isTTY) throw Error("Use login for interactive key entry.");
      const chunks = []; let size = 0;
      try {
        for await (const chunk of process.stdin) {
          chunks.push(chunk); size += chunk.length;
          if (size > 65536) throw Error("Key is too long.");
        }
        const key = Buffer.concat(chunks);
        try {
          if (!key.length) throw Error("Empty key.");
          await api(svc, `/api/integration/${encodeURIComponent(provider)}/connect/key?directory=${encodeURIComponent(cwd)}`,
            { method: "POST", body: { key: key.toString("utf8") } });
        } finally { key.fill(0); }
      } finally { chunks.forEach(b => b.fill(0)); }
      return;
    }
    const child = spawn(findOpencode(), ["auth", action, ...(provider ? [provider] : []), ...targetArgs(svc)],
      { cwd, env: environment(svc, cwd), stdio: "inherit",timeout:600000 });
    const exited = new Promise((ok, fail) => child.once("error", fail).once("exit", code => ok(code ?? 1)));
    if (!svc) await lease.bindClient(child.pid);
    process.exitCode = await exited;
  });
}
try { await main(); } catch {
  // In particular, syntax/HTTP errors must never echo config values or secret input.
  console.error("Worker sign-in command failed. Check the worker configuration and service. Usage: node bridge-auth.mjs list | login PROVIDER | logout PROVIDER | prune DAYS");
  process.exitCode = 1;
}
