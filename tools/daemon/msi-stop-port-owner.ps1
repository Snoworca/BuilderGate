# OPS-BGSTAB-021. Run by the MSI before InstallValidate: stop any BuilderGate that listens on the
# ports the new install will serve, so the new executable can bind them and the old files are free.
#
# Rules (see the requirement):
# - Only a process recognised as BuilderGate is terminated. Anything else is left running.
# - Termination is by PID. Never by image name, never a process tree.
# - The sentinel of that BuilderGate goes first, so it cannot restart the app it watches. A
#   sentinel is matched to the app through the appPid in its own state file, so the sentinel of
#   another BuilderGate is not touched.
# - Exit 1 only when a BuilderGate listener is still there after the timeout.
param(
  [int[]]$Ports = @(2002, 2001),
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Log([string]$Message) {
  Write-Output "[BuilderGate install] $Message"
}

function Get-ListenerPids([int[]]$TargetPorts) {
  $ids = @()
  foreach ($port in $TargetPorts) {
    try {
      $ids += @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | ForEach-Object { [int]$_.OwningProcess })
    } catch {
      # No listener on this port.
    }
  }
  return @($ids | Where-Object { $_ -gt 4 } | Sort-Object -Unique)
}

function Get-ProcessInfo([int]$ProcessId) {
  return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-BuilderGateCheckoutEntry([string]$CommandLine) {
  $match = [regex]::Match($CommandLine, '(?i)([A-Z]:\\[^"]*?)\\server\\dist\\index\.js')
  if (-not $match.Success) { return $false }
  $packageJson = Join-Path $match.Groups[1].Value 'server\package.json'
  if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { return $false }
  try {
    $name = (Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json).name
    return $name -eq 'buildergate-server'
  } catch {
    return $false
  }
}

function Test-BuilderGateProcess($Info) {
  if (-not $Info) { return $false }
  $exe = [string]$Info.ExecutablePath
  $cmd = [string]$Info.CommandLine
  if ($exe -match '(?i)\\BuilderGate\.exe$') { return $true }
  if ($cmd -match '--internal-app(\s|$|")' -or $cmd -match '--internal-sentinel(\s|$|")') { return $true }
  return Test-BuilderGateCheckoutEntry $cmd
}

function Get-SentinelPids([int]$AppPid) {
  $sentinels = @()
  $candidates = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { ([string]$_.CommandLine) -match '--internal-sentinel-state' })
  foreach ($candidate in $candidates) {
    $match = [regex]::Match([string]$candidate.CommandLine, '--internal-sentinel-state\s+(?:"([^"]+)"|(\S+))')
    if (-not $match.Success) { continue }
    $statePath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    try {
      $state = Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json
      if ([int]$state.appPid -eq $AppPid) { $sentinels += [int]$candidate.ProcessId }
    } catch {
      # A state file that cannot be read names no app.
    }
  }
  return $sentinels
}

function Stop-ById([int]$ProcessId, [string]$Role) {
  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    Write-Log "stopped $Role pid=$ProcessId"
  } catch {
    if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
      Write-Log "could not stop $Role pid=${ProcessId}: $($_.Exception.Message)"
    }
  }
}

function Get-BuilderGateListeners([int[]]$TargetPorts) {
  return @(Get-ListenerPids $TargetPorts | Where-Object { Test-BuilderGateProcess (Get-ProcessInfo $_) })
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$reportedOthers = @{}
while ($true) {
  $listeners = @(Get-ListenerPids $Ports)
  $builderGate = @()
  foreach ($listenerPid in $listeners) {
    $info = Get-ProcessInfo $listenerPid
    if (Test-BuilderGateProcess $info) {
      $builderGate += $listenerPid
    } elseif (-not $reportedOthers.ContainsKey($listenerPid)) {
      $reportedOthers[$listenerPid] = $true
      Write-Log "port held by another program, left running: pid=$listenerPid $([string]$info.ExecutablePath)"
    }
  }
  if ($builderGate.Count -eq 0) {
    Write-Log "no BuilderGate listens on $($Ports -join ', ')"
    exit 0
  }
  if ((Get-Date) -gt $deadline) {
    Write-Log "BuilderGate still listens after ${TimeoutSeconds}s: pid=$($builderGate -join ', ')"
    exit 1
  }
  foreach ($appPid in $builderGate) {
    foreach ($sentinelPid in @(Get-SentinelPids $appPid)) {
      Stop-ById $sentinelPid 'sentinel'
    }
    Stop-ById $appPid 'listener'
  }
  Start-Sleep -Milliseconds 500
}
