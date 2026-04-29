## v2.0.28 — issue #91 本地凭证导入 + PR #90 follow-up + 登录验证

### 1. 新增：从本地 Windsurf 客户端导入凭证（issue #91）

如果你已经在本机装了 Windsurf 桌面客户端并登录过，dashboard 可以直接读取本地凭证生成账号，不用再跑一遍 OAuth 弹窗 / 输入 token。

**用法**：账号管理 → 添加账号区块 → 点「**从本地 Windsurf 导入**」按钮 → 列出找到的账号 → 点「导入」。

**支持的位置**：
- macOS: `~/Library/Application Support/{Windsurf,Windsurf - Next}/User/globalStorage/state.vscdb`
- Windows: `%APPDATA%\{Windsurf,Windsurf - Next,Windsurf-Next,Windsurf Insiders}\User\globalStorage\state.vscdb`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/{Windsurf,Windsurf - Next}/User/globalStorage/state.vscdb`
- Fallback: `~/.codeium/config.json`（CLI 工具用的）

**读取的字段**：从 `ItemTable` 表里抽 `windsurfAuthStatus`（主登录态）+ `codeium.windsurf-windsurf_auth.sessions`（VS Code SecretStorage 镜像里的 sessions），都是 JSON value，主要拿 `apiKey` / `email` / `name`。

**安全边界**：
- **严格 loopback only**：endpoint 检查 `req.socket.remoteAddress`，必须是 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`，**不**只看 bind host。公网部署也不会暴露这个 endpoint
- 仍然要求 dashboard auth（DASHBOARD_PASSWORD / API_KEY）；无 secret 时仅本机 bind 模式才放行
- 日志只写来源、字段名、masked key，不写原始 apiKey
- sqlite 文件先复制到 tmp 再读，避免 Windsurf 在跑时锁库
- API key 在前端 UI 显示是 masked（`sk-ws-01...cdef`），导入时通过现有 `/dashboard/api/accounts` 流程

**Node 版本**：用 `node:sqlite`（Node 22.5+ 自带）；Node 20 用户会得到清晰的 `sqlite_unavailable` 提示，可读 `~/.codeium/config.json` fallback。

**实测**：build 一个 fixture `state.vscdb` → 起 server → 调 endpoint → 返回 1 个账号，apiKey 正确，masked 正常。

### 2. PR #90 follow-up：proxy 校验顺序修正

PR #90 引入了 add account 时的 per-account proxy 配置，但实现里 proxy 校验发生在 account 创建之后，导致 proxy 校验失败时已经创建了账号但接口返回 400 → 用户重试 → 重复账号。

**修法**：把 proxy 解析 + 校验提到 `addAccountByKey/addAccountByToken` 之前。

```js
// before: account 已经存在了才校验 proxy
account = addAccountByKey(...)
if (body.proxy) { ...validate; setAccountProxy(account.id, parsed); }

// after: validate first, create account only if proxy ok
if (body.proxy) { ...validate; }   // 失败 return 400，不碰 account store
const account = body.api_key ? addAccountByKey(...) : await addAccountByToken(...)
if (parsedProxy) { setAccountProxy(account.id, parsedProxy); }
```

新增 `test/account-add-proxy-ordering.test.js` 4 条测试：
- bad proxy format → 0 account 创建
- private proxy + ALLOW_PRIVATE_PROXY_HOSTS=off → 0 account 创建
- 缺 api_key/token → 0 account 创建（先做 body shape 校验）
- 无 proxy → 1 account 正常创建

### 3. 登录"没反应" v2.0.26 修复独立验证

用户问「设密码登录没反应你解决了吗」。这次正式跑 codex 独立审计 + 端到端 decoy curl 实测。

**结论**：v2.0.26 修了。三种关键状态都返回正确 JSON shape：
```
no header        → {"required":true,"valid":false}     → UI: "密码不正确"
correct password → {"required":true,"valid":true}      → UI: 正常进入
wrong password   → {"required":true,"valid":false}     → UI: "密码不正确"
empty secret     → {"required":true,"valid":false,"locked":true} → UI: locked 提示
```

剩余次要风险（**不是回归**）：
- Enter 键并发提交（input 上 onkeydown 没检查 in-flight）
- 错密码无 rate limit（建议反代层限速）
- 旧 `localStorage.dp` 残留只弹 overlay 不主动清理

这些写到 backlog，不阻塞此次发布。

### Verification

- `node --test test/*.test.js`：**327/327 passing**（v2.0.27 → v2.0.28 新增 16 条）
- `node src/dashboard/check-i18n.js`：✓ 全部通过
- 端到端 decoy 实测 4 个 endpoint（auth ×3 + import-local ×2）

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- 纯 dashboard + 配置项扩展 —— Cascade / Anthropic / OpenAI API 不变
- 本地导入 endpoint 默认仅 loopback 可用 —— 公网部署完全不受影响
- Node 20 用户本地导入功能会 graceful 降级（提示 sqlite_unavailable）
