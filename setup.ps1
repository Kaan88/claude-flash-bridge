# One-step setup and update of the deepseek-flash bridge on Windows:
#   irm https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.ps1 | iex
# Installs what is missing (Node.js, Git, Claude Code, OpenCode), clones or updates this repo in
# ~/.claude/mcp-servers/opencode-agent, signs OpenCode in to DeepSeek if it has no key yet (the key is
# typed into OpenCode's own prompt and never passes through this script), then runs install.mjs.
# Safe to run again: everything already present is left alone, and the bridge is updated.
# $env:FLASH_BRIDGE_UPGRADE = "1" also upgrades OpenCode to its latest release.

# Continue, not Stop: Windows PowerShell 5.1 turns a native tool's stderr into a terminating error under Stop.
# Failures are checked explicitly below; throw ends the script without closing the window (no exit under iex).
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Repo = "https://github.com/Kaan88/claude-flash-bridge"
$Dir = Join-Path $HOME ".claude\mcp-servers\opencode-agent"

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "WARN  $m" -ForegroundColor Yellow }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $extra = @((Join-Path $HOME ".local\bin"), (Join-Path $env:APPDATA "npm"))
    $env:Path = (@($machine, $user) + $extra | Where-Object { $_ }) -join ";"
}
function Winget-Install($id, $what) {
    if (-not (Have winget)) { throw "$what is missing and winget is not available; install $what by hand and run this again." }
    Say "Installing $what"
    winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent | Out-Host
    Refresh-Path
}

# 1. Node.js (runs the bridge and installs OpenCode)
if (-not (Have node)) { Winget-Install "OpenJS.NodeJS.LTS" "Node.js" }
if (-not (Have node)) { throw "Node.js still not found after installing; open a new terminal and run this again." }
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 18) { throw "Node.js 18 or newer is needed (found $(node -v))." }
Say "Node.js $(node -v)"

# 2. Git (clone and update; without it the repo is downloaded as a zip)
if (-not (Have git)) {
    try { Winget-Install "Git.Git" "Git" } catch { Warn "Git not installed ($($_.Exception.Message)); falling back to a zip download." }
}

# 3. Claude Code
if (-not (Have claude)) {
    Say "Installing Claude Code"
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Refresh-Path
}
if (Have claude) { Say "Claude Code $((claude --version) -join ' ')" } else { Warn "Claude Code not found on PATH; the bridge is still added to Claude Desktop." }

# 4. OpenCode
if (-not (Have opencode)) {
    Say "Installing OpenCode"
    npm install -g @opencode/cli | Out-Host
    Refresh-Path
} elseif ($env:FLASH_BRIDGE_UPGRADE -eq "1") {
    Say "Upgrading OpenCode"
    npm install -g @opencode/cli@latest | Out-Host
}
if (-not (Have opencode)) { throw "OpenCode still not found after installing; open a new terminal and run this again." }
Say "OpenCode $((opencode --version) -join ' ')"

# 5. The bridge itself
if (Test-Path (Join-Path $Dir ".git")) {
    Say "Updating the bridge in $Dir"
    git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Warn "git pull failed (local changes?); keeping the current copy." }
} elseif (Have git) {
    if (Test-Path $Dir) { throw "$Dir exists but is not a git clone; move it away and run this again." }
    Say "Cloning the bridge into $Dir"
    New-Item -ItemType Directory -Force (Split-Path $Dir) | Out-Null
    git clone $Repo $Dir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed." }
} else {
    Say "Downloading the bridge into $Dir"
    $zip = Join-Path $env:TEMP "claude-flash-bridge.zip"
    $tmp = Join-Path $env:TEMP "claude-flash-bridge-unzip"
    Invoke-WebRequest "$Repo/archive/refs/heads/main.zip" -OutFile $zip
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Expand-Archive $zip $tmp
    New-Item -ItemType Directory -Force $Dir | Out-Null
    Copy-Item -Recurse -Force (Join-Path $tmp "claude-flash-bridge-main\*") $Dir
    Remove-Item -Recurse -Force $tmp, $zip
}

# 6. DeepSeek key: only asked for when OpenCode has none
$auth = (opencode auth list 2>&1) -join "`n"
if ($auth -notmatch '(?im)^\s*\S.*\bdeepseek\b.*\bstored\b') {
    Say "OpenCode has no DeepSeek key yet. Pick DeepSeek and paste your API key at OpenCode's prompt (https://platform.deepseek.com/api_keys)."
    opencode auth login deepseek
    $auth = (opencode auth list 2>&1) -join "`n"
    if ($auth -notmatch '(?im)\bdeepseek\b.*\bstored\b') { Warn "No DeepSeek key stored; run 'opencode auth login deepseek' later, then run this again." }
} else {
    Say "DeepSeek key already stored in OpenCode"
}

# 7. Agents, Claude Code and Claude Desktop registration, smoke test
Say "Registering the bridge"
Push-Location $Dir
try { node install.mjs } finally { Pop-Location }
