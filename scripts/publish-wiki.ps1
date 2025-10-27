param(
  [string]$Repo = "ankitseal/electron-auto-reload",
  [string]$SourceDir = "docs/wiki",
  [string]$Branch = "master", # GitHub Wiki default branch is 'master'
  [string]$Token = $env:GITHUB_TOKEN
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "[wiki] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[wiki] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "[wiki] $msg" -ForegroundColor Red }

if (!(Test-Path $SourceDir)) {
  Write-Err "SourceDir '$SourceDir' not found."
  exit 1
}

$wikiUrl = if ([string]::IsNullOrWhiteSpace($Token)) { "https://github.com/$Repo.wiki.git" } else { "https://$Token@github.com/$Repo.wiki.git" }
$publishDir = Join-Path $PSScriptRoot "..\wiki-publish"

# Clean publish dir
if (Test-Path $publishDir) { Remove-Item -Recurse -Force $publishDir }

# Probe wiki existence/access
Write-Info "Probing wiki repo..."
$ls = ""
$exit = 0
try {
  $ls = & git ls-remote $wikiUrl 2>&1
  $exit = $LASTEXITCODE
} catch {
  $exit = 1
  $ls = $_.Exception.Message
}
if ($exit -ne 0 -or ($ls -match 'Repository not found')) {
  Write-Warn "Wiki repo not reachable. Likely not enabled or you lack access."
  Write-Warn "Enable 'Wiki' in GitHub repo settings, then re-run."
  Write-Warn "If private, set a GITHUB_TOKEN with repo access in your env."
  exit 2
}

Write-Info "Cloning wiki..."
& git clone $wikiUrl $publishDir | Write-Host

# Copy markdown files
Write-Info "Copying pages from $SourceDir ..."
Copy-Item -Path (Join-Path $PSScriptRoot "..\$SourceDir\*.md") -Destination $publishDir -Force

# Ensure Home.md exists
$readmePath = Join-Path $publishDir "README.md"
$homePath = Join-Path $publishDir "Home.md"
if ((Test-Path $readmePath) -and !(Test-Path $homePath)) {
  Rename-Item -Path $readmePath -NewName "Home.md" -Force
}

Push-Location $publishDir
try {
  & git add . | Write-Host
  & git commit -m "Publish docs/wiki to GitHub Wiki (auto-generated)" --allow-empty | Write-Host
  & git push origin $Branch | Write-Host
  Write-Info "Published to GitHub Wiki."
}
finally {
  Pop-Location
}
