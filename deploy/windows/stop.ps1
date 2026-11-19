# Stop only this installation's supported supervisors and a generation-bound
# child ticket. Unsupported/missing identity is preserved for manual inspection.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$ScriptDir = $PSScriptRoot
$Root = if (Test-Path (Join-Path $ScriptDir 'windsurfapi.exe')) { $ScriptDir }
        else { (Resolve-Path (Join-Path $ScriptDir '..\..')).Path }
$LogDir = Join-Path $Root 'logs'
Import-Module (Join-Path $ScriptDir 'ownership.psm1') -Force -ErrorAction Stop

# Query failure must never become proof that a process has exited.
function Get-StopProcessSnapshot([int]$OwnerId) {
  try {
    $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerId" -ErrorAction Stop)
    if ($rows.Count -gt 1) { return @{ Known = $false; Row = $null } }
    return @{ Known = $true; Row = $(if ($rows.Count -eq 1) { $rows[0] } else { $null }) }
  } catch { return @{ Known = $false; Row = $null } }
}

# Capture before stopping supervisors; a concurrent publisher must survive the
# final cleanup, and its new PID must not replace this request's target.
$ticket = $null
try { $ticket = Get-WindsurfApiPidTicket -LogDir $LogDir }
catch { Write-Host 'PID ticket could not be read; child stop will be skipped.' -ForegroundColor Yellow }

# A global task name is insufficient: exactly one actual WScript/CScript action
# must execute this install's run.vbs. No concatenated Exec or path substring.
try {
  $queryOut = & schtasks /query /tn WindsurfAPI /xml 2>$null
  if ($LASTEXITCODE -eq 0 -and $queryOut -and
      (Test-IsOwnedScheduledTask -Xml ($queryOut -join "`n") -ScriptDir $ScriptDir)) {
    & schtasks /end /tn WindsurfAPI 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host 'Requested stop of the verified scheduled task.' -ForegroundColor DarkGray }
  }
} catch { }

# Each numeric PID action is immediately preceded by an exact CIM-generation
# and launch-form check. OS query -> signal is still not an atomic operation.
$handled = @{}
for ($sweep = 0; $sweep -lt 2; $sweep++) {
  try {
    $rows = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe' OR Name='cscript.exe'" -ErrorAction Stop)
  } catch { Write-Host 'Supervisor query failed; no inferred targets.' -ForegroundColor Yellow; break }
  foreach ($target in $rows) {
    if (-not (Test-IsOwnedSupervisor -Process $target -ScriptDir $ScriptDir)) { continue }
    $ownerId = [int]$target.ProcessId
    $generationKey = "$ownerId/$($target.CreationDate)"
    if ($handled.ContainsKey($generationKey)) { continue }
    $handled[$generationKey] = $true
    $snapshot = Get-StopProcessSnapshot $ownerId
    if ($snapshot.Known -and $snapshot.Row -and
        (Test-ProcessGeneration $snapshot.Row $target.CreationDate) -and
        (Test-IsOwnedSupervisor $snapshot.Row $ScriptDir)) {
      try { Stop-Process -Id $ownerId -Force -ErrorAction Stop } catch { }
    }
  }
}

if ($null -eq $ticket -or -not $ticket.Valid) {
  Write-Host 'No valid captured PID ticket; child stop was not attempted.' -ForegroundColor Yellow
  return
}
$nodePid = [int]$ticket.Pid
$snapshot = Get-StopProcessSnapshot $nodePid
if (-not $snapshot.Known) {
  Write-Host "Cannot query PID $nodePid; ticket preserved." -ForegroundColor Yellow
  return
}
$verdict = Test-PidOwnership -Process $snapshot.Row -Pid $nodePid -Meta $ticket.Meta -Root $Root
if ($verdict -eq 'unowned') {
  Write-Host "PID $nodePid has no matching complete generation ticket; no child action, ticket preserved." -ForegroundColor Yellow
  return
}
$stopped = ($verdict -eq 'absent')
$uncertain = $false
$reused = $false
if (-not $stopped) {
  $creation = $snapshot.Row.CreationDate
  $fresh = Get-StopProcessSnapshot $nodePid
  if (-not $fresh.Known) { $uncertain = $true }
  elseif (-not $fresh.Row) { $stopped = $true }
  elseif ((Test-PidOwnership $fresh.Row $nodePid $ticket.Meta $Root) -ne 'trusted') { $reused = $true }
  else {
    try { & taskkill /PID $nodePid /T 2>$null | Out-Null } catch { }
    for ($waited = 0; $waited -lt 3; $waited++) {
      Start-Sleep -Seconds 1
      $fresh = Get-StopProcessSnapshot $nodePid
      if (-not $fresh.Known) { $uncertain = $true; break }
      if (-not $fresh.Row) { $stopped = $true; break }
      if (-not (Test-ProcessGeneration $fresh.Row $creation)) { $reused = $true; break }
    }
    if (-not $stopped -and -not $uncertain -and -not $reused) {
      $fresh = Get-StopProcessSnapshot $nodePid
      if (-not $fresh.Known) { $uncertain = $true }
      elseif (-not $fresh.Row) { $stopped = $true }
      elseif ((Test-PidOwnership $fresh.Row $nodePid $ticket.Meta $Root) -ne 'trusted') { $reused = $true }
      else {
        try { & taskkill /F /PID $nodePid /T 2>$null | Out-Null } catch { }
        # An issued /F request is not evidence of exit. Verify again; failures
        # and still-live rows keep the captured ticket available for diagnosis.
        for ($verify = 0; $verify -lt 3; $verify++) {
          $fresh = Get-StopProcessSnapshot $nodePid
          if (-not $fresh.Known) { $uncertain = $true; break }
          if (-not $fresh.Row) { $stopped = $true; break }
          if (-not (Test-ProcessGeneration $fresh.Row $creation)) { $reused = $true; break }
          Start-Sleep -Seconds 1
        }
      }
    }
  }
}

if ($stopped) {
  try {
    if (Remove-WindsurfApiPidArtifacts -LogDir $LogDir -ExpectedTicket $ticket) {
      Write-Host "Captured child PID $nodePid is absent; its ticket was removed." -ForegroundColor Green
    } else {
      Write-Host "Captured child PID $nodePid is absent; a replacement ticket was preserved." -ForegroundColor Yellow
    }
  } catch { Write-Host 'Child absence verified; ticket cleanup failed and was left for inspection.' -ForegroundColor Yellow }
} elseif ($reused) {
  Write-Host "PID $nodePid changed generation; no further action, ticket preserved." -ForegroundColor Yellow
} else {
  Write-Host "Child exit was not verified for PID $nodePid; ticket preserved." -ForegroundColor Yellow
}
