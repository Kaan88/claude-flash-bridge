#!/usr/bin/env bash
# One-step setup and update of the deepseek-flash bridge on macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.sh | bash
# Installs what is missing (Claude Code, OpenCode; Node.js through Homebrew on macOS), clones or updates
# this repo in ~/.claude/mcp-servers/opencode-agent, signs OpenCode in to DeepSeek if it has no key yet
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

# 4. The bridge itself
if [ -d "$DIR/.git" ]; then
  say "Updating the bridge in $DIR"
  git -C "$DIR" pull --ff-only || warn "git pull failed (local changes?); keeping the current copy."
elif have git; then
  [ -e "$DIR" ] && { echo "$DIR exists but is not a git clone; move it away and run this again." >&2; exit 1; }
  say "Cloning the bridge into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO" "$DIR"
else
  say "Downloading the bridge into $DIR"
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
cd "$DIR" && node install.mjs
