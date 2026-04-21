# Star & Follow me and I'll leave you alone

<p align="center">
  <a href="https://github.com/dwgx/WindsurfAPI/stargazers"><img src="https://img.shields.io/github/stars/dwgx/WindsurfAPI?style=for-the-badge&logo=github&color=f5c518" alt="Stars"></a>&nbsp;
  <a href="https://github.com/dwgx"><img src="https://img.shields.io/github/followers/dwgx?label=Follow&style=for-the-badge&logo=github&color=181717" alt="Follow"></a>
  &nbsp;·&nbsp;
  <a href="README.md">中文/简体中文</a>
</p>

# Notice

> **If you haven't starred and followed**: commercial use, resale, paid deployment, hosting as a backend for public services, or reselling as a relay service is strictly prohibited.
> **If you have starred and followed**: go ahead, I'll look the other way.
>
> The code itself is MIT-licensed (see [LICENSE](LICENSE)); the above is the author's personal stance.

---

Turns [Windsurf](https://windsurf.com) (formerly Codeium)'s AI models into **two standard, compatible APIs**:

- `POST /v1/chat/completions` — **OpenAI Compatible** for any OpenAI SDK.
- `POST /v1/messages` — **Anthropic Compatible** for direct connection with Claude Code / Cline / Cursor.

**107 Models**: Claude Opus / Sonnet · GPT-5 series · Gemini 3.x · DeepSeek · Grok · Qwen · Kimi · GLM, etc. Zero npm dependencies, pure Node.js.

## What is it doing?

```
     ┌─────────────┐   /v1/chat/completions   ┌────────────┐
     │ OpenAI SDK  │ ──────────────────────→  │            │
     │ curl / Frontend │ ←──────────────────────  │            │
     └─────────────┘   OpenAI JSON + SSE      │ WindsurfAPI│
                                              │ Node.js    │      ┌──────────────┐       ┌─────────────────┐
     ┌─────────────┐   /v1/messages           │ (This Service)   │ gRPC │ Language     │ HTTPS │ Windsurf Cloud  │
     │ Claude Code │ ──────────────────────→  │            │ ───→ │ Server (LS)  │ ────→ │ server.self-    │
     │ Cline       │ ←──────────────────────  │            │ ←─── │ (Windsurf    │ ←─── │ serve.windsurf  │
     │ Cursor      │   Anthropic SSE          │            │      │  binary)     │       │ .com            │
     └─────────────┘                          └────────────┘      └──────────────┘       └─────────────────┘
                                                    ↑
                                           Account Pool Round-Robin
                                            Rate Limit Isolation
                                                   Failover
```

**What it does**:
1. An HTTP service (port 3003) exposing both OpenAI and Anthropic APIs simultaneously.
2. Translates requests into Windsurf's internal gRPC protocol and sends them to the Windsurf cloud via a local Language Server.
3. Manages an account pool with automatic round-robin, rate limiting, and failover.
4. Strips the upstream Windsurf identity before returning, making the model identify as "I am Claude Opus 4.6, developed by Anthropic."

## How to use with Claude Code / Cline / Cursor

The model itself does **not** operate on files — file operations are executed locally by the IDE Agent client (Claude Code, Cline, etc.):

```
 You "Help me fix a bug"         Claude Code                    WindsurfAPI               Windsurf Cloud
   │                                │                               │                          │
   │────────────────────────────→  │                               │                          │
   │                                │  POST /v1/messages            │                          │
   │                                │  messages + tools + system    │                          │
   │                                │ ─────────────────────────────→│ Package into Cascade request │
   │                                │                               │ ──────────────────────→  │
   │                                │                               │                          │
   │                                │                               │               Model thinks → returns
   │                                │                               │               tool_use(edit_file)
   │                                │                               │ ←──────────────────────  │
   │                                │ ←── Anthropic SSE ────────────│                          │
   │                                │   content_block=tool_use      │                          │
   │                                │                               │                          │
   │                                │ Execute edit_file() locally   │                          │
   │                                │ (Read/write local files)      │                          │
   │                                │                               │                          │
   │                                │ Send another turn with tool_result │                          │
   │                                │ ─────────────────────────────→│ ──────────────────────→  │
   │                                │                                             ... (loop) ...
   │                                │                               │                          │
   │  ← Final answer                │                               │                          │
```

**Key Point**: WindsurfAPI is only responsible for **passing** `tool_use` / `tool_result`. The client CLI is what actually modifies the files.

## Quick Start

### One-Click Deployment

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI
bash setup.sh          # Create directories · Set permissions · Generate .env
node src/index.js
```

Dashboard: `http://YOUR_IP:3003/dashboard`

### One-Click Update

To pull the latest fixes after deployment, just run one command:

```bash
cd ~/WindsurfAPI && bash update.sh
```

`update.sh` does: `git pull` → stops PM2 → kills any residual process on port 3003 → restarts → health check.

If you are using our public instances (`skiapi.dev`, etc.), you don't need to do anything; we've already pushed the updates.

### Manual Installation

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# Language Server binary — one-click download + chmod (from Exafunction/codeium releases)
mkdir -p /opt/windsurf/data/db
bash install-ls.sh

# Or use a local binary you already have:
#   bash install-ls.sh /path/to/language_server_linux_x64
# Or specify a custom URL:
#   bash install-ls.sh --url https://example.com/language_server_linux_x64

# ⚠️ Can't see opus-4.7 / other new models?
# The public Exafunction/codeium release is stuck at v2.12.5 (Jan 2026)
# and does not ship 4.7. To get 4.7, copy the LS binary out of the
# Windsurf desktop app bundle:
#
#   macOS:   "$HOME/Library/Application Support/Windsurf/resources/app/extensions/windsurf/bin/language_server_macos_arm"
#   Linux:   "$HOME/.windsurf/bin/language_server_linux_x64"
#            or /opt/Windsurf/resources/app/extensions/windsurf/bin/language_server_linux_x64
#   Windows: %APPDATA%\Windsurf\bin\language_server_windows_x64.exe
#
#   # Install from the local desktop copy:
#   bash install-ls.sh /path/to/language_server_linux_x64
#
# Once swapped, /v1/models will auto-discover the newer catalog from the cloud.

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

## Add Accounts

After the service is running, you need to add Windsurf accounts. There are three ways:

**Method 1: Dashboard One-Click Login (Recommended)**

Open `http://YOUR_IP:3003/dashboard` → Login to get token → Click **Sign in with Google** or **Sign in with GitHub** (OAuth popup) or fill in email/password directly. All methods will automatically add the account to the pool.

**Method 2: Token (Works with any login method)**

Go to [windsurf.com/show-auth-token](https://windsurf.com/show-auth-token) to copy your token:

```bash
curl -X POST http://localhost:3003/auth/login 
  -H "Content-Type: application/json" 
  -d '{"token": "YOUR_TOKEN"}'
```

**Method 3: Batch**

```bash
curl -X POST http://localhost:3003/auth/login 
  -H "Content-Type: application/json" 
  -d '{"accounts": [{"token": "t1"}, {"token": "t2"}]}'
```

## Usage Examples

### OpenAI Format (Python / JS / curl)

```python
from openai import OpenAI
client = OpenAI(base_url="http://YOUR_IP:3003/v1", api_key="YOUR_API_KEY")
r = client.chat.completions.create(
    model="claude-sonnet-4.6",
    messages=[{"role": "user", "content": "Hello"}]
)
print(r.choices[0].message.content)
```

### Anthropic Format (Directly with Claude Code)

```bash
export ANTHROPIC_BASE_URL=http://YOUR_IP:3003
export ANTHROPIC_API_KEY=YOUR_API_KEY
claude                # Use Claude Code as usual
```

```bash
# Raw curl test
curl http://localhost:3003/v1/messages 
  -H "Authorization: Bearer YOUR_KEY" 
  -H "anthropic-version: 2023-06-01" 
  -d '{"model":"claude-opus-4.6","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'
```

### Cline / Cursor / Aider

In your client's settings for **Custom OpenAI Compatible**:
- Base URL: `http://YOUR_IP:3003/v1`
- API Key: YOUR_API_KEY
- Model: Choose any supported model.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3003` | Service port |
| `API_KEY` | empty | API key required for requests. Leave empty to disable validation. |
| `DEFAULT_MODEL` | `claude-4.5-sonnet-thinking` | The model to use if `model` is not specified. |
| `MAX_TOKENS` | `8192` | Default maximum number of response tokens. |
| `LOG_LEVEL` | `info` | debug / info / warn / error |
| `LS_BINARY_PATH` | `/opt/windsurf/language_server_linux_x64` | Path to the LS binary. |
| `LS_PORT` | `42100` | LS gRPC port. |
| `DASHBOARD_PASSWORD` | empty | Dashboard password. Leave empty for no password. |

## Dashboard Features

Open `http://YOUR_IP:3003/dashboard`:

| Panel | Features |
|---|---|
| **Overview** | Runtime status · Account pool · LS health · Success rate |
| **Login/Get Token** | Google / GitHub OAuth one-click login · Email/password login · **Test Proxy** button (tests egress IP) |
| **Account Management** | Add / Delete / Disable · Detect subscription level · Check balance · Ban models via blacklist |
| **Model Control** | Global model whitelist/blacklist |
| **Proxy Config** | Global or per-account HTTP / SOCKS5 proxy |
| **Logs** | Real-time SSE streaming · Filter by level · `turns=N chars=M` diagnostics per turn |
| **Stats & Analytics** | Time range 6h / 24h / 72h · Per-account dimensions · p50 / p95 latency |
| **Experimental** | Cascade conversation reuse · **Model Identity Injection (custom prompt per vendor)** |

## Supported Models

A total of 107 models. The following are the main categories; the actual list is based on the `/v1/models` response:

<details>
<summary><b>Claude (Anthropic)</b> — 20 models</summary>

claude-3.5-sonnet / 3.7-sonnet / thinking · claude-4-sonnet / opus / thinking · claude-4.1-opus · claude-4.5-haiku / sonnet / opus · claude-sonnet-4.6 (incl. 1m / thinking / thinking-1m) · claude-opus-4.6 / thinking

</details>

<details>
<summary><b>GPT (OpenAI)</b> — 55+ models</summary>

gpt-4o · gpt-4o-mini · gpt-4.1 / mini / nano · gpt-5 / 5-medium / 5-high / 5-mini · gpt-5.1 series (incl. codex / fast) · gpt-5.2 series (none / low / medium / high / xhigh + fast + codex) · gpt-5.3-codex · gpt-5.4 / 5.4-mini · gpt-oss-120b · o3 / o3-mini / o3-high / o3-pro / o4-mini

</details>

<details>
<summary><b>Gemini (Google)</b> — 9 models</summary>

gemini-2.5-pro / flash · gemini-3.0-pro / flash (incl. minimal / low / high) · gemini-3.1-pro (low / high)

</details>

<details>
<summary><b>Others</b></summary>

deepseek-v3 / v3-2 / r1 · grok-3 / mini / mini-thinking / code-fast-1 · qwen-3 / 3-coder · kimi-k2 / k2.5 · glm-4.7 / 5 / 5.1 · minimax-m2.5 · swe-1.5 / 1.6 (incl. fast) · arena-fast / smart

</details>

> **Free accounts** can only use `gpt-4o-mini` and `gemini-2.5-flash`. Others require Windsurf Pro.

## Architecture Highlights

- **Zero npm dependencies** Everything uses `node:*` built-ins · Protobuf is handcrafted (`src/proto.js`) · Download and run.
- **Account Pool + LS Pool** Each independent proxy gets its own LS instance, no mixing.
- **NO_TOOL Mode** `planner_mode=3` disables Cascade's built-in tool loop to prevent `/tmp/windsurf-workspace/` path leakage.
- **Three-layer sanitization** LS built-in tool result filtering · `<tool_call>` text parsing · Output path cleaning.
- **Real token counting** Fetches real `inputTokens` / `outputTokens` / `cacheRead` / `cacheWrite` from `CortexStepMetadata.model_usage`. `prompt_tokens` includes cacheWrite.

## PM2 Deployment

```bash
npm install -g pm2
pm2 start src/index.js --name windsurf-api
pm2 save && pm2 startup
```

**Do not** use `pm2 restart` (it can create zombie processes). Use the one-click update script `bash update.sh`.

## Firewall

```bash
# Ubuntu
ufw allow 3003/tcp

# CentOS
firewall-cmd --add-port=3003/tcp --permanent && firewall-cmd --reload
```

Remember to open port 3003 in your cloud provider's security group.

## FAQ

**Q: Login fails with "Invalid email or password"**
A: You probably signed up for Windsurf using Google/GitHub, which means your account doesn't have a password. The Dashboard's login panel now directly supports one-click login via Google / GitHub OAuth.

**Q: The model says "I cannot operate on the file system"**
A: This is a **chat API**, not an IDE agent. To have the model actually modify files, use a client CLI like **Claude Code / Cline / Cursor / Aider** and point their API base URL to this service. The model will produce `tool_use`, the client executes it locally, and sends the `tool_result` back. The diagram above shows the detailed flow.

**Q: Context is lost / The model forgets previous parts of the conversation**
A: Multi-account round-robin will **not** lose context — every request repackages the full history and sends it to Cascade. The real reason is usually a relay layer (like new-api) not passing the full `messages[]` array. Check `turns=N` in the Dashboard logs: if it's a multi-turn conversation but `turns=1`, then a layer before you has already dropped the history.

**Q: Long prompts are timing out**
A: This has been fixed. Cold stall detection is now adaptive to input length, with a max timeout of 90s for long inputs.

**Q: Can I use Claude Code?**
A: Yes. `export ANTHROPIC_BASE_URL=http://YOUR_API` + `export ANTHROPIC_API_KEY=YOUR_KEY`. `/v1/messages` supports the full suite: system, tools, tool_use, tool_result, stream, and multi-turn, all tested and working.

**Q: What models can free accounts use?**
A: Only `gpt-4o-mini` and `gemini-2.5-flash`. All others require Pro.

## Contributors

Huge thanks to the following folks who sent pull requests or systematically audited the code:

- [@dd373156](https://github.com/dd373156) — [PR #1](https://github.com/dwgx/WindsurfAPI/pull/1)
  Fixed the Pro tier model-merge logic: the hardcoded table wasn't picking up dynamically-fetched cloud models, so Pro accounts couldn't see newly-released models in Cursor / Cherry Studio.
- [@colin1112a](https://github.com/colin1112a) — [PR #13](https://github.com/dwgx/WindsurfAPI/pull/13)
  A single-shot audit that flagged 15 security / concurrency / resource bugs: XSS escaping, shell injection, OOM guards, auth route placement, gRPC double-callback, LS pool race, HTTP/2 frame size caps, and more. On top of this we later added a JS-level `escJsAttr`, coalesced concurrent `ensureLs` calls via `_pending`, released pooled sessions on LS exit, and fixed 6 more issues surfaced by a follow-up Antigravity audit.

Want to be on this list? Open an [issue](https://github.com/dwgx/WindsurfAPI/issues) or a [pull request](https://github.com/dwgx/WindsurfAPI/pulls). The dashboard has a Credits panel on the left that shows the same info.

## License

MIT
