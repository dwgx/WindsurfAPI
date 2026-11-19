# Windows Stop ownership harness (web-takeover windows-stop lane).
#
# Runs one scenario per invocation, selected by -Scenario. Never enumerates,
# signals or terminates a real process: Get-CimInstance / Stop-Process /
# taskkill / schtasks / Start-Sleep are all replaced with in-memory stubs
# BEFORE the product stop.ps1 body is dot-sourced, and all filesystem state
# lives under a throwaway synthetic install directory whose path contains
# spaces (quoted launch forms are exercised with real quoting).
#
# Selector and PID-verdict scenarios import the real deploy/windows
# ownership.psm1 and feed it synthetic Win32_Process-shaped rows.
#
# Exit 0 + "SCENARIO DONE" = every assertion held; exit 1 lists failures.

param([Parameter(Mandatory = $true)][string]$Scenario)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DeploySrc = Join-Path $RepoRoot 'deploy\windows'

$script:Failures = New-Object System.Collections.Generic.List[string]

function Assert-True([bool]$Condition, [string]$Message) {
  if ($Condition) { Write-Output ("ok   " + $Message) }
  else { Write-Output ("FAIL " + $Message); $script:Failures.Add($Message) | Out-Null }
}
function Finish-Scenario([string]$Name) {
  if ($script:Failures.Count -gt 0) {
    Write-Output ("SCENARIO ${Name} FAILED (" + $script:Failures.Count + " assertions)")
    exit 1
  }
  Write-Output ("SCENARIO ${Name} DONE")
  Write-Output 'SCENARIO DONE'
  exit 0
}

function New-ProcRow {
  param([string]$Name, [int]$ProcessId, [int]$ParentProcessId, $CommandLine, [datetime]$CreationDate)
  return [pscustomobject]@{
    Name = $Name; ProcessId = $ProcessId; ParentProcessId = $ParentProcessId
    CommandLine = $CommandLine; CreationDate = $CreationDate
  }
}

Import-Module (Join-Path $DeploySrc 'ownership.psm1') -Force -ErrorAction Stop
$T0 = Get-Date -Date '2026-11-19T12:00:00'

# ─────────────────────────────────────────────────────────────────────────────
# Selector scenarios: pure predicate over synthetic rows.
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-SelectorScenario {
  param([string]$Kind)
  $sd = Join-Path $env:TEMP 'windsurf api\deploy\windows'   # synthetic canonical dir, spaces included
  $sdFwd = $sd -replace '\\', '/'

  if ($Kind -eq 'selector-owned-forms') {
    # Every shipped launch form; arbitrary command expressions are unsupported.
    $owned = @(
      @{ Name = 'powershell.exe'; Id = 111; Cl = "powershell.exe  -NoProfile -ExecutionPolicy Bypass -File `"$sd\run.ps1`"" },            # run.bat
      @{ Name = 'powershell.exe'; Id = 112; Cl = "powershell.exe  -NoProfile -ExecutionPolicy Bypass -File `"$sd\start.ps1`"" },            # start.bat (inline supervisor)
      @{ Name = 'powershell.exe'; Id = 113; Cl = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$sd\tray.ps1`"" }, # tray.bat
      @{ Name = 'wscript.exe';    Id = 114; Cl = "wscript.exe `"$sd\run.vbs`"" },                                                           # run-background / schtasks
      @{ Name = 'cscript.exe';    Id = 115; Cl = "cscript.exe //nologo `"$sd\run.vbs`"" },
      @{ Name = 'wscript.exe'; Id = 116; Cl = "wscript.exe `"$sd\tray.vbs`"" }
    )
    foreach ($r in $owned) {
      $row = New-ProcRow -Name $r.Name -ProcessId $r.Id -ParentProcessId 10 -CommandLine $r.Cl -CreationDate $T0
      Assert-True (Test-IsOwnedSupervisor -Process $row -ScriptDir $sd) ("owned form selected: pid $($r.Id)")
    }
  }
  elseif ($Kind -eq 'selector-foreign-rows') {
    $foreign = @(
      @{ Name = 'powershell.exe'; Id = 211; Cl = 'powershell.exe  -NoProfile -ExecutionPolicy Bypass -File "C:\other place\deploy\windows\run.ps1"' }, # other install, same names
      @{ Name = 'powershell.exe'; Id = 212; Cl = 'powershell.exe -File "C:\somewhere\run.ps1"' },                                                       # same basename, different dir
      @{ Name = 'powershell.exe'; Id = 213; Cl = 'powershell.exe -File deploy\windows\run.ps1' },                                                       # relative, unverifiable
      @{ Name = 'powershell.exe'; Id = 214; Cl = "powershell.exe -NoProfile -Command `"Get-Content '$sd\run.ps1'`"" },                                  # document argument
      @{ Name = 'powershell.exe'; Id = 215; Cl = "powershell.exe -NoProfile -Command `"Select-String -Path '$sd\run.ps1' -Pattern x`"" },               # non-invocation mention
      @{ Name = 'powershell.exe'; Id = 221; Cl = "powershell.exe -Command `"Write-Output ' & $sd\run.ps1 '`"" },
      @{ Name = 'powershell.exe'; Id = 222; Cl = "powershell.exe -Command `"Write-Output ' ; & $sd\run.ps1 ; '`"" },
      @{ Name = 'powershell.exe'; Id = 223; Cl = "powershell.exe -Command Write-Output -File `"$sd\run.ps1`"" },
      @{ Name = 'powershell.exe'; Id = 224; Cl = "powershell.exe -File C:\other.ps1 -File `"$sd\run.ps1`"" },
      @{ Name = 'powershell.exe'; Id = 225; Cl = "powershell.exe -Command `"& '$sd\run.ps1'`"" },
      @{ Name = 'powershell.exe'; Id = 226; Cl = "powershell.exe -File `"$sd\run.ps1" },
      @{ Name = 'Code.exe';       Id = 216; Cl = "Code.exe `"$sd\run.ps1`"" },                                                                          # editor host
      @{ Name = 'notepad.exe';    Id = 217; Cl = 'notepad.exe' },
      @{ Name = 'powershell.exe'; Id = 218; Cl = $null },                                                                                               # missing command line
      @{ Name = 'wscript.exe';    Id = 219; Cl = '' },                                                                                                  # empty command line
      @{ Name = 'node.exe';       Id = 220; Cl = '"C:\Program Files\nodejs\node.exe" run.ps1' }                                                          # child, not a supervisor
    )
    foreach ($r in $foreign) {
      $row = New-ProcRow -Name $r.Name -ProcessId $r.Id -ParentProcessId 10 -CommandLine $r.Cl -CreationDate $T0
      Assert-True (-not (Test-IsOwnedSupervisor -Process $row -ScriptDir $sd)) ("foreign row rejected: pid $($r.Id)")
    }
  }
  elseif ($Kind -eq 'selector-normalization') {
    $ok1 = New-ProcRow -Name 'powershell.exe' -ProcessId 311 -ParentProcessId 10 -CommandLine "powershell.exe -File `"$sdFwd\run.ps1`"" -CreationDate $T0
    Assert-True (Test-IsOwnedSupervisor -Process $ok1 -ScriptDir $sd) 'forward-slash path selected'
    $sdUpper = $sd.ToUpperInvariant()
    $ok2 = New-ProcRow -Name 'POWERSHELL.EXE' -ProcessId 312 -ParentProcessId 10 -CommandLine "POWERSHELL.EXE -FILE `"$sdUpper\RUN.PS1`"" -CreationDate $T0
    Assert-True (Test-IsOwnedSupervisor -Process $ok2 -ScriptDir $sd) 'case-insensitive path selected'
    $ok3 = New-ProcRow -Name 'powershell.exe' -ProcessId 313 -ParentProcessId 10 -CommandLine "powershell.exe -File `"  $sd\run.ps1  `" " -CreationDate $T0
    Assert-True (-not (Test-IsOwnedSupervisor -Process $ok3 -ScriptDir $sd)) 'padded path is not the canonical invocation'
    $no1 = New-ProcRow -Name 'powershell.exe' -ProcessId 314 -ParentProcessId 10 -CommandLine 'powershell.exe -File run.ps1' -CreationDate $T0
    Assert-True (-not (Test-IsOwnedSupervisor -Process $no1 -ScriptDir $sd)) 'bare script name rejected'
    $no2 = New-ProcRow -Name 'powershell.exe' -ProcessId 315 -ParentProcessId 10 -CommandLine $null -CreationDate $T0
    Assert-True (-not (Test-IsOwnedSupervisor -Process $no2 -ScriptDir $sd)) 'missing command line rejected'
  }
  else { throw "unknown selector kind $Kind" }
}

# ─────────────────────────────────────────────────────────────────────────────
# PID verdict scenario: ownership decision over synthetic rows + meta record.
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-PidVerdictScenario {
  $root = Join-Path $env:TEMP 'windsurf api'
  $sups = @(111, 222)

  $nodeRow = New-ProcRow -Name 'node.exe' -ProcessId 4242 -ParentProcessId 111 -CommandLine '"C:\Program Files\nodejs\node.exe" src/index.js' -CreationDate $T0
  $exeRow  = New-ProcRow -Name 'windsurfapi.exe' -ProcessId 4242 -ParentProcessId 222 -CommandLine 'C:\pkg\windsurfapi.exe' -CreationDate $T0
  $foreign = New-ProcRow -Name 'node.exe' -ProcessId 4242 -ParentProcessId 999 -CommandLine '"C:\Program Files\nodejs\node.exe" src/index.js' -CreationDate $T0
  $notepad = New-ProcRow -Name 'notepad.exe' -ProcessId 4242 -ParentProcessId 999 -CommandLine 'notepad.exe' -CreationDate $T0

  $meta = [pscustomobject]@{ pid = 4242; createdAt = $T0.ToUniversalTime().ToString('o'); root = $root; mode = 'source' }
  Assert-True ((Test-PidOwnership -Process $nodeRow -Pid 4242 -Meta $meta -Root $root -SupervisorPids $sups) -eq 'trusted') 'trusted: meta + generation match'
  $metaExe = [pscustomobject]@{ pid = 4242; createdAt = $T0.ToUniversalTime().ToString('o'); root = 'C:\pkg'; mode = 'exe' }
  Assert-True ((Test-PidOwnership -Process $exeRow -Pid 4242 -Meta $metaExe -Root 'C:\pkg' -SupervisorPids $sups) -eq 'trusted') 'trusted: packaged exe generation match'

  $metaWrongPid = [pscustomobject]@{ pid = 111; createdAt = $T0.ToUniversalTime().ToString('o'); root = $root; mode = 'source' }
  Assert-True ((Test-PidOwnership -Process $foreign -Pid 4242 -Meta $metaWrongPid -Root $root -SupervisorPids @()) -eq 'unowned') 'meta pid mismatch falls back to ownership check'

  $metaWrongRoot = [pscustomobject]@{ pid = 4242; createdAt = $T0.ToUniversalTime().ToString('o'); root = 'C:\other'; mode = 'source' }
  Assert-True ((Test-PidOwnership -Process $nodeRow -Pid 4242 -Meta $metaWrongRoot -Root $root -SupervisorPids $sups) -eq 'unowned') 'meta root mismatch cannot fall back to parent PID'

  $metaLate = [pscustomobject]@{ pid = 4242; createdAt = $T0.AddMinutes(10).ToUniversalTime().ToString('o'); root = $root; mode = 'source' }
  Assert-True ((Test-PidOwnership -Process $nodeRow -Pid 4242 -Meta $metaLate -Root $root -SupervisorPids @()) -eq 'unowned') 'generation mismatch in meta rejects the PID'

  Assert-True ((Test-PidOwnership -Process $nodeRow -Pid 4242 -Meta $null -Root $root -SupervisorPids $sups) -eq 'unowned') 'legacy numeric + parent PID is not generation proof'
  Assert-True ((Test-PidOwnership -Process $foreign -Pid 4242 -Meta $null -Root $root -SupervisorPids $sups) -eq 'unowned') 'legacy: same-name node of another install rejected'
  Assert-True ((Test-PidOwnership -Process $notepad -Pid 4242 -Meta $null -Root $root -SupervisorPids $sups) -eq 'unowned') 'legacy: reused PID held by unrelated image rejected'
  Assert-True ((Test-PidOwnership -Process $null -Pid 4242 -Meta $null -Root $root -SupervisorPids $sups) -eq 'absent') 'absent row reports absent'

  foreach ($ticks in @(1, 10, 10000, 1000000, 10000000, 29990000)) {
    Assert-True (-not (Test-ProcessGeneration -Process $nodeRow -Creation $T0.AddTicks($ticks))) "generation: $ticks ticks mismatch rejected"
  }
  Assert-True (-not (Test-ProcessGeneration -Process $nodeRow -Creation $T0.AddSeconds(5))) 'generation: 5s drift rejected'
  Assert-True (Test-ProcessGeneration -Process $nodeRow -Creation $T0.ToUniversalTime().ToString('o')) 'generation: ISO string input accepted'
}

# ─────────────────────────────────────────────────────────────────────────────
# Full-script scenarios: synthetic install + stubbed entry points + dot-source.
# ─────────────────────────────────────────────────────────────────────────────
$script:Table = New-Object System.Collections.Generic.List[object]
$script:Actions = New-Object System.Collections.Generic.List[string]
$script:HostMessages = New-Object System.Collections.Generic.List[string]
$script:OnQuery = $null
$script:TaskkillKills = $true
$script:ForceKills = $false
$script:StopProcessKills = $true
$script:SchtasksXml = $null

function Remove-TableRow([int]$Id) {
  for ($i = $script:Table.Count - 1; $i -ge 0; $i--) {
    if ($script:Table[$i].ProcessId -eq $Id) { $script:Table.RemoveAt($i) }
  }
}

# Stubs: same names as the cmdlets / native commands stop.ps1 uses.
function Get-CimInstance {
  $filter = $null
  for ($i = 0; $i -lt $args.Count; $i++) {
    if ("$($args[$i])" -ieq '-Filter') { $filter = $args[$i + 1]; $i++ }
  }
  if ($script:OnQuery) { & $script:OnQuery $filter }
  if ($filter -and ("$filter" -match 'ProcessId=(\d+)')) {
    $want = [int]$Matches[1]
    return @($script:Table | Where-Object { $_.ProcessId -eq $want })
  }
  return $script:Table.ToArray()   # 不要 @($list):部分 PS 版本无法把 List[object] 转 object[]
}
function Stop-Process {
  $id = $null
  for ($i = 0; $i -lt $args.Count; $i++) {
    if ("$($args[$i])" -ieq '-Id') { $id = [int]$args[$i + 1]; $i++ }
  }
  $script:Actions.Add("stop-process $id") | Out-Null
  if ($script:StopProcessKills) { Remove-TableRow $id }
}
function taskkill {
  $joined = ($args -join ' ')
  $script:Actions.Add("taskkill $joined") | Out-Null
  if (($script:TaskkillKills -or ($script:ForceKills -and $joined -match '/F')) -and $joined -match '/PID (\d+)') {
    Remove-TableRow ([int]$Matches[1])
    if ($script:TrayFake) { $script:proc.HasExited = $true }
  }
  $global:LASTEXITCODE = 0
}
function schtasks {
  $joined = ($args -join ' ')
  if ($joined -match '/xml') { $global:LASTEXITCODE = 0; return $script:SchtasksXml }
  $script:Actions.Add("schtasks $joined") | Out-Null
  $global:LASTEXITCODE = 0
}
function Start-Sleep { }   # grace window must be instantaneous and deterministic
function Write-Host { $script:HostMessages.Add(($args -join ' ')) | Out-Null }

function New-SyntheticInstall {
  param([switch]$ExeMode)
  $base = Join-Path $env:TEMP ('w a ' + ([IO.Path]::GetRandomFileName().Replace('.', 'x')))
  $install = if ($ExeMode) { $base } else { (Join-Path $base 'root') }
  $deploy = if ($ExeMode) { $base } else { (Join-Path $install 'deploy\windows') }
  $logDir = Join-Path $install 'logs'
  New-Item -ItemType Directory -Force -Path $deploy, $logDir | Out-Null
  Copy-Item (Join-Path $DeploySrc 'stop.ps1') $deploy
  Copy-Item (Join-Path $DeploySrc 'ownership.psm1') $deploy
  if ($ExeMode) { Set-Content -Path (Join-Path $base 'windsurfapi.exe') -Value 'marker' -Encoding ASCII }  # marker only, never executed
  return @{ Install = $install; Deploy = $deploy; LogDir = $logDir }
}
function Write-PidArtifacts {
  param($InstallInfo, [string]$OwnerPid, [datetime]$Creation, [string]$Mode)
  Set-WindsurfApiPidMeta -LogDir $InstallInfo.LogDir -ProcessId ([int]$OwnerPid) -CreationTimeUtc $Creation.ToUniversalTime() -Root $InstallInfo.Install -Mode $Mode | Out-Null
}
function Invoke-StopScript {
  param($InstallInfo)
  $before = $script:Actions.Count
  . (Join-Path $InstallInfo.Deploy 'stop.ps1')
  Write-Output ("stop script executed, recorded actions: " + ($script:Actions.Count - $before))
}
function Assert-ActionCount([string]$Pattern, [int]$Expected, [string]$Message) {
  $count = @($script:Actions | Where-Object { $_ -match $Pattern }).Count
  Assert-True ($count -eq $Expected) ("$Message (observed $count)")
}

function Invoke-FullScriptScenario {
  param([string]$Name)
  if ($Name -eq 'stop-trusted-source') {
    $ii = New-SyntheticInstall
    $rows = @(
      (New-ProcRow 'powershell.exe' 111 10 "powershell.exe  -NoProfile -ExecutionPolicy Bypass -File `"$($ii.Deploy)\run.ps1`"" $T0),
      (New-ProcRow 'powershell.exe' 222 10 "powershell.exe  -NoProfile -ExecutionPolicy Bypass -File `"$($ii.Deploy)\start.ps1`"" $T0),
      (New-ProcRow 'powershell.exe' 333 10 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\other place\deploy\windows\run.ps1"' $T0),
      (New-ProcRow 'powershell.exe' 444 10 "powershell.exe -NoProfile -Command `"Get-Content '$($ii.Deploy)\run.ps1'`"" $T0),
      (New-ProcRow 'Code.exe' 555 10 "Code.exe `"$($ii.Deploy)\run.ps1`"" $T0),
      (New-ProcRow 'wscript.exe' 666 10 $null $T0),
      (New-ProcRow 'node.exe' 4242 111 '"C:\Program Files\nodejs\node.exe" src/index.js' $T0)
    )
    foreach ($r in $rows) { $script:Table.Add($r) }
    Write-PidArtifacts -InstallInfo $ii -OwnerPid '4242' -Creation $T0 -Mode 'source'
    Invoke-StopScript -InstallInfo $ii
    Assert-ActionCount '^stop-process 111$' 1 'run.bat supervisor selected'
    Assert-ActionCount '^stop-process 222$' 1 'start.ps1 inline supervisor selected'
    Assert-ActionCount '^stop-process ' 2 'exactly two supervisors selected'
    Assert-True (-not ($script:Actions | Where-Object { $_ -match 'stop-process (333|444|555|666)' })) 'foreign rows untouched'
    Assert-ActionCount '^taskkill /PID 4242 /T$' 1 'initial tree kill issued for trusted node'
    Assert-True (-not ($script:Actions | Where-Object { $_ -match '/F' })) 'no forced kill needed'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid'))) 'pidfile removed'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid.meta'))) 'meta removed'
  }
  elseif ($Name -eq 'stop-legacy-owned') {
    $ii = New-SyntheticInstall
    $script:Table.Add((New-ProcRow 'powershell.exe' 111 10 "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$($ii.Deploy)\run.ps1`"" $T0))
    $script:Table.Add((New-ProcRow 'node.exe' 4242 111 '"C:\Program Files\nodejs\node.exe" src/index.js' $T0.AddSeconds(30)))
    Set-Content -Path (Join-Path $ii.LogDir 'windsurfapi.pid') -Value '4242' -Encoding ASCII   # legacy: no meta file
    Invoke-StopScript -InstallInfo $ii
    Assert-ActionCount '^taskkill ' 0 'legacy parent PID alone cannot authorize child stop'
    Assert-True (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid')) 'legacy pidfile preserved'
  }
  elseif ($Name -eq 'stop-stale-pid-unowned') {
    $ii = New-SyntheticInstall
    $script:Table.Add((New-ProcRow 'notepad.exe' 4242 999 'notepad.exe' $T0))
    Set-Content -Path (Join-Path $ii.LogDir 'windsurfapi.pid') -Value '4242' -Encoding ASCII
    Invoke-StopScript -InstallInfo $ii
    Assert-True ($script:Actions.Count -eq 0) 'no action taken for unowned PID'
    Assert-True (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid')) 'pidfile preserved for manual inspection'
  }
  elseif ($Name -eq 'stop-foreign-node-legacy') {
    $ii = New-SyntheticInstall
    $script:Table.Add((New-ProcRow 'node.exe' 4242 999 '"C:\Program Files\nodejs\node.exe" src/index.js' $T0))
    Set-Content -Path (Join-Path $ii.LogDir 'windsurfapi.pid') -Value '4242' -Encoding ASCII
    Invoke-StopScript -InstallInfo $ii
    Assert-True (-not ($script:Actions | Where-Object { $_ -match 'taskkill' })) 'another install node not terminated'
    Assert-True (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid')) 'pidfile preserved'
  }
  elseif ($Name -eq 'stop-reuse-during-grace') {
    $ii = New-SyntheticInstall
    $script:Table.Add((New-ProcRow 'powershell.exe' 111 10 "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$($ii.Deploy)\run.ps1`"" $T0))
    $script:Table.Add((New-ProcRow 'node.exe' 4242 111 '"C:\Program Files\nodejs\node.exe" src/index.js' $T0))
    Write-PidArtifacts -InstallInfo $ii -OwnerPid '4242' -Creation $T0 -Mode 'source'
    $script:TaskkillKills = $false   # initial tree kill fails to terminate
    $script:OnQuery = {
      param($Filter)
      if ($Filter -and "$Filter" -match 'ProcessId=4242') {
        $script:QueryCount = [int]$script:QueryCount + 1
        if ($script:QueryCount -ge 3) {
          # PID reused between the initial kill and the forced kill.
          Remove-TableRow 4242
          $script:Table.Add((New-ProcRow 'notepad.exe' 4242 999 'notepad.exe' $T0.AddMilliseconds(1)))
        }
      }
    }
    Invoke-StopScript -InstallInfo $ii
    Assert-ActionCount '^taskkill /PID 4242 /T$' 1 'initial kill attempted once'
    Assert-True (-not ($script:Actions | Where-Object { $_ -match '/F' })) 'forced kill withheld after PID reuse'
    Assert-True (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid')) 'pidfile preserved after reuse detection'
  }
  elseif ($Name -eq 'stop-escalates-when-same-generation') {
    $ii = New-SyntheticInstall
    $script:Table.Add((New-ProcRow 'powershell.exe' 111 10 "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$($ii.Deploy)\run.ps1`"" $T0))
    $script:Table.Add((New-ProcRow 'node.exe' 4242 111 '"C:\Program Files\nodejs\node.exe" src/index.js' $T0))
    Write-PidArtifacts -InstallInfo $ii -OwnerPid '4242' -Creation $T0 -Mode 'source'
    $script:TaskkillKills = $false   # process survives the graceful attempt, generation unchanged
    $script:ForceKills = $true
    Invoke-StopScript -InstallInfo $ii
    Assert-ActionCount '^taskkill /PID 4242 /T$' 1 'initial kill attempted'
    Assert-ActionCount '^taskkill /F /PID 4242 /T$' 1 'forced kill issued when generation still matches'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid'))) 'pidfile removed'
  }
  elseif ($Name -eq 'stop-absent-pid') {
    $ii = New-SyntheticInstall
    $script:Table.Add((New-ProcRow 'powershell.exe' 111 10 "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$($ii.Deploy)\run.ps1`"" $T0))
    Write-PidArtifacts -InstallInfo $ii -OwnerPid '4242' -Creation $T0 -Mode 'source'   # node already dead, pid + meta stale
    Invoke-StopScript -InstallInfo $ii
    Assert-ActionCount '^stop-process 111$' 1 'supervisor still stopped'
    Assert-True (-not ($script:Actions | Where-Object { $_ -match 'taskkill' })) 'no kill for absent node'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid'))) 'stale pidfile cleaned'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid.meta'))) 'stale meta cleaned'
  }
  elseif ($Name -eq 'stop-exe-mode') {
    $ii = New-SyntheticInstall -ExeMode
    $script:Table.Add((New-ProcRow 'powershell.exe' 777 10 "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$($ii.Deploy)\tray.ps1`"" $T0))
    $script:Table.Add((New-ProcRow 'windsurfapi.exe' 4242 777 "$($ii.Install)\windsurfapi.exe" $T0))
    Write-PidArtifacts -InstallInfo $ii -OwnerPid '4242' -Creation $T0 -Mode 'exe'
    Invoke-StopScript -InstallInfo $ii
    Assert-ActionCount '^stop-process 777$' 1 'tray supervisor (packaged layout) selected'
    Assert-ActionCount '^taskkill /PID 4242 /T$' 1 'packaged exe child stopped via trusted meta'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid'))) 'pidfile removed'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid.meta'))) 'meta removed'
  }
  elseif ($Name -eq 'stop-schtasks-own' -or $Name -eq 'stop-schtasks-foreign') {
    $ii = New-SyntheticInstall
    $vbs = if ($Name -eq 'stop-schtasks-own') { "$($ii.Deploy)\run.vbs" } else { 'C:\other place\deploy\windows\run.vbs' }
    $script:SchtasksXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author">
    <Exec>
      <Command>wscript</Command>
      <Arguments>"$vbs"</Arguments>
    </Exec>
  </Actions>
</Task>
"@
    Invoke-StopScript -InstallInfo $ii
    $ended = @($script:Actions | Where-Object { $_ -match '^schtasks /end' }).Count
    if ($Name -eq 'stop-schtasks-own') {
      Assert-True ($ended -eq 1) 'own-install scheduled task instance ended'
    } else {
      Assert-True ($ended -eq 0) 'foreign scheduled task instance left alone'
    }
  }
  else { throw "unknown full-script scenario $Name" }
}

function Invoke-ExtraScenario([string]$Name) {
  if ($Name -eq 'task-action-contract') {
    $sd = Join-Path $env:TEMP 'Owner App\deploy\windows'
    $vbs = Join-Path $sd 'run.vbs'
    $owned = '<Exec><Command>wscript.exe</Command><Arguments>&quot;' + [Security.SecurityElement]::Escape($vbs) + '&quot;</Arguments></Exec>'
    $foreign = '<Exec><Command>wscript.exe</Command><Arguments>C:\other\run.vbs</Arguments></Exec>'
    $cases = @(
      @{ Id = 'single owned'; Body = $owned; Expected = $true },
      @{ Id = 'foreign'; Body = $foreign; Expected = $false },
      @{ Id = 'notepad document'; Body = $owned.Replace('wscript.exe', 'notepad.exe'); Expected = $false },
      @{ Id = 'generic shell'; Body = $owned.Replace('wscript.exe', 'powershell.exe'); Expected = $false },
      @{ Id = 'two exec'; Body = $owned + $foreign; Expected = $false },
      @{ Id = 'two owned exec'; Body = $owned + $owned; Expected = $false },
      @{ Id = 'other action'; Body = $owned + '<ComHandler><ClassId>synthetic</ClassId></ComHandler>'; Expected = $false },
      @{ Id = 'suffix'; Body = $owned.Replace('run.vbs', 'run.vbs.backup'); Expected = $false },
      @{ Id = 'later document argument'; Body = $owned.Replace('<Arguments>', '<Arguments>C:\other\run.vbs '); Expected = $false },
      @{ Id = 'empty'; Body = ''; Expected = $false }
    )
    foreach ($case in $cases) {
      $xml = '<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Actions>' + $case.Body + '</Actions></Task>'
      Assert-True ((Test-IsOwnedScheduledTask $xml $sd) -eq $case.Expected) $case.Id
    }
    Assert-True (-not (Test-IsOwnedScheduledTask '<broken' $sd)) 'unreadable XML rejected'
    Assert-True (-not (Test-IsOwnedScheduledTask '<!DOCTYPE Task [<!ENTITY x "synthetic">]><Task><Actions>&x;</Actions></Task>' $sd)) 'DTD rejected'
    return
  }
  if ($Name -eq 'ticket-generation-contract') {
    $root = Join-Path $env:TEMP 'owner root'
    $row = New-ProcRow 'node.exe' 4242 111 'node src/index.js' $T0
    $good = @{ pid = 4242; createdAt = $T0.ToUniversalTime().ToString('o'); root = $root; mode = 'source' }
    foreach ($field in @('pid', 'createdAt', 'root', 'mode')) {
      $bad = $good.Clone(); $bad.Remove($field)
      Assert-True ((Test-PidOwnership $row 4242 ([pscustomobject]$bad) $root @(111)) -eq 'unowned') "missing $field rejects even with parent PID"
    }
    foreach ($mode in @('', 'unknown', 'exe')) {
      $bad = $good.Clone(); $bad.mode = $mode
      Assert-True ((Test-PidOwnership $row 4242 ([pscustomobject]$bad) $root @(111)) -eq 'unowned') "wrong mode '$mode' rejected"
    }
    foreach ($image in @('notepad.exe', 'windsurfapi.exe')) {
      $other = New-ProcRow $image 4242 111 'synthetic' $T0
      Assert-True ((Test-PidOwnership $other 4242 ([pscustomobject]$good) $root @(111)) -eq 'unowned') "wrong image $image rejected"
    }
    $bad = $good.Clone(); $bad.createdAt = $T0.AddTicks(10).ToString('o')
    Assert-True ((Test-PidOwnership $row 4242 ([pscustomobject]$bad) $root @(111)) -eq 'unowned') 'one microsecond mismatch cannot fall back'
    $started = [pscustomobject]@{ Id = 4242; StartTime = $T0.AddTicks(1); HasExited = $false }
    Assert-True (Test-StartedProcessCimIdentity $started $row) 'Process 100ns vs CIM microsecond precision normalized only at publication'
    $started.StartTime = $T0.AddTicks(10)
    Assert-True (-not (Test-StartedProcessCimIdentity $started $row)) 'publication rejects distinct microsecond'
    Assert-True (Test-ProcessGeneration $row ($T0.ToUniversalTime().ToString('o'))) 'exact UTC positive control'
    return
  }
  if ($Name -eq 'ticket-replacement-cleanup') {
    $ii = New-SyntheticInstall
    $old = Set-WindsurfApiPidMeta $ii.LogDir 4242 $T0 $ii.Install 'source'
    $new = Set-WindsurfApiPidMeta $ii.LogDir 4242 $T0 $ii.Install 'source'
    Assert-True ($old.Meta.ticketId -ne $new.Meta.ticketId) 'new publication gets unique receipt'
    Assert-True (-not (Remove-WindsurfApiPidArtifacts $ii.LogDir $old)) 'old receipt cannot delete replacement with same PID and creation'
    Assert-True ((Get-WindsurfApiPidTicket $ii.LogDir).Meta.ticketId -eq $new.Meta.ticketId) 'replacement preserved intact'
    Assert-True (Remove-WindsurfApiPidArtifacts $ii.LogDir $new) 'matching receipt cleaned'
    Assert-True (-not (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid.meta'))) 'matching sidecar removed'
    $old = Set-WindsurfApiPidMeta $ii.LogDir 4242 $T0 $ii.Install 'source'
    [IO.File]::WriteAllText((Join-Path $ii.LogDir 'windsurfapi.pid.meta'), '{malformed')
    $broken = Get-WindsurfApiPidTicket $ii.LogDir
    $row = New-ProcRow 'node.exe' 4242 111 'node' $T0
    Assert-True ((Test-PidOwnership $row 4242 $broken.Meta $ii.Install @(111)) -eq 'unowned') 'malformed sidecar cannot authorize legacy fallback'
    Assert-True (-not (Remove-WindsurfApiPidArtifacts $ii.LogDir $old)) 'changed malformed evidence is also preserved'
    return
  }
  if ($Name -eq 'tray-stop-contract') {
    # Extract exactly the reviewed function, never execute WinForms, bootstrap,
    # Start-Node or a real process API. All action/query names are stubs above.
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $DeploySrc 'tray.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'tray parse failed' }
    $function = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Stop-Node' }, $true)
    if (-not $function) { throw 'Stop-Node definition missing' }
    . ([scriptblock]::Create($function.Extent.Text))
    function Clear-NodeEvents { }
    foreach ($kind in @('grace', 'force', 'force-failed', 'reused', 'query-unknown')) {
      $ii = New-SyntheticInstall
      $script:Table.Clear(); $script:Actions.Clear(); $script:QueryCount = 0
      $script:TrayFake = $true
      $script:TaskkillKills = ($kind -eq 'grace')
      $script:ForceKills = ($kind -eq 'force')
      $script:Table.Add((New-ProcRow 'node.exe' 4242 111 'node' $T0))
      $script:proc = [pscustomobject]@{ Id = 4242; StartTime = $T0; HasExited = $false }
      $script:proc | Add-Member ScriptMethod WaitForExit { param($milliseconds) return $this.HasExited }
      $script:proc | Add-Member ScriptMethod Dispose { }
      $script:pidTicket = Set-WindsurfApiPidMeta $ii.LogDir 4242 $T0 $ii.Install 'source'
      $LogDir = $ii.LogDir
      $script:OnQuery = {
        param($filter)
        $script:QueryCount++
        if ($kind -eq 'query-unknown') { throw 'synthetic query failure' }
        if ($kind -eq 'reused' -and $script:QueryCount -ge 2) {
          Remove-TableRow 4242
          $script:Table.Add((New-ProcRow 'notepad.exe' 4242 999 'notepad' $T0.AddMilliseconds(1)))
        }
      }
      $success = Stop-Node
      $expected = $kind -in @('grace', 'force')
      Assert-True ($success -eq $expected) "tray $kind reports verified result"
      Assert-True ((Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid')) -eq (-not $expected)) "tray $kind receipt retention"
      if ($kind -in @('reused', 'query-unknown')) { Assert-ActionCount '/F' 0 "tray $kind no forced action" }
    }
    $script:TrayFake = $false
    return
  }
  $ii = New-SyntheticInstall
  $script:Table.Add((New-ProcRow 'node.exe' 4242 111 'node src/index.js' $T0))
  Write-PidArtifacts -InstallInfo $ii -OwnerPid '4242' -Creation $T0 -Mode 'source'
  if ($Name -eq 'stop-force-failure') {
    $script:TaskkillKills = $false
    Invoke-StopScript $ii
    Assert-ActionCount '/F' 1 'force requested once'
    Assert-True (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid')) 'failed force preserves ticket'
    Assert-True ([bool]($script:HostMessages | Where-Object { $_ -match 'exit was not verified' })) 'failed force does not claim successful stop'
  } elseif ($Name -eq 'stop-query-failure') {
    $script:OnQuery = { param($filter) if ($filter -match 'ProcessId=4242') { throw 'synthetic query failure' } }
    Invoke-StopScript $ii
    Assert-ActionCount '^taskkill ' 0 'unknown query cannot authorize action'
    Assert-True (Test-Path (Join-Path $ii.LogDir 'windsurfapi.pid')) 'query failure preserves ticket'
  } elseif ($Name -eq 'stop-concurrent-ticket') {
    $script:PublishedReplacement = $false
    $script:OnQuery = {
      param($filter)
      if (-not $script:PublishedReplacement -and $filter -match 'ProcessId=4242' -and
          @($script:Actions | Where-Object { $_ -match '^taskkill' }).Count -gt 0) {
        $script:PublishedReplacement = $true
        Write-PidArtifacts -InstallInfo $ii -OwnerPid '7777' -Creation $T0.AddMilliseconds(1) -Mode 'source'
      }
    }
    Invoke-StopScript $ii
    Assert-True ((Get-WindsurfApiPidTicket $ii.LogDir).Pid -eq 7777) 'new concurrent ticket survives old stop cleanup'
    Assert-ActionCount '7777' 0 'captured stop never targets new ticket'
  } else { throw "unknown extra scenario $Name" }
}

# ─────────────────────────────────────────────────────────────────────────────
switch ($Scenario) {
  'selector-owned-forms'    { Invoke-SelectorScenario -Kind 'selector-owned-forms' }
  'selector-foreign-rows'   { Invoke-SelectorScenario -Kind 'selector-foreign-rows' }
  'selector-normalization'  { Invoke-SelectorScenario -Kind 'selector-normalization' }
  'pid-verdicts'            { Invoke-PidVerdictScenario }
  { $_ -in @('task-action-contract', 'ticket-generation-contract', 'ticket-replacement-cleanup', 'stop-force-failure', 'stop-query-failure', 'stop-concurrent-ticket', 'tray-stop-contract') } { Invoke-ExtraScenario $Scenario }
  default                   { Invoke-FullScriptScenario -Name $Scenario }
}
Finish-Scenario $Scenario
