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

# 4. The bridge itself. An existing copy is adopted, whatever made it: a clone is fast-forwarded; a copy
# made by hand, an archive, or a clone with local edits is backed up next to it first, then brought to the
# latest version in place.
BACKUP=""
backup_bridge() {
  [ -n "$BACKUP" ] && return
  BACKUP="$DIR.bak-$(date +%Y%m%d-%H%M%S)"
  cp -R "$DIR" "$BACKUP"
  say "Backed up the existing copy to $BACKUP"
}
g() { git -C "$DIR" "$@"; }

if have git && [ ! -e "$DIR" ]; then
  say "Cloning the bridge into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone "$REPO" "$DIR"
elif have git; then
  say "Updating the bridge in $DIR"
  if [ ! -d "$DIR/.git" ]; then
    say "The existing copy is not a git clone; converting it"
    backup_bridge
    g init -q
  fi
  g remote get-url origin >/dev/null 2>&1 || g remote add origin "$REPO"
  g fetch -q origin main || { echo "git fetch from $REPO failed." >&2; exit 1; }
  has_head=0; g rev-parse --verify -q HEAD >/dev/null && has_head=1
  dirty=0; [ "$has_head" = 1 ] && [ -n "$(g status --porcelain --untracked-files=no)" ] && dirty=1
  if [ "$has_head" = 1 ] && [ "$dirty" = 0 ] && g merge-base --is-ancestor HEAD origin/main; then
    g merge -q --ff-only origin/main
  elif [ "$has_head" = 1 ] && [ "$dirty" = 0 ] && g merge-base --is-ancestor origin/main HEAD; then
    warn "The local copy has commits GitHub does not have; kept as it is."
  else
    [ "$has_head" = 1 ] && say "The local copy has edits or has diverged from GitHub; replacing it with the latest version"
    backup_bridge
    # reset --hard drops local edits and overwrites untracked files at the repo's paths (a hand-made copy
    # has those); checkout alone would carry the edits over. Then the branch is named main.
    { g reset -q --hard origin/main && g checkout -q -B main origin/main; } ||
      { echo "Could not bring $DIR to the latest version; the old copy is in $BACKUP." >&2; exit 1; }
  fi
  g branch -q --set-upstream-to=origin/main main >/dev/null 2>&1 || true
  say "Bridge at $(g log -1 --format='%h %s')"
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
