## v2.0.31 — GLM / Kimi 工具调用方言支持（修 #86）

GLM-4.7 / GLM-5 / GLM-5.1 和 Kimi K2 在 Windsurf API 上能聊天但不会调工具，被用户骂"明明在官方 IDE 中是可以的"。三层 codex 协作（GPT-5.5 xhigh 研究 → GPT-5.3-Codex-Spark high 实现 → Claude 复审）查到根因并修了。

### 根因

emulation 解析器只认识一种 tool-call 格式：

```
<tool_call>{"name":"Read","arguments":{"file_path":"..."}}</tool_call>
```

但 GLM-4.7/5/5.1 输出的是 vLLM `glm47` parser 格式：

```
<tool_call>Read<arg_key>file_path</arg_key><arg_value>README.md</arg_value></tool_call>
```

Kimi K2 输出的是另一种 section-token 格式：

```
<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"README.md"}<|tool_call_end|><|tool_calls_section_end|>
```

结果：模型确实**调了**工具，但 parser 不认识它写的格式，silently 把 tool_call 当文本丢掉，`finish_reason` 变成 `"stop"`、`tool_calls=[]`。Gemini 因为正好按 JSON-XML 写所以没事。

### 修了什么

1. **`pickToolDialect(modelKey, provider)`** —— `zhipu` / `glm*` → `glm47`，`moonshot` / `kimi*` → `kimi_k2`，其他 → `openai_json_xml`（保持原样）

2. **prompt 按方言分发** —— 5 个 preamble builder 全接入：
   - `buildToolPreamble`（user-message 兜底）
   - `buildToolPreambleForProto`（full）
   - `buildSchemaCompactToolPreambleForProto`
   - `buildSkinnyToolPreambleForProto`
   - `buildCompactToolPreambleForProto`（names-only）

3. **streaming parser 支持 GLM47 + Kimi K2** —— `ToolCallStreamParser` 按方言分支，handle:
   - GLM47 zero-arg `<tool_call>pwd</tool_call>`
   - GLM47 same-line / newline / 多 arg
   - GLM47 多 tool_call back-to-back
   - Kimi K2 完整 section 解析
   - tag 跨 chunk 断点（`<tool_ca` 在一个 chunk，`ll>` 在下一个）

4. **streaming UX 不退化** —— GLM/Kimi 路径不再 buffer 全部输出到 flush。先 emit 安全文本（hold back tag 前缀），看到 `<tool_call>` / `<|tool_calls_section_begin|>` 才停下等完整块，flush 时统一解析。纯聊天回复实时流式输出。

5. **历史 tool_calls 也按方言序列化（修 "上下文会丢"）** —— 之前 GLM 看到自己上一轮的 tool_call 是 OpenAI JSON-XML 格式，模型不认识自己说过的话，对话上下文丢失。现在 GLM 历史用 GLM47 格式重写，Kimi 历史用 section tokens 重写。

### 新加的测试（+16 条）

```
✓ pickToolDialect 选 glm47 / kimi_k2 / openai_json_xml
✓ GLM47 split-chunk
✓ GLM47 zero-arg
✓ GLM47 single-arg arg_key/arg_value
✓ GLM47 multi-arg (number values 解析为 number)
✓ GLM47 multiple tool_calls back-to-back
✓ Kimi K2 section-token 单调用
✓ GLM47 streaming 普通 prose 不被 buffer
✓ GLM47 streaming prefix text + tool call 同 stream 正确分发
✓ GLM47 holds back partial open-tag 跨 chunk
✓ proto preamble 选 GLM47 arg_key/arg_value 协议
✓ proto preamble 选 Kimi section-token 协议
✓ assistant 历史按 glm47 dialect 序列化
✓ assistant 历史按 kimi_k2 dialect 序列化
✓ assistant 历史保留 anthropic/openai/gemini 的 JSON-XML
+ Gemini JSON-XML 兼容回归
```

### 数字

- **测试**：v2.0.30 之前 349 → v2.0.31 现在 **365**（+16 条新测试 / 0 失败）
- **suites**：77（不变）
- **代码改动**：+578 / -48（实现 + 测试）
- **API 不变**：OpenAI / Anthropic / Gemini 路径走原来的 JSON-XML，零行为改变
- **fallback preamble 仍 <640 char**：保留 Opus injection-detection 兜底

### 三层 codex 协作

```
v2.0.30 master + issue #86
        │
        ▼
┌─────────────────────────────────────────┐
│ Stage 1: GPT-5.5 xhigh research          │
│ — trace chat.js / tool-emulation.js      │
│ — Cascade proto field 检查               │
│ — vLLM/Z.AI 文档查 glm47 / kimi_k2 格式  │
│ — 给 3 个修复方案 + 每个的 file/test     │
└─────────────────────────────────────────┘
        │ 选 Option 1 (model-aware parser + prompt)
        ▼
┌─────────────────────────────────────────┐
│ Stage 2: GPT-5.3-Codex-Spark high impl   │
│ — pickToolDialect + 5 preamble + parsers │
│ — 加 13 条 test / 流式分支               │
└─────────────────────────────────────────┘
        │ 自身权限不够无法 commit / 一处 typo
        ▼
┌─────────────────────────────────────────┐
│ Stage 3: Claude 修 + 拓展                │
│ — 修 protocolLines.join 的类型 bug       │
│ — buildToolPreamble 重写回 <640 char     │
│   (worker 把它换成完整 1329 char header) │
│ — 加历史 tool_calls 按方言序列化         │
│ — 加 streaming text emit + hold-back     │
│ — 加 6 条新 test / commit + merge        │
└─────────────────────────────────────────┘
```

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- 全部是加固 + 测试 + parser 扩展 —— **API 不变**，旧客户端不受影响
- OpenAI / Anthropic / Google 系列模型走原 JSON-XML 路径，零行为改变
- 新版 GLM-5.1 / GLM-4.7 / Kimi K2 现在能像 Gemini 一样在 Cascade 走 emulation 调工具
- 365/365 tests pass
