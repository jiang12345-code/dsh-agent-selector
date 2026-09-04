# install.ps1 — one-shot installer for dsh-agent-selector
# Usage:  pwsh install.ps1 [-ProfileName web]
# What it does:
#   1) copy this package into <dsh-home>/profiles/<profile>/node_modules/dsh-agent-selector
#   2) add "dsh-agent-selector" to that profile package.json's dsh.profile.bundles (if missing)
#   3) remind you to restart DSH (host half) and hard-refresh the page (client half)
param(
    [string]$ProfileName = 'web',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$dst = Join-Path $profileDir 'node_modules\dsh-agent-selector'
$pjPath = Join-Path $profileDir 'package.json'

if (-not (Test-Path $pjPath)) {
    Write-Error "profile package.json not found: $pjPath — check -ProfileName / -DshHome"
    exit 1
}

# 1) copy package
New-Item -ItemType Directory -Force -Path (Join-Path $dst 'lib') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dst 'scripts') | Out-Null
Copy-Item (Join-Path $src 'lib\index.js')  (Join-Path $dst 'lib\') -Force
Copy-Item (Join-Path $src 'lib\client.js') (Join-Path $dst 'lib\') -Force
Copy-Item (Join-Path $src 'scripts\wb_bridge.py') (Join-Path $dst 'scripts\') -Force
Copy-Item (Join-Path $src 'package.json') $dst -Force
Copy-Item (Join-Path $src 'cordis.patch.yml') $dst -Force
Write-Output "[1/3] package copied -> $dst"

# 2) register in dsh.profile.bundles (precise anchor edit, JSON-validated)
$raw = Get-Content $pjPath -Raw
if ($raw -match '"dsh-agent-selector"') {
    Write-Output '[2/3] already present in profile package.json (bundles or dependencies) — skipped'
} else {
    # add to bundles array: anchor on the closing of dsh.profile.bundles
    if ($raw -match '(?<pre>"bundles"\s*:\s*\[)(?<body>.*?)(?<post>\s*\])') {
        # single-line JSON (machine-written): insert after the opening bracket
        $raw = $raw -replace '(?<pre>"bundles"\s*:\s*\[)', '${pre}"dsh-agent-selector",'
    } else {
        Write-Error 'unexpected package.json shape: no dsh.profile.bundles found'
        exit 1
    }
    Set-Content -Path $pjPath -Value $raw -Encoding UTF8 -NoNewline
    # hard validation: file must still parse
    try {
        $pj = Get-Content $pjPath -Raw | ConvertFrom-Json
        if ($pj.dsh.profile.bundles -notcontains 'dsh-agent-selector') { throw 'entry not present after edit' }
        Write-Output ("[2/3] registered in bundles (total {0})" -f $pj.dsh.profile.bundles.Count)
    } catch {
        Write-Error "package.json edit failed validation: $_ — restore from $pjPath.bak if needed"
        exit 1
    }
}

# 3) remind
Write-Output '[3/3] done. Next steps:'
Write-Output '   - restart DSH          (host half: agent_dispatch tool + RPC)'
Write-Output '   - hard-refresh page    (client half: composer dropdown + settings panel)'
Write-Output '   - open Settings -> [🤖 智能体选择器] and run the channel tests'
