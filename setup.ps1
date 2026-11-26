# One-step setup and update of the OpenCode bridge on Windows:
#   irm https://raw.githubusercontent.com/Kaan88/claude-flash-bridge/main/setup.ps1 | iex
# Installs only what is missing: Node.js, Git, Claude Code, OpenCode and this bridge. A bridge already installed
# is used where it is (the copy Claude is registered with, else ~/.claude/mcp-servers/opencode-agent; a git clone
# is updated). Signs OpenCode in to DeepSeek if it has no key yet (the key is typed into OpenCode's own prompt and
# never passes through this script), then runs install.mjs.
# Safe to run again: everything already present is left alone.
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

# 5. The bridge itself: an installed copy is used as it is; only a missing one is installed.
# A copy registered in Claude Code or Claude Desktop is found wherever it lives, not only in $Dir.
$findRegistered = @'
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
'@
$registered = ($findRegistered | node - 2>$null | Select-Object -First 1)
if ($registered) { $Dir = $registered.Trim() }

if (Test-Path (Join-Path $Dir "server.mjs")) {
    if ((Test-Path (Join-Path $Dir ".git")) -and (Have git)) {
        Say "Bridge found in $Dir; updating it"
        git -C $Dir pull -q --ff-only 2>$null
        if ($LASTEXITCODE -ne 0) { Warn "Could not update it (local changes, or no network); using it as it is." }
    } else {
        # a copied folder (not a clone) was never updated, so an old install.mjs kept registering the old name:
        # turn it into a clone of the latest version, keeping a backup of what was there
        Say "Bridge found in $Dir (not a git clone); updating it to the latest version"
        $backup = "$Dir.old-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $Dir $backup -Recurse -Force
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "flash-bridge-$PID"
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        if (Have git) {
            git clone -q $Repo $tmp
        } else {
            $zip = "$tmp.zip"
            Invoke-WebRequest "$Repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
            Expand-Archive $zip "$tmp-x" -Force; Remove-Item $zip
            Move-Item (Get-ChildItem "$tmp-x" -Directory | Select-Object -First 1).FullName $tmp; Remove-Item "$tmp-x" -Recurse -Force
        }
        if (-not (Test-Path (Join-Path $tmp "server.mjs"))) { throw "Could not download the bridge; the old copy is unchanged." }
        Copy-Item (Join-Path $tmp "*") $Dir -Recurse -Force
        Copy-Item (Join-Path $tmp ".git") $Dir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $tmp -Recurse -Force
        Say "Updated; the previous copy is in $backup"
    }
} elseif ((Have git) -and -not (Test-Path (Join-Path $Dir "*"))) {
    Say "Installing the bridge into $Dir"
    New-Item -ItemType Directory -Force (Split-Path $Dir) | Out-Null
    git clone -q $Repo $Dir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed." }
} else {
    # no git, or a folder that holds other files but no bridge: add the bridge's files beside them
    Say "Installing the bridge into $Dir"
    $zip = Join-Path $env:TEMP "claude-flash-bridge.zip"
    $tmp = Join-Path $env:TEMP "claude-flash-bridge-unzip"
    Invoke-WebRequest "$Repo/archive/refs/heads/main.zip" -OutFile $zip -UseBasicParsing
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    Expand-Archive $zip $tmp
    New-Item -ItemType Directory -Force $Dir | Out-Null
    Copy-Item -Recurse -Force (Join-Path $tmp "claude-flash-bridge-main\*") $Dir
    Remove-Item -Recurse -Force $tmp, $zip
}

# 6. Registration, sign-in and smoke test against the worker's actual profile.
Say "Registering the bridge"
if (-not (Test-Path (Join-Path $Dir "install.mjs"))) { throw "$Dir has no install.mjs (an old copy?); register it by hand or delete the folder and run this again." }
Push-Location $Dir
try { node install.mjs --signin } finally { Pop-Location }
