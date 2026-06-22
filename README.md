# 给我点 Star 和 Follow 我就不管你了

<p align="center">
  <a href="https://github.com/dwgx/WindsurfAPI/stargazers"><img src="https://img.shields.io/github/stars/dwgx/WindsurfAPI?style=for-the-badge&logo=github&color=f5c518" alt="Stars"></a>&nbsp;
  <a href="https://github.com/dwgx"><img src="https://img.shields.io/github/followers/dwgx?label=Follow&style=for-the-badge&logo=github&color=181717" alt="Follow"></a>
  &nbsp;·&nbsp;
  <a href="README.en.md">English</a>
</p>

# 声明

> **没点 Star 和 Follow 的**：严禁商业使用、转售、代部署、挂后台对外提供服务、包装成中转服务出售。
> **点了 Star 和 Follow 的**：随便用，我睁一只眼闭一只眼。
>
> 代码本体按 MIT License 开源（见 [LICENSE](LICENSE)），上面这段是作者个人态度。

---

把 [Windsurf](https://windsurf.com)（原 Codeium）的 AI 模型变成**两套标准 API 同时兼容**：

- `POST /v1/chat/completions` — **OpenAI 兼容** 任何 OpenAI SDK 直接用
- `POST /v1/messages` — **Anthropic 兼容** Claude Code / Cline / Cursor 直接连

**100+ 模型**：Claude 4.5/4.6/Opus 4.7 · GPT-5/5.1/5.2/5.4 全系 · Gemini 2.5/3.0/3.1 · Grok · Qwen · Kimi K2.x · GLM 4.7/5/5.1/5.2 · MiniMax · SWE 1.5/1.6 · Arena 等。零 npm 依赖 纯 Node.js。

## 它到底在干嘛

```
     ┌─────────────┐   /v1/chat/completions   ┌────────────┐
     │ OpenAI SDK  │ ──────────────────────→  │            │
     │ curl / 前端 │ ←──────────────────────  │            │
     └─────────────┘   OpenAI JSON + SSE      │ WindsurfAPI│
                                              │ Node.js    │      ┌──────────────┐       ┌─────────────────┐
     ┌─────────────┐   /v1/messages           │ (本服务)   │ gRPC │ Language     │ HTTPS │ Windsurf 云端   │
     │ Claude Code │ ──────────────────────→  │            │ ───→ │ Server (LS)  │ ────→ │ server.self-    │
     │ Cline       │ ←──────────────────────  │            │ ←─── │ (Windsurf    │ ←─── │ serve.windsurf  │
     │ Cursor      │   Anthropic SSE          │            │      │  binary)     │       │ .com            │
     └─────────────┘                          └────────────┘      └──────────────┘       └─────────────────┘
                                                    ↑
                                                账号池轮询
                                                速率限制隔离
                                                故障转移
```

**它做了什么**：
1. 一个 HTTP 服务（端口 3003）同时暴露 OpenAI 和 Anthropic 两套 API
2. 把请求翻译成 Windsurf 内部 gRPC 协议，通过本地 Language Server 发给 Windsurf 云
3. 维护账号池，自动轮询 + 速率限制 + 故障转移
4. 返回前把上游 Windsurf 身份剥掉，模型自称"我是 Claude Opus 4.6 由 Anthropic 开发"

## Claude Code / Cline / Cursor 怎么用

模型本身**不会**操作文件 — 文件操作是 IDE Agent 客户端（Claude Code / Cline 等）在本地执行的：

```
 你 "帮我改 bug"                Claude Code                    WindsurfAPI               Windsurf Cloud
   │                                │                               │                          │
   │────────────────────────────→  │                               │                          │
   │                                │  POST /v1/messages            │                          │
   │                                │  messages + tools + system    │                          │
   │                                │ ─────────────────────────────→│ 打包成 Cascade 请求      │
   │                                │                               │ ──────────────────────→  │
   │                                │                               │                          │
   │                                │                               │               模型思考 → 返回
   │                                │                               │               tool_use(edit_file)
   │                                │                               │ ←──────────────────────  │
   │                                │ ←── Anthropic SSE ────────────│                          │
   │                                │   content_block=tool_use      │                          │
   │                                │                               │                          │
   │                                │ 本地执行 edit_file()          │                          │
   │                                │ (读写本地文件)                │                          │
   │                                │                               │                          │
   │                                │ 带 tool_result 再发一轮       │                          │
   │                                │ ─────────────────────────────→│ ──────────────────────→  │
   │                                │                                             ... (循环) ...
   │                                │                               │                          │
   │  ← 最终答案                    │                               │                          │
```

**重点**：WindsurfAPI 只负责**传递** tool_use / tool_result，真正改文件的是客户端 CLI。

## 快速开始

### 一键部署

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI
bash setup.sh          # 建目录 · 配权限 · 生成 .env
node src/index.js
```

Dashboard：`http://你的IP:3003/dashboard`

### Docker 部署

```bash
cp .env.example .env

# 可选：提前把 language_server_linux_x64 放到 .docker-data/opt/windsurf/ 下
# 不放也行，容器首次启动时会自动下载到 /opt/windsurf/

docker compose up -d --build
docker compose logs -f
```

默认挂载：

- `./.docker-data/data`：持久化 `accounts.json`、`proxy.json`、`stats.json`、`runtime-config.json`、`model-access.json`、`logs/`
- `./.docker-data/opt/windsurf`：Language Server 二进制与数据目录
- `./.docker-data/tmp/windsurf-workspace`：临时工作区

如果想改持久化目录，可在 `.env` 里设置 `DATA_DIR`。Docker 默认已设为 `/data`。

### 一键更新

部署过之后要拉最新修复，一条命令搞定：

```bash
cd ~/WindsurfAPI && bash update.sh
```

`update.sh` 做了：`git pull` → 通过 `install-ls.sh` 更新 LS binary → 停 PM2 → kill 3003 端口残留 → 重启 → 健康检查。

如果你用的是我们的公网实例（`skiapi.dev` 之类），不用管，我们已经推过了。

### 手动安装

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# Language Server 二进制 —— 自动检测 Linux/macOS，一键下载 + chmod
bash install-ls.sh

# 默认安装路径：
#   Linux x64:          /opt/windsurf/language_server_linux_x64
#   Linux arm64:        /opt/windsurf/language_server_linux_arm
#   macOS Apple Silicon: $HOME/.windsurf/language_server_macos_arm
#   macOS Intel:        $HOME/.windsurf/language_server_macos_x64

# 如果想用本地已下好的 binary：
#   bash install-ls.sh /path/to/language_server_linux_x64
# 或者指定 URL：
#   bash install-ls.sh --url https://example.com/language_server_linux_x64

# ⚠️ 看不到 opus-4.7 / 其他新模型？
# Exafunction/codeium 公开 release 最新停在 v2.12.5（2026-01），不含 4.7。
# 要 4.7，把 Windsurf 桌面端本体里的 LS binary 拷过来：
#
#   macOS:   "$HOME/Library/Application Support/Windsurf/resources/app/extensions/windsurf/bin/language_server_macos_arm"
#   Linux:   "$HOME/.windsurf/bin/language_server_linux_x64"
#            或  /opt/Windsurf/resources/app/extensions/windsurf/bin/language_server_linux_x64
#   Windows: %APPDATA%\Windsurf\bin\language_server_windows_x64.exe
#
#   # 从本地桌面端装：
#   bash install-ls.sh /path/to/language_server_linux_x64
#
# LS binary 一换，/v1/models 立刻就能看到最新模型目录了（云端自动发现）。

cat > .env << 'EOF'
PORT=3003
API_KEY=
DEFAULT_MODEL=claude-4.5-sonnet-thinking
MAX_TOKENS=8192
LOG_LEVEL=info
LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64
LS_DATA_DIR=/opt/windsurf/data
LS_PORT=42100
DASHBOARD_PASSWORD=
EOF

# macOS 本地部署时，使用 install-ls.sh 打印的 LS_BINARY_PATH，
# 并把 LS_DATA_DIR 设到用户可写目录，例如 /Users/you/.windsurf/data。

node src/index.js
```

## 加账号

服务跑起来之后要先加 Windsurf 账号才能用，三种方式：

**方式 1 Dashboard 一键登录（推荐）**

打开 `http://你的IP:3003/dashboard` → 登录取号 → 点 **Google 登录** 或 **GitHub 登录**（OAuth 弹窗）或直接填邮箱密码。所有方式都会自动入池。

**方式 2 Token（任何登录方式都能用）**

去 [windsurf.com/show-auth-token](https://windsurf.com/show-auth-token) 复制 Token：

```bash
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"token": "你的token"}'
```

**方式 3 批量**

```bash
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"accounts": [{"token": "t1"}, {"token": "t2"}]}'
```

## 调用示例

### OpenAI 格式（Python / JS / curl）

```python
from openai import OpenAI
client = OpenAI(base_url="http://你的IP:3003/v1", api_key="你设的API_KEY")
r = client.chat.completions.create(
    model="claude-sonnet-4.6",
    messages=[{"role": "user", "content": "你好"}]
)
print(r.choices[0].message.content)
```

### Anthropic 格式（Claude Code 直接连）

```bash
export ANTHROPIC_BASE_URL=http://你的IP:3003
export ANTHROPIC_API_KEY=你设的API_KEY
claude                # 正常用 Claude Code 即可
```

```bash
# 裸 curl 测试
curl http://localhost:3003/v1/messages \
  -H "Authorization: Bearer 你的key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4.6","max_tokens":100,"messages":[{"role":"user","content":"你好"}]}'
```

### Cline / Cursor / Aider

在客户端配置里 **Custom OpenAI Compatible**：
- Base URL: `http://你的IP:3003/v1`
- API Key: 你设的 API_KEY
- Model: 任选我们支持的模型

> **Cursor 用户注意**：Cursor 客户端白名单会拦截含 `claude` 的模型名（请求根本不到后端）。用以下别名绕过：
>
> | 在 Cursor 填 | 实际模型 |
> |---|---|
> | `opus-4.6` | claude-opus-4.6 |
> | `opus-4.6-thinking` | claude-opus-4.6-thinking |
> | `opus-4.7` | claude-opus-4-7-medium |
> | `sonnet-4.6` | claude-sonnet-4.6 |
> | `sonnet-4.5` | claude-4.5-sonnet |
> | `haiku-4.5` | claude-4.5-haiku |
> | `ws-opus` | claude-opus-4.6 |
> | `ws-sonnet` | claude-sonnet-4.6 |
>
> GPT / Gemini / DeepSeek 等不受 Cursor 白名单限制，直接填原名。

## 环境变量

| 变量 | 默认值 | 干嘛的 |
|---|---|---|
| `PORT` | `3003` | 服务端口 |
| `API_KEY` | 空 | 调 API 要带的密钥 留空就不验证 |
| `DATA_DIR` | 项目根目录 | 持久化 JSON 状态和 `logs/` 的目录，Docker 推荐设成 `/data` |
| `DEFAULT_MODEL` | `claude-4.5-sonnet-thinking` | 不传 model 用哪个 |
| `MAX_TOKENS` | `8192` | 默认最大回复 token 数 |
| `LOG_LEVEL` | `info` | debug / info / warn / error |
| `LS_BINARY_PATH` | `/opt/windsurf/language_server_linux_x64` | LS 二进制位置 |
| `LS_DATA_DIR` | Linux: `/opt/windsurf/data`；macOS: `~/.windsurf/data` | 每个 proxy 独立的 LS 数据根目录 |
| `LS_PORT` | `42100` | LS gRPC 端口 |
| `LS_MAX_INSTANCES` | 内存自适应，最多 `20` | LS 池最大实例数；2GB VPS 建议 `2` |
| `LS_POOL_WAIT_MS` | `30000` | LS 池满且全部 active 时，新 proxy LS 最多等待这么久再返回 `LS_POOL_EXHAUSTED` |
| `LS_SPAWN_MIN_AVAILABLE_BYTES` | `700MB` | 新增非 default LS 前要求的可用内存水位；低于该值会排队/拒绝，避免 OOM |
| `LS_MEMORY_GUARD` | `1` | 设 `0` 可关闭 LS 内存护栏（仅在你有外部 memory limit/监控时考虑） |
| `LS_IDLE_TTL_MS` | `1200000` | 非 default LS 空闲超过该时间自动停止；`0` 关闭 |
| `LS_IDLE_SWEEP_MS` | 自动推导 | LS 空闲回收扫描间隔 |
| `LS_PREWARM_DEFAULT` | `1` | 设为 `0` 可跳过启动时 default LS 预热，低内存/全 proxy 池改为首个真实请求再懒启动 |
| `LS_PREWARM_PROXIES` | `0` | 设为 `1` 才在启动时预热所有 proxy LS；默认按需启动。后台 scheduled probe / 预测 prewarm 只复用空闲常驻 LS，不会为了探测新开/等待/驱逐 LS |
| `LS_PREWARM_ON_ACCOUNT_ADD` | `0` | 设为 `1` 才在 Dashboard/批量导入/OAuth 添加账号后立即预热对应 LS；默认避免批量录入打爆内存 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE` | 空 | 仅用于 lab/远程执行灰度。`all_mapped` 仅在已 allowlist 的工具全部可映射时走 native bridge；`1` 为混合工具 partition 模式。不要把它当成本地 IDE 工具调用的通用修复 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS` | `Bash/shell_command/run_command` 语义族 | native bridge 工具 allowlist。默认只包含成熟的 Bash/run_command 路径；Read/Grep/Glob 和 WebSearch/WebFetch 必须显式加入 allowlist，再配合模型/账号/API key gate 小流量实测，仍不是生产默认 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS` / `PROVIDERS` / `ROUTES` / `CALLERS` / `ACCOUNTS` / `API_KEYS` | 空 | native bridge 灰度门。为空表示不限；设置后必须匹配才启用。`ACCOUNTS` 可填账号 id/email，`API_KEYS` 匹配调用方 API key 但不会把明文 key 传进 chat 逻辑 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF` | 空 | 设为 `1` 强制关闭 native tool bridge，优先级高于上面的开关 |
| `WINDSURFAPI_SPECIAL_AGENT_BACKEND` | 空 | 可选 lab-only special-agent 后端。设为 `devin-cli` 后，`swe-1.6` / `swe-1.6-fast` / `adaptive` / `arena-*` 不再走 direct Cascade，而是走 Devin CLI PoC；这不是普通 catalog 模型修复 |
| `DEVIN_CLI_PATH` | `devin` | Devin CLI 可执行文件路径；Docker/macOS 都需要自己安装或挂载，不是基础镜像硬依赖 |
| `DEVIN_CLI_MODE` | `print` | `print` 为 `devin -p` 保守模式；`acp` 为实验 ACP stdio 后端，使用账号池上游 Windsurf apiKey 认证，默认不全量启用 |
| `DEVIN_MAX_PROCS` | `1` | Devin CLI 最大并发进程数，避免 special-agent 路径把内存打爆 |
| `DEVIN_CLI_USE_ACCOUNT_POOL` | `1` | 默认从 WindsurfAPI 账号池取一个账号并把 apiKey 注入 `WINDSURF_API_KEY`；设 `0` 表示 Devin CLI 自己管理登录态 |
| `DASHBOARD_PASSWORD` | 空 | 后台密码 留空不设密码 |
| `ALLOW_PRIVATE_PROXY_HOSTS` | 空 | 设为 `1` 允许在代理测试和登录时使用内网 IP（如 `192.168.x.x`、`10.x.x.x`）。默认留空仅允许公网地址 |
| `CASCADE_REUSE_BY_CALLER` | `0` | 设为 `1` 启用 caller 级别回退复用。指纹未命中时，按 callerKey+model 回退到最近的 cascade。适合单用户 Claude Code 场景 |
| `CASCADE_POOL_MAX` | `500` | 对话池最大条目数。单用户场景设 `1`–`5` 即可，减少资源占用 |

## Dashboard 功能面板

打开 `http://你的IP:3003/dashboard`：

| 面板 | 功能 |
|---|---|
| **总览** | 运行状态 · 账号池 · LS 健康 · 成功率 |
| **登录取号** | Google / GitHub OAuth 一键登录 · 邮箱密码登录 · **测试代理** 按钮（实测出口 IP） |
| **账号管理** | 加 / 删 / 停用 · 探测订阅等级 · 看余额 · 封禁模型黑名单 |
| **模型控制** | 全局模型黑白名单 |
| **代理配置** | 全局或单账号的 HTTP / SOCKS5 代理 |
| **日志** | 实时 SSE 串流 · 按级别筛 · 每条 `turns=N chars=M` 诊断多轮 |
| **统计分析** | 时间范围 6h / 24h / 72h · 账号维度 · p50 / p95 延迟 |
| **实验性** | Cascade 对话复用 · **模型身份注入（每厂商可自定义 prompt）** |

## 支持的模型

主线 100+ 个静态模型 + Windsurf 雲端動態下發（`mergeCloudModels` 啟動時拉取最新）。完整列表查 `GET /v1/models`，或看 [GitHub Pages 模型清单](https://dwgx.github.io/WindsurfAPI/#models)（同步生成於 `src/models.js`）。

<details>
<summary><b>Claude（Anthropic）</b> — 21 个</summary>

claude-3.5-sonnet / 3.7-sonnet / thinking · claude-4-sonnet / opus / thinking · claude-4.1-opus · claude-4.5-haiku / sonnet / opus · claude-sonnet-4.6（含 1m / thinking / thinking-1m） · claude-opus-4.6 / thinking · **claude-opus-4.7-medium**

</details>

<details>
<summary><b>GPT（OpenAI）</b> — 55 个</summary>

gpt-4o · gpt-4.1 · gpt-5 全系（含 medium / high / codex） · **gpt-5.1 全系**（base / low / medium / high + fast + codex 全 6 變體） · **gpt-5.2 全系**（none / low / medium / high / xhigh + fast + codex 全 5 變體） · **gpt-5.4 全系**（base / mini × low/medium/high/xhigh） · o3 全系（base / mini / pro） · o4-mini

</details>

<details>
<summary><b>Gemini（Google）</b> — 9 个</summary>

gemini-2.5-pro / flash · gemini-3.0-pro / flash（minimal / low / medium / high 4 個 reasoning 等級） · gemini-3.1-pro（low / high）

</details>

<details>
<summary><b>开源 / 国产</b></summary>

**Kimi**: kimi-k2 / k2.5 / k2-6 / k2-7 · **GLM**: glm-4.7 / 5 / 5.1 / 5.2 · **Qwen**: qwen-3 · **Grok**: grok-3 / grok-3-mini-thinking / grok-code-fast-1 · **MiniMax**: minimax-m2.5

</details>

<details>
<summary><b>Windsurf 自家 + Arena</b></summary>

swe-1.5 / 1.5-fast / 1.6 / 1.6-fast · arena-fast · arena-smart

</details>

> `swe-1.6` / `swe-1.6-fast` / `adaptive` / `arena-*` 属于 special-agent 路径。direct Cascade 会报 unknown model UID / route 不通；默认不会假装可用。需要测试时显式开启 `WINDSURFAPI_SPECIAL_AGENT_BACKEND=devin-cli`，并安装/挂载 Devin CLI。当前 PoC 是 `devin -p` print 模式，默认拒绝 caller-local tools/media；ACP 工具桥接另做。

> **免费账号 entitled 模型**主要是 `gemini-2.5-flash`、`glm-4.7`、`glm-5` / `5.1`、`kimi-k2` / `k2.5` / `k2-6`、`qwen-3` 等开源系列；Claude / GPT 全系 + Opus 系列要 Pro。具体每个账号的 entitled 清单看 dashboard。
>
> **工具调用稳定性**（v2.0.82+ 实测）：Claude family 走 `<tool_use>` 协议最稳；GLM-4.7 / Kimi-K2.5 走 NLU 兜底 + 可选 retry 大部分 case 能调；GLM-5.1 在 cascade 后端不稳（经常空回复 textLen=0），proxy 救不动；GPT 在 cascade 协议层不传 tools[] schema 也救不全。Claude Code 调本地工具优先 `claude-haiku-4.5` / `claude-sonnet-4.6`。

## 架构要点

- **零 npm 依赖** 全走 `node:*` 内置 · protobuf 手搓（`src/proto.js`）· 下载即跑
- **账号池 + LS 池** 每个独立 proxy 一个 LS 实例 不混用
- **NO_TOOL 模式** `planner_mode=3` 关掉 Cascade 内置工具循环，避免 `/tmp/windsurf-workspace/` 路径泄漏
- **三层 sanitize** LS 内建工具结果过滤 · `<tool_call>` 文本解析 · 输出路径清洗
- **真实 token 计量** 从 `CortexStepMetadata.model_usage` 抓 Cascade 真实 `inputTokens` / `outputTokens` / `cacheRead` / `cacheWrite`，`prompt_tokens` 含 cacheWrite

## PM2 部署

```bash
npm install -g pm2
pm2 start src/index.js --name windsurf-api
pm2 save && pm2 startup
```

**不要**用 `pm2 restart`（会出僵尸进程），用一键更新脚本 `bash update.sh`。

## 防火墙

```bash
# Ubuntu
ufw allow 3003/tcp

# CentOS
firewall-cmd --add-port=3003/tcp --permanent && firewall-cmd --reload
```

云服务器记得去安全组开 3003。

## 常见问题

**Q: 登录报"邮箱或密码错误"**
A: 你是用 Google/GitHub 登录的 Windsurf 吧 那种账号没有密码。Dashboard 的登录取号面板现在直接支持 Google / GitHub OAuth 一键登录。

**Q: 模型说"我无法操作文件系统"**
A: 这是 **chat API**，不是 IDE agent。要让模型真的改文件，用 **Claude Code / Cline / Cursor / Aider** 之类的客户端 CLI，把它们的 API base URL 指向本服务就行。模型出 tool_use，客户端本地执行，再把 tool_result 发回来。上面的图有详细流程。

**Q: 上下文丢失 / 模型忘了前面说的**
A: 多账号轮询**不会**丢上下文 — 每次请求都重新打包完整 history 发给 Cascade。真正的原因通常是中转层（new-api 等）没把完整 `messages[]` 透传过来。在 Dashboard 日志面板看 `turns=N`：如果多轮对话但 `turns=1`，就是中转层在你之前就把历史丢了。

**Q: 长 prompt 超时**
A: 已修。cold stall 检测按输入长度自适应，长输入最多给 90s。

**Q: Claude Code 能用吗**
A: 能。`export ANTHROPIC_BASE_URL=http://你的API` + `export ANTHROPIC_API_KEY=你的key`。`/v1/messages` 支持 system + tools + tool_use + tool_result + stream + multi-turn 全套，已实测通过。

**Q: 免费账号能用什么模型**
A: 主要是 `gemini-2.5-flash`、`glm-4.7` / `5` / `5.1`、`kimi-k2` / `k2.5` / `k2-6`、`qwen-3` 这些开源系列。Claude family + GPT 全系 + Opus / Max / Thinking 高阶模型要 Pro entitlement。具体每个账号的 entitled 清单 dashboard 里看 — `model_not_entitled` 错误返回的 `available_in_pool` 字段也会列出账号池能用的。

**Q: 免费账号调工具稳吗**
A: 看模型。Claude family `<tool_use>` 协议训练扎实最稳（free 账号若 entitled 也是优选）；GLM-4.7 / Kimi-K2.5 走 NLU 兜底 + `WINDSURFAPI_NLU_RETRY=1` retry-with-correction 多数 case 能调；GLM-5.1 在 cascade 后端经常空回复 proxy 救不动；GPT 系列受 cascade 协议层限制（不传 OpenAI tools[] schema）也不稳。**Claude Code / Cline / Codex 调本地文件 / 跑命令优先 `claude-haiku-4.5` 或 `claude-sonnet-4.6`**。

**Q: 客户端显示“没有调用工具”，怎么排查**
A: 先看日志里的 `ToolRoute[...]`。它会列出客户端声明的工具、`tool_choice` 过滤后的有效工具、native bridge 映射/未映射工具、preamble 降级层级，以及 `tool_choice_none` / `forced_tool_not_declared` / `preamble_compacted` / `native_bridge_*` 等原因。`/v1/messages` 和 `/v1/responses` 的 server-side 工具（如 Anthropic advisor/code_execution，OpenAI file_search/mcp/computer_use）如果代理没有实现，会在翻译层丢弃；这类工具不是普通 function tool，不等于 WindsurfAPI 已经能替客户端执行。native bridge 也不是“本地 IDE 工具修复开关”：默认安全路径仍是 prompt/tool emulation，由客户端本地执行工具；native bridge 是让 Windsurf 远端 workspace 执行 Cascade 内置工具，只适合有模型/账号/API key gate 的小流量实验。

**Q: 31 个 trial 账号一会儿就全 unavailable**
A: 八成是用了周限模型 — `claude-opus-4-7-max` / `gpt-5.5-xhigh` / `claude-sonnet-4-7-thinking` 这类高 reasoning effort 变体每个账号每周只有 5 次配额，31 号 × 5 次 ≈ 150 次就到顶。换 `claude-sonnet-4.6` / `claude-haiku-4.5` daily 配额比较宽松。`docker logs windsurfapi-windsurf-api-1 | grep rate_limit` 看每个账号的 cooldown 字段验证。

**Q: All accounts temporarily rate-limited / IP-level cooldown 是不是代理坏了**
A: 通常不是。Windsurf 上游会对同一出口 IP + 同一模型的密集请求施加 cooldown，多个账号绑在同一出口时会一起被限流。WindsurfAPI 会停止继续烧账号并返回 `429 + Retry-After`；v2.0.140 起这个等待时间会按上游 `Resets in: 27m12s` 这类真实值返回，而不是固定提示 30 秒。解决方向是降并发、换更宽松模型、给账号绑定不同出口 IP，或者等上游 cooldown 到期。

**Q: free 账号是不是本地限制成 1 分钟 1 次**
A: 不是。本地 free tier RPM 默认是 10/min。你看到的 1/min 或一段时间后恢复，通常是 Windsurf 上游 free-tier 动态限频或模型 entitlement 限制。Dashboard 里看账号状态和模型可用清单；请求无权限模型时错误里的 `available_in_pool` 会列出当前账号池能用的模型。

**Q: context deadline exceeded / Client.Timeout 能靠调大 .env timeout 解决吗**
A: 不能。长 thinking / 长输出在约 236-243 秒断流，是 Windsurf provider/Cascade 单次 stream 窗口。WindsurfAPI 会把它标成 `upstream_deadline_exceeded` / `windsurf_provider_deadline`，并丢弃半截 Cascade 复用轨迹，避免下一轮上下文错乱。实际规避只能拆任务、降低 reasoning/max output，或换更快模型。

## 贡献者

特别感谢下面的朋友，他们提交过 PR 或系统性地审了代码，让这个项目变得更稳：

- [@dd373156](https://github.com/dd373156) — [PR #1](https://github.com/dwgx/WindsurfAPI/pull/1)
  修复 Pro 层级的模型合并逻辑：原本只看硬编码清单，云端动态拉回来的模型没进 tier 表，Pro 账号在 Cursor / Cherry Studio 里看不到新上线的模型。
- [@colin1112a](https://github.com/colin1112a) — [PR #13](https://github.com/dwgx/WindsurfAPI/pull/13)
  一次性审了 15 个安全 / 并发 / 资源管理 bug：XSS 转义、shell 注入、OOM 防护、auth 路由位置、gRPC 双回调、LS pool 竞态、HTTP/2 帧大小上限等。后续我们在这个基础上又加固了 JS-level `escJsAttr`、`_pending` 合并并发 `ensureLs`、LS 退出时释放 pooled session，并延伸修了 Antigravity 审计发现的 6 个问题。
- [@baily-zhang](https://github.com/baily-zhang) — [PR #36](https://github.com/dwgx/WindsurfAPI/pull/36) + [PR #45](https://github.com/dwgx/WindsurfAPI/pull/45)
  Cascade reuse 的核心修复：stableTurns 指纹匹配 (#36) 解决了 0% 命中率；trajectory offset 增量拉取 (#45) 消除了多轮复用时的上下文膨胀。
- [@aict666](https://github.com/aict666) — [PR #44](https://github.com/dwgx/WindsurfAPI/pull/44)
  修复 chat 调用后 inferTier 把 Pro/Trial 账号降级为 free 的 bug，保护了 GetUserStatus 设定的权威 tier。
- [@smeinecke](https://github.com/smeinecke) — [PR #43](https://github.com/dwgx/WindsurfAPI/pull/43)
  Dashboard 完整国际化：14 个 commit 覆盖中英文翻译、I18n 系统、check-i18n.js 校验工具。
- [@you922](https://github.com/you922) — [PR #162](https://github.com/dwgx/WindsurfAPI/pull/162) + [PR #163](https://github.com/dwgx/WindsurfAPI/pull/163)
  Sticky session 机制从零搭建（callerKey + modelKey → accountId 绑定）+ LS 崩溃指数退避自动重启。另外在 #164 提供了 SectionOverrideConfig 工具调用失效的源码级根因分析。
- [@Fermiz](https://github.com/Fermiz) — [PR #181](https://github.com/dwgx/WindsurfAPI/pull/181)
  Cascade 复用优化（单用户场景跳过轮询）+ HTTPS 代理层 + conversation-pool 大小可配置化。
- [@linqichenggg](https://github.com/linqichenggg) — [PR #175](https://github.com/dwgx/WindsurfAPI/pull/175)
  Windows / macOS / Linux 三平台 LS 路径统一：二进制路径、数据目录、安装脚本全部对齐。
- [@lauvww](https://github.com/lauvww) — [PR #182](https://github.com/dwgx/WindsurfAPI/pull/182)
  Dashboard 批量导入解析器重写：支持 JSON / CSV / 纯文本混合粘贴，自动检测分隔符。
- [@ucloudnb666](https://github.com/ucloudnb666) — [PR #184](https://github.com/dwgx/WindsurfAPI/pull/184)
  Astraflow 第三方提供商接入。
- [@datfooldive](https://github.com/datfooldive) — [PR #173](https://github.com/dwgx/WindsurfAPI/pull/173)
  Dashboard UI 大扫除：统一组件风格、优化卡片布局和响应式适配。
- [@The-five-stooges](https://github.com/The-five-stooges) — [PR #188](https://github.com/dwgx/WindsurfAPI/pull/188)
  Sticky session 流式路径修复 + body.user 多用户隔离机制 + stickyNoFallback / stickyBindByUserOnly 双开关。
- [@andya1lan](https://github.com/andya1lan) — [PR #192](https://github.com/dwgx/WindsurfAPI/pull/192)
  `update.sh` 通过 `install-ls.sh` 更新 LS binary，统一 WindsurfAPI / Windsurf 桌面 LS / Exafunction 下载链，并修复 macOS `grep -P` 兼容性。
- [@MatrixNeoKozak](https://github.com/MatrixNeoKozak) — [PR #195](https://github.com/dwgx/WindsurfAPI/pull/195)
  Dashboard API malformed JSON 现在返回 HTTP 400，不再用 200 包着 `ok:false`，让前端和自动化调用方能按状态码正确处理请求体格式错误。
- [@brandonedley](https://github.com/brandonedley) — [PR #201](https://github.com/dwgx/WindsurfAPI/pull/201)
  新增 GLM 5.2 和 Kimi K2.7 模型目录项，并同步 README / 英文 README / package 描述 / 模型 catalog 测试，给后续模型新增留下了代码、文档、测试一起更新的样板。

想加入这份名单？欢迎提 [issue](https://github.com/dwgx/WindsurfAPI/issues) 或 [pull request](https://github.com/dwgx/WindsurfAPI/pulls)。Dashboard 左侧有"致谢"面板 能看到同样的信息。

## 授权

MIT License. See [LICENSE](LICENSE).

## Release and Secret Boundary

Release automation may publish Docker images and GitHub Releases. Keep tokens, API keys, cookies, and provider credentials out of issues, pull requests, logs, and committed config. If a report needs authentication details, share only redacted metadata and reproduction steps.

## Star History

https://www.star-history.com/?type=date&repos=dwgx/WindsurfAPI
