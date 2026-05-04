param(
  [ValidateSet("0700", "1200", "2000")]
  [string]$Slot,
  [switch]$SkipRender,
  [switch]$Upload,
  [switch]$DryRunUpload
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $Root "scripts\vnexpress-hot-news.mjs"
$PortableNodeDir = Join-Path $Root "tools\node-v24.14.0-win-x64"
$PortableFfmpegDir = Join-Path $Root "tools\ffmpeg-bin"
if (Test-Path -LiteralPath $PortableNodeDir) {
  $env:PATH = "$PortableNodeDir;$env:PATH"
}
if (Test-Path -LiteralPath $PortableFfmpegDir) {
  $env:PATH = "$PortableFfmpegDir;$env:PATH"
}
$NodeCandidates = @(
  (Join-Path $PortableNodeDir "node.exe"),
  (Join-Path $Root "node.exe"),
  "node",
  "C:\Program Files\nodejs\node.exe",
  "C:\Program Files\WindowsApps\OpenAI.Codex_26.429.3425.0_x64__2p2nqsd0c76g0\app\resources\node.exe"
)

$Node = $null
foreach ($Candidate in $NodeCandidates) {
  $Resolved = $null
  try {
    $Command = Get-Command $Candidate -ErrorAction Stop
    if ($Command.Source) {
      $Resolved = $Command.Source
    } else {
      $Resolved = $Candidate
    }
  } catch {
    if (Test-Path -LiteralPath $Candidate) {
      $Resolved = $Candidate
    }
  }

  if ($Resolved) {
    try {
      & $Resolved --version *> $null
      if ($LASTEXITCODE -eq 0) {
        $Node = $Resolved
        break
      }
    } catch {
      continue
    }
  }
}

if (-not $Node) {
  throw "Node.js was not found. Install Node.js >= 22 before running the VnExpress video automation."
}

$ArgsList = @($Script)
if ($Slot) {
  $ArgsList += @("--slot", $Slot)
}
if ($SkipRender) {
  $ArgsList += "--skip-render"
}
if ($Upload) {
  $ArgsList += "--upload"
}
if ($DryRunUpload) {
  $ArgsList += "--dry-run-upload"
}

Push-Location $Root
try {
  & $Node @ArgsList
  if ($LASTEXITCODE -ne 0) {
    throw "VnExpress video automation failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
