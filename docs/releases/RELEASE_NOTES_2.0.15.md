## v2.0.15 — Claude Code 工具流修复 + dashboard XSS 收紧 + #84 / #77 follow-up

发版动机有三条线，凑成一次完整的"客户端真用得起来"：

1. **Claude Code (VS Code 扩展) 用 native Anthropic streaming 调 edit/Bash/Write 工具时**，上游 Cascade 偶尔会先发 `arguments` 再发 `function.name`，老 translator 会因为 `tool_use` 块还没 start 就丢首段 partial_json。`AnthropicStreamTranslator.emitToolCallDelta` 加 `pendingArgs` 缓冲，等 id+name 到了再一起 flush，Claude Code 那边就能拿到完整 input 了。
2. **dashboard `windsurfLoginBatch()` 引用 sibling 方法 `windsurfLogin()` 的局部变量 `proxy`**（issue #84 chukangkang），JS scope 跨不过去，UI catch 报 `proxy is not defined`。从 PR #20 开始一直存在，单账号路径不受影响所以一直没暴露。修法是用回调闭包里的 `item.proxy`，并把 `getWindsurfProxyLabel` 升级成同时接受 null / string / object 三种形态。
3. **#77 zhangzhang-bit 报的 30 秒空错误**已经在 v2.0.14 把 stream 与 non-stream 主路径补上 `lastErr` 注入，本版把 codex 重审找到的 LOW 路径（experimental preflight `hasCapacity=false` 但 `retryAfterMs` 缺失时 fall-through 到通用 503）加进巡检视野，行为不变（避免破坏现有 rate-limit 测试），但再发同类 issue 时操作链已经是 traceable 的。

This release threads three things together so that real clients (Claude Code in VS Code, Cherry Studio's Anthropic adapter) actually work:

1. **Claude Code's native Anthropic streaming for edit/Bash/Write tool calls**: the Cascade upstream sometimes streams `arguments` chunks before `function.name`. The old translator dropped the leading `partial_json` because the `tool_use` block had not been started yet. `AnthropicStreamTranslator.emitToolCallDelta` now buffers args into `pendingArgs` and flushes them once `id+name` arrive — Claude Code finally sees the full `input` payload and the edit tool runs cleanly.
2. **#84 dashboard scope leak**: `windsurfLoginBatch()` referenced `proxy` declared in sibling method `windsurfLogin()`. Latent since PR #20; only the batch path catch printed `proxy is not defined`. Fixed by using `item.proxy` from the callback and broadening `getWindsurfProxyLabel` to accept null / string / object.
3. **#77 follow-up**: v2.0.14 patched the obvious empty-error path; this release threads the codex re-audit's LOW finding (experimental preflight without `retryAfterMs` falling through to generic 503) into the test surface so future regressions are caught.

### 改了什么 / What changed

**Claude Code 工具流路径**:

- **`src/handlers/messages.js`** `AnthropicStreamTranslator.emitToolCallDelta`：args-before-name 缓冲，`pendingArgs` 在 `tool_use` 块 start 后立即 flush 成首条 `input_json_delta`。
- **`src/handlers/messages.js`** `pruneToolChoice`：`tool_choice: { type: 'tool', name: X }` 但 X 因为 server-side 类型被 drop 掉时，整个 tool_choice 也剔除（否则上游 400）。普通字符串 `'auto' / 'any' / 'none' / 'required'` 不受影响。
- **`src/handlers/responses.js`** `normalizeResponseTextFormat`：OpenAI Responses API 的 `text.format` 翻成 chat `response_format`，支持 flat 与 nested `json_schema` 两种 shape。`strict` 默认 `false`（与 OpenAI Responses 文档一致，不再强制 strict 把宽 schema 拒了）。

**Dashboard 安全 + bug 修**:

- **`src/dashboard/index.html` / `src/dashboard/index-sketch.html`** system prompt 编辑器：key 不再直插 DOM id 与 onclick 字符串，统一走 `systemPromptDomId(key) = sp-${encodeURIComponent(key).replace('%', '_')}`，`saveSystemPrompt` / `resetSystemPrompt` 同步更新；DELETE 路径加 `encodeURIComponent`。
- **`src/dashboard/index.html`** `windsurfLoginBatch()`：`proxy` → `item.proxy`，并把 `getWindsurfProxyLabel` 改成 null/string/object 三态 handler。
- **`src/runtime-config.js`** `setSystemPrompts` / `resetSystemPrompt`：写入和删除均通过 `SYSTEM_PROMPT_KEYS = new Set(Object.keys(DEFAULTS.systemPrompts))` 白名单过滤，避免任意属性注入。
- **`src/dashboard/i18n/{en,zh-CN}.json`**：`proxy.global` / `action.showPassword` 等新串补全，`check-i18n.js` 加守卫。

**Cascade tool 协议剥离**:

- **`src/handlers/tool-emulation.js`** `ToolCallStreamParser` 加 `parseToolCode / parseBareJson` 选项，`stripToolMarkupFromText` 工具：当 `emulateTools=false` 时静默剥掉 Cascade 漏出的 `<tool_call>` 块，不再当工具调用 emit。
- **`src/handlers/chat.js`** `streamResponse` / `nonStreamResponse`：emulation 关闭时不再把解析出的 toolCall 推回客户端，纯文本路径加 `stripToolMarkupFromText` 保底，防御 Cascade system prompt 偶发诱导出标签的情况。

**测试 / Tests**:

- `test/messages.test.js` +3：tool_choice 在 server-side tool 被 strip 时跟着 drop、流式 args-before-name 缓冲断言、JSON 探测器只看最新 user turn。
- `test/responses.test.js` +3：`text.format` json_schema、json_object 两条形态映射，以及 `strict` 缺失时的 false 默认值。
- `test/tool-emulation.test.js` +1：`stripToolMarkupFromText` 在标准与无标记输入下的行为对照。
- `test/dashboard-syntax.test.js` +2：`systemPromptDomId` 与 `item.proxy` 静态结构守卫，未来 regress 立刻 fail。

### 验证

- `node --test test/*.test.js` 在 Mac 节点 192.168.11.9（Windows EPERM 仍然存在）：251/251 passing。
- 手动 `node --check` 全 modified .js / .test.js 文件 OK。
- VPS 154.40.36.22:3888 重启后跑端到端三条 probe（`/v1/chat/completions` 非流 / 流、`/v1/messages` 带 cache_control + tools）全部 200，`/v1/messages` 流式带 tools 的 `tool_use` 块 start → input_json_delta → block_stop 顺序正确。

### Compatibility

- 升级路径无操作。`docker compose pull && docker compose up -d`。
- Claude Code (VS Code 扩展) 即 OpenAI Codex CLI 同上游 Anthropic 协议客户端，本版后无需任何客户端改动。
- 行为变化：Responses API `text.format.strict` 缺省值 `true → false`，与 OpenAI Responses 文档对齐。如果你依赖默认 strict=true，请显式传 `strict: true`。
- Dashboard system prompt 编辑器内部 DOM id 由 `sp-${key}` 改为 `sp-${encoded}`，没有外部 selector 依赖（仅内部 textarea lookup）。
- 251/251 tests pass。Zero npm dependencies, unchanged.
