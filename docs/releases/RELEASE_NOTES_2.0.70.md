## v2.0.70 — #115 真根因翻方向 + 一波积压完结

v2.0.69 NO_EMUL 那条诊断 probe 老实把脸打了 — partition 模式 + 关掉 emulation toolPreamble，GPT 还是 markers=none，反而 fabricate 了一个像样的 epoch 时间戳交差。结论是：**cascade DEFAULT planner 给 GPT 看到的 `run_command` 工具描述用的是 cascade 内部 trajectory grammar，GPT 训练分布里压根没见过这种调用语法**，知道有工具但不会 emit 真 call → hallucinate。

这版换方向 + 一并把 v2.0.65 之后挂着的 5 件事补完。

### #115 主菜：GPT 退出 native bridge，emulation + gpt_native dialect 接管

`shouldUseNativeBridge` 改逻辑：

- **GPT/Codex/o3/o4 family → 默认 OFF**（v2.0.66 加的 GPT auto-on 撤回）
- **Claude family → 默认 ON**（cascade-native function-calling 跟它们训练对得上）
- **Gemini / 其他 → OFF**（emulation 已经够用）

GPT 这条路现在走 NO_TOOL planner_mode + 完整 emulation toolPreamble + gpt_native bare-JSON dialect — 这条路 v2.0.62 已经铺好但 prompt 不够狠让 GPT 还是 fabricate。这版 anti-fabrication ruleset 加了一条决定性的：

```
4. NEVER FABRICATE OUTPUT. Do NOT guess the result of a function call. Do NOT
   invent timestamps, file contents, command outputs, search results, or any
   other data that a function would have produced. If the user asks for the
   output of `echo $(date +%s)`, `ls`, `cat README.md`, or anything similar,
   you have NO way to know the answer — you MUST call the function.
   Hallucinated outputs are worse than refusing; the only correct response is
   the function_call JSON.
```

枪口指向"echo timestamp" 这种典型 fabrication trap，明文列举禁止行为。

### #115 follow-up：Edit/MultiEdit 真编 cascade ActionSpec proto

v2.0.65 release notes 里说"Edit 走 emulation fallback"算欠的。这版做完：

```
Edit({file_path, old_string, new_string})
  ↓ forward
ActionSpec.command {
  is_edit: true,
  replacement_chunks: [{ target_content, replacement_content, allow_multiple? }],
  target.file: PathScopeItem { absolute_uri }
}
  ↓ wrap
CortexStepProposeCode.action_spec[1]
  ↓ wrap
CortexTrajectoryStep.type=32 / oneof[32]
```

MultiEdit 直接把 `edits[]` 折成多个 ReplacementChunk，`replace_all` → `allow_multiple=true`。reverse 路径完整 round-trip。

### #115 follow-up：web_search → cascade search_web step（field 42）

之前错映射成 `read_url_content`，这版按 `CortexStepSearchWeb { query=1, domain=3, summary=5 }` 真编。codex CLI 的 `web_search`（type=web_search → flatten 成 function/web_search）和 Claude Code 的 `WebSearch` 都进 TOOL_MAP。

### #115 follow-up：apply_patch 标记 unmappable（v2.0.71 接 fan-out）

apply_patch 多文件 patch 单步无损 cascade 编码做不来（cascade 的 write_to_file 是单文件，需要解析 patch grammar 拆 fan-out）。这版把 `forwardApplyPatchArgs` 设成 sentinel `__apply_patch_unmappable: true`，`buildAdditionalStepsFromHistory` 看到 sentinel 跳过 — partition 把它推回 emulation 路径。caller tool_call 仍然能用，只是不走 native trajectory step。完整 fan-out 留 v2.0.71。

### v2.0.65 gap：stream 路径流式 emit cascade native tool_calls

之前 cascade native trajectory tool_calls 是在 `cascadeChat` 完成后 batch emit（v2.0.65 release notes 自己列的 known gap）。这版 client.js polling loop 每发现新 step.toolCalls 立刻 onChunk 一个 `{nativeToolCall: tc}` chunk；chat.js stream onChunk 识别后立刻 emit OpenAI tool_call delta。tail-batch 路径保留作 fallback（dedupe by id 不重复 emit）。

### #112 follow-up：dashboard quiet-window UI toggle 上线

v2.0.67 的服务端逻辑 + API 都做了，但实验性面板没 toggle 控件（只能 curl `/dashboard/api/auto-update/quiet-window`）。这版加：

- 实验面板新 section "空档自动更新" + 启用 checkbox + 状态显示 + 刷新/立即测试按钮
- 状态行实时显示 `disabled / cold-start grace / cooldown / busy / eligible`
- "立即测试"按钮 force 一次 tick（仍走完整 4 道门）
- zh-CN/en i18n 全配 + i18n check pass

### #57 follow-up：thinking-aware warm stall 有 env override

v2.0.69 加了，这版仅文档化在 release notes 里 — 默认 thinking 模式 warm-stall 阈值 120s，env `CASCADE_WARM_STALL_THINKING_MS` 可调到 180s/300s。

### 诊断工具：`WINDSURFAPI_DUMP_SYSTEM_PROMPT=1`

operator 想看 cascade injected `additional_instructions_section` 实际给 GPT 看到的样子，开 env 后每次 cascade send 把内容写到 `/tmp/windsurf-sp-dump-<ts>.txt`（前 4KB），方便定位"哪句话让 GPT 选 hallucinate"。

### 改动

- `src/cascade-native-bridge.js` — shouldUseNativeBridge 翻方向；TOOL_MAP 加 WebSearch/web_search → search_web；Edit/MultiEdit 真 propose_code 编码；apply_patch unmappable sentinel
- `src/handlers/tool-emulation.js` — gpt_native preamble 加 anti-fabrication 第 4 条
- `src/client.js` — stream 流式 emit cascade native tool_calls
- `src/handlers/chat.js` — onChunk 识别 nativeToolCall delta + tail batch dedupe
- `src/windsurf.js` — `WINDSURFAPI_DUMP_SYSTEM_PROMPT` 诊断
- `src/dashboard/index.html` — 实验面板加 quiet-window toggle + status 显示
- `src/dashboard/i18n/zh-CN.json` + `en.json` — quiet-window 完整 i18n
- `test/v2070-issue-fixes.test.js` 新（19 cases），更新 5 个老测试匹配新行为

### 数字

- 测试：743 → **763**（+19 新 + 5 update）
- 全测 0 fail / 0 回归
- i18n check pass

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### 仍未修

- **#115 真验证未完成**：v2.0.70 部署后还要 codex CLI + GPT-5.5 + shell_command probe 真测，看 anti-fabrication ruleset 让 GPT 真调而不是再编。这次 release notes 之后我会立刻起 probe 看
- **apply_patch fan-out** v2.0.71 接
- **#116 zhangzhang-bit 循环分析根因** — 仍等 hash 字段对照 log
