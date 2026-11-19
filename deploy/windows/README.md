# WindsurfAPI — Windows 后台运行

零依赖(纯 `schtasks` + `wscript` + PowerShell)把网关在 Windows 上以隐藏后台、开机自启、崩溃自愈的方式跑起来。不碰 `src/`,只是外挂启动/监督层。

## 两种跑法

**A. 单 exe(开箱即用,无需装 Node)** —— 类似 KiroStudio 的 `kirostudio.exe`。
从 [GitHub Releases](https://github.com/dwgx/WindsurfAPI/releases) 下载 `windsurfapi.exe`(每个 `v*` tag 由 CI 的 windows runner 打包,已 smoke 验证能起 + 出面板),放进任意空文件夹,双击即跑:
  - exe 内置默认:`DEVIN_CONNECT=1`(纯 HTTP 路,不需要 Linux 专用的 language server)、`HOST=127.0.0.1`(仅本机,不暴露局域网)、`PORT=3003`。
  - **所有状态存到 exe 同目录的 `Windsurf_data/` 文件夹**(accounts.json / stats / logs),与程序内部的只读快照隔离。想换位置可在同目录 `.env` 里设 `DATA_DIR=`。
  - **首次运行会自动打开** `http://127.0.0.1:3003/dashboard`(之后启动不再自动开;`WINDSURFAPI_NO_OPEN=1` 可关掉)。
  - 首次运行若同目录没有 `API_KEY` / `DASHBOARD_PASSWORD`,exe 会**自动生成**强随机值,写入同目录 `.env`,并在控制台打印一次。下次启动沿用,不必手写。要自己设,在 `.env` 里覆盖即可。
  - 关窗口 = 停止。换新版 = 下载新 exe 覆盖,`Windsurf_data/` 与 `.env` 不动。
  - **先验签再运行**(v3.10.0 起):每个资产都带 cosign keyless 签名。把 exe、`SHA256SUMS` 及同名 `.sig` / `.pem` / `.sigstore.json` 下载到同一目录,按 [docs/RELEASE-SIGNING.md](../../docs/RELEASE-SIGNING.md) 用 `cosign verify-blob --bundle ...` 验证,再用 `Get-FileHash` 核对已验签的清单。exe 会读取同目录的 `.env` 和 `accounts.json`,不要运行未验证的下载。

**B. 源码 + 脚本(需装 Node 22.13+,零 npm 依赖)** —— 开发/自更新首选,`git pull` 即拉最新。
双击 `start.bat`(见下),它生成 `.env` + 打印密钥 + 前台监督循环。

**C. 系统匣托盘(推荐,零黑窗)** —— 双击 `tray.vbs`,右下角系统匣出现图标,右键菜单【打开面板 / 复制面板密码 / 复制 API Key / 状态 / 重启 / 退出】。
`tray.ps1` **自动双模式**:同目录有 `windsurfapi.exe` → 启单 exe(零依赖,无需 Node);否则 → 启 `node src\index.js`(源码模式)。CI 打的 `windsurfapi-windows.zip` 就是「exe + 托盘脚本」同目录打包,解压双击 `tray.vbs` 即用。`.env`/`logs` 落在脚本(exe)同目录,与 `config.js` 的 `dirname(process.execPath)` 一致,密钥/数据同处。托盘内建崩溃监督(退出码 75/0 重启、连续 5 次异常停并弹窗)。

## 快速开始(源码方式)

1. **首次引导**:双击 `start.bat`。它会:
   - 校验 Node ≥ 22.13
   - 幂等生成项目根 `.env`(UTF-8 无 BOM),填缺失键:`PORT=3003`、`HOST=127.0.0.1`、强随机 `API_KEY` / `DASHBOARD_PASSWORD`、`DEVIN_CONNECT=1`
   - 打印两把密钥 + 面板地址 `http://127.0.0.1:3003/dashboard`
   - 进入前台监督循环(可 Ctrl-C 优雅停,最利首次调试)
2. **登录面板**:浏览器开 `http://127.0.0.1:3003/dashboard`,用打印出的 `DASHBOARD_PASSWORD` 登录,到 accounts 页加一个 Windsurf/Devin session token。
3. **装成开机自启后台**:`install-task.bat`(注册登录时计划任务,隐藏分离进程)。之后 `status.bat` 看状态,`stop.bat` 停,`uninstall-task.bat` 卸。

## 脚本清单

| 脚本 | 作用 |
|---|---|
| `start.bat` / `start.ps1` | 首次引导(生成 `.env`+密钥)+ 前台监督循环 |
| `run.ps1` | 监督循环内核(退出码路由 + pidfile + 日志 Tee) |
| `run.bat` | 已有 `.env`,直接跑前台监督循环 |
| `run-background.bat` / `run.vbs` | 一次性隐藏后台(不注册任务,不跨重启) |
| `install-task.bat` / `install-task.ps1` | 注册开机自启计划任务(主后台方案) |
| `uninstall-task.bat` | 移除计划任务 |
| `stop.bat` / `stop.ps1` | 停机(优雅优先,超时 `/F` 兜底)。所有权绑定:只动「命令行启动的脚本 ∈ 本目录」的监督者与代际吻合的 node,PID 复用/它装同名脚本一律不动手 |
| `ownership.psm1` | 所有权判定辅助模块(纯函数):监督者选择、代际校验、pidfile 元数据读写,供 stop/run/tray 共用 |
| `status.bat` / `status.ps1` | 状态(RUNNING/STOPPED + PID + 端口 + 日志尾) |
| `restart.bat` | 重启 |
| `update.bat` | `git pull --ff-only` 拉新码(解释执行不锁文件,无需先停) |
| `tray.vbs` / `tray.ps1` / `tray.bat` | 系统匣托盘(双模式:同目录有 exe 启 exe,否则启 node)+ 右键复制密码/API Key |
| `gen-icon.ps1` / `windsurfapi.ico` | 托盘 W 波浪图标(生成脚本 + 成品) |

## 退出码语义(⚠️ 与 KiroStudio 相反)

| 退出码 | 含义 | 监督动作 |
|---|---|---|
| **75** | 自更新/面板 Update 请求重启(`EX_TEMPFAIL`) | 重启,重置崩溃计数 |
| **0** | 优雅停机(Ctrl-C/SIGTERM,已抽干 SSE + 存盘) | 短暂可打断等待后重启(真实 Ctrl-C 会同时终结监督者,走不到重拉) |
| **1**/其它 | 崩溃 / 启动抛错 / 端口占用重试耗尽 | 退避重启,连续 5 次后红框停机打印日志尾 |

不可照抄 KS 的「0=重启」循环——WS 里 **75** 才是「请重启我」信号,漏接会让面板 Update 按钮卡死。

## Windows 特有注意

### 停止操作的身份范围

`stop.ps1` 只识别本仓库启动器实际使用的形式：PowerShell `-File` 后的本安装绝对 `run.ps1` / `start.ps1` / `tray.ps1`，以及 WScript/CScript 的本安装绝对 `run.vbs` / `tray.vbs`。任意 `-Command`、编码命令、相对路径和文件内容里的路径提及都不作为归属证明。计划任务必须只有一个 Exec action，且由 WScript/CScript 实际执行本安装 `run.vbs`；同名任务或参数子串均不足以停止它。

子进程票据保留原单行数字 `windsurfapi.pid`，并以 `windsurfapi.pid.meta` 记录 PID、CIM 创建时刻、安装根目录、source/exe 模式及唯一 receipt。发布与复验都使用 `Win32_Process.CreationDate` 的精确值，没有三秒身份容差。缺失、损坏、根目录或模式不匹配的 metadata 不退回父 PID 推断；旧版数字票据需要人工核对，正常重新启动后会生成新格式。

三个脚本通过同一 `windsurfapi.pid.lock` 串行化票据发布、读取与条件清理；清理只删除自己捕获的完整 receipt，保留并发启动的新票据。发出 `/F` 后必须再确认目标消失，查询失败或仍在运行时不宣称成功，也不删除票据。托盘同样在确认原 Process 对象退出前拒绝启动第二个实例。

限制：Windows 的 CIM 查询与随后按数字 PID 发出的 `Stop-Process` / `taskkill` 之间仍存在很短的非原子窗口；计划任务查询与 `/end` 也不是原子事务。这里缩小并校验每个动作前后的窗口，不声称具备操作系统级原子身份绑定。锁协议只协调这些启动脚本，不保护绕过协议直接改文件的外部写者。Windows 分发包必须同时携带 `ownership.psm1`；缺失时启动器在 spawn 前报错。

- **`.env` 用 UTF-8 无 BOM 写**(`start.ps1` 用 `UTF8Encoding($false)`)。`config.js` 的 `.trim()` 恰好能剥掉首键 BOM,但仍以无 BOM 为准。`.bat` 全 ASCII,中文只在 `.ps1`。
- **必须 `HOST=127.0.0.1`**:默认 `0.0.0.0` + 空 `API_KEY` = fail-closed 锁死(看似起来了实则 401)。
- **必须 `DEVIN_CONNECT=1`**:language_server 仅 Linux/macOS;不设则面板能开但每个 completion 静默失败。
- **`accounts.json` 原子写**:`taskkill /F` 不会截断它(tmp+rename),但优雅停更好(刷新池态 + 抽干在途)。监督者**阻塞等子进程完全退出再重启**,绝不用 `/F` 来「重启」。
