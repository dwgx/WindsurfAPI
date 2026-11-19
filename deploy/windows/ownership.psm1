# Windows launcher ownership and generation-bound pid tickets.
# This module never enumerates, signals or terminates a process. Callers provide
# CIM rows. Missing/ambiguous metadata and unsupported launch syntax fail closed.
Set-StrictMode -Version 2.0

function ConvertTo-OwnershipPath {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim() -or
      $Value.Contains('"')) { return $null }
  return ($Value.Replace('/', '\').TrimEnd('\').ToLowerInvariant())
}

function Test-OwnershipPathEquals {
  param([string]$A, [string]$B)
  $left = ConvertTo-OwnershipPath $A
  $right = ConvertTo-OwnershipPath $B
  return ($left -and $right -and $left -ceq $right)
}

function Get-OwnedSupervisorScripts {
  param([string]$ScriptDir)
  @('run.ps1', 'start.ps1', 'tray.ps1', 'run.vbs', 'tray.vbs') |
    ForEach-Object { Join-Path $ScriptDir $_ }
}

# Deliberately small grammar for the shipped launchers. No escaped/embedded
# quotes, single-quote shell syntax, empty arguments or unmatched quotes.
function Split-OwnershipCommandLine {
  param([string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
  $tokens = New-Object System.Collections.Generic.List[string]
  $matches = [regex]::Matches($CommandLine, '(?:^|\s)(?:"([^"\r\n]+)"|([^\s"\r\n]+))(?=\s|$)')
  $end = 0
  foreach ($match in $matches) {
    if ($CommandLine.Substring($end, $match.Index - $end).Trim()) { return @() }
    $token = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if ($token.Contains('"')) { return @() }
    $tokens.Add($token)
    $end = $match.Index + $match.Length
  }
  if ($CommandLine.Substring($end).Trim()) { return @() }
  return $tokens.ToArray()
}

function Test-OwnershipScriptPath {
  param([string]$Candidate, [string]$ScriptDir, [string]$Extension)
  if (-not (ConvertTo-OwnershipPath $Candidate) -or -not [IO.Path]::IsPathRooted($Candidate)) { return $false }
  if ($Extension -and [IO.Path]::GetExtension($Candidate) -ine $Extension) { return $false }
  foreach ($canonical in (Get-OwnedSupervisorScripts $ScriptDir)) {
    if (Test-OwnershipPathEquals $Candidate $canonical) { return $true }
  }
  return $false
}

# Arbitrary -Command expressions are intentionally unsupported. Paths inside a
# literal, document argument or later -File token are not proof of invocation.
function Test-OwnershipInvocation {
  param([string]$CommandValue, [string]$ScriptDir)
  return $false
}

function Test-IsOwnedSupervisor {
  param($Process, [string]$ScriptDir)
  try {
    $name = ([string]$Process.Name).ToLowerInvariant()
    $tokens = @(Split-OwnershipCommandLine ([string]$Process.CommandLine))
    if ($tokens.Count -lt 2) { return $false }
    $hostName = [IO.Path]::GetFileName($tokens[0]).ToLowerInvariant()
    if ($hostName -ne $name -and ($hostName + '.exe') -ne $name) { return $false }
    if ($name -in @('powershell.exe', 'pwsh.exe')) {
      for ($i = 1; $i -lt $tokens.Count; $i++) {
        $option = $tokens[$i].ToLowerInvariant()
        if ($option -eq '-file') {
          if ($i + 1 -ge $tokens.Count) { return $false }
          return (Test-OwnershipScriptPath $tokens[$i + 1] $ScriptDir '.ps1')
        }
        if ($option -in @('-noprofile', '-nologo', '-noninteractive', '-sta', '-mta')) { continue }
        if ($option -in @('-executionpolicy', '-windowstyle')) {
          $i++
          if ($i -ge $tokens.Count) { return $false }
          if ($option -eq '-executionpolicy' -and $tokens[$i] -notin @('Bypass', 'RemoteSigned', 'AllSigned', 'Restricted', 'Unrestricted', 'Default')) { return $false }
          if ($option -eq '-windowstyle' -and $tokens[$i] -notin @('Normal', 'Hidden', 'Minimized', 'Maximized')) { return $false }
          continue
        }
        return $false
      }
    } elseif ($name -in @('wscript.exe', 'cscript.exe')) {
      for ($i = 1; $i -lt $tokens.Count; $i++) {
        if ($tokens[$i] -in @('//nologo', '//b', '//i', '//u')) { continue }
        return (Test-OwnershipScriptPath $tokens[$i] $ScriptDir '.vbs')
      }
    }
  } catch { return $false }
  return $false
}

function Test-IsOwnedScheduledTask {
  param([string]$Xml, [string]$ScriptDir)
  $reader = $null
  try {
    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [System.Xml.XmlReader]::Create((New-Object System.IO.StringReader($Xml)), $settings)
    $doc = New-Object System.Xml.XmlDocument
    $doc.XmlResolver = $null
    $doc.Load($reader)
    $actions = @($doc.SelectNodes('/*[local-name()="Task"]/*[local-name()="Actions"]/*'))
    if ($actions.Count -ne 1 -or $actions[0].LocalName -ne 'Exec') { return $false }
    $commands = @($actions[0].SelectNodes('*[local-name()="Command"]'))
    $arguments = @($actions[0].SelectNodes('*[local-name()="Arguments"]'))
    if ($commands.Count -ne 1 -or $arguments.Count -ne 1) { return $false }
    $command = [string]$commands[0].InnerText
    if (-not (ConvertTo-OwnershipPath $command)) { return $false }
    $name = [IO.Path]::GetFileName($command).ToLowerInvariant()
    if ($name -in @('wscript', 'cscript')) { $name += '.exe' }
    if ($name -notin @('wscript.exe', 'cscript.exe')) { return $false }
    $args = @(Split-OwnershipCommandLine ([string]$arguments[0].InnerText))
    $index = 0
    while ($index -lt $args.Count -and $args[$index] -in @('//nologo', '//b', '//i', '//u')) { $index++ }
    if ($index -ge $args.Count -or -not (Test-OwnershipPathEquals $args[$index] (Join-Path $ScriptDir 'run.vbs'))) { return $false }
    return (Test-IsOwnedSupervisor ([pscustomobject]@{ Name = $name; CommandLine = ('"' + $command + '" ' + $arguments[0].InnerText) }) $ScriptDir)
  } catch { return $false }
  finally { if ($reader) { $reader.Dispose() } }
}

function ConvertTo-OwnershipCreation {
  param($Value)
  if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
  return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind).UtcDateTime
}

# Both stored timestamps and queried timestamps come from Win32_Process.
# Exact tick equality; no grace interval is an identity tolerance.
function Test-ProcessGeneration {
  param($Process, $Creation)
  try {
    if ($null -eq $Process -or $null -eq $Creation) { return $false }
    return ((ConvertTo-OwnershipCreation $Process.CreationDate).Ticks -eq (ConvertTo-OwnershipCreation $Creation).Ticks)
  } catch { return $false }
}

# The Process object and its CIM row differ in precision: CIM exposes microseconds.
# Use this only while publishing our own newly spawned Process; persist CIM itself.
function Test-StartedProcessCimIdentity {
  param($Process, $CimProcess)
  try {
    if ($Process.HasExited -or [int]$Process.Id -ne [int]$CimProcess.ProcessId) { return $false }
    $format = 'yyyy-MM-ddTHH:mm:ss.ffffffZ'
    return ($Process.StartTime.ToUniversalTime().ToString($format) -ceq
      (ConvertTo-OwnershipCreation $CimProcess.CreationDate).ToString($format))
  } catch { return $false }
}

function Enter-WindsurfApiPidLock {
  param([string]$LogDir)
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    try { return [IO.File]::Open((Join-Path $LogDir 'windsurfapi.pid.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { if ($attempt -eq 49) { throw }; [Threading.Thread]::Sleep(10) }
  }
}

function Read-WindsurfApiPidTicket {
  param([string]$LogDir)
  $pidPath = Join-Path $LogDir 'windsurfapi.pid'
  $metaPath = Join-Path $LogDir 'windsurfapi.pid.meta'
  $pidText = if ([IO.File]::Exists($pidPath)) { [IO.File]::ReadAllText($pidPath) } else { $null }
  $metaText = if ([IO.File]::Exists($metaPath)) { [IO.File]::ReadAllText($metaPath) } else { $null }
  $meta = $null
  try { if ($metaText) { $meta = ConvertFrom-Json -InputObject $metaText -ErrorAction Stop } } catch { }
  $ownerId = 0
  $valid = ($null -ne $pidText -and $pidText.Trim() -match '^\d+$' -and
    [int]::TryParse($pidText.Trim(), [ref]$ownerId) -and $ownerId -gt 0)
  return [pscustomobject]@{ Pid = $ownerId; PidText = $pidText; MetaText = $metaText; Meta = $meta; Valid = [bool]$valid }
}

function Get-WindsurfApiPidTicket {
  param([Parameter(Mandatory = $true)][string]$LogDir)
  if (-not [IO.Directory]::Exists($LogDir)) { return $null }
  $lock = Enter-WindsurfApiPidLock $LogDir
  try { return (Read-WindsurfApiPidTicket $LogDir) } finally { $lock.Dispose() }
}

# Publish both files under the same lock used by readers and conditional cleanup.
# A unique receipt also distinguishes a replacement ticket for the same process.
function Set-WindsurfApiPidMeta {
  param([string]$LogDir, [int]$ProcessId, $CreationTimeUtc, [string]$Root, [string]$Mode)
  if ($ProcessId -le 0 -or -not (ConvertTo-OwnershipPath $Root) -or $Mode -notin @('source', 'exe')) { throw 'Invalid pid ticket identity' }
  $record = [pscustomobject]@{ pid = $ProcessId; createdAt = (ConvertTo-OwnershipCreation $CreationTimeUtc).ToString('o'); root = $Root; mode = $Mode; ticketId = [guid]::NewGuid().ToString('N') }
  $json = ConvertTo-Json -InputObject $record -Compress
  $lock = Enter-WindsurfApiPidLock $LogDir
  try {
    [IO.File]::WriteAllText((Join-Path $LogDir 'windsurfapi.pid'), [string]$ProcessId, [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $LogDir 'windsurfapi.pid.meta'), $json, (New-Object Text.UTF8Encoding($false)))
    return (Read-WindsurfApiPidTicket $LogDir)
  } finally { $lock.Dispose() }
}

function Get-WindsurfApiPidMeta {
  param([string]$LogDir)
  $ticket = Get-WindsurfApiPidTicket $LogDir
  if ($ticket) { return $ticket.Meta }
  return $null
}

# Never erase a newer publisher's ticket. All supplied launchers share this lock.
function Remove-WindsurfApiPidArtifacts {
  param([string]$LogDir, $ExpectedTicket)
  if ($null -eq $ExpectedTicket -or -not [IO.Directory]::Exists($LogDir)) { return $false }
  $lock = Enter-WindsurfApiPidLock $LogDir
  try {
    $current = Read-WindsurfApiPidTicket $LogDir
    if ($current.PidText -cne $ExpectedTicket.PidText -or $current.MetaText -cne $ExpectedTicket.MetaText) { return $false }
    [IO.File]::Delete((Join-Path $LogDir 'windsurfapi.pid'))
    [IO.File]::Delete((Join-Path $LogDir 'windsurfapi.pid.meta'))
    return $true
  } finally { $lock.Dispose() }
}

function Test-PidOwnership {
  param($Process, [int]$Pid, $Meta, [string]$Root, [int[]]$SupervisorPids)
  if ($null -eq $Process) { return 'absent' }
  try {
    if ($null -eq $Meta -or $Pid -le 0 -or [int]$Process.ProcessId -ne $Pid -or
        [int]$Meta.pid -ne $Pid -or -not $Meta.createdAt -or -not $Meta.root -or
        -not (Test-OwnershipPathEquals ([string]$Meta.root) $Root)) { return 'unowned' }
    $image = ([string]$Process.Name).ToLowerInvariant()
    if (($Meta.mode -eq 'source' -and $image -eq 'node.exe') -or
        ($Meta.mode -eq 'exe' -and $image -eq 'windsurfapi.exe')) {
      if (Test-ProcessGeneration $Process $Meta.createdAt) { return 'trusted' }
    }
  } catch { }
  # Parent PID alone is not a generation-bound proof; no legacy fallback.
  return 'unowned'
}

Export-ModuleMember -Function @(
  'ConvertTo-OwnershipPath', 'Test-OwnershipPathEquals', 'Get-OwnedSupervisorScripts',
  'Split-OwnershipCommandLine', 'Test-OwnershipScriptPath', 'Test-OwnershipInvocation',
  'Test-IsOwnedSupervisor', 'Test-IsOwnedScheduledTask', 'Test-ProcessGeneration',
  'Test-StartedProcessCimIdentity', 'Set-WindsurfApiPidMeta', 'Get-WindsurfApiPidMeta',
  'Get-WindsurfApiPidTicket', 'Remove-WindsurfApiPidArtifacts', 'Test-PidOwnership'
)
