# Замеры графического стенда растительности (docs/UNITY_FLORA_RENDERER_REPORT.md).
# Запускать на эталонной машине при свободном GPU (без параллельных тяжёлых процессов Unity), окно 1920 × 1080 на весь экран.
# Сборка стенда: Unity.exe -batchmode -quit -projectPath unity\WorldboundProto -executeMethod Worldbound.FloraView.EditorTools.FloraStandBuilder.All
param(
    [string]$Exe = "$PSScriptRoot\..\WorldboundProto\Build\FloraStand\FloraStand.exe",
    [string]$Out = "$PSScriptRoot\..\Results\flora",
    [int]$Seconds = 15
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Out | Out-Null
$views = 'overview','flight','forest','grass','mixed'
$medium = @()
foreach ($t in 10000, 50000, 100000, 300000) { foreach ($v in $views) { $medium += "${t}:$v" } }
$medium += '300000:live'
$runs = @(
    @{ Name = 'bench-medium'; Quality = 'medium'; Spec = ($medium -join ',') },
    @{ Name = 'bench-high'; Quality = 'high'; Spec = (($views | ForEach-Object { "300000:$_" }) -join ',') },
    @{ Name = 'bench-low'; Quality = 'low'; Spec = (($views | ForEach-Object { "300000:$_" }) -join ',') }
)
foreach ($r in $runs) {
    $json = Join-Path $Out "$($r.Name).json"
    $log = Join-Path $Out "$($r.Name).log"
    Write-Host "== $($r.Name): $($r.Spec)"
    $p = Start-Process -FilePath $Exe -PassThru -Wait -ArgumentList @(
        '-flbench', $r.Spec, '-flquality', $r.Quality, '-flsec', $Seconds, '-flout', $json,
        '-screen-width', 1920, '-screen-height', 1080, '-screen-fullscreen', 1, '-logFile', $log)
    Write-Host "   exit $($p.ExitCode) -> $json"
}
