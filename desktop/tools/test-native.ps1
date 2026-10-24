[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $desktopRoot 'src-tauri\test-fixtures\windows.manifest'
$mtTool = Get-Command mt.exe -ErrorAction SilentlyContinue
if (-not $mtTool) {
    $sdkRoot = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue).KitsRoot10
    if (-not $sdkRoot) { $sdkRoot = "${env:ProgramFiles(x86)}\Windows Kits\10" }
    $mtTool = Get-ChildItem -Path (Join-Path $sdkRoot 'bin\*\x64\mt.exe') -File | Sort-Object FullName -Descending | Select-Object -First 1
}
if (-not $mtTool) { throw 'Windows SDK mt.exe is required for native test executables.' }
$mtToolPath = if ($mtTool -is [System.Management.Automation.CommandInfo]) { $mtTool.Source } else { $mtTool.FullName }
$testExecutables = @()
Push-Location -LiteralPath $desktopRoot
try {
    & cargo test --manifest-path src-tauri/Cargo.toml --locked --lib --no-run --message-format=json | ForEach-Object {
        try { $artifact = $_ | ConvertFrom-Json } catch { Write-Host $_; return }
        if ($artifact.reason -eq 'compiler-artifact' -and $artifact.profile.test -and $artifact.executable) {
            $script:testExecutables += $artifact.executable
        } elseif ($artifact.reason -eq 'compiler-message') {
            Write-Host $artifact.message.rendered
        }
    }
    if ($LASTEXITCODE -ne 0) { throw 'Native test build failed.' }
    if (-not $testExecutables.Count) { throw 'Native test executable not found.' }
    foreach ($testExe in $testExecutables) {
        # Tests load Windows common controls even when no visible window is created.
        & $mtToolPath -nologo -manifest $manifest "-outputresource:$testExe;#1"
        if ($LASTEXITCODE -ne 0) { throw 'Could not embed the common-controls test manifest.' }
        # Native fixtures use the shared Windows credential store, COM and window state.
        # Serialize harness tests; concurrency inside each regression test is retained.
        & $testExe --test-threads=1
        if ($LASTEXITCODE -ne 0) { throw "Native tests failed with exit code $LASTEXITCODE." }
    }
} finally { Pop-Location }
