## v2.0.80 — H-4 narrowing hotfix（v2.0.79 实测发现 GLM 反退步）

部署 v2.0.79 后跑 e2e probe，GLM-4.7 反而 FAIL — 跑前还能抠到 tool_call。看 server log：

```
markers=fenced_json,bare_json
NLU recovery: extracted 0 tool_call(s)  (layer3-skipped: structural markers seen)
```

是 v2.0.78 H-4 引入的 markers gate 把 GLM/Kimi 这种"thinking 里有 JSON 但 parser 抠不到 + 真在 narrate 工具调用"的真实场景误判了。

GLM-4.7 / Kimi-K2.5 经常这么 emit：

```
Sample: {"name":"shell_exec","arguments":{...}} ...
I'll call shell_exec with command 'echo HELLO'.
```

`bare_json` marker 触发因为 thinking 里有 JSON 片段，但 parser 抠不到（不规范 / 不在 expected position）。Layer 3 narrative 正好能捞 "with command 'echo HELLO'"。H-4 把这条路堵了。

### 修

H-4 收紧到只在 `xml_tag` marker（Claude 协议）触发时跳过 Layer 3。`bare_json` / `fenced_json` / `openai_native` 仍然允许 Layer 3 — 这些 marker 的 emitter 普遍依赖 NLU 兜底。

```js
// v2.0.79 (太严)
const skipLayer3 = markers.some((m) => STRUCTURAL_MARKERS.has(m)) && !markers.includes('natural_lang');

// v2.0.80 (准)
const skipLayer3 = markers.includes('xml_tag') && !markers.includes('natural_lang');
```

H-2 的三层 placeholder + article-led prose 过滤还在，所以即使 Layer 3 跑也不会再抠 "a shell command." 这种垃圾 — 安全。

### 改动

- `src/handlers/intent-extractor.js` — H-4 gate 缩小
- `test/v2078-audit-fixes.test.js` — 更新 4 个 H-4 case + 加 1 个 fenced_json 对照

### 数字

- 测试 839 → **840**（+1）
- e2e probe v2.0.80 重测 GLM-4.7 应回到 PASS

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```
