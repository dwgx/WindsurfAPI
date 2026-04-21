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

**107 个模型**：Claude Opus / Sonnet · GPT-5 全系 · Gemini 3.x · DeepSeek · Grok · Qwen · Kimi · GLM 等。零 npm 依赖 纯 Node.js。

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

### 一键更新

部署过之后要拉最新修复，一条命令搞定：

```bash
cd ~/WindsurfAPI && bash update.sh
```

`update.sh` 做了：`git pull` → 停 PM2 → kill 3003 端口残留 → 重启 → 健康检查。

如果你用的是我们的公网实例（`skiapi.dev` 之类），不用管，我们已经推过了。

### 手动安装

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# Language Server 二进制 —— 一键下载 + chmod（从 Exafunction/codeium releases）
mkdir -p /opt/windsurf/data/db
bash install-ls.sh

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
DEFAULT_MODEL=gpt-4o-mini
MAX_TOKENS=8192
LOG_LEVEL=info
LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64
LS_PORT=42100
DASHBOARD_PASSWORD=
EOF

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

## 环境变量

| 变量 | 默认值 | 干嘛的 |
|---|---|---|
| `PORT` | `3003` | 服务端口 |
| `API_KEY` | 空 | 调 API 要带的密钥 留空就不验证 |
| `DEFAULT_MODEL` | `claude-4.5-sonnet-thinking` | 不传 model 用哪个 |
| `MAX_TOKENS` | `8192` | 默认最大回复 token 数 |
| `LOG_LEVEL` | `info` | debug / info / warn / error |
| `LS_BINARY_PATH` | `/opt/windsurf/language_server_linux_x64` | LS 二进制位置 |
| `LS_PORT` | `42100` | LS gRPC 端口 |
| `DASHBOARD_PASSWORD` | 空 | 后台密码 留空不设密码 |

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

总共 107 个，以下是主要分类，实际列表以 `/v1/models` 返回为准：

<details>
<summary><b>Claude（Anthropic）</b> — 20 个</summary>

claude-3.5-sonnet / 3.7-sonnet / thinking · claude-4-sonnet / opus / thinking · claude-4.1-opus · claude-4.5-haiku / sonnet / opus · claude-sonnet-4.6（含 1m / thinking / thinking-1m） · claude-opus-4.6 / thinking

</details>

<details>
<summary><b>GPT（OpenAI）</b> — 55+ 个</summary>

gpt-4o · gpt-4o-mini · gpt-4.1 / mini / nano · gpt-5 / 5-medium / 5-high / 5-mini · gpt-5.1 全系（含 codex / fast） · gpt-5.2 全系（none / low / medium / high / xhigh + fast + codex） · gpt-5.3-codex · gpt-5.4 / 5.4-mini · gpt-oss-120b · o3 / o3-mini / o3-high / o3-pro / o4-mini

</details>

<details>
<summary><b>Gemini（Google）</b> — 9 个</summary>

gemini-2.5-pro / flash · gemini-3.0-pro / flash（含 minimal / low / high） · gemini-3.1-pro（low / high）

</details>

<details>
<summary><b>其他</b></summary>

deepseek-v3 / v3-2 / r1 · grok-3 / mini / mini-thinking / code-fast-1 · qwen-3 / 3-coder · kimi-k2 / k2.5 · glm-4.7 / 5 / 5.1 · minimax-m2.5 · swe-1.5 / 1.6（含 fast） · arena-fast / smart

</details>

> **免费账号**只能用 `gpt-4o-mini` 和 `gemini-2.5-flash`，其他需要 Windsurf Pro。

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
A: 只有 `gpt-4o-mini` 和 `gemini-2.5-flash`，其他全要 Pro。

## 贡献者

特别感谢下面的朋友，他们提交过 PR 或系统性地审了代码，让这个项目变得更稳：

- [@dd373156](https://github.com/dd373156) — [PR #1](https://github.com/dwgx/WindsurfAPI/pull/1)
  修复 Pro 层级的模型合并逻辑：原本只看硬编码清单，云端动态拉回来的模型没进 tier 表，Pro 账号在 Cursor / Cherry Studio 里看不到新上线的模型。
- [@colin1112a](https://github.com/colin1112a) — [PR #13](https://github.com/dwgx/WindsurfAPI/pull/13)
  一次性审了 15 个安全 / 并发 / 资源管理 bug：XSS 转义、shell 注入、OOM 防护、auth 路由位置、gRPC 双回调、LS pool 竞态、HTTP/2 帧大小上限等。后续我们在这个基础上又加固了 JS-level `escJsAttr`、`_pending` 合并并发 `ensureLs`、LS 退出时释放 pooled session，并延伸修了 Antigravity 审计发现的 6 个问题。

想加入这份名单？欢迎提 [issue](https://github.com/dwgx/WindsurfAPI/issues) 或 [pull request](https://github.com/dwgx/WindsurfAPI/pulls)。Dashboard 左侧有"致谢"面板 能看到同样的信息。

## 授权

MIT
