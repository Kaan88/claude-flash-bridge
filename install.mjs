#!/usr/bin/env node
// Sets up the deepseek-flash bridge on this PC: OpenCode agents, Claude Code (user scope), Claude Desktop.
// Run from this folder after copying it to ~/.claude/mcp-servers/opencode-agent:  node install.mjs
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "server.mjs");
const node = process.execPath;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const ok = (m) => console.log(`ok    ${m}`);
const warn = (m) => console.log(`WARN  ${m}`);

// Same lookup as server.mjs, plus common install folders when OpenCode is not on PATH.
function findOpencode() {
  if (process.env.OPENCODE_EXE) return process.env.OPENCODE_EXE;
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const real = join(dir, "node_modules", "@opencode", "cli", "bin", exe);
    if (existsSync(real)) return real;
    if (existsSync(join(dir, exe))) return join(dir, exe);
  }
  const extra = [
    join(process.env.LOCALAPPDATA || "", "Programs", "opencode"),
    join(process.env.LOCALAPPDATA || "", "Programs", "OpenCode"),
    join(process.env.LOCALAPPDATA || "", "opencode", "bin"),
    join(homedir(), ".opencode", "bin"),
    join(homedir(), ".local", "bin"),
    join(process.env.APPDATA || "", "npm", "node_modules", "@opencode", "cli", "bin"),
    join(process.env.ProgramFiles || "", "OpenCode"),
  ];
  for (const dir of extra) if (existsSync(join(dir, exe))) return join(dir, exe);
  return null;
}
const opencode = findOpencode();
// Off-PATH installs are handed to the server through OPENCODE_EXE.
const onPath = opencode && (process.env.PATH || "").split(delimiter).some((d) => opencode.startsWith(d));
const serverEnv = { OPENCODE_TIMEOUT_MS: "3600000", ...(opencode && !onPath ? { OPENCODE_EXE: opencode } : {}) };
opencode ? ok(`OpenCode: ${opencode}`) : warn("OpenCode executable not found; set OPENCODE_EXE=<full path to opencode.exe> and re-run");

// Accepts JSONC: strips comments and trailing commas (outside strings) before parsing.
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function editJson(path, fn) {
  if (!existsSync(path)) return warn(`${path} not found, skipped`);
  let data;
  try {
    data = parseJsonc(readFileSync(path, "utf8"));
  } catch (e) {
    return warn(`${path} could not be parsed (${e.message}); add the entries by hand`);
  }
  copyFileSync(path, `${path}.bak-${stamp}`);
  fn(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  ok(`${path} updated (backup .bak-${stamp})`);
}

// 1. OpenCode agents
const shell = (r) => ({ action: "shell", resource: r, effect: "allow" });
const model = "deepseek/deepseek-flash#high";
const ocDir = join(homedir(), ".config", "opencode");
const ocConfig =
  ["opencode.json", "opencode.jsonc"].map((f) => join(ocDir, f)).find(existsSync) ||
  (mkdirSync(ocDir, { recursive: true }), writeFileSync(join(ocDir, "opencode.json"), '{ "$schema": "https://opencode.ai/config.json" }\n'), join(ocDir, "opencode.json"));
editJson(ocConfig, (c) => {
  c.agents ??= {};
  c.agents["deepseek-flash"] = {
    ...(c.agents["deepseek-flash"] || {}),
    description: "Delegates work to DeepSeek Flash with high reasoning effort.",
    mode: "subagent",
    model,
    permissions: [{ action: "subagent", resource: "*", effect: "deny" }],
  };
  c.agents["deepseek-flash-ro"] = {
    description: "DeepSeek Flash, read-only: cannot edit files or launch subagents.",
    mode: "subagent",
    hidden: true,
    model,
    permissions: [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      ...["git status*", "git diff*", "git log*", "git show*", "cargo check*", "cargo clippy*", "cargo test*"].map(shell),
    ],
  };
});

// 2. Claude Code CLI, user scope
try {
  execSync("claude mcp remove --scope user deepseek-flash", { stdio: "ignore" });
} catch {}
try {
  const envArgs = Object.entries(serverEnv).map(([k, v]) => `-e "${k}=${v}" `).join("");
  execSync(`claude mcp add --scope user ${envArgs}deepseek-flash -- "${node}" "${server}"`, { stdio: "inherit" });
  ok("Claude Code: deepseek-flash registered (user scope)");
} catch {
  warn("Claude Code CLI not found or failed; run: claude mcp add --scope user deepseek-flash -- node " + server);
}

// 3. Claude Desktop
const desktop =
  process.platform === "win32"
    ? join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(homedir(), ".config", "Claude", "claude_desktop_config.json");
if (!existsSync(desktop) && existsSync(dirname(desktop))) writeFileSync(desktop, "{}\n");
editJson(desktop, (c) => {
  c.mcpServers ??= {};
  c.mcpServers["deepseek-flash"] = { command: node, args: [server], env: serverEnv };
});

// 4. Smoke test through OpenCode
try {
  if (!opencode) throw new Error("OpenCode executable not found");
  const out = execSync(`"${opencode}" run --agent deepseek-flash-ro --archived "Reply with exactly: PONG"`, {
    encoding: "utf8",
    timeout: 120000,
    cwd: homedir(),
  });
  out.includes("PONG") ? ok("OpenCode + DeepSeek reply: PONG") : warn(`unexpected reply: ${out.trim().slice(0, 200)}`);
} catch (e) {
  warn(`OpenCode smoke test failed (is the deepseek provider signed in? run: opencode auth): ${e.message.split("\n")[0]}`);
}
console.log("\nDone. Fully quit Claude Desktop (tray icon too) and reopen; start a new Claude Code session.");

// Claude Code's own wait on a tool call; jobs return at once now, so this is only a safety net.
const settings = join(homedir(), ".claude", "settings.json");
if (!existsSync(settings)) (mkdirSync(dirname(settings), { recursive: true }), writeFileSync(settings, "{}\n"));
editJson(settings, (c) => {
  c.env ??= {};
  c.env.MCP_TOOL_TIMEOUT ??= "1800000";
});
