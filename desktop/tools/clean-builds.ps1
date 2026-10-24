[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$PurgeLegacyCaches)

$ErrorActionPreference = 'Stop'
$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $desktopRoot '..')).Path
$repoPrefix = $repoRoot.TrimEnd('\') + '\'
$targetRoot = Join-Path $desktopRoot 'src-tauri\target'
$releaseRoot = Join-Path $targetRoot 'release'
$config = Get-Content -LiteralPath (Join-Path $desktopRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$exe = Join-Path $releaseRoot 'cuvilo.exe'
$installer = Join-Path $releaseRoot ("bundle\nsis\{0}_{1}_x64-setup.exe" -f $config.productName, $config.version)

function Get-DeliveryHash([string]$Path) {
    # Get-FileHash may not be available in a Windows PowerShell launched from a
    # different PowerShell runtime. Use the same SHA-256 algorithm via .NET.
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Assert-SafePath([string]$Path, [switch]$Tree) {
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (-not $resolved.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the repository: $resolved"
    }
    $cursor = Get-Item -LiteralPath $resolved -Force
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a link or junction: $($cursor.FullName)"
        }
        $cursor = if ($cursor -is [IO.DirectoryInfo]) { $cursor.Parent } else { $cursor.Directory }
    }
    if ($Tree) {
        $link = Get-ChildItem -LiteralPath $resolved -Recurse -Force -Attributes ReparsePoint | Select-Object -First 1
        if ($null -ne $link) { throw "Refusing a tree containing a link: $($link.FullName)" }
    }
    return $resolved
}

# No deletion until a complete current delivery has been found and checked.
$exe = Assert-SafePath $exe
$installer = Assert-SafePath $installer
if ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -ne $config.version) {
    throw 'The canonical EXE does not match the configured version. Nothing was removed.'
}
$exeHash = Get-DeliveryHash $exe
$installerHash = Get-DeliveryHash $installer
$candidates = @()
$nsisRoot = Split-Path -Parent $installer
$candidates += @(Get-ChildItem -LiteralPath $nsisRoot -File -Filter '*_x64-setup.exe' | Where-Object {
    ($_.Name.StartsWith($config.productName + '_', [StringComparison]::OrdinalIgnoreCase) -or
     $_.Name.StartsWith('CueWise_', [StringComparison]::OrdinalIgnoreCase) -or
     $_.Name.StartsWith('Interview Copilot_', [StringComparison]::OrdinalIgnoreCase)) -and $_.FullName -ne $installer
} | ForEach-Object { $_.FullName })
# Keep the current updater signature paired with its installer; remove orphaned older signatures.
$candidates += @(Get-ChildItem -LiteralPath $nsisRoot -File -Filter '*_x64-setup.exe.sig' | Where-Object {
    $_.Name.StartsWith($config.productName + '_', [StringComparison]::OrdinalIgnoreCase) -and $_.FullName -ne ($installer + '.sig')
} | ForEach-Object { $_.FullName })
# Previous product names are obsolete deliveries, not user data or dependency caches.
foreach ($name in @('cuewise.exe', 'cuewise.d', 'cuewise.pdb', 'cuewise_lib.pdb', 'cuewise_lib.dll', 'cuewise_lib.dll.lib', 'cuewise_lib.lib', 'libcuewise_lib.rlib', 'cuewise_lib.dll.exp', 'interview-copilot.exe', 'interview-copilot.d', 'interview_copilot.pdb')) {
    $path = Join-Path $releaseRoot $name
    if (Test-Path -LiteralPath $path) { $candidates += $path }
}
$logsRoot = Join-Path $repoRoot 'logs'
if (Test-Path -LiteralPath $logsRoot) {
    $null = Assert-SafePath $logsRoot -Tree
    $candidates += @(Get-ChildItem -LiteralPath $logsRoot -Recurse -File | Where-Object {
        $_.Name -like 'interview-copilot*.exe' -or $_.Name -like 'cuewise*.exe' -or $_.Name -like 'cuvilo*.exe'
    } | ForEach-Object { $_.FullName })
}
if ($PurgeLegacyCaches) {
    # The renamed app no longer references these old application crates. Keep
    # reusable third-party dependency artifacts in the same release tree.
    foreach ($cacheName in @('.fingerprint', 'build')) {
        $cacheRoot = Join-Path $releaseRoot $cacheName
        if (Test-Path -LiteralPath $cacheRoot) {
            $candidates += @(Get-ChildItem -LiteralPath $cacheRoot -Directory | Where-Object { $_.Name -like 'interview-copilot-*' -or $_.Name -like 'cuewise-*' } | ForEach-Object { $_.FullName })
        }
    }
    $depsRoot = Join-Path $releaseRoot 'deps'
    if (Test-Path -LiteralPath $depsRoot) {
        $candidates += @(Get-ChildItem -LiteralPath $depsRoot -File | Where-Object {
            $_.Name -like 'interview_copilot*' -or $_.Name -like 'libinterview_copilot*.rlib' -or $_.Name -like 'cuewise*' -or $_.Name -like 'libcuewise*'
        } | ForEach-Object { $_.FullName })
    }
    foreach ($name in @('debug', 'x86_64-pc-windows-msvc')) {
        $path = Join-Path $targetRoot $name
        if (Test-Path -LiteralPath $path) { $candidates += $path }
    }
}

$running = @(Get-CimInstance Win32_Process -Property Name,ExecutablePath | ForEach-Object {
    if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) {
        if ($_.Name -in @('cuvilo.exe', 'cuewise.exe', 'interview-copilot.exe')) { throw 'Cannot determine a running app path; cleanup stopped.' }
    } else { $_.ExecutablePath }
})
$plan = @($candidates | Sort-Object -Unique | ForEach-Object {
    $item = Get-Item -LiteralPath $_ -Force
    $path = Assert-SafePath $item.FullName -Tree:$item.PSIsContainer
    foreach ($active in $running) {
        if ($active -eq $path -or $active.StartsWith($path.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "A cleanup target contains a running app: $path"
        }
    }
    $bytes = if ($item.PSIsContainer) { (Get-ChildItem -LiteralPath $path -Recurse -File -Force | Measure-Object Length -Sum).Sum } else { $item.Length }
    [pscustomobject]@{Path=$path; Directory=$item.PSIsContainer; Bytes=[long]$bytes}
})

[long]$removedBytes = 0
$removed = @()
foreach ($entry in $plan) {
    if ($PSCmdlet.ShouldProcess($entry.Path, 'Remove obsolete build output')) {
        # Recheck immediately before a recursive deletion.
        $null = Assert-SafePath $entry.Path -Tree:$entry.Directory
        Remove-Item -LiteralPath $entry.Path -Recurse:$entry.Directory -Force -ErrorAction Stop
        $removedBytes += $entry.Bytes
        $removed += $entry.Path
    }
}
if ((Get-DeliveryHash $exe) -ne $exeHash -or
    (Get-DeliveryHash $installer) -ne $installerHash) {
    throw 'Current delivery changed during cleanup.'
}
[pscustomobject]@{Version=$config.version; PlannedBytes=[long](($plan | Measure-Object Bytes -Sum).Sum); RemovedBytes=$removedBytes; RemovedPaths=$removed; Exe=$exe; Installer=$installer; ExeSHA256=$exeHash; InstallerSHA256=$installerHash}
