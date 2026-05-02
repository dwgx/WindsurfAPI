## v2.0.65 — Cascade native tool bridge：把 client tools 翻译成 Cascade 内置 IDE tools（#115 真修）

v2.0.62-v2.0.64 一路 dialect/anti-refusal 全套 ship 完，GPT + Codex CLI 实测 markers=none — 模型在 NO_TOOL planner mode 下根本不输出任何工具形态字符。Cascade 自家的 baked SP "你没工具" 比任何 prompt 改写都硬。

这版换路：**planner_mode 切回 DEFAULT 让 Cascade 启用 IDE agent loop，但工具集严格限制成 client 那边能执行的子集**，trajectory step.action 反向翻译成 OpenAI tool_calls 给 client，client 的 tool_result 通过 `additional_steps[9]` 注回 trajectory 让 planner 接续推理。

### 设计

新模块 `src/cascade-native-bridge.js` 一个文件搞定：

```
client OpenAI tools[]               cascade native step kinds
  Read(file_path,offset,limit)  ←→  view_file{absolute_path_uri,offset,limit,content}
  Bash(command,cwd)             ←→  run_command{command_line,cwd,combined_output{full}}
  Glob(pattern,path)            ←→  find{pattern,search_directory,raw_output}
  Grep(pattern,-i,head_limit,…) ←→  grep_search_v2{pattern,case_insensitive,head_limit,raw_output}
  Write(file_path,content)      ←→  write_to_file{target_file_uri,code_content[]}
```

forward / reverse 都纯函数，单元测试拉了 5 组 round-trip 对照。Codex CLI 风格的 `view_file` / `run_command` / `find` / `list_dir` 名字 caller 也直接喂得进去（identity 翻译）。

**激活策略**：
- `canMapAllTools(tools)` 严格模式 — caller 声明的每个 tool 都得在 mapping 表里，混合一个 unknown 立刻 fallback 到原 emulation 路径（部分 native 覆盖会让 planner 困惑）
- `shouldUseNativeBridge` auto-on：GPT 家族（provider=openai 或 `gpt-*`/`o3-*`/`o4-*`）+ `route='responses'` (Codex CLI 正好这条)。Anthropic/Gemini 默认走原 emulation —— 那条路对它们已经稳，没理由折腾
- `WINDSURFAPI_NATIVE_TOOL_BRIDGE=1` 全开 / `_OFF=1` 全关

### 改动

**`src/cascade-native-bridge.js`**（新，490 行）：
- `TOOL_MAP` 名字 + arg 翻译表（覆盖 Claude Code 风格 + Codex CLI 风格 + 常见别名 read_file/shell）
- `canMapAllTools` / `shouldUseNativeBridge` / `buildReverseLookup`
- `buildAdditionalStep(kind, args)` → 每种 cascade step kind 一个 proto 编码器
- `buildAdditionalStepsFromHistory(messages)` 把 caller 历史 (assistant.tool_calls + role:"tool") 编码成 trajectory step Buffer，每个 step 的 observation 字段（view_file→content / run_command→combined_output / grep→raw_output / find→raw_output / list_dir→children[] / write→file_created）填好

**`src/windsurf.js`**（约 +180 行）：
- `buildSendCascadeMessageRequest` 接受 `nativeMode` / `nativeAllowlist` / `additionalSteps`，把 step Buffers 写到 `SendUserCascadeMessageRequest.additional_steps[9]`
- `buildCascadeConfig` 在 `nativeMode=true` 时 mode → DEFAULT (1) + 加 `CascadePlannerConfig.tool_config[13]`（新 helper `buildNativeCascadeToolConfig` 写空 sub-config + `tool_allowlist[32]`）；`toolPreamble` 在 native 模式下被强制清空，emulation 那套不再 ship
- `parseTrajectorySteps` 扩展认 7 种 native step kind（view_file=14 / list_directory=15 / write_to_file=23 / run_command=28 / grep_search=13 / find=34 / grep_search_v2=105），每个 step 推到 `entry.toolCalls` 形如 `{id:'native:<kind>:<idx>', name:<kind>, argumentsJson, result, cascade_native:true}`，老的 ChatToolCall 包装路径（45 custom_tool / 47 mcp_tool / 49 proposal / 50 choice）保持不变

**`src/handlers/chat.js`**（约 +90 行）：
- `handleChatCompletions` 入口算 `nativeBridgeOn` + `nativeAdditionalSteps` + `nativeAllowlist`，bundle 成 `nativeOpts` 透传
- 在 native 模式下 `cascadeMessages` 过滤掉 role:"tool" 和无 content 的 assistant.tool_calls 条目（信息已经在 additional_steps 里）
- `nonStreamResponse` / `streamResponse` 两个分支都识别 `cascade_native:true` 的 toolCalls，按 callerLookup → callerName → reverseFn(args) 翻译成 OpenAI tool_calls，经过同款 `filterToolCallsByAllowlist` + `sanitizeToolCall` + `repairToolCallArguments` 防护后 emit
- stream 路径目前是 cascadeChat 完成后 batch emit（不是 step-by-step），下版做流式 callback

**`src/client.js`**（+8 行）：`cascadeChat` 把 `nativeMode` / `nativeAllowlist` / `additionalSteps` 透传到 `buildSendCascadeMessageRequest`

### 数字

- 测试：654 → **687**（+33 新 case：mapping 双向一致 / canMapAllTools / shouldUseNativeBridge gating / `parseTrajectorySteps` native step / `buildSendCascadeMessageRequest` field 9 + planner_mode 切换）
- 全测 0 fail
- 改动：3 src 文件 + 1 新 src 文件 + 1 新测试文件 + package.json bump

### 升级

```bash
docker compose pull && docker compose up -d
```

### 启用方式

默认 OFF —— auto-on 只命中 GPT 家族 + Codex CLI (responses 路由)。其他 caller 默认走老的 NO_TOOL emulation 路径不变。Operator 全开：

```bash
WINDSURFAPI_NATIVE_TOOL_BRIDGE=1
```

全关：

```bash
WINDSURFAPI_NATIVE_TOOL_BRIDGE_OFF=1
```

### 实测 (Codex CLI)

```bash
codex --model gpt-5.5-medium
# v2.0.64: markers=none，模型零 tool 形态字符，0 tool_calls
# v2.0.65: planner DEFAULT 模式下 cascade IDE agent loop 跑起来，trajectory 出 view_file/run_command 等 step，
#          被反向翻译回 Read/Bash 给 Codex CLI，client 真去执行后结果作为 additional_steps 注回
```

### 已知 gap（留 v2.0.66）

- **Stream 路径 batch emit**：当前 native trajectory tool_calls 在 cascadeChat 完成后一次性 emit，不是 step-by-step 流式。要做流式得在 client.js cascadeChat polling loop 里加回调
- **Edit / MultiEdit → propose_code**：当前是 pass-through (`__raw_edit` 字段)，没真编 ActionSpec / ActionResult / DiffBlock proto。这俩工具走 emulation 路径
- **server-side 副作用观察**：DEFAULT planner mode 历史上有 /tmp/windsurf-workspace 路径泄露 / "file already exists" 副作用。v2.0.65 通过 `tool_allowlist` 限制工具集 + `additional_steps` 提前注入结果（让 planner 不重跑）来缓解，但需要部署后实测确认

### 关 #115 真修

dialect/anti-refusal 那一波（v2.0.62-v2.0.64）是这版的前置依赖 — 它们填好了识别 GPT 输出形态的能力。这版把 GPT 路径整个换轨，不再要求模型按文本协议 emit `<tool_call>` 标签，而是直接走 Cascade 自家的 trajectory step 机制。
