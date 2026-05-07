$ErrorActionPreference = 'Continue'

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
Set-Location -LiteralPath $root.Path

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message =="
}

Write-Step "Starting CodexMobile"
npm run start:bg
if ($LASTEXITCODE -ne 0) {
  Write-Warning "CodexMobile start command returned a non-zero exit code."
}

Write-Host ""
if ($env:CODEXMOBILE_PUBLIC_URL) {
  Write-Host "CodexMobile URL: $env:CODEXMOBILE_PUBLIC_URL"
} else {
  Write-Host "CodexMobile URL: https://<your-device>.<your-tailnet>.ts.net:3443/"
}
Start-Sleep -Seconds 3
