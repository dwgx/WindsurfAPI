# 严正声明：未经作者明确书面许可，严禁任何商业使用、转售、代部署或中转售卖

> 本项目目前仅供获准范围内使用。
> 未经作者明确书面授权，禁止将本项目用于商业用途、付费代部署、挂后台对外提供服务、包装成中转服务出售，或以任何形式转售。
> 对未经授权的商业使用与传播行为，作者保留公开说明、取证和追责的权利。


[Windsurf](https://windsurf.com)（原 Codeium）的 OpenAI 相容 API 代理服務。在 Linux 伺服器上無頭運行 Windsurf 的 AI 模型，透過標準 OpenAI API 端點對外提供服務。

## 特色功能

- **OpenAI 相容 API** — 直接替換 `/v1/chat/completions` 和 `/v1/models`，可搭配任何 OpenAI SDK 使用
- **59 個模型** — Claude、GPT、Gemini、DeepSeek、Grok、Qwen、Kimi 及 Windsurf SWE
- **多帳號池** — 多個 Windsurf 帳號輪詢負載均衡，自動錯誤追蹤與故障轉移
- **管理後台** — Web 介面管理帳號、代理配置、即時日誌、請求統計與封禁偵測
- **串流支援** — 完整 SSE 串流，相容 OpenAI 格式
- **智慧錯誤處理** — 區分模型級錯誤與帳號級錯誤，避免誤停帳號
- **零依賴** — 純 Node.js 實作，無需任何 npm 套件

## 快速開始

### 前置條件

- Node.js >= 20
- Windsurf Language Server 二進位檔（`language_server_linux_x64`）
- 一個 Windsurf 帳號（免費或付費）

### 安裝步驟

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# 放置 Language Server 二進位檔
mkdir -p /opt/windsurf
cp language_server_linux_x64 /opt/windsurf/
chmod +x /opt/windsurf/language_server_linux_x64

# 建立資料目錄
mkdir -p /opt/windsurf/data/db

# 設定環境變數（選填）
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

# 啟動
node src/index.js
```

伺服器預設監聽 `http://0.0.0.0:3003`。

### 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `PORT` | `3003` | HTTP 伺服器埠號 |
| `API_KEY` | _（空）_ | `/v1/*` 端點的 API 密鑰（選填，留空不驗證） |
| `DEFAULT_MODEL` | `claude-4.5-sonnet-thinking` | 未指定模型時的預設值 |
| `MAX_TOKENS` | `8192` | 預設最大 token 數 |
| `LOG_LEVEL` | `info` | 日誌級別：`debug`、`info`、`warn`、`error` |
| `LS_BINARY_PATH` | `/opt/windsurf/language_server_linux_x64` | Language Server 路徑 |
| `LS_PORT` | `42100` | Language Server gRPC 埠號 |
| `DASHBOARD_PASSWORD` | _（空）_ | 後台密碼（選填，留空免密碼） |

## API 端點

### 聊天補全

```bash
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": false
  }'
```

### 列出模型

```bash
curl http://localhost:3003/v1/models
```

### 新增帳號

```bash
# 使用 Token（推薦）
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"token": "你的-windsurf-token"}'

# 使用 API Key
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"api_key": "sk-ws-..."}'

# 批次新增
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"accounts": [{"token": "token1"}, {"token": "token2"}]}'
```

### 帳號管理

```bash
# 列出帳號
curl http://localhost:3003/auth/accounts

# 刪除帳號
curl -X DELETE http://localhost:3003/auth/accounts/{id}

# 健康檢查
curl http://localhost:3003/health
```

## 支援的模型

<details>
<summary><b>Claude（Anthropic）</b> — 18 個模型</summary>

| 模型 | 供應商 | 方案 |
|---|---|---|
| claude-3.5-sonnet | Anthropic | 免費 |
| claude-3.7-sonnet | Anthropic | 免費 |
| claude-3.7-sonnet-thinking | Anthropic | 免費 |
| claude-4-sonnet / thinking | Anthropic | Pro |
| claude-4-opus / thinking | Anthropic | Pro |
| claude-4.1-opus / thinking | Anthropic | Pro |
| claude-4.5-sonnet / thinking | Anthropic | Pro |
| claude-4.5-haiku | Anthropic | Pro |
| claude-4.5-opus / thinking | Anthropic | Pro |
| claude-sonnet-4.6 / thinking | Anthropic | Pro |
| claude-opus-4.6 / thinking | Anthropic | Pro |

</details>

<details>
<summary><b>GPT（OpenAI）</b> — 16 個模型</summary>

| 模型 | 供應商 | 方案 |
|---|---|---|
| gpt-4o | OpenAI | Pro |
| gpt-4o-mini | OpenAI | 免費 |
| gpt-4.1 / mini / nano | OpenAI | Pro |
| gpt-5 / 5-mini | OpenAI | Pro |
| gpt-5.2（low / medium / high） | OpenAI | Pro |
| gpt-5.4（low / medium / high / xhigh） | OpenAI | Pro |
| gpt-5.3-codex | OpenAI | Pro |

</details>

<details>
<summary><b>Gemini（Google）</b> — 6 個模型</summary>

| 模型 | 供應商 | 方案 |
|---|---|---|
| gemini-2.5-pro | Google | Pro |
| gemini-2.5-flash | Google | 免費 |
| gemini-3.0-pro / flash | Google | Pro |
| gemini-3.1-pro（low / high） | Google | Pro |

</details>

<details>
<summary><b>其他</b> — 19 個模型</summary>

| 模型 | 供應商 |
|---|---|
| o3 / o3-mini / o3-high / o3-pro / o4-mini | OpenAI |
| deepseek-v3 / r1 | DeepSeek |
| grok-3 / grok-3-mini / grok-code-fast-1 | xAI |
| qwen-3 / qwen-3-coder | Alibaba |
| kimi-k2 / kimi-k2.5 | Moonshot |
| swe-1.5 / swe-1.5-thinking / swe-1.6-fast | Windsurf |
| arena-fast / arena-smart | Windsurf |

</details>

> **免費帳號可用模型：** `gpt-4o-mini` 和 `gemini-2.5-flash`。其餘模型需要 Windsurf Pro 訂閱。

## 管理後台

存取後台：`http://你的伺服器:3003/dashboard`

**功能面板：**
- **總覽** — 運行時間、帳號池狀態、Language Server 健康、請求成功率
- **帳號管理** — 新增/刪除/停用帳號，編輯標籤，重置錯誤計數
- **代理配置** — 全域及個別帳號的 HTTP/SOCKS5 代理設定
- **日誌檢視** — 透過 SSE 即時串流日誌，支援級別篩選
- **請求統計** — 按模型/帳號的指標統計、延遲追蹤、每小時圖表
- **封禁偵測** — 監控錯誤模式與帳號健康狀態

設定 `DASHBOARD_PASSWORD` 環境變數以保護後台。

## 架構

```
用戶端（OpenAI SDK / curl）
    |
    v
WindsurfAPI（Node.js HTTP 伺服器，埠號 3003）
    |
    v
Language Server（gRPC，埠號 42100）
    |
    v
Windsurf/Codeium 後端（server.self-serve.windsurf.com）
```

- **零 npm 依賴** — 僅使用 Node.js 內建模組
- **gRPC via HTTP/2** — 與 Language Server 二進位檔直接通訊
- **帳號池** — 輪詢選擇，自動錯誤追蹤與停用
- **持久化** — 帳號存至 `accounts.json`，統計存至 `stats.json`

## 部署

### PM2 常駐（推薦）

```bash
npm install -g pm2
pm2 start src/index.js --name windsurf-api
pm2 save
pm2 startup
```

### 重啟流程

> **重要：** 不要使用 `pm2 restart`，會產生殭屍程序。

```bash
pm2 stop windsurf-api
pm2 delete windsurf-api
fuser -k 3003/tcp 2>/dev/null
sleep 2
pm2 start src/index.js --name windsurf-api --cwd /root/WindsurfAPI
```

### 防火牆

```bash
# Ubuntu (ufw)
ufw allow 3003/tcp

# CentOS (firewalld)
firewall-cmd --add-port=3003/tcp --permanent && firewall-cmd --reload

# 雲伺服器記得在安全組中開放 3003 埠
```

## 授權

MIT
