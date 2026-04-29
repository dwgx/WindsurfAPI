## v2.0.33 — 修 #93（上下文丢失）+ #96（路径循环）+ GLM5.1 沉默兜底

三个独立 fix 一起发，全是真 bug：

### 修 #93 — `claude-sonnet-4-6-thinking` 上下文会丢

zhangzhang-bit 贴的 debug log 里，**每次** CascadeChat 都是 `reuse=false`，cascadeId 每轮都换。msgs 从 33 涨到 97（20 多轮工具调用），但每次都是 fresh 上游 cascade session——模型 in-session 中间状态完全丢失，看起来就是"上下文会丢"。

**根因**：`shouldUseCascadeReuse()` 在 emulateTools=true 时只对 Opus 模型启用 reuse（通过 `isToolSensitiveOpusModel()`，正则只匹配 `^claude-opus-4(?:[.-]6|[.-]7)`）。Sonnet 4.6/4.7 全被排除，Claude Code 多轮工具场景下每次跑 fresh cascade。

**修法**：
- 加 `isToolEmulatedReusableModel()` 谓词，覆盖 Opus 4.6/4.7 + Sonnet 4.6（含 -thinking 变体）
- `shouldUseCascadeReuse()` 改用新谓词
- `shouldUseStrictCascadeReuse()` + multimodal-fallback 仍 Opus-only（这些是 Opus 特有 prompt-injection 防护）
- 加 env 开关 `WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE=1` 让用户回退老行为

新增 `test/chat-reuse.test.js`（24 条新测试覆盖 Sonnet/Opus/GPT × thinking × strict-reuse × env-disable 全矩阵）。

### 修 #96 — `…` 占位符让模型陷入"路径=…"循环

yangzailai 用 Sonnet 4.6 + Claude Code 在 `D:\000000\Project\Test`，问"我的项目路径"，模型答 `{"path":"…"}`。之后用户继续问目录、文件，模型反复输出"项目路径是 …，让我查看其中的文件…路径是 ……路径是 …" 形成 UX 死循环。

**根因**：`REDACTED_PATH = '…'`（Unicode ellipsis）。sanitize.js 注释里写过 5 个之前 marker（`./tail` / `[internal]` / `<redacted-path>` / `(path redacted)` / `redacted internal path`）都因模型把它们当 shell 命令跑而失败，所以选 `…`——模型不会 `cd …` 形成 shell-loop。

但这次失败的是新模式：**模型不在 shell 跑 `…`，而是把 `…` 当成"路径答案"在 prose 里反复输出**。第 6 种失败模式。

**修法**（两部分一起改）：

1. **Marker 换成 `<workspace>`**：
   - 用户读到 `<workspace>` 立刻明白"LLM 看不到我的真实路径"
   - 还是不会形成 shell-loop（angle bracket 被 LLM 读作 placeholder syntax）
   - 仍然没有 shell metacharacter，survives JSON/SSE/shell 引号

2. **Tool preamble 加一行系统提示**（5 个 builder 全加）：
   > Your sandbox workspace path is hidden from the user; if asked for path/cwd, say real path unavailable; use relative/tool paths.
   
   模型看到这行就**知道不该把 marker 当答案输出**，应该直接告诉用户"我看不到你机器上的绝对路径，请用相对路径"。打断 echo loop。

更新了 sanitize.js 顶部 marker history 注释，记录第 6 种失败模式 + 为什么这次的方案是最低成本的修正。

新增 `test/sanitize-marker-no-loop.test.js`（marker shape regression：不能是 `…`、必须有结构 delimiter、必须 <16 字符、不能像绝对路径）。

### 修 GLM5.1 沉默 (#86 follow-up KLFDan0534)

KLFDan0534 报：claudecode/openclaw 用 GLM5.1，"不打印文字，只思考，看不到思考内容"。

**根因**：cascade 上游有时把 GLM 整个 response 打包进 `step.thinking` 而不是 `step.responseText`。`client.js:761-773` 把 `step.thinking` 路由到 `chunk.thinking`，proxy `chat.js:1834-1836` emit 成 SSE `reasoning_content`。但 Claude Code（和很多 OpenAI-style 客户端）默认隐藏 reasoning_content，只渲染 `content` deltas → **可见沉默**。

**修法**：加 `shouldFallbackThinkingToText()` helper，在 stream end + non-stream end 都接上：
- 非 reasoning 模型 + 只产出 thinking + 没 tool_calls → 把 thinking 提升到 content delta
- Guard 严格：reasoning 模型 / caller 显式请求 thinking / 已有文本 / 有 tool_calls → 都不触发

新增 `test/thinking-fallback-glm.test.js`（11 条覆盖 GLM/Kimi/Claude × thinking-requested × tool_calls × empty 全组合）。

### 本地实测

不只跑测试，还写了 `tmp/probe.mjs` import 真实模块跑端到端断言：

```
---  Marker probes ---
Unix workspace: "<workspace>"      ✓
Windows C: workspace: "<workspace>" ✓
Mixed sep: "<workspace>"            ✓
Plain text: "Hello world..."        ✓ (untouched)
---  Preamble hint check (GLM 5.1) ---
hint present: ✓
hint lines: ['Your sandbox workspace path is hidden from the user;...']

---  Helper probes ---
GLM5.1 thinking-only → true ✓
kimi-k2-thinking → false ✓ (real reasoning model, don't promote)
Sonnet thinking + tools reuse → true ✓
GPT-5 + tools reuse → false ✓
```

### 数字

- **测试**：v2.0.32 之前 373 → v2.0.33 现在 **390**（+17 / 0 失败）
- **suites**：78 → **79** (+1)
- **代码改动**：+339 / -68（3 个 commit）
- **API 不变**：所有现有客户端不受影响
- **依赖不变**：仍然 zero-dep
- **i18n guard**：✓ 全部通过
- **本地实测**：4 路径 marker probe + 4 helper probe + 全跑一遍单元测试

### Multi-stage codex orchestration 流程

```
Issue #93 (zhangzhang-bit, sonnet-4-6-thinking, reuse=false 死循环)
Issue #96 (yangzailai, "…" 字符 echo loop)
Issue #86 续 (KLFDan0534, GLM5.1 沉默)
        │
        ▼ 并行 dispatch 3 个 worker
┌─────────────────────────────────────────────────┐
│ Worker A (GPT-5.5 high): #93 sonnet reuse fix   │
│ — 加 isToolEmulatedReusableModel + env 开关     │
│ — 24 条 reuse routing 测试                       │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ Worker B (GPT-5.5 high): #96 marker + hint      │
│ — `…` → `<workspace>`                            │
│ — 5 preamble builder 加 hidden-path hint        │
│ — marker shape regression 测试                   │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ Claude: GLM5.1 silence fallback                  │
│ — shouldFallbackThinkingToText helper            │
│ — stream + non-stream 双路径接上                 │
│ — 11 条单元测试                                  │
└─────────────────────────────────────────────────┘
        │
        ▼ Claude 收 + 验证 + commit + merge + 实测
v2.0.33 ship
```

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- API 不变 / 依赖不变 / 旧客户端透明
- Sonnet 4.6 用户：多轮工具调用 cascade reuse 现在会启用，理论上模型上下文连续性大幅改善。如出现意外 reuse-related 错误（账号切换 / cascade not found），用 `WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE=1` 回退
- Claude Code 用户：被 sanitize 的工作区路径现在显示 `<workspace>` 而不是 `…`，模型也学会了"路径不可见就告诉用户用相对路径"
- GLM/Kimi 等非 reasoning 模型用户：上游若把 response 打包进 thinking，proxy 现在会 promote 成 content，claudecode 不再"沉默"
- 390/390 tests pass
