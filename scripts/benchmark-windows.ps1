param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [Parameter(Mandatory = $true)]
  [string]$Label,
  [ValidateRange(1, 100)]
  [int]$Runs = 10
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workRoot = [IO.Path]::GetFullPath((Join-Path $root '.work'))
$installerPath = [IO.Path]::GetFullPath($Installer)
$installDir = [IO.Path]::GetFullPath((Join-Path $workRoot "benchmark-$Label-install"))
$dshHome = [IO.Path]::GetFullPath((Join-Path $workRoot "benchmark-$Label-home"))
$tracePath = Join-Path $env:APPDATA 'dsh-desktop\logs\startup-trace.jsonl'
$resultPath = Join-Path $workRoot "benchmark-$Label.json"

function Assert-WorkPath([string]$Path) {
  $prefix = $workRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside .work: $Path"
  }
}

function Remove-BenchmarkDirectory([string]$Path) {
  Assert-WorkPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Stop-BenchmarkProcess([Diagnostics.Process]$Process) {
  if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force
    $Process.WaitForExit(5000) | Out-Null
  }
}

function Find-InteractiveControl([int]$ProcessId) {
  $processCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $ProcessId
  )
  $window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Children,
    $processCondition
  )
  if ($null -eq $window) { return $false }

  try {
    $windowTop = $window.Current.BoundingRectangle.Top
    $elements = $window.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($element in $elements) {
      try {
        $type = $element.Current.ControlType
        $interactive = $type -eq [System.Windows.Automation.ControlType]::Button `
          -or $type -eq [System.Windows.Automation.ControlType]::Edit `
          -or $type -eq [System.Windows.Automation.ControlType]::ComboBox `
          -or $type -eq [System.Windows.Automation.ControlType]::TabItem `
          -or $type -eq [System.Windows.Automation.ControlType]::Hyperlink
        if (-not $interactive -or -not $element.Current.IsEnabled -or $element.Current.IsOffscreen) {
          continue
        }
        $bounds = $element.Current.BoundingRectangle
        if ($bounds.Width -gt 0 -and $bounds.Height -gt 0 -and $bounds.Top -ge ($windowTop + 48)) {
          return $true
        }
      } catch {
        # UI elements can disappear while the React tree commits; retry the next snapshot.
      }
    }
  } catch {
    return $false
  }
  return $false
}

function Read-InteractiveTrace {
  if (-not (Test-Path -LiteralPath $tracePath)) { return $null }
  foreach ($line in Get-Content -LiteralPath $tracePath) {
    try {
      $record = $line | ConvertFrom-Json
      if ($record.phase -eq 'interactive') { return [double]$record.elapsed_ms }
    } catch {
      # The final JSONL line can be observed between append and flush; retry it.
    }
  }
  return $null
}

function Percentile([double[]]$Values, [double]$Quantile) {
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Max(0, [Math]::Ceiling($sorted.Count * $Quantile) - 1)
  return [Math]::Round($sorted[$index], 1)
}

if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "Installer not found: $installerPath"
}
if (Get-Process -Name 'dsh-gui' -ErrorAction SilentlyContinue) {
  throw 'Close every running dsh-gui process before benchmarking so trace and process samples stay isolated.'
}
Assert-WorkPath $installDir
Assert-WorkPath $dshHome
Remove-BenchmarkDirectory $installDir
Remove-BenchmarkDirectory $dshHome

$results = @()
for ($run = 1; $run -le $Runs; $run += 1) {
  $runDshHome = [IO.Path]::GetFullPath("$dshHome-$run")
  Assert-WorkPath $runDshHome
  Remove-BenchmarkDirectory $runDshHome
  $guiProcess = $null

  try {
    $installWatch = [Diagnostics.Stopwatch]::StartNew()
    $installerProcess = Start-Process -FilePath $installerPath -ArgumentList @('/S', "/D=$installDir") -PassThru -Wait
    $installWatch.Stop()
    if ($installerProcess.ExitCode -ne 0) {
      throw "Installer exited $($installerProcess.ExitCode) on run $run"
    }

    $gui = Get-ChildItem -LiteralPath $installDir -Filter '*.exe' |
      Where-Object Name -ne 'uninstall.exe' |
      Select-Object -First 1
    if ($null -eq $gui) { throw "GUI executable missing after install run $run" }

    if (Test-Path -LiteralPath $tracePath) {
      Remove-Item -LiteralPath $tracePath -Force
    }
    if (Test-Path -LiteralPath $tracePath) {
      throw "Unable to clear stale startup trace before run $run"
    }
    $env:DSH_STARTUP_TRACE = '1'
    $env:DSH_HOME = $runDshHome
    $startupWatch = [Diagnostics.Stopwatch]::StartNew()
    $guiProcess = Start-Process -FilePath $gui.FullName -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($guiProcess.HasExited) {
        throw "GUI exited $($guiProcess.ExitCode) before interactivity on run $run"
      }
      if (Find-InteractiveControl $guiProcess.Id) { break }
      Start-Sleep -Milliseconds 25
    }
    $startupWatch.Stop()
    if (-not (Find-InteractiveControl $guiProcess.Id)) {
      throw "GUI did not expose an interactive control within 60s on run $run"
    }
    $traceDeadline = [DateTime]::UtcNow.AddSeconds(5)
    $traceMs = $null
    while ($null -eq $traceMs -and [DateTime]::UtcNow -lt $traceDeadline) {
      $traceMs = Read-InteractiveTrace
      if ($null -eq $traceMs) { Start-Sleep -Milliseconds 25 }
    }
    if ($null -eq $traceMs) {
      throw "GUI exposed a control but did not write the interactive trace on run $run"
    }
    Stop-BenchmarkProcess $guiProcess

    $uninstaller = Join-Path $installDir 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw "Uninstaller missing on run $run" }
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
    if ($uninstallProcess.ExitCode -ne 0) {
      throw "Uninstaller exited $($uninstallProcess.ExitCode) on run $run"
    }
    Remove-BenchmarkDirectory $installDir

    $sample = [ordered]@{
      run = $run
      install_ms = [Math]::Round($installWatch.Elapsed.TotalMilliseconds, 1)
      interactive_ms = [Math]::Round($startupWatch.Elapsed.TotalMilliseconds, 1)
      trace_interactive_ms = if ($null -eq $traceMs) { $null } else { [Math]::Round($traceMs, 1) }
    }
    $results += [pscustomobject]$sample
    Write-Host ($sample | ConvertTo-Json -Compress)
  } finally {
    if ($null -ne $guiProcess) {
      Stop-BenchmarkProcess $guiProcess
    }
    Remove-Item Env:DSH_STARTUP_TRACE -ErrorAction SilentlyContinue
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue

    $cleanupUninstaller = Join-Path $installDir 'uninstall.exe'
    if (Test-Path -LiteralPath $cleanupUninstaller) {
      try {
        Start-Process -FilePath $cleanupUninstaller -ArgumentList '/S' -Wait
      } catch {
        Write-Warning "Cleanup uninstaller failed on run ${run}: $_"
      }
    }
    Remove-BenchmarkDirectory $installDir
    Remove-BenchmarkDirectory $runDshHome
    if (Test-Path -LiteralPath $tracePath) {
      Remove-Item -LiteralPath $tracePath -Force
    }
  }
}

$summary = [ordered]@{
  label = $Label
  installer = $installerPath
  runs = $results
  install_p50_ms = Percentile @($results.install_ms) 0.5
  install_p95_ms = Percentile @($results.install_ms) 0.95
  interactive_p50_ms = Percentile @($results.interactive_ms) 0.5
  interactive_p95_ms = Percentile @($results.interactive_ms) 0.95
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding utf8
$summary | ConvertTo-Json -Depth 5
