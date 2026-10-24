[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$targetRoot = Join-Path $desktopRoot 'src-tauri\target'
$exe = Join-Path $targetRoot 'release\cuvilo.exe'
$previousExecutables = @((Join-Path $targetRoot 'release\cuewise.exe'), (Join-Path $targetRoot 'release\interview-copilot.exe'))
foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='cuvilo.exe' OR Name='cuewise.exe' OR Name='interview-copilot.exe'")) {
    if ([string]::IsNullOrWhiteSpace($process.ExecutablePath) -or $process.ExecutablePath -in (@($exe) + $previousExecutables)) {
        throw 'Save your input and exit Cuvilo from its tray menu before packaging. No process was stopped.'
    }
}
$hostInfo = & rustc -vV
if ($LASTEXITCODE -ne 0 -or $hostInfo -notcontains 'host: x86_64-pc-windows-msvc') {
    throw 'Packaging requires the Windows x64 MSVC Rust host and a Visual Studio developer shell.'
}

$previousSigningKey = $env:TAURI_SIGNING_PRIVATE_KEY
$localSigningKey = Join-Path $desktopRoot '..\.local\updater\cuvilo.key'
if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
    if (-not (Test-Path -LiteralPath $localSigningKey -PathType Leaf)) {
        throw 'Signed updates require TAURI_SIGNING_PRIVATE_KEY. See RELEASING.md. No key was generated or changed.'
    }
    $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $localSigningKey).Path
}

$previousTargetDir = $env:CARGO_TARGET_DIR
$previousBuildTarget = $env:CARGO_BUILD_TARGET
try {
    # One native output tree, also used by the user's usual EXE path.
    $env:CARGO_TARGET_DIR = $targetRoot
    Remove-Item Env:CARGO_BUILD_TARGET -ErrorAction SilentlyContinue
    Push-Location -LiteralPath $desktopRoot
    try {
        & npm.cmd run tauri -- build
        if ($LASTEXITCODE -ne 0) { throw "Tauri build failed with exit code $LASTEXITCODE. Previous installers were retained." }
    } finally { Pop-Location }
    & (Join-Path $PSScriptRoot 'clean-builds.ps1') -PurgeLegacyCaches
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $previousSigningKey
    $env:CARGO_TARGET_DIR = $previousTargetDir
    $env:CARGO_BUILD_TARGET = $previousBuildTarget
}
