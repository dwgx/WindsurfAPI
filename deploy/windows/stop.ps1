# 停止 WindsurfAPI。
# 顺序关键:先杀监督者(powershell/wscript,否则它会立刻重拉 node),再停 node。
# node 停机:先试 taskkill(不带 /F)+ 短等 3s,超时即 /F 兜底。K7 起 accounts.json
# 是 fsync 原子写 + dirty-flush 持续落盘,/F 安全(不截断、最多丢一个 flush 周期)。
#
# 所有权绑定(审计 P1/P2 修复 @70defee2):
#   P1 旧实现机器级按脚本名子串(run.ps1|run.vbs|start.ps1)杀 powershell/wscript,
#      会误杀其它安装、同名脚本、仅把脚本当文档参数的进程;还漏掉 tray.ps1 监督者。
#      现在监督者 = 命令行实际启动的脚本 ∈ 本目录规范脚本(ownership.psm1);
#      相对路径/裸脚本名无法核实所属安装 → 保守不选(宁可漏杀,不可误杀)。
#   P2 pidfile 原来只存数字 → 现由 run.ps1/tray.ps1 同步写 windsurfapi.pid.meta
#      代际记录(pid + 进程创建时刻 UTC + root + mode)。停 node 的每一步动作
#      (初杀、升级 /F)前都重验代际,PID 复用(含 3s 优雅窗口内的复用)立即
#      中止升级,不把强杀打到无关进程上。
#      旧格式纯数字 pidfile(无 meta)退化到"父进程是已验证监督者"的链路;
#      无法确认归属 → 保守不动手、不删 pidfile,交人工核对。
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ScriptDir = $PSScriptRoot
# 分发包(脚本与 windsurfapi.exe 同目录)根 = 脚本目录;源码模式根 = 上两级。
# 与 tray.ps1 的双模式判定一致:exe 模式下 .env/logs 都在 exe 旁。
$Root = if (Test-Path (Join-Path $ScriptDir 'windsurfapi.exe')) { $ScriptDir }
        else { (Resolve-Path (Join-Path $ScriptDir '..\..')).Path }
$LogDir = Join-Path $Root 'logs'
$PidFile = Join-Path $LogDir 'windsurfapi.pid'

Import-Module (Join-Path $ScriptDir 'ownership.psm1') -Force -ErrorAction Stop

# ── 1. 只结束指向本安装 run.vbs 的计划任务实例(它是监督者的父)──
# 计划任务名 WindsurfAPI 全局唯一:另一套安装也可能注册了同名任务,直接 /end
# 会误杀它的监督进程。先读任务 XML,动作命令含本安装 run.vbs 规范路径才动手。
try {
  $queryOut = & schtasks /query /tn WindsurfAPI /xml 2>$null
  if ($LASTEXITCODE -eq 0 -and $queryOut) {
    $taskLine = ''
    try {
      [xml]$taskDoc = ($queryOut -join "`n")
      foreach ($exec in @($taskDoc.Task.Actions.Exec)) {
        $taskLine += ' ' + $exec.Command + ' ' + $exec.Arguments
      }
    } catch { $taskLine = '' }
    $needle = ConvertTo-OwnershipPath -Value (Join-Path $ScriptDir 'run.vbs')
    if ($taskLine -and $needle) {
      $hay = ConvertTo-OwnershipPath -Value $taskLine
      if ($hay -and $hay.Contains($needle)) {
        & schtasks /end /tn WindsurfAPI 2>$null | Out-Null
        Write-Host '已结束本安装的计划任务实例。' -ForegroundColor DarkGray
      }
    }
  }
} catch { }

# ── 2. 杀掉本安装的监督循环脚本(否则会重拉 node)──
#   监督循环可能活在三种进程里(全部按"命令行实际启动的脚本 ∈ 本目录"核实):
#     - run.ps1 直接跑(run.bat 前台)
#     - run.vbs 起的 wscript(run-background 隐藏后台)
#     - start.ps1 —— 它末尾用 `& run.ps1` 内联执行监督循环(同一进程),命令行
#       是 start.ps1 而非 run.ps1;tray.ps1 同理(托盘自带监督循环)。
#   两轮有界扫描:第一轮杀已存在的监督者;若监督者临死前又拉起新监督者,
#   第二轮按同样的所有权判定补杀。每个动作前重验代际:捕获行之后 PID 被
#   复用 → 跳过该目标,绝不误杀。
$killedSup = 0
$validatedSupervisorPids = New-Object System.Collections.Generic.List[int]
$handledSupPids = @{}
for ($sweep = 0; $sweep -lt 2; $sweep++) {
  $targets = @()
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='wscript.exe' OR Name='cscript.exe'" -ErrorAction SilentlyContinue |
    ForEach-Object {
      if ($handledSupPids.ContainsKey([int]$_.ProcessId)) { return }
      if (Test-IsOwnedSupervisor -Process $_ -ScriptDir $ScriptDir) { $targets += $_ }
    }
  if ($targets.Count -eq 0) { break }
  foreach ($target in $targets) {
    $supPid = [int]$target.ProcessId
    $handledSupPids[$supPid] = $true
    # 先记入已验证集合(供步骤 3 的旧格式 pidfile 走父进程链路),再杀。
    $validatedSupervisorPids.Add($supPid)
    $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$supPid" -ErrorAction SilentlyContinue
    if ($fresh -and (Test-ProcessGeneration -Process $fresh -Creation $target.CreationDate)) {
      try { Stop-Process -Id $supPid -Force -ErrorAction Stop; $killedSup++ } catch { }
    }
  }
}
if ($killedSup -gt 0) { Write-Host "已停止 $killedSup 个监督进程。" -ForegroundColor Yellow }

# ── 3. 按代际身份停 node ─────────────────────────────────────────
$nodePid = $null
if (Test-Path $PidFile) { $nodePid = (Get-Content $PidFile -Raw).Trim() }
$pidMeta = Get-WindsurfApiPidMeta -LogDir $LogDir
$nodeRow = $null
if ($nodePid -match '^\d+$') {
  $nodeRow = Get-CimInstance Win32_Process -Filter "ProcessId=$nodePid" -ErrorAction SilentlyContinue
}
$verdict = Test-PidOwnership -Process $nodeRow -Pid ([int]($nodePid -as [int])) `
  -Meta $pidMeta -Root $Root -SupervisorPids ([int[]]$validatedSupervisorPids.ToArray())

if ($verdict -eq 'absent') {
  Write-Host 'pidfile 无有效 node 进程(可能已停)。' -ForegroundColor DarkGray
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
  Remove-WindsurfApiPidMeta -LogDir $LogDir
  Write-Host 'WindsurfAPI 已停止。' -ForegroundColor Green
}
elseif ($verdict -eq 'unowned') {
  # 保守路径:pidfile 里的数字活着,但身份对不上(PID 复用,或旧格式 pidfile
  # 且父进程链路也核实不了)。不终止、不删 pidfile —— 删了就丢掉唯一线索,
  # 让下一次 stop 还能复现同一告警;留给人核对后再清。
  Write-Host "pidfile 的 pid=$nodePid 无法确认归属(PID 复用或旧格式 pidfile 缺代际记录),保守起见未终止。" -ForegroundColor Yellow
  Write-Host '请人工核对该 PID;确认无关后可手动删除 logs\windsurfapi.pid(及其 windsurfapi.pid.meta)。' -ForegroundColor Yellow
}
else {
  Write-Host "正在停止 node (pid=$nodePid)..." -ForegroundColor White
  # Windows 现实:node 是无窗口 console 进程,外部脚本用 taskkill(不带 /F)发的
  # WM_CLOSE 它收不到,SIGINT/SIGTERM 也无法可靠跨 console 投递 → 优雅关几乎必然
  # 超时。K7 起 accounts.json 是 fsync 原子写 + 池态由 30s dirty-flush 持续落盘,
  # 强杀(/F)不会截断文件、最多丢一个 flush 周期的自愈态 → /F 兜底是安全的。
  # 先给一次不带 /F 的尝试(极少数情形 node 能响应)+ 短等待 3s,超时即 /F。
  # 与旧实现的差别:每一步动作前后都重验代际(见上方 P2 注释)。
  $expectedCreation = $nodeRow.CreationDate
  $stopped = $false
  $reused = $false
  $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$nodePid" -ErrorAction SilentlyContinue
  if ($fresh -and (Test-ProcessGeneration -Process $fresh -Creation $expectedCreation)) {
    taskkill /PID $nodePid /T 2>$null | Out-Null
    $waited = 0
    while ($waited -lt 3) {
      Start-Sleep -Seconds 1; $waited++
      $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$nodePid" -ErrorAction SilentlyContinue
      if (-not $fresh) { $stopped = $true; break }
      if (-not (Test-ProcessGeneration -Process $fresh -Creation $expectedCreation)) { $reused = $true; break }
    }
    if (-not $stopped -and -not $reused) {
      # 升级 /F 前最后一次代际重验(3s 优雅窗口内 PID 可能已换手)。
      $fresh = Get-CimInstance Win32_Process -Filter "ProcessId=$nodePid" -ErrorAction SilentlyContinue
      if ($fresh -and (Test-ProcessGeneration -Process $fresh -Creation $expectedCreation)) {
        Write-Host '强制结束(K7:accounts.json 原子写 + dirty-flush,安全)...' -ForegroundColor Yellow
        taskkill /F /PID $nodePid /T 2>$null | Out-Null
        $stopped = $true
      } else { $reused = $true }
    }
  } else { $reused = $true }

  if ($reused) {
    Write-Host "PID $nodePid 在停止过程中已被其它进程复用(代际不匹配),未强杀。" -ForegroundColor Yellow
    Write-Host '请人工核对该 PID;确认无关后可手动删除 logs\windsurfapi.pid(及其 windsurfapi.pid.meta)。' -ForegroundColor Yellow
  }
  elseif ($stopped) {
    Write-Host 'node 已停止。' -ForegroundColor Green
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
    Remove-WindsurfApiPidMeta -LogDir $LogDir
    Write-Host 'WindsurfAPI 已停止。' -ForegroundColor Green
  }
}
