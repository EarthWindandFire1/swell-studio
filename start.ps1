$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE." }
}

function Get-DependencyHash([string]$File) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $File).Path)
        return [BitConverter]::ToString($sha.ComputeHash($bytes))
    } finally { $sha.Dispose() }
}
if (-not $env:DATABASE_URL) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Install and start Docker Desktop, or set DATABASE_URL to an existing PostgreSQL database.'
    }
    Invoke-Checked docker @('compose', 'up', '-d', '--wait', 'db')
}

$pythonBin = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonBin)) {
    Invoke-Checked python @('-m', 'venv', '.venv')
}
$depHash = Get-DependencyHash 'backend/requirements.txt'
$depStamp = '.venv/.requirements-hash'
if (-not (Test-Path $depStamp) -or (Get-Content $depStamp -Raw).Trim() -ne $depHash) {
    Invoke-Checked $pythonBin @('-m', 'pip', 'install', '-r', 'backend/requirements.txt')
    Set-Content $depStamp $depHash
}
Push-Location frontend
try {
    $lockHash = Get-DependencyHash 'package-lock.json'
    $lockStamp = 'node_modules/.swell-lock'
    if (-not (Test-Path $lockStamp) -or (Get-Content $lockStamp -Raw).Trim() -ne $lockHash) {
        Invoke-Checked npm.cmd @('ci', '--no-audit', '--no-fund')
        Set-Content $lockStamp $lockHash
    }
    Invoke-Checked npm.cmd @('run', 'build')
} finally { Pop-Location }
Invoke-Checked $pythonBin @('backend/app.py')

