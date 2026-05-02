## v2.0.66 — Cascade native bridge partition 模式：让 codex CLI 真命中（#115 续）

v2.0.65 的 native bridge ship 完，VPS 部署后拉日志一看 — `tools=15 emulateTools=true markers=none`，新代码路径 0 触发。原因：v2.0.65 的激活门槛 `canMapAllTools` 是「caller 声明的所有 tools 必须**全部**在 TOOL_MAP 里」all-or-nothing 严格模式，codex CLI 0.128 默认发 11 个工具（`shell_command` / `update_plan` / `request_user_input` / `apply_patch` / `web_search` / `view_image` / `spawn_agent` / `send_input` / `resume_agent` / `wait_agent` / `close_agent`），里头只有 `shell_command` 能干净映射到 cascade `run_command`，剩下 10 个让整体回退到老 emulation。生产里没有任何一个 codex CLI 请求过得了这道关。

零部署也不能算修。这版换 partition 模式：mapped 走 native trajectory + unmapped 同时走 emulation toolPreamble，两路并存。

### partition 设计

新 `partitionTools(tools)` 取代 `canMapAllTools` 当门：

```
codex CLI 0.128 默认 11 tools
  → mapped:   [shell_command]                                  ← cascade native
  → unmapped: [update_plan, request_user_input, apply_patch,
               web_search, view_image, spawn_agent, send_input,
               resume_agent, wait_agent, close_agent]           ← emulation toolPreamble
```

同一请求两条路并存：

- `CascadePlannerConfig.tool_config.tool_allowlist[32]` 只列 `[run_command]`，cascade DEFAULT planner 仅启用映射到的内置工具
- `additional_instructions_section[12]` 仍然 inject 那 10 个 unmapped tool 的 emulation toolPreamble，让模型知道这些工具，能 emit `<tool_call>` 文本块调它们
- v2.0.65 把 `toolPreamble` 在 `nativeMode=true` 时**强制清空**这条规矩取消了 — 现在两者并存

`shouldUseNativeBridge` 阈值从 `canMapAllTools(tools)` 改成 `partitionTools(tools).hasAny`。

### 改动

**`src/cascade-native-bridge.js`**：
- 新 `partitionTools(tools)` → `{mapped, unmapped, hasAny}`
- `TOOL_MAP` 加 `shell_command` 映射（codex CLI 主力工具，参数 `command`/`workdir` ↔ cascade `command_line`/`cwd`）
- `shouldUseNativeBridge` 改用 `partitionTools(tools).hasAny`
- `canMapAllTools` 保留作 legacy 严格模式 API

**`src/handlers/chat.js`**：
- `handleChatCompletions` 入口先算 `toolPartition = partitionTools(tools)`
- emulation toolPreamble 用 `emulationTools = toolPartition.unmapped`（bridge 关时还是全 tools 走 emulation 兜底）
- `nativeAllowlist` 只用 mapped 子集
- Probe log 加 mapped/unmapped 名字明细：`native bridge ON — mapped=[shell_command] unmapped=[update_plan,apply_patch,...] allowlist=run_command`
- 新 export `mergeReasoningEffortIntoModel(reqModel, body)`：codex CLI 发 `model="gpt-5.5"` + 单独的 `reasoning.effort="xhigh"`，windsurf 的 `gpt-5.5` alias 默认指 medium tier，effort 信息在 v2.0.65 之前是丢的（zhqsuo #115 反馈：`model=gpt-5.5-medium reasoning=xhigh`）。新 helper 在 reqModel 解析前做合并：如果 `${reqModel}-${effort}` 在 catalog 里存在就改写
  - 支持 `body.reasoning.effort`（codex/Responses 风格）和 `body.reasoning_effort`（OpenAI Chat 风格）
  - `minimal` → `none`（windsurf catalog 的最低档命名）
  - 已有 effort 后缀时不重复 stamp
  - merged model 不在 catalog 时静默退回原 reqModel

**`src/windsurf.js`**：
- `buildSendCascadeMessageRequest` 不再在 nativeMode 下强制清空 toolPreamble，让 partition 模式两者并存
- `buildCascadeConfig` 路径不变（`if (toolPreamble)` 仍然 inject 到 `additional_instructions_section[12]`）

### 数字

- 测试：687 → **702**（+15 新 case：partitionTools 4 个 / shell_command round-trip 2 个 / canMapAllTools 兼容 1 个 / mergeReasoningEffortIntoModel 7 个 / shouldUseNativeBridge 改用 partition 后语义切换 1 个）
- 全测 0 fail，0 回归
- 改动：3 src 文件 + 1 test 文件

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### 实测验证 (codex CLI)

```bash
codex --model gpt-5.5 -c reasoning.effort='"xhigh"'
# v2.0.65: log 出 "tools=15 emulateTools=true markers=none"，native bridge 0 触发
# v2.0.66: log 出 "native bridge ON — mapped=[shell_command] unmapped=[...] allowlist=run_command"
#          + reasoning effort 合并到 model id (gpt-5.5-xhigh, 不再降级到 medium)
```

分析方法：本地起 dump-only HTTP server（`scripts/probes/dump-codex-tools.mjs`，因 `scripts/` 在 gitignore 不入 repo），让 codex CLI 发过来一次请求把 body 里的 tools[] 倾倒出来 — 这次拿到 codex CLI 0.128 真实声明的 11 个工具名清单。

### 已知 gap（留 v2.0.67）

- `apply_patch` 多文件 patch fan-out 到 cascade `propose_code` / `write_to_file`（当前走 emulation）
- `web_search` 真正映射到 cascade `search_web`（当前走 emulation）
- `update_plan` / `spawn_agent` 等 codex 内部协调工具：cascade 没等价物，长期留 emulation
- v2.0.65 的 stream native trajectory tool_calls batch emit 还没改成 step-by-step 流式

### 关 #115（v2 部分）

zhqsuo 反馈的 v2.0.64 「codex CLI 用 GPT 模型 markers=none」这一条这版应该真修到 — partition 模式 + reasoning effort 合并双管齐下，codex CLI 默认配置就能命中 native bridge。Claude / Gemini caller 路径没动。
