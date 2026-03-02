$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path .\node_modules)) { npm install }
node .\scan_phase1.js
