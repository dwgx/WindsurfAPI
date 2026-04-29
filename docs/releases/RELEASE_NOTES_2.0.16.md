## v2.0.16 — tool preamble 分层降级，修 #77 AromaACG 搭车帖（opus-4-7 短回复 14 字符）

#77 里 AromaACG 报了**和 zhangzhang-bit 完全不同的症状**：他不是 30 秒空错误，是 200 OK 但 `Cascade short reply textLen=14` —— 模型只吐了 14 个字符。日志里关键一行是：

```
toolPreamble 71KB exceeds soft cap 23KB; falling back to names-only preamble (2KB, 25 tools)
```

他用 `claude-opus-4-7` + `response_format=json_schema` + 25 个 MCP tool，full preamble 编出来 71KB（150KB 也见过），硬撞 24KB soft cap，**直接降级成 names-only**（只有名字、丢了所有 schema）。同样的请求 `claude-opus-4.6` 抗压能 hold 住，opus-4-7 没有 schema 直接懵了，14 字符敷衍交差。

The bug class: payload-budget compaction was binary — full schemas at 71KB or names-only at 2KB, no middle ground. opus-4-7 needs at least param-name-and-type information to produce a useful response_format=json_schema reply.

### 改了什么 / What changed

把 `applyToolPreambleBudget` 从 binary fallback 改成**四档分层**，从大到小逐层降级直到塞进 soft cap：

| Tier | 内容 | 25-tool 案例大小 |
|------|------|------------------|
| `full` | 完整 JSON schema，pretty-printed | ~150KB |
| `schema-compact`（**新**）| minified JSON + 剥掉 schema 内部的 description / examples / default / title / additionalProperties | **~10KB** |
| `skinny`（**新**）| name + 一行描述 + 参数签名 (`file_path: string, mode?: "a"\|"b"`)，丢完整 schema | ~5KB |
| `names-only` | 仅函数名 + 提示 schema 已省略 | ~2KB |

AromaACG 这个 25 工具 / 71KB 案例现在落在 `schema-compact` 档（~10KB），opus-4-7 看得到 param 名字和类型 + 小 enum，能正常出 json_schema 响应。30+ 工具的极端场景才会进 skinny / names-only。

The walk:

| Tier | Content | 25-tool fixture size |
|------|---------|----------------------|
| `full` | Pretty-printed full JSON schema | ~150KB |
| `schema-compact` (**new**) | Minified JSON, schema-internal `description` / `examples` / `default` / `title` / `additionalProperties` stripped | **~10KB** |
| `skinny` (**new**) | Name + first-sentence description + parameter signature (`file_path: string, mode?: "a"\|"b"`) | ~5KB |
| `names-only` | Function names with a note that schemas were omitted | ~2KB |

`applyToolPreambleBudget` walks tiers from largest to smallest, picks the first one ≤ soft cap. Hard cap only rejects if even names-only is too big (extreme tool counts).

**`src/handlers/tool-emulation.js`**:
- `buildSchemaCompactToolPreambleForProto` (新)
- `buildSkinnyToolPreambleForProto` (新)
- `stripSchemaDocs` / `firstSentence` / `paramSignature` 工具函数

**`src/handlers/chat.js`**:
- `applyToolPreambleBudget` tiered walk
- 日志从 "falling back to names-only" 改成 "using <tier> tier"，operator 一眼看到落在哪档

### 验证

- `test/tool-preamble-budget.test.js` +2：25-tool 70KB 案例必须落 schema-compact / skinny（不是 names-only）；schema-compact 必须保留 enum / 参数名。
- 既有 `tool preamble forbidden wording` 测试在新 tier 上仍然 pass（`TOOL_PROTOCOL_SYSTEM_HEADER` / `TOOL_CHOICE_SUFFIX` 共用，已经过 jailbreak-vocab audit）。
- 253/253 tests pass。

实测数字（25 工具 / 8 props each / verbose 描述）：
```
full: 151468 → tier: schema-compact final: 9883 ok: true
```

### Compatibility

- 升级路径无操作。`docker compose pull && docker compose up -d`。
- 行为变化：原本因为 71KB 超 soft cap 直接 names-only 的请求，现在多数会落到 schema-compact 或 skinny —— **opus-4-7 / 类似挑剔模型应能正常输出**，不再吐 14 字符短回复。
- soft / hard cap 默认值不变（24KB / 48KB），可经 `TOOL_PREAMBLE_SOFT_BYTES` / `TOOL_PREAMBLE_HARD_BYTES` 调。
- 253/253 tests pass。Zero npm dependencies, unchanged.
