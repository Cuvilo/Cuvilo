param([int]$ProcessId,[int]$Seconds=3600,[int]$Interval=10,[string]$OutputPath=(Join-Path $PSScriptRoot '..\performance.csv'))
$ErrorActionPreference='Stop'
if (-not $ProcessId) { $root=Get-Process -Name cuvilo -ErrorAction Stop | Select-Object -First 1; $ProcessId=$root.Id }
$deadline=(Get-Date).AddSeconds($Seconds)
$rows=[System.Collections.Generic.List[object]]::new()
while ((Get-Date) -lt $deadline) {
    $processes=Get-CimInstance Win32_Process
    $ids=[System.Collections.Generic.HashSet[int]]::new();$null=$ids.Add($ProcessId)
    do { $before=$ids.Count; foreach($item in $processes){if($ids.Contains([int]$item.ParentProcessId)){$null=$ids.Add([int]$item.ProcessId)}} } while($ids.Count -gt $before)
    $live=@(foreach($id in $ids){Get-Process -Id $id -ErrorAction SilentlyContinue})
    if(-not ($live | Where-Object Id -eq $ProcessId)){break}
    $rows.Add([pscustomobject]@{Time=(Get-Date).ToString('o');ProcessCount=$live.Count;WorkingSetMB=[math]::Round(($live|Measure-Object WorkingSet64 -Sum).Sum/1MB,2);PrivateMB=[math]::Round(($live|Measure-Object PrivateMemorySize64 -Sum).Sum/1MB,2);CPUSeconds=[math]::Round(($live|Measure-Object CPU -Sum).Sum,2)})
    $rows | Export-Csv -LiteralPath $OutputPath -NoTypeInformation -Encoding utf8
    Start-Sleep -Seconds $Interval
}
Write-Output "Metrics saved: $OutputPath"
