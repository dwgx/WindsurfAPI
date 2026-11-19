# WindsurfAPI 监督循环内核。
# 阻塞式跑 `node src/index.js`,按退出码路由:75/0 重启,其它退避后停。
# 由 start.ps1(前台)、run.bat(前台)、run.vbs(隐藏后台)共用。
#
# ⚠️ 退出码语义与 KiroStudio 相反(见 README):
#   75 = 自更新/面板 Update 请求重启(EX_TEMPFAIL, api.js:2055)
#   0  = 优雅停机(index.js exit(0),已抽干 SSE;K7 起关机只 drain 不回写池,
#        盘上池态由 30s dirty-flush 保持最新)
#   其它非零 = 崩溃/启动错/端口占用重试耗尽(index.js/server.js exit(1))
#
# 关键红线:阻塞等子进程完全退出再重启,杜绝两个 node 抢写 accounts.json。
# 绝不用 taskkill /F 来「重启」(那是外部写者红线;监督者靠等子退出即零写重叠)。

$ErrorActionPreference = 'Stop'
# 控制台按 UTF-8 输出,否则中文文案在默认 GBK/936 码页的窗口里显示为乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 项目根 = 本脚本上两级(deploy/windows/ → 根)。config.js 按模块路径解析
# .env/数据文件(ROOT=resolve(__dirname,'..')),cwd 必须是根以保 git/自更新正确。
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root

$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$PidFile = Join-Path $LogDir 'windsurfapi.pid'
# Required before spawning: missing ownership support must not silently publish
# a numeric-only ticket that cannot be safely stopped.
Import-Module (Join-Path $PSScriptRoot 'ownership.psm1') -Force -ErrorAction Stop
$Date = Get-Date -Format 'yyyy-MM-dd'
$SupLog = Join-Path $LogDir "supervisor-$Date.log"

# DEVIN_CONNECT 必需(language_server 仅 Linux/macOS)。仅在未设时补默认,
# 不覆盖用户显式值(config.js:27 环境变量优先于 .env)。
if (-not $env:DEVIN_CONNECT -and -not $env:DEVIN_ONLY) { $env:DEVIN_CONNECT = '1' }
if (-not $env:LOG_LEVEL) { $env:LOG_LEVEL = 'info' }

function Write-Sup([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $SupLog -Value $line -Encoding UTF8
}

$MaxCrashLoop = 5
$crashStreak = 0

Write-Sup "supervisor start (root=$Root)"

while ($true) {
  # 原始 stdout/stderr 必须落盘:app 的 JSONL 日志不含启动 banner(index.js:78)
  # 与 pre-logger 致命 console.error(index.js:214)。给子进程单独的 node 日志,
  # 与监督者自己的 Write-Sup 记录分离(否则同一文件被 stdout 重定向截断,监督
  # 记录会被 app 输出覆盖 —— 老版 Start-Process 方案的隐患)。
  $nodeOut = Join-Path $LogDir "node-$Date.log"

  # 关键:用 [Diagnostics.Process] 而非 Start-Process -PassThru。后者在
  # -RedirectStandardOutput 到文件时,$proc.ExitCode 会返回 $null(Windows
  # PowerShell 已知缺陷),导致 75/0 全部落入 else 崩溃分支 —— 热更新与优雅
  # 重启彻底失效。.NET Process 的 ExitCode 可靠,且能拿到 PID 写 pidfile
  # (stop.ps1/status.ps1 依赖)。异步抽干 stdout/stderr 到 node 日志,避免
  # 管道缓冲写满导致子进程阻塞(经典死锁),同时满足"等子退出再重启"红线。
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node'
  $psi.Arguments = 'src/index.js'
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $sink = { if ($EventArgs.Data -ne $null) { Add-Content -Path $Event.MessageData -Value $EventArgs.Data -Encoding UTF8 } }
  $so = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $sink -MessageData $nodeOut
  $se = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived  -Action $sink -MessageData $nodeOut
  [void]$proc.Start()
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()

  $pidTicket = $null
  try {
    $creationRow = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction Stop
    if (-not (Test-StartedProcessCimIdentity $proc $creationRow)) { throw 'Child CIM identity unavailable' }
    $pidTicket = Set-WindsurfApiPidMeta -LogDir $LogDir -ProcessId $proc.Id -CreationTimeUtc $creationRow.CreationDate -Root $Root -Mode 'source'
  } catch { Write-Sup "PID ticket unavailable; child remains supervised: $($_.Exception.Message)" }
  Write-Sup "node started pid=$($proc.Id)"

  $proc.WaitForExit()
  $code = $proc.ExitCode
  try { [void](Remove-WindsurfApiPidArtifacts -LogDir $LogDir -ExpectedTicket $pidTicket) } catch { }
  # 注销事件订阅,防止跨循环泄漏。
  Unregister-Event -SourceIdentifier $so.Name -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier $se.Name -ErrorAction SilentlyContinue
  $proc.Dispose()
  Write-Sup "node exited code=$code"

  if ($code -eq 75) {
    # 自更新/面板 Update:重启,重置崩溃计数。
    $crashStreak = 0
    Write-Sup 'exit 75 (self-update/restart requested) -> restarting'
    Start-Sleep -Milliseconds 1000
    continue
  }
  elseif ($code -eq 0) {
    # 优雅停机。真实 Ctrl-C/关窗会同时终结本监督者,走不到重拉;这段可打断的
    # 等待只是兜底(例如程序内部主动 exit(0))。
    $crashStreak = 0
    Write-Sup 'exit 0 (graceful) -> restarting after 2s (Ctrl-C to stop)'
    Start-Sleep -Seconds 2
    continue
  }
  else {
    # 崩溃/启动错/端口占用重试耗尽。退避,连续 MaxCrashLoop 次后停机。
    $crashStreak++
    if ($crashStreak -ge $MaxCrashLoop) {
      Write-Sup "CRASH LOOP: $crashStreak consecutive non-zero exits (last=$code). Stopping."
      Write-Host ''
      Write-Host '============================================================' -ForegroundColor Red
      Write-Host " WindsurfAPI 连续 $crashStreak 次异常退出,监督循环已停止。" -ForegroundColor Red
      Write-Host " 最近日志:$SupLog" -ForegroundColor Red
      Write-Host '============================================================' -ForegroundColor Red
      if (Test-Path $outLog) { Write-Host '--- 日志尾 ---'; Get-Content $outLog -Tail 30 }
      break
    }
    $backoff = [Math]::Min(2 * $crashStreak, 10)
    Write-Sup "non-zero exit (code=$code), crashStreak=$crashStreak -> backoff ${backoff}s"
    Start-Sleep -Seconds $backoff
    continue
  }
}

# Each exited child cleaned only its own receipt above; never delete a new run.
Write-Sup 'supervisor stopped'
