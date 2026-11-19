# Проверка свёрнутого режима: запускает сборку с -wbbg (20 с активно, 40 с свёрнуто, 20 с восстановлено),
# раз в секунду снимает загрузку 3D-движка видеокарты процессом (счётчики Windows «GPU Engine») и CPU процесса.
# Результаты: Results/background/*.json (из приложения) и *.csv (внешние замеры).
param([string]$Mode = "continue")
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "WorldboundProto\Build\Windows\WorldboundProto.exe"
$out = Join-Path $root "Results\background"
New-Item -ItemType Directory -Force $out | Out-Null
$json = Join-Path $out "background-$Mode.json"
$csv = Join-Path $out "background-$Mode.csv"
Remove-Item -ErrorAction SilentlyContinue $json, "$json.phases.log", $csv
# Режим «пауза» задаётся настройкой (PlayerPrefs) — для проверки передаём через реестр Unity недоступно, поэтому
# приложение читает -wbpause как переопределение.
$args = @("-wbbg", $json, "-screen-width", "1920", "-screen-height", "1080", "-screen-fullscreen", "0")
if ($Mode -eq "pause") { $args += "-wbpause" }
$p = Start-Process -FilePath $exe -ArgumentList $args -PassThru
$cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
"time,gpu3dPercent,cpuPercentMachine,workingSetMB" | Out-File $csv -Encoding utf8
$prevCpu = 0; $prevT = Get-Date
while (-not $p.HasExited) {
  Start-Sleep -Milliseconds 1000
  try {
    $samples = (Get-Counter "\GPU Engine(pid_$($p.Id)_*engtype_3D)\Utilization Percentage" -ErrorAction Stop).CounterSamples
    $gpu = ($samples | Measure-Object -Property CookedValue -Sum).Sum
  } catch { $gpu = 0 }
  $p.Refresh()
  if ($p.HasExited) { break }
  $now = Get-Date
  $cpu = $p.TotalProcessorTime.TotalMilliseconds
  $cpuPct = if ($prevCpu -gt 0) { ($cpu - $prevCpu) / (($now - $prevT).TotalMilliseconds) / $cores * 100 } else { 0 }
  $prevCpu = $cpu; $prevT = $now
  "{0},{1:0.0},{2:0.0},{3}" -f $now.ToString("HH:mm:ss.fff"), $gpu, $cpuPct, [int]($p.WorkingSet64 / 1MB) | Out-File $csv -Append -Encoding utf8
}
Write-Output "done: $json"
