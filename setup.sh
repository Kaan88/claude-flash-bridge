#!/usr/bin/env bash
# One-step setup and update of the OpenCode bridge on macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.sh | bash
# Installs only what is missing: Claude Code, OpenCode, Node.js (through Homebrew on macOS) and this bridge. A
# bridge already installed is used where it is (the copy Claude is registered with, else
# ~/.claude/mcp-servers/opencode-agent; a git clone is updated). Signs OpenCode in to DeepSeek if it has no key yet
# (the key is typed into OpenCode's own prompt and never passes through this script), then runs install.mjs.
# Safe to run again. FLASH_BRIDGE_UPGRADE=1 also upgrades OpenCode to its latest release.
set -euo pipefail

REPO="https://github.com/Kaan88/claude-flash-bridge"
DIR="$HOME/.claude/mcp-servers/opencode-agent"
say() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARN  %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
export PATH="$HOME/.local/bin:$PATH"
# piped into bash, stdin is the script: interactive prompts read the terminal instead
TTY=/dev/tty
[ -r "$TTY" ] || TTY=/dev/stdin

# 1. Node.js
if ! have node; then
  if have brew; then say "Installing Node.js"; brew install node
  else echo "Node.js 18+ is needed: install it (https://nodejs.org or your package manager) and run this again." >&2; exit 1; fi
fi
[ "$(node -p "process.versions.node.split('.')[0]")" -ge 18 ] || { echo "Node.js 18 or newer is needed (found $(node -v))." >&2; exit 1; }
say "Node.js $(node -v)"

# 2. Claude Code
if ! have claude; then
  say "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
have claude && say "Claude Code $(claude --version)" || warn "Claude Code not found on PATH; the bridge is still added to Claude Desktop."

# 3. OpenCode (a user-owned npm prefix when the global one needs root)
npm_global() {
  if npm install -g "$@"; then return; fi
  warn "global npm install failed; using ~/.npm-global"
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  npm install -g "$@"
}
if ! have opencode; then
  say "Installing OpenCode"; npm_global @opencode/cli
elif [ "${FLASH_BRIDGE_UPGRADE:-}" = "1" ]; then
  say "Upgrading OpenCode"; npm_global @opencode/cli@latest
fi
have opencode || { echo "OpenCode still not found after installing; open a new terminal and run this again." >&2; exit 1; }
say "OpenCode $(opencode --version)"

# 4. The bridge itself: an installed copy is used as it is; only a missing one is installed.
# A copy registered in Claude Code or Claude Desktop is found wherever it lives, not only in $DIR.
registered="$(node - 2>/dev/null <<'EOF' || true
const fs = require("fs"), os = require("os"), p = require("path");
const desktop = process.platform === "win32" ? p.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
  : process.platform === "darwin" ? p.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
  : p.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
for (const f of [p.join(os.homedir(), ".claude.json"), desktop]) {
  try {
    const m = JSON.parse(fs.readFileSync(f, "utf8")).mcpServers || {}, s = m.opencode || m["deepseek-flash"];
    const server = ((s && s.args) || []).find((a) => /server\.mjs$/.test(a));
    if (server && fs.existsSync(server)) { console.log(p.dirname(server)); break; }
  } catch {}
}
EOF
)"
[ -n "$registered" ] && DIR="$registered"

if [ -f "$DIR/server.mjs" ]; then
  if [ -d "$DIR/.git" ] && have git; then
    say "Bridge found in $DIR; updating it"
    git -C "$DIR" pull -q --ff-only 2>/dev/null || warn "Could not update it (local changes, or no network); using it as it is."
  else
    # a copied folder (not a clone) was never updated: make it a clone of the latest version, keeping a backup
    say "Bridge found in $DIR (not a git clone); updating it to the latest version"
    backup="$DIR.old-$(date +%Y%m%d-%H%M%S)"; cp -R "$DIR" "$backup"
    tmp="$(mktemp -d)"
    if have git; then git clone -q "$REPO" "$tmp/b"
    else mkdir -p "$tmp/b" && curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$tmp/b" --strip-components=1; fi
    [ -f "$tmp/b/server.mjs" ] || { echo "Could not download the bridge; the old copy is unchanged." >&2; exit 1; }
    cp -R "$tmp/b/." "$DIR/"; rm -rf "$tmp"
    say "Updated; the previous copy is in $backup"
  fi
elif have git && [ -z "$(ls -A "$DIR" 2>/dev/null)" ]; then
  say "Installing the bridge into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone -q "$REPO" "$DIR"
else
  # no git, or a folder that holds other files but no bridge: add the bridge's files beside them
  say "Installing the bridge into $DIR"
  tmp="$(mktemp -d)"
  curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$tmp"
  mkdir -p "$DIR"
  cp -R "$tmp"/claude-flash-bridge-main/. "$DIR"/
  rm -rf "$tmp"
fi

# 5. DeepSeek key: only asked for when OpenCode has none
if opencode auth list 2>&1 | grep -Eiq '\bdeepseek\b.*\bstored\b'; then
  say "DeepSeek key already stored in OpenCode"
else
  say "OpenCode has no DeepSeek key yet. Pick DeepSeek and paste your API key at OpenCode's prompt (https://platform.deepseek.com/api_keys)."
  opencode auth login deepseek <"$TTY" || true
  opencode auth list 2>&1 | grep -Eiq '\bdeepseek\b.*\bstored\b' || warn "No DeepSeek key stored; run 'opencode auth login deepseek' later, then run this again."
fi

# 6. Agents, Claude Code and Claude Desktop registration, smoke test
say "Registering the bridge"
[ -f "$DIR/install.mjs" ] || { echo "$DIR has no install.mjs (an old copy?); register it by hand or delete the folder and run this again." >&2; exit 1; }
cd "$DIR" && node install.mjs
