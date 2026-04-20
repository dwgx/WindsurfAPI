# 給我點 Star 和 Follow 我就不管你了

<p align="center">
  <a href="https://github.com/dwgx/WindsurfAPI/stargazers"><img src="https://img.shields.io/github/stars/dwgx/WindsurfAPI?style=for-the-badge&logo=github&color=f5c518" alt="Stars"></a>&nbsp;
  <a href="https://github.com/dwgx"><img src="https://img.shields.io/github/followers/dwgx?label=Follow&style=for-the-badge&logo=github&color=181717" alt="Follow"></a>
</p>

# 严正声明：未经作者明确书面许可，严禁任何商业使用、转售、代部署或中转售卖

> 本项目目前仅供获准范围内使用。
> 未经作者明确书面授权，禁止将本项目用于商业用途、付费代部署、挂后台对外提供服务、包装成中转服务出售，或以任何形式转售。
> 对未经授权的商业使用与传播行为，作者保留公开说明、取证和追责的权利。

---

把 [Windsurf](https://windsurf.com) 的 AI 模型變成標準 OpenAI API 用

簡單說就是在 Linux 上跑一個 Windsurf 的 Language Server 然後把它包成 `/v1/chat/completions` 接口 任何支持 OpenAI API 的客戶端都能直接接

**107 個模型** Claude Opus/Sonnet GPT-5 Gemini DeepSeek Grok Qwen Kimi 都有 零 npm 依賴 純 Node.js

## 一鍵部署

整個過程就三步 拉代碼 放二進位 跑起來

```bash
# 1. 拉代碼
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# 2. 初始化環境（自動建目錄 設權限 生成配置）
bash setup.sh

# 3. 跑起來
node src/index.js
```

跑起來之後打開 `http://你的IP:3003/dashboard` 就是管理後台

## 手動安裝

不想用腳本的話自己來也很簡單

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# Language Server 二進位放到這裡
mkdir -p /opt/windsurf/data/db
cp language_server_linux_x64 /opt/windsurf/
chmod +x /opt/windsurf/language_server_linux_x64

# 環境變數（可選 不建的話全走預設）
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

## 加帳號

服務跑起來之後要先加 Windsurf 帳號才能用

**方法一 Token（推薦）**

去 [windsurf.com/show-auth-token](https://windsurf.com/show-auth-token) 複製你的 Token 然後

```bash
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"token": "你的token貼這裡"}'
```

**方法二 後台操作**

打開 `http://你的IP:3003/dashboard` 在「登入取號」面板輸入郵箱密碼登入

> 用 Google / GitHub 第三方登入的帳號沒有密碼 只能用 Token 方式

**方法三 批次加**

```bash
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"accounts": [{"token": "token1"}, {"token": "token2"}]}'
```

## 用法

跟 OpenAI API 一模一樣

```bash
# 聊天
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "你好"}]}'

# 看有哪些模型
curl http://localhost:3003/v1/models

# 健康檢查
curl http://localhost:3003/health
```

用 Python 的話

```python
from openai import OpenAI
client = OpenAI(base_url="http://你的IP:3003/v1", api_key="隨便填")
r = client.chat.completions.create(
    model="claude-sonnet-4.6",
    messages=[{"role": "user", "content": "你好"}]
)
print(r.choices[0].message.content)
```

## 環境變數

| 變數 | 預設值 | 幹嘛的 |
|---|---|---|
| `PORT` | `3003` | 服務端口 |
| `API_KEY` | 空 | 調 API 要帶的密鑰 留空就不驗證 |
| `DEFAULT_MODEL` | `claude-4.5-sonnet-thinking` | 不傳 model 的時候用哪個 |
| `MAX_TOKENS` | `8192` | 預設最大回覆 token 數 |
| `LOG_LEVEL` | `info` | 日誌級別 debug/info/warn/error |
| `LS_BINARY_PATH` | `/opt/windsurf/language_server_linux_x64` | LS 二進位位置 |
| `LS_PORT` | `42100` | LS gRPC 端口 |
| `DASHBOARD_PASSWORD` | 空 | 後台密碼 留空不設密碼 |

## 支援的模型

總共 107 個 以下是主要的 實際列表以 `/v1/models` 返回為準

<details>
<summary><b>Claude（Anthropic）</b> — 20 個</summary>

| 模型 | 方案 |
|---|---|
| claude-3.5-sonnet / 3.7-sonnet / 3.7-sonnet-thinking | 免費 |
| claude-4-sonnet / opus（含 thinking） | Pro |
| claude-4.1-opus / thinking | Pro |
| claude-4.5-haiku / sonnet / opus（含 thinking） | Pro |
| claude-sonnet-4.6 / thinking / 1m / thinking-1m | Pro |
| claude-opus-4.6 / thinking | Pro |

</details>

<details>
<summary><b>GPT（OpenAI）</b> — 55+ 個</summary>

| 模型 | 方案 |
|---|---|
| gpt-4o / gpt-4o-mini | 免費（mini）/ Pro |
| gpt-4.1 / mini / nano | Pro |
| gpt-5 / 5-medium / 5-high / 5-mini | Pro |
| gpt-5.1 系列（含 codex / fast 變體） | Pro |
| gpt-5.2 系列（none / low / medium / high / xhigh + fast） | Pro |
| gpt-5.3-codex / gpt-5.4 系列 / gpt-5.4-mini 系列 | Pro |
| gpt-oss-120b | Pro |
| o3 / o3-mini / o3-high / o3-pro / o4-mini | Pro |

</details>

<details>
<summary><b>Gemini（Google）</b> — 9 個</summary>

| 模型 | 方案 |
|---|---|
| gemini-2.5-pro / flash | 免費（flash）/ Pro |
| gemini-3.0-pro / flash（含 minimal / low / high） | Pro |
| gemini-3.1-pro（low / high） | Pro |

</details>

<details>
<summary><b>其他</b></summary>

| 模型 | 供應商 |
|---|---|
| deepseek-v3 / v3-2 / r1 | DeepSeek |
| grok-3 / grok-3-mini / grok-3-mini-thinking / grok-code-fast-1 | xAI |
| qwen-3 / qwen-3-coder | Alibaba |
| kimi-k2 / kimi-k2.5 | Moonshot |
| glm-4.7 / glm-5 / glm-5.1 | Zhipu |
| minimax-m2.5 | MiniMax |
| swe-1.5 / 1.5-fast / 1.6 / 1.6-fast | Windsurf |
| arena-fast / arena-smart | Windsurf |

</details>

> 免費帳號只能用 `gpt-4o-mini` 和 `gemini-2.5-flash` 其他都要 Windsurf Pro

## 管理後台

打開 `http://你的IP:3003/dashboard` 長這樣

- **總覽** 運行狀態 帳號池 LS 健康 成功率
- **登入取號** 用郵箱密碼登入 Windsurf 拿 API Key
- **帳號管理** 加號 刪號 看狀態 探測訂閱等級
- **模型控制** 全域的模型黑白名單
- **Proxy 設定** 全域或單帳號的代理
- **日誌** 即時 SSE 串流 可以按級別篩
- **統計** 按模型按帳號看請求量 延遲 成功率
- **封禁偵測** 監控帳號有沒有被搞

設 `DASHBOARD_PASSWORD` 環境變數就能加密碼保護

## 架構

```
你的客戶端（curl / OpenAI SDK / 任何支援 OpenAI API 的東西）
    ↓
WindsurfAPI（Node.js HTTP 3003）
    ↓
Language Server（gRPC 42100）
    ↓
Windsurf 雲端（server.self-serve.windsurf.com）
```

零 npm 依賴 protobuf 手搓的 gRPC 走 HTTP/2 帳號池自動輪詢和故障轉移

## PM2 部署

```bash
npm install -g pm2
pm2 start src/index.js --name windsurf-api
pm2 save && pm2 startup
```

重啟的時候別用 `pm2 restart` 會出殭屍進程 用這個

```bash
pm2 stop windsurf-api && pm2 delete windsurf-api
fuser -k 3003/tcp 2>/dev/null
sleep 2
pm2 start src/index.js --name windsurf-api --cwd /root/WindsurfAPI
```

## 防火牆

```bash
# Ubuntu
ufw allow 3003/tcp

# CentOS
firewall-cmd --add-port=3003/tcp --permanent && firewall-cmd --reload
```

雲服務器記得去安全組開 3003

## 常見問題

**Q: 登入報「信箱或密碼錯誤」**
A: 你是用 Google/GitHub 登入的 Windsurf 對吧 那種帳號沒有密碼 去 [windsurf.com/show-auth-token](https://windsurf.com/show-auth-token) 拿 Token 用 Token 方式加

**Q: 模型說「我無法操作文件系統」**
A: 正常的 這是 chat API 不是 IDE 模型沒有文件操作能力

**Q: 長 prompt 超時了**
A: 長輸入需要更多處理時間 系統會根據輸入長度自動調整等待時間 最長到 90 秒

**Q: Claude Code 能用嗎**
A: 目前不行 Claude Code 用的是 Anthropic 自己的 API 格式 不是 OpenAI 格式 後面考慮加

**Q: 免費帳號能用什麼模型**
A: 只有 `gpt-4o-mini` 和 `gemini-2.5-flash` 其他全要 Pro

## 授權

MIT
