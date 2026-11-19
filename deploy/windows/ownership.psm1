# WindsurfAPI Windows 所有权辅助模块(narrow ownership helper)。
# 纯函数:只做判定与 pidfile 元数据读写,绝不枚举/终止真实进程 —— stop.ps1
# 是唯一的动作编排者,测试可对这些函数注入合成 Win32_Process 行(见
# test/stop-ownership-harness.ps1)。
#
# 背景(审计 P1/P2, 70defee2):
#   P1  旧 stop.ps1 机器级按脚本名子串杀 powershell/wscript,可误杀其它安装
#       甚至仅"提到"同名脚本的进程(编辑器/文档参数/缺失命令行)。
#   P2  pidfile 只存数字 PID,按"存在即命中"判定;PID 复用(含优雅停 3s
#       窗口内的复用)会把强杀打到无关进程上。
# 解法:
#   - 监督者选择 = 命令行里实际启动的脚本路径 == 本安装目录下的规范脚本
#     (run.ps1/start.ps1/tray.ps1/run.vbs/tray.vbs),引号空格路径真实解析。
#     相对路径/裸脚本名无法核实所属安装 → 保守不选。
#   - 子进程归属 = pidfile 数字 PID + 同目录 windsurfapi.pid.meta 代际记录
#     (pid + 进程创建时刻 UTC + root + mode)。元数据齐全且创建时刻吻合 →
#     trusted;缺元数据(旧格式 pidfile)→ 退化到"父进程是已验证监督者"
#     的保守链路;两者皆不成立 → unowned,不动手。
#   - 每次动作(初杀 / 升级 /F)前重验代际,PID 复用即中止升级。

Set-StrictMode -Version 2.0

# 规范化路径用于比较:去外层引号、统一斜杠、小写、去尾反斜杠。
# 不处理 8.3 短名与 UNC(启动器全部用 %~dp0 / WScript.ScriptFullName 长路径)。
function ConvertTo-OwnershipPath {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $p = $Value.Trim().Trim('"').Trim("'").Trim()
  if (-not $p) { return $null }
  $p = $p -replace '/', '\'
  $p = $p.ToLowerInvariant()
  while ($p.EndsWith('\')) { $p = $p.Substring(0, $p.Length - 1) }
  if (-not $p) { return $null }
  return $p
}

function Test-OwnershipPathEquals {
  param([string]$A, [string]$B)
  $na = ConvertTo-OwnershipPath $A
  $nb = ConvertTo-OwnershipPath $B
  if (-not $na -or -not $nb) { return $false }
  return ($na -eq $nb)
}

# 本安装目录下的规范监督脚本(与 stop.ps1/tray.ps1/run.vbs/tray.vbs 同目录;
# 源码模式在 deploy\windows,分发包与 windsurfapi.exe 同层)。
function Get-OwnedSupervisorScripts {
  param([string]$ScriptDir)
  return @('run.ps1', 'start.ps1', 'tray.ps1', 'run.vbs', 'tray.vbs') |
    ForEach-Object { Join-Path $ScriptDir $_ }
}

# 引号感知分词:丢双引号字符、引号内空格保留、引号外空格分词。
# 单引号保留在 token 里(由 ConvertTo-OwnershipPath 剥外层)。
function Split-OwnershipCommandLine {
  param([string]$CommandLine)
  if ([string]::IsNullOrEmpty($CommandLine)) { return @() }
  $tokens = New-Object System.Collections.Generic.List[string]
  $cur = New-Object System.Text.StringBuilder
  $inQuote = $false
  foreach ($ch in $CommandLine.ToCharArray()) {
    if ($ch -eq '"') { $inQuote = -not $inQuote; continue }
    if (-not $inQuote -and ($ch -eq ' ' -or $ch -eq "`t")) {
      if ($cur.Length -gt 0) { $tokens.Add($cur.ToString()) | Out-Null; $cur.Length = 0 }
      continue
    }
    $cur.Append($ch) | Out-Null
  }
  if ($cur.Length -gt 0) { $tokens.Add($cur.ToString()) | Out-Null }
  return $tokens.ToArray()
}

# 候选脚本路径是否 == 本安装规范脚本。必须绝对路径:相对路径/裸名无法核实
# 所属安装(进程 CWD 不可靠),保守不选 → 宁可漏杀,不可误杀。
function Test-OwnershipScriptPath {
  param([string]$Candidate, [string]$ScriptDir)
  if ([string]::IsNullOrWhiteSpace($Candidate)) { return $false }
  $p = $Candidate.Trim().Trim('"').Trim("'").Trim()
  if (-not $p) { return $false }
  if (-not [System.IO.Path]::IsPathRooted($p)) { return $false }
  $norm = ConvertTo-OwnershipPath $p
  if (-not $norm) { return $false }
  foreach ($canonical in (Get-OwnedSupervisorScripts -ScriptDir $ScriptDir)) {
    if ((ConvertTo-OwnershipPath $canonical) -eq $norm) { return $true }
  }
  return $false
}

# -Command 值必须以调用操作符(& 或 .)紧邻规范路径才算监督者启动;
# Get-Content / Select-String / iex 等文档参数一律拒绝。
function Test-OwnershipInvocation {
  param([string]$CommandValue, [string]$ScriptDir)
  if ([string]::IsNullOrWhiteSpace($CommandValue)) { return $false }
  $norm = ConvertTo-OwnershipPath $CommandValue
  if (-not $norm) { return $false }
  foreach ($canonical in (Get-OwnedSupervisorScripts -ScriptDir $ScriptDir)) {
    $target = ConvertTo-OwnershipPath $canonical
    if (-not $target) { continue }
    $esc = [Regex]::Escape($target)
    # (^|分隔符)(& 或 .) 空白 可选引号 <规范路径> 可选引号 (结束|分隔符)
    $pattern = '(^|[\s;&|(])(\&|\.)\s*["'']?' + $esc + '["'']?(\s|$|[;|&)])'
    if ($norm -match $pattern) { return $true }
  }
  return $false
}

# 监督者判定(纯谓词):powershell/pwsh 看 -File / -Command 调用 / 首个位置参数;
# wscript/cscript 看第一个非 // 开关参数;其它宿主一律拒绝。
function Test-IsOwnedSupervisor {
  param($Process, [string]$ScriptDir)
  if ($null -eq $Process) { return $false }
  $name = ''
  try { $name = ([string]$Process.Name).ToLowerInvariant() } catch { }
  $cl = $null
  try { $cl = [string]$Process.CommandLine } catch { $cl = $null }
  if ([string]::IsNullOrWhiteSpace($cl)) { return $false }

  $tokens = @(Split-OwnershipCommandLine -CommandLine $cl)
  if ($tokens.Count -lt 2) { return $false }
  $rest = @($tokens[1..($tokens.Count - 1)])   # 丢弃宿主映像 token

  if ($name -in @('powershell.exe', 'pwsh.exe')) {
    for ($i = 0; $i -lt $rest.Count; $i++) {
      $t = $rest[$i].ToLowerInvariant()
      if ($t -eq '-file' -or $t -eq '/file') {
        if ($i + 1 -ge $rest.Count) { return $false }
        return (Test-OwnershipScriptPath -Candidate $rest[$i + 1] -ScriptDir $ScriptDir)
      }
      if ($t.StartsWith('-file:')) {
        return (Test-OwnershipScriptPath -Candidate $t.Substring(6) -ScriptDir $ScriptDir)
      }
    }
    for ($i = 0; $i -lt $rest.Count; $i++) {
      $t = $rest[$i].ToLowerInvariant()
      if ($t -eq '-command' -or $t -eq '-c' -or $t -eq '/command' -or $t -eq '/c') {
        if ($i + 1 -ge $rest.Count) { return $false }
        $cmdVal = (@($rest[($i + 1)..($rest.Count - 1)]) -join ' ')
        return (Test-OwnershipInvocation -CommandValue $cmdVal -ScriptDir $ScriptDir)
      }
    }
    # 位置参数默认绑 -File。
    foreach ($t in $rest) {
      if (-not $t.StartsWith('-')) {
        return (Test-OwnershipScriptPath -Candidate $t -ScriptDir $ScriptDir)
      }
    }
    return $false
  }
  if ($name -in @('wscript.exe', 'cscript.exe')) {
    foreach ($t in $rest) {
      if (-not $t.StartsWith('/')) {
        return (Test-OwnershipScriptPath -Candidate $t -ScriptDir $ScriptDir)
      }
    }
    return $false
  }
  return $false
}

# 代际校验:进程创建时刻与期望值(本地 DateTime 或 UTC ISO 字符串)差 ≤ 容差。
# PID 复用必然换创建时刻 —— 这是判定"还是那一个进程"的唯一可靠依据。
function Test-ProcessGeneration {
  param($Process, $Creation, [long]$ToleranceTicks = 30000000)   # 3s(1s = 1e7 ticks)
  if ($null -eq $Process -or $null -eq $Creation) { return $false }
  try {
    $rowTicks = ([datetime]$Process.CreationDate).ToUniversalTime().Ticks
    $expectedTicks = $null
    if ($Creation -is [datetime]) {
      $expectedTicks = $Creation.ToUniversalTime().Ticks
    } else {
      $expectedTicks = ([DateTimeOffset]::Parse([string]$Creation,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind)).UtcTicks
    }
    return ([Math]::Abs($rowTicks - $expectedTicks) -le $ToleranceTicks)
  } catch { return $false }
}

# pidfile 元数据(sidecar):写 windsurfapi.pid.meta。pidfile 本身保持单行数字
# (status.ps1 等旧读者按 -Raw 读数字,不能破坏该契约)。
function Set-WindsurfApiPidMeta {
  param(
    [Parameter(Mandatory = $true)][string]$LogDir,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)]$CreationTimeUtc,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Mode
  )
  $iso = if ($CreationTimeUtc -is [datetime]) { $CreationTimeUtc.ToUniversalTime().ToString('o') }
         else { [string]$CreationTimeUtc }
  $record = [pscustomobject]@{ pid = $ProcessId; createdAt = $iso; root = $Root; mode = $Mode }
  $json = ConvertTo-Json -InputObject $record -Compress
  [System.IO.File]::WriteAllText((Join-Path $LogDir 'windsurfapi.pid.meta'), $json,
    (New-Object System.Text.UTF8Encoding($false)))
}

function Get-WindsurfApiPidMeta {
  param([Parameter(Mandatory = $true)][string]$LogDir)
  $path = Join-Path $LogDir 'windsurfapi.pid.meta'
  if (-not (Test-Path $path)) { return $null }
  try {
    $obj = Get-Content -Path $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $obj.pid = [int]$obj.pid
    return $obj
  } catch { return $null }
}

function Remove-WindsurfApiPidMeta {
  param([Parameter(Mandatory = $true)][string]$LogDir)
  Remove-Item (Join-Path $LogDir 'windsurfapi.pid.meta') -Force -ErrorAction SilentlyContinue
}

# pidfile 数字 PID 的归属裁决(纯函数,不动进程):
#   trusted      元数据齐全:pid 一致 + 创建时刻吻合 + root 一致(或元数据无 root)
#   legacy-owned 旧格式无元数据:映像是 node/windsurfapi 且父进程是已验证监督者
#   unowned      两者皆不成立 → 保守不动手
#   absent       进程已不存在
function Test-PidOwnership {
  param($Process, [int]$Pid, $Meta, [string]$Root, [int[]]$SupervisorPids)
  if ($null -eq $Process) { return 'absent' }

  if ($null -ne $Meta -and [int]$Meta.pid -eq $Pid -and $Meta.createdAt) {
    if (Test-ProcessGeneration -Process $Process -Creation ([string]$Meta.createdAt)) {
      if (-not $Meta.root -or (Test-OwnershipPathEquals -A ([string]$Meta.root) -B $Root)) {
        return 'trusted'
      }
    }
  }

  $name = ''
  try { $name = ([string]$Process.Name).ToLowerInvariant() } catch { }
  if (($name -eq 'node.exe' -or $name -eq 'windsurfapi.exe') -and
      ($null -ne $SupervisorPids) -and ($SupervisorPids -contains [int]$Process.ParentProcessId)) {
    return 'legacy-owned'
  }
  return 'unowned'
}

Export-ModuleMember -Function @(
  'ConvertTo-OwnershipPath',
  'Test-OwnershipPathEquals',
  'Get-OwnedSupervisorScripts',
  'Split-OwnershipCommandLine',
  'Test-OwnershipScriptPath',
  'Test-OwnershipInvocation',
  'Test-IsOwnedSupervisor',
  'Test-ProcessGeneration',
  'Set-WindsurfApiPidMeta',
  'Get-WindsurfApiPidMeta',
  'Remove-WindsurfApiPidMeta',
  'Test-PidOwnership'
)
