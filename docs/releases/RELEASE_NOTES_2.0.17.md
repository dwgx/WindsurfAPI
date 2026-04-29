## v2.0.17 — 安全加固一波过：fail-closed auth、apiKey 脱敏、LS port 不再盲接管、gRPC 异常不再炸进程

这是 codex 全面审计 + 我审计 + codex 互审的产出，5 个 HIGH、1 个 MED 回归（v2.0.16 我自己埋的）、若干 LOW 一次性收掉。生产部署 154.40.36.22 是公网 IP，这些不修是真的危险。

This release closes a comprehensive security audit. Five HIGH, one MED regression I introduced in v2.0.16, several LOW. The proxy runs on a public IP in production; these were not theoretical.

### 改了什么 / What changed

**🔴 HIGH 1 — Default-allow when API_KEY missing**

`if (!config.apiKey) return true` 让 operator 忘配 key 时整个 API 全开放。改成：未配 key 时**仅在 localhost bind 才放行**，公网 bind 一律 fail closed。`crypto.timingSafeEqual` 取代 `===`。新增 `HOST` / `BIND_HOST` env 让 operator 显式选 localhost-only 部署。

`validateApiKey()` and `checkAuth()` no longer fail open when no secret is configured. They now only allow unauthenticated access on localhost binds (`127.0.0.1`, `::1`, `::ffff:127.0.0.1` mapped form). `0.0.0.0` / `::` / public IPs fail closed. `crypto.timingSafeEqual` replaces `===` for secret comparison. New `HOST` / `BIND_HOST` env var lets operators explicitly choose localhost-only.

**🔴 HIGH 2 — `/auth/accounts` and `/dashboard/api/accounts` returned full upstream apiKey**

`getAccountList()` 现在返 `apiKey_masked: '<8 chars>...<4 chars>'`，不再返完整 key。新增 `getAccountInternal(id)` 仅供需要原始 key 的内部路径（rate-limit check、token refresh、`POST /account/:id/reveal-key`）使用。Dashboard UI 加 "click to reveal & copy" 按钮，触发显式 reveal-key 流程而不是被动 listing。

Account listing endpoints no longer leak the raw upstream apiKey. New `getAccountInternal(id)` is the only path that returns the raw key, behind dashboard auth and used only by rate-limit / token refresh / the explicit `/account/:id/reveal-key` endpoint. Dashboard UI now has a "click to reveal & copy" affordance instead of embedding the full key in the listing HTML.

**🔴 HIGH 3 — Dashboard write API default-allow**

同 HIGH 1 — `checkAuth()` 在 `dashboardPassword` 和 `apiKey` 都未配置时之前直接 `return true`，现在 fail closed unless localhost。`/dashboard/api/auth` GET 在公网 bind + 无 secret 配置时返 `{ required: true, locked: true }`，UI 知道服务被锁了应该提示 operator 去设环境变量，而不是傻傻 prompt 一个永远验证不过的密码。

**🔴 HIGH 4 — gRPC frame parser exception crashed Node**

`StreamingFrameParser.drain()` 抛异常时，原代码没在 `req.on('data', ...)` event handler 里 catch，**Node 默认把 unhandled error 当 process crash**。包了 try/catch，路由到 `onError`，关 HTTP/2 stream（`NGHTTP2_CANCEL`）。Connect 逻辑错误 frame 也补上 stream close（之前只 onError 不 close 是资源泄漏）。Unary path 的 `parser.drain()` 同样 try/catch。Connect 帧 gzip 解压失败原本静默 `continue` 吃掉数据，现在抛错让上层处理。

Wrapped `connectParser.push()` + `drain()` in try/catch in `grpcStream` and the unary `parser.drain()` in `unaryCall`. Connect logical-error frames now close the upstream HTTP/2 stream in addition to calling `onError`. Frame-level gzip decompression failures throw instead of silently dropping the frame. Non-Connect streaming path also got a 100MB pendingBuf cap.

**🔴 HIGH 5 — LS port adoption was credential-exfil vector**

旧逻辑：proxy 启动时如果 LS 默认端口 42100 已被占用，**直接当 LS 用**，把账号 protobuf 元数据（包含 apiKey）发过去。任何本地恶意进程先抢 42100 即可窃取账号 key。codex 第一版加了 gRPC-shape probe，但 codex 第二审实测 `server: custom-grpc-decoy` 这一行 nginx 配置就能骗过去（公开源码 + 公开 CSRF）。

**v2.0.17 完全禁用接管** —— 默认端口被占就跳到下一个空闲端口起新 LS。代价是 PM2 重启场景偶尔残留 orphan LS 进程，operator 需 `pkill -f language_server` 清理；换来"本地恶意/意外进程不再能拿到账号 key"。`probeLanguageServerPort` 函数仍 export 出去（未来如果设计出非 spoofable 校验可以重新启用）。

Removed blind LS port adoption entirely. If 42100 is occupied, the proxy walks to the next free port and spawns a fresh LS there. Any probe-based adoption is spoofable by a local HTTP/2 service emitting a `server: *grpc*` header. The "adopt the orphan" convenience is gone; the public-IP attack vector with it.

**🟡 MED 6 — schema-compact tier dropped `additionalProperties` (object) and `$ref/$defs`**

我在 v2.0.16 ship 了 `stripSchemaDocs` 用 KEEP allowlist，把 schema 内部的 `description` / `title` 等文档字段剥掉。结果**也把 `additionalProperties`（object 形态，描述 dict 值类型）和 `$ref/$defs` 一并剥了** —— map 工具和带 `$ref` 的工具都丢 schema。

修法：
- `additionalProperties`：保留 `false` 和 object 形态，仅丢 `true` / 缺省（默认值）
- `$ref`：在 strip 前 inline-resolve `#/$defs/Foo` → 替换成实际 schema，sibling 字段保留
- 循环引用：替换成 `{type: 'object'}` 占位（之前 codex 第一版留 `{$ref: '...'}` 但 `$defs` 已被 strip 导致 dangling pointer）

`stripSchemaDocs` now keeps `additionalProperties` when it is `false` or an object schema, drops only the default `true` form. `$ref` is inline-resolved against `$defs`/`definitions` before stripping. Cycles replace the recursive edge with a `{type: 'object'}` placeholder so output never contains a dangling `$ref`.

**🟢 LOW 7-9 — Bearer parsing / forbidden-words coverage / safeEqualString DRY**

- `extractToken()` 大小写不敏感（`bearer` / `Bearer` / `BEARER` 都接受）、拒绝逗号折叠的多 Authorization、不再把任意 raw Authorization 当 key
- `tool-preamble-forbidden-words` 测试扩展到 v2.0.16 新增的 `buildSchemaCompactToolPreambleForProto` 和 `buildSkinnyToolPreambleForProto`
- `safeEqualString` 提到 `auth.js` export，`dashboard/api.js` 删除复制，统一一处实现

### 验证 / Verification

- `node --test "test/*.test.js"`: **269/269 passing** (v2.0.16 的 253 + 本版新增 16)
- 新增测试覆盖：
  - `auth-warning.test.js`: 4 条断言 — fail-closed when missing API_KEY, IPv4-mapped IPv6 loopback, masked listing, timing-safe compare
  - `dashboard-api.test.js`: 3 条 — fail-closed dashboard write on non-local, allow on local, timing-safe header compare
  - `server-auth.test.js`: 3 条 token 提取 — case-insensitive Bearer, comma-fold rejection, x-api-key fallback
  - `langserver-redact.test.js`: 2 条 — `probeLanguageServerPort` 真起 HTTP/2 server 验证（probe 函数留着但 adoption 路径不用了）
  - `stream-error.test.js`: 1 条 — oversized Connect frame parser error 不抛 process crash
  - `tool-emulation.test.js`: 3 条 — `additionalProperties` 三态、$ref inline-resolve、cycle 占位（无 dangling $ref）
  - `tool-preamble-forbidden-words.test.js`: 扩展到两个新 tier

- 流程：
  1. codex 高 reasoning 跑全项目 8 大领域审计 → 找出 11 个 HIGH/MED + 若干 LOW
  2. 我筛 HIGH 5 个、MED 1 个回归（v2.0.16）、LOW 2 个进 v2.0.17 scope
  3. codex full-auto 做 8 个 fix → 268/268 测试 pass
  4. **codex 第二审 + 我并发审** → 比较两边覆盖度
  5. codex 第二审实测起 HTTP/2 decoy 验证 LS spoofability、追配置链路找到 `config.host` 没接进去的功能 break、找到 `autoAdd:false` 登录回归
  6. v2.0.17 这一版收掉所有 follow-up：LS 完全禁接管、`autoAdd:false` 流程恢复、Connect 错误 close、$defs cycle 占位、`/dashboard/api/auth` bind-aware 报告、IPv4-mapped IPv6 检测、`safeEqualString` DRY、加 dashboard reveal-key UI

### 配置变化 / Config changes

- 新增 `HOST` / `BIND_HOST` env：默认 `0.0.0.0`（向后兼容）。设 `127.0.0.1` 即 localhost-only。当未配置 `API_KEY` 也未配置 `DASHBOARD_PASSWORD` 时，**只有 localhost bind 仍允许免认证访问**；公网 bind fail closed，operator 必须显式配置 secret。
- Dashboard listing 不再有完整 apiKey 可点击复制。改为点击 masked key 触发 `POST /account/:id/reveal-key`，登录态 + 显式动作。
- LS port 占用时不再"接管"，自动找下一个端口起 LS。重启后端口可能漂移（42100 → 42101 → ...）— 不影响功能，operator 偶尔需 `pkill -f language_server` 清残留。

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`。
- **行为变化（重要）**：之前部署忘记配 `API_KEY` 又 bind 到 `0.0.0.0` 的 setup 升级后会 fail closed。**这是预期的安全改进** —— 没配 key 又公网监听本就不该开放。要么配 `API_KEY`，要么 `HOST=127.0.0.1`。
- 行为变化：`/auth/accounts` 和 `/dashboard/api/accounts` 字段从 `apiKey` 改为 `apiKey_masked`。如果你的脚本依赖 `apiKey` 字段，改用 `POST /account/:id/reveal-key` 显式获取。
- 行为变化：`POST /dashboard/api/windsurf-login` 当 `autoAdd: false` 时仍返回完整 `apiKey`（恢复 v2.0.16 之前行为）；`autoAdd: true` 时只返回 `apiKey_masked`。
- 269/269 tests pass。Zero npm dependencies, unchanged.
