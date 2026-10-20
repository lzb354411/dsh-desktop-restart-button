<#
  restart-helper.ps1 - the process that actually restarts DeepSeek Harness.

  Why this file exists:
    A Cordis plugin cannot ask the shell to restart (see REFERENCES.md R1). So the
    plugin launches THIS script outside the app process tree, and the script does
    the kill/relaunch. It is started through WMI (Win32_Process.Create), which makes
    its parent WmiPrvSE.exe, so `taskkill /T /F` on the app root cannot reach it.

  Safety rules baked in:
    1. Never kill by process name alone: kill the app root by PID with /T /F first,
       and any name-based sweep explicitly skips this script and its whole ancestor
       chain. NOTE: the app's internal Node runners are ALSO named "DeepSeek Harness.exe",
       so a blind name sweep would kill this helper.
    2. Remove ELECTRON_RUN_AS_NODE from the environment before relaunching: the Host
       process inherits it (REFERENCES R7). Relaunching with it still set would start
       the desktop app in Node mode, i.e. "restarted but no window appears".
    3. Never relaunch before the old instance is really gone: the app takes a
       single-instance lock, and a premature start would silently die.
       Do not check TCP ports - the Host listens on a random port each start (R9).

  Usage (normally called by the plugin, not by hand):
    powershell -NoProfile -File restart-helper.ps1 -RootPid 12280 -Exe "<path>" [-DryRun]
#>
[CmdletBinding()]
param(
  # PID of the desktop app root process (its parent is explorer.exe). 0 = infer it.
  [int]$RootPid = 0,
  # Absolute path of the desktop executable to start again.
  [string]$Exe = "",
  # Wait this long before doing anything, so the HTTP reply reaches the page first.
  [int]$DelayMs = 1500,
  # Log file. Defaults to a timestamped file under %TEMP%.
  [string]$LogFile = "",
  # Print what WOULD happen and exit without killing or starting anything.
  [switch]$DryRun,
  # Confirm that a desktop app really is running. Required before ANY process is killed,
  # so a foreign caller (a test harness, a CLI host) can never trigger a name-based sweep.
  [switch]$ExpectApp
)

$ErrorActionPreference = 'Continue'
$script:LogPath = $null
$script:ExePath = $null

if ([string]::IsNullOrWhiteSpace($LogFile)) {
  $LogFile = Join-Path $env:TEMP ("dsh-desktop-restart\restart-" + $PID + ".log")
}

function Write-Log {
  param([string]$Message)
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Message
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $LogFile))) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null
  }
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  Write-Host $line
}

function Get-Proc {
  param([int]$Id)
  if ($Id -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
}

# Walk ParentProcessId upward and collect every ancestor PID (used to protect ourselves).
function Get-AncestorPids {
  param([int]$StartId)
  $chain = New-Object System.Collections.Generic.List[int]
  $current = $StartId
  $guard = 0
  while ($current -gt 0 -and $guard -lt 64) {
    $guard++
    $proc = Get-Proc -Id $current
    if ($null -eq $proc) { break }
    $parent = [int]$proc.ParentProcessId
    if ($parent -le 0) { break }
    if ($chain.Contains($parent)) { break }
    $chain.Add($parent)
    $current = $parent
  }
  return $chain
}

# Processes named like the desktop app. A shell process can carry that image name too
# (the app's unsandboxed Node runners reuse it), so this is only a CANDIDATE list:
# every candidate must still pass Test-IsAppProcess before it may be killed.
function Get-AppProcesses {
  return @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID })
}

# Names the whole process chain of a candidate, up to the root, as "name(pid)" strings.
# The desktop root is launched by the shell, so its chain ends outside the app
# (explorer.exe / userinit.exe / winlogon.exe / services.exe / WmiPrvSE.exe ...).
function Get-ProcessChain {
  param([int]$ProcessId)
  $chain = New-Object System.Collections.Generic.List[string]
  $current = $ProcessId
  $guard = 0
  while ($current -gt 0 -and $guard -lt 32) {
    $guard++
    $proc = Get-Proc -Id $current
    if ($null -eq $proc) { break }
    $chain.Add(("{0}({1})" -f $proc.Name, $current))
    $current = [int]$proc.ParentProcessId
  }
  return $chain
}

# Is this candidate part of the running desktop app rather than some other process
# that merely shares the executable name?
#
# This test exists because of a real incident: the helper used to sweep every process
# named "DeepSeek Harness.exe" and thereby killed a running app from a foreign caller
# (see NOTES.md). Identity is now confirmed by structure, not by name:
#   1. the process must exist and still carry the app image name;
#   2. its chain must NOT end at this helper or at any ancestor of this helper;
#   3. when a root PID is known, the candidate must be the root itself or descend from
#      it. When no root is known, the candidate must be a chain TOP: an app-named
#      process with no app-named ancestor. The root is the only such process, so a
#      stray runner hanging under the app does not qualify.
# Anything else - a stray Node runner, a second instance under another parent, a
# shell process that happens to be named the same - is reported and skipped.
function Test-IsAppProcess {
  param([System.Object]$Process, [int]$Root, [int[]]$Protected)
  if ($null -eq $Process) { return $false }
  if ($Process.Name -ne 'DeepSeek Harness.exe') { return $false }
  if ($Protected -contains [int]$Process.ProcessId) { return $false }
  if ([int]$Process.ProcessId -eq $PID) { return $false }

  $chain = Get-ProcessChain -ProcessId ([int]$Process.ProcessId)
  if ($chain.Count -eq 0) { return $false }
  foreach ($element in $chain) {
    $pidText = [regex]::Match($element, '\((\d+)\)$').Groups[1].Value
    if ($pidText -eq '') { continue }
    $chainPid = [int]$pidText
    if ($chainPid -eq $PID) { return $false }
    if ($Protected -contains $chainPid) { return $false }
  }

  # (a) with a root: the root itself, or a descendant of it.
  if ($Root -gt 0) {
    if ([int]$Process.ProcessId -eq $Root) { return $true }
    $cursor = [int]$Process.ParentProcessId
    $guard = 0
    while ($cursor -gt 0 -and $guard -lt 32) {
      $guard++
      if ($cursor -eq $Root) { return $true }
      $parent = Get-Proc -Id $cursor
      if ($null -eq $parent) { break }
      $cursor = [int]$parent.ParentProcessId
    }
    return $false
  }

  # (b) without a root: accept only a chain top - no app-named ancestor anywhere.
  # This rejects the app's own Node runners, which are named like the app but always
  # sit under an app-named ancestor.
  for ($i = 1; $i -lt $chain.Count; $i++) {
    $ancestorName = $chain[$i] -replace '\(\d+\)$', ''
    if ($ancestorName -like 'DeepSeek Harness*') { return $false }
  }
  return $true
}

# Every process of the running app, accepting only candidates that pass the identity test.
function Get-AppProcessesVerified {
  param([int]$Root, [int[]]$Protected)
  $accepted = New-Object System.Collections.Generic.List[object]
  $skipped = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in @(Get-AppProcesses)) {
    if (Test-IsAppProcess -Process $candidate -Root $Root -Protected $Protected) {
      $accepted.Add($candidate)
    } else {
      $skipped.Add($candidate)
    }
  }
  return [pscustomobject]@{ Accepted = $accepted; Skipped = $skipped }
}

# Stale app-named processes need no ancestor trace at all, so Test-IsAppProcess cannot
# classify them. They must still count as dirty: a tree kill does NOT always follow
# orphaned children (measured: an orphan survives `taskkill /T /F`), so relaunching while
# such a runner is alive risks two instances fighting over one workspace and one lock.
function Get-StaleAppProcesses {
  param([int]$Root, [int[]]$Protected)
  $stale = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in @(Get-AppProcesses)) {
    $id = [int]$candidate.ProcessId
    if ($id -eq $PID) { continue }
    if ($Protected -contains $id) { continue }
    if ($Root -gt 0 -and $id -eq $Root) { continue }
    # A candidate that the identity test accepts is not stale.
    if (Test-IsAppProcess -Process $candidate -Root $Root -Protected $Protected) { continue }
    # It is stale when it cannot be reached from any live app-named ancestor any more.
    $parent = Get-Proc -Id ([int]$candidate.ParentProcessId)
    if ($null -eq $parent -or $parent.Name -ne 'DeepSeek Harness.exe') { $stale.Add($candidate) }
  }
  return $stale
}

# Is the desktop app really gone? "No verified app process left, no stale app-named
# process left, and the root PID is gone".
function Test-AllGone {
  param([int]$Root, [int[]]$Protected)
  $verified = Get-AppProcessesVerified -Root $Root -Protected $Protected
  $stale = Get-StaleAppProcesses -Root $Root -Protected $Protected
  $rootAlive = $false
  if ($Root -gt 0) { $rootAlive = $null -ne (Get-Proc -Id $Root) }
  return [pscustomobject]@{
    Clean     = ((-not $rootAlive) -and ($verified.Accepted.Count -eq 0) -and ($stale.Count -eq 0))
    RootAlive = $rootAlive
    Remaining = $verified.Accepted
    Skipped   = $verified.Skipped
    Stale     = $stale
  }
}

function Wait-UntilGone {
  param([int]$Root, [int[]]$Protected, [int]$TimeoutMs)
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    $state = Test-AllGone -Root $Root -Protected $Protected
    if ($state.Clean) { return $state }
    Start-Sleep -Milliseconds 500
  }
  return (Test-AllGone -Root $Root -Protected $Protected)
}

function Invoke-TaskKill {
  param([int]$Id)
  $output = & taskkill.exe /PID $Id /T /F 2>&1 | Out-String
  Write-Log ("taskkill /PID {0} /T /F -> {1}" -f $Id, ($output.Trim() -replace "`r?`n", " | "))
}

# Terminate leftover VERIFIED app processes one by one through WMI. WMI Terminate is not
# recursive, which is exactly what we want for stragglers after the tree kill.
#
# Two hard rules learned from the incident:
#   - never kill by name; only processes that passed Test-IsAppProcess are eligible;
#   - if no verified app process exists at all, do NOT sweep anything. That situation
#     means we are not looking at the app (a foreign caller, or a wrong root PID), and
#     the previous unconditional sweep is precisely what killed a live app.
function Remove-Leftovers {
  param([int]$Root, [int[]]$Protected)
  $verified = Get-AppProcessesVerified -Root $Root -Protected $Protected
  $stale = Get-StaleAppProcesses -Root $Root -Protected $Protected
  if ($verified.Accepted.Count -eq 0 -and $stale.Count -eq 0) {
    Write-Log "leftover sweep skipped: no process passed the app identity test (nothing to kill)"
    if ($verified.Skipped.Count -gt 0) {
      Write-Log ("leftover sweep skipped candidates (name-only matches): {0}" -f (($verified.Skipped | ForEach-Object { $_.ProcessId }) -join ","))
    }
    return 0
  }
  $targets = @(@($verified.Accepted | Where-Object { [int]$_.ProcessId -ne $Root }) + @($stale))
  if ($targets.Count -eq 0) { Write-Log "leftover sweep: nothing left besides the root PID"; return 0 }
  Write-Log ("leftover sweep: {0} verified process(es) -> {1}" -f $targets.Count, (($targets | ForEach-Object { $_.ProcessId }) -join ","))
  $killed = 0
  foreach ($target in $targets) {
    try {
      $result = Invoke-CimMethod -InputObject $target -MethodName Terminate -ErrorAction Stop
      Write-Log ("wmi terminate pid {0} -> {1}" -f $target.ProcessId, $result.ReturnValue)
      if ($result.ReturnValue -eq 0) { $killed++ }
    } catch {
      Write-Log ("wmi terminate pid {0} failed: {1}" -f $target.ProcessId, $_.Exception.Message)
    }
  }
  return $killed
}

# Pick a sane root when the caller could not supply one.
#
# The desktop root is the one app-named process with NO app-named ancestor: the app's
# own Node runners are named like the app but always hang under it. Requiring that
# structure - and returning 0 when nothing matches - matters because a caller that
# passes -RootPid 0 has no other evidence; a guess accepted here would then sail past
# the root check in the expectation gate (which can only compare the image name).
# Callers that cannot name a root must pass -ExpectApp.
function Resolve-RootPid {
  param([switch]$ExpectApp)
  if (-not $ExpectApp) {
    Write-Log "root inference refused: no -ExpectApp switch was given (refusing to guess a root)"
    return 0
  }
  $candidates = @(Get-AppProcesses)
  if ($candidates.Count -eq 0) { return 0 }
  # Prefer the process started by the shell (the true desktop root).
  foreach ($candidate in $candidates) {
    $parent = Get-Proc -Id ([int]$candidate.ParentProcessId)
    if ($null -ne $parent -and $parent.Name -eq 'explorer.exe') { return [int]$candidate.ProcessId }
  }
  # Otherwise accept only a chain top (no app-named ancestor).
  foreach ($candidate in @($candidates | Sort-Object CreationDate)) {
    $chain = Get-ProcessChain -ProcessId ([int]$candidate.ProcessId)
    $parentIsApp = $false
    for ($i = 1; $i -lt $chain.Count; $i++) {
      if (($chain[$i] -replace '\(\d+\)$', '') -like 'DeepSeek Harness*') { $parentIsApp = $true; break }
    }
    if (-not $parentIsApp) {
      Write-Log ("root inference: no shell parent, but PID {0} is a chain top - accepting it" -f $candidate.ProcessId)
      return [int]$candidate.ProcessId
    }
  }
  Write-Log "root inference gave up: every app-named process has an app-named ancestor"
  return 0
}

function Start-DesktopApp {
  # Strip the Node-mode flag this process inherited from the app Host (REFERENCES R7).
  $hadFlag = $false
  if (Test-Path Env:ELECTRON_RUN_AS_NODE) {
    $hadFlag = $true
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }
  Write-Log ("relaunch: ELECTRON_RUN_AS_NODE was present={0}, now removed" -f $hadFlag)
  $workingDir = Split-Path -Parent $Exe

  # Launch through WMI, NOT through Start-Process.
  #
  # Measured reasons (NOTES.md, "console, parentage and the black window"):
  #   1. Start-Process makes the app a CHILD of this helper, so the app's lifetime hangs
  #      off a helper the user can kill by closing its console window. A WMI-launched app
  #      has WmiPrvSE.exe as its parent instead - nothing to do with this script.
  #   2. A WMI-created GUI process inherits NO console (measured: zero conhost children,
  #      no visible window), so no console window can ever attach to the app.
  #   3. Win32_Process.Create has no working-directory argument, and a WMI child gets
  #      C:\Windows\system32 as its cwd instead of ours (measured). So the working
  #      directory is set explicitly with `cd /d` inside a cmd wrapper, matching what the
  #      desktop shortcut does (empty arguments, install directory as the working dir).
  #      That wrapper measured as creating no console window either; cmd exits right after
  #      `start`, leaving the app running on its own.
  #   4. `Win32_ProcessStartup` (the only way to pass StartupInfo) failed to create
  #      anything on this machine, so it is not used.
  $exeQuoted = '"' + $Exe + '"'
  $cmdLine = 'cmd.exe /c cd /d "' + $workingDir + '" && start "" ' + $exeQuoted
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
  if ($null -eq $created -or $created.ReturnValue -ne 0) {
    $code = if ($null -eq $created) { 'no result' } else { $created.ReturnValue }
    Write-Log ("relaunch: WMI Create failed (ReturnValue={0}); falling back to Start-Process" -f $code)
    Start-Process -FilePath $Exe -WorkingDirectory $workingDir | Out-Null
    Write-Log ("relaunch: started '{0}' via Start-Process fallback, working directory '{1}'" -f $Exe, $workingDir)
    return
  }
  Write-Log ("relaunch: WMI created the app launcher (PID {0}); command={1}" -f $created.ProcessId, $cmdLine)
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
Write-Log "=== restart helper started ==="
Write-Log ("params: RootPid={0} Exe='{1}' DelayMs={2} DryRun={3} MyPid={4}" -f $RootPid, $Exe, $DelayMs, $DryRun.IsPresent, $PID)

if ([string]::IsNullOrWhiteSpace($Exe)) {
  Write-Log "ERROR: -Exe was not provided; cannot relaunch. Aborting."
  exit 2
}
# I5: the path must not only exist, it must BE the desktop app. A caller passing an
# arbitrary executable would otherwise reproduce the incident (a node.exe relaunch).
if ((Split-Path -Leaf $Exe).ToLower() -ne 'deepseek harness.exe') {
  Write-Log ("REFUSING TO RESTART: '{0}' is not the desktop app executable." -f $Exe)
  Write-Log "=== restart helper finished WITHOUT restarting ==="
  exit 2
}
$script:ExePath = $Exe
if (-not (Test-Path -LiteralPath $Exe)) {
  Write-Log ("ERROR: executable not found at '{0}'. Aborting." -f $Exe)
  exit 2
}

$protected = @(Get-AncestorPids -StartId $PID)
Write-Log ("protected PIDs (self + ancestors): {0} + {1}" -f $PID, ($protected -join ","))

if ($RootPid -le 0) {
  $RootPid = Resolve-RootPid -ExpectApp:$ExpectApp
  Write-Log ("root PID inferred from process table: {0}" -f $RootPid)
}
if ($RootPid -le 0) {
  Write-Log "no running desktop app found; nothing to stop."
}

if ($DryRun) {
  $appProcs = @(Get-AppProcesses)
  $verified = Get-AppProcessesVerified -Root $RootPid -Protected $protected
  Write-Log "DRY RUN - nothing will be killed and nothing will be started."
  Write-Log ("DRY RUN - root PID {0}" -f $RootPid)
  Write-Log ("DRY RUN - would kill root PID {0} with: taskkill /PID {0} /T /F" -f $RootPid)
  Write-Log ("DRY RUN - candidates named like the app ({0}): {1}" -f $appProcs.Count, (($appProcs | ForEach-Object { $_.ProcessId }) -join ","))
  Write-Log ("DRY RUN - passed the identity test ({0}): {1}" -f $verified.Accepted.Count, (($verified.Accepted | ForEach-Object { $_.ProcessId }) -join ","))
  Write-Log ("DRY RUN - REJECTED as not-the-app ({0}): {1}" -f $verified.Skipped.Count, (($verified.Skipped | ForEach-Object { $_.ProcessId }) -join ","))
  Write-Log ("DRY RUN - would protect (never kill): {0} + {1}" -f $PID, ($protected -join ","))
  Write-Log ("DRY RUN - would then wait for zero app processes, then start '{0}'" -f $Exe)
  Write-Log "=== dry run finished ==="
  exit 0
}

if ($DelayMs -gt 0) {
  Write-Log ("waiting {0} ms before acting (lets the page receive its reply)" -f $DelayMs)
  Start-Sleep -Milliseconds $DelayMs
}

# Expectation gate: before killing anything, insist that the app is actually running and
# that the root PID points at a real process. This is the second half of the incident
# fix - the first half is the identity test inside Test-IsAppProcess.
$appRunning = @(Get-AppProcesses).Count -gt 0
Write-Log ("expectation gate: app processes present = {0}, ExpectApp = {1}, root PID exists = {2}" -f $appRunning, $ExpectApp.IsPresent, ($RootPid -gt 0 -and $null -ne (Get-Proc -Id $RootPid)))
if (-not $DryRun) {
  if (-not $ExpectApp) {
    Write-Log "REFUSING TO RESTART: -ExpectApp was not given, so this caller is not trusted to kill processes."
    Write-Log "=== restart helper finished WITHOUT restarting ==="
    exit 6
  }
  if (-not $appRunning) {
    Write-Log "REFUSING TO RESTART: no process named like the desktop app is running."
    Write-Log "=== restart helper finished WITHOUT restarting ==="
    exit 6
  }
  if ($RootPid -gt 0) {
    $rootProc = Get-Proc -Id $RootPid
    if ($null -eq $rootProc -or $rootProc.Name -ne 'DeepSeek Harness.exe') {
      Write-Log ("REFUSING TO RESTART: root PID {0} does not exist or is not the desktop app." -f $RootPid)
      Write-Log "=== restart helper finished WITHOUT restarting ==="
      exit 6
    }
    # The root must be a chain top: the real desktop root has no app-named ancestor.
    # A root PID that merely shares the image name (the app's own Node runners do) is
    # rejected here - otherwise /T /F would hit an unrelated runner subtree.
    $rootChain = Get-ProcessChain -ProcessId $RootPid
    for ($i = 1; $i -lt $rootChain.Count; $i++) {
      if (($rootChain[$i] -replace '\(\d+\)$', '') -like 'DeepSeek Harness*') {
        Write-Log ("REFUSING TO RESTART: root PID {0} has an app-named ancestor, so it is not the desktop root." -f $RootPid)
        Write-Log ("  chain: {0}" -f ($rootChain -join " <- "))
        Write-Log "=== restart helper finished WITHOUT restarting ==="
        exit 6
      }
    }
  }
  # Self-location assertion: the whole design assumes this helper sits OUTSIDE the target
  # tree (it is created through WMI, so its parent is WmiPrvSE.exe). If this helper can be
  # reached from the root by walking parents, killing the tree would kill the helper too.
  if ($RootPid -gt 0) {
    $cursor = [int]$PID
    $inside = $false
    $guard = 0
    while ($cursor -gt 0 -and $guard -lt 32) {
      $guard++
      if ($cursor -eq $RootPid) { $inside = $true; break }
      $proc = Get-Proc -Id $cursor
      if ($null -eq $proc) { break }
      $cursor = [int]$proc.ParentProcessId
    }
    if ($inside) {
      Write-Log ("REFUSING TO RESTART: this helper (PID {0}) is a descendant of the target root {1}." -f $PID, $RootPid)
      Write-Log "The helper must run outside the target tree (it is normally created through WMI)."
      Write-Log "=== restart helper finished WITHOUT restarting ==="
      exit 7
    }
    Write-Log ("self-location confirmed: helper PID {0} is not inside the target tree of root {1}" -f $PID, $RootPid)
  }
}

# 1) Kill the root by PID with its whole tree. Doing this FIRST also orphans this
#    helper, so the tree kill cannot reach us.
$killIssued = $false
if ($RootPid -gt 0) {
  Invoke-TaskKill -Id $RootPid
  $killIssued = $true
} else {
  Write-Log "skipping root kill: no root PID known"
}

# 2) Wait for a fully clean process table.
$state = Wait-UntilGone -Root $RootPid -Protected $protected -TimeoutMs 15000
if (-not $state.Clean) {
  Write-Log "still not clean after 15s; re-issuing the tree kill"
  if ($RootPid -gt 0) { Invoke-TaskKill -Id $RootPid }
  $state = Wait-UntilGone -Root $RootPid -Protected $protected -TimeoutMs 15000
}
if (-not $state.Clean) {
  Write-Log "still not clean after 30s; sweeping leftovers through WMI"
  Remove-Leftovers -Root $RootPid -Protected $protected | Out-Null
  $state = Wait-UntilGone -Root $RootPid -Protected $protected -TimeoutMs 15000
}

# C1: never leave the app dead. If we already killed it, the single-instance lock died
# with the root PID too, so refusing to relaunch here would strand the user with no app
# at all. Only a still-living instance justifies skipping the relaunch.
if (-not $state.Clean) {
  Write-Log ("not clean after 45s -> remaining {0}, stale {1}" -f (($state.Remaining | ForEach-Object { $_.ProcessId }) -join ","), (($state.Stale | ForEach-Object { $_.ProcessId }) -join ","))
  if ($state.RootAlive) {
    Write-Log "refusing to relaunch: the old instance is still alive and holds the single-instance lock."
    Write-Log "=== restart helper finished WITHOUT restarting ==="
    exit 4
  }
  Write-Log "root process is gone, so the lock is released; relaunching despite leftovers."
}

# 3) Settle briefly so Electron finishes flushing its state to disk.
Write-Log "root is gone; waiting 2s for the app to finish flushing state"
Start-Sleep -Seconds 2

# 4) Start it again, then retry with a bounded budget. A launch can fail for transient
#    reasons, and after a kill we must not simply give up (C1).
$confirmed = $false
$attempts = 0
$maxAttempts = 6
while (-not $confirmed -and $attempts -lt $maxAttempts) {
  $attempts++
  Start-DesktopApp
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $fresh = @(Get-AppProcesses)
    if ($fresh.Count -gt 0) {
      Write-Log ("relaunch confirmed: {0} process(es) running, root candidate {1}" -f $fresh.Count, (($fresh | Sort-Object CreationDate)[0].ProcessId))
      $confirmed = $true
      break
    }
  }
  if (-not $confirmed) { Write-Log ("relaunch attempt {0}/{1} produced no app process within 20s" -f $attempts, $maxAttempts) }
}

if ($confirmed) {
  Write-Log "=== restart helper finished successfully ==="
  exit 0
}
Write-Log ("FAILED: {0} relaunch attempts over {1}s produced no app process." -f $maxAttempts, ($maxAttempts * 20))
if ($killIssued) {
  Write-Log "The app was stopped and could not be started again. Start it manually:"
  Write-Log ("  Start-Process '{0}'" -f $Exe)
}
Write-Log "=== restart helper finished without a running app ==="
exit 7
