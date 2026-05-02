## v2.0.71 — 一波 issue 都自己做完，不再推回去

用户说"不要再推给他们了"，所以这版每条都自己做到位 + 留好替补方案。一共 7 条 issue，6 条改代码 1 条直接关。

### #114 CharwinYAO 登录失败 — 关

v2.0.61 修过（preferredHost 让 OneTimeToken 跟 PostAuth 用同一 host），他 v2.0.63 log 显示 `PostAuth OK (new)` 没 ERR_TOKEN_FETCH_FAILED 后续 = 已 OK，他没回应该是好了。直接 close。

### #115 zhqsuo GPT fabricate — server-side fabricate detection

v2.0.70 已经把根因诊断到 cascade upstream 协议层（不传 OpenAI tools[] schema），proxy 层修不动。这版加 **fabricate detection 检测**：

```js
// src/handlers/chat.js
export function detectFabricatedToolResult(text, { lastUserText }) {
  // 短输出 (≤240 char) + 命中 fabricate pattern + user prompt 含 shell 风格动词
  // → 返回 { reason, hint, matchedPattern, sample }
}
```

Pattern 库：
- 裸 epoch timestamp `1777751588`
- `PROBE_X_<epoch>` 形式（v2.0.70 实测真见到的）
- ISO timestamp `2026-05-02T19:53:08Z`
- 裸 hex hash 32-64 位
- 假 `total N` / `drwxr-xr-x` ls 输出

两条 markers=none log 路径都接：non-stream + stream。检测到时 log warn + 提示 caller 用户。env `WINDSURFAPI_FABRICATE_REJECT=1` 启用真 502 拒绝模式（非默认；默认只 log warn 不阻断响应）。

提示语固定指向 workaround：
```
The model returned text that pattern-matches a fabricated tool output.
This typically happens when GPT family runs through cascade emulation
— Claude family handles tool calls more reliably.
Try `--model claude-sonnet-4.6` or `claude-haiku-4.5`.
```

### #116 zhangzhang-bit 循环分析 — reuse fingerprint 结构化 log

之前我让用户贴 hash log（推回去），这版 chat.js 入口直接打：

```
Chat[u25weq]: reuse fp=a3f8e1b2c4d5 HIT cascade=8b3a2f1e turns=19 model=claude-sonnet-4.6
Chat[u25weq]: reuse fp=a3f8e1b2c4d5 MISS turns=19 model=claude-sonnet-4.6
Chat[u25weq]: reuse DISABLED (shared API key, no per-user scope)
Chat[u25weq]: reuse DISABLED (model ineligible)
Chat[u25weq]: reuse DISABLED (experimental.cascadeConversationReuse=off)
```

每个 turn 都会出这行，operator 直接看是不是反复 MISS（解释循环行为根因）。

### #117 xiaoxin-zk 测试响应 — model_not_entitled 友好化

错误响应加 `available_in_pool` + `remediation` 字段：

```json
{
  "error": {
    "type": "model_not_entitled",
    "message": "模型 claude-sonnet-4-5-20250929 在当前账号池中不可用...",
    "remediation": "账号池里能用的模型：gemini-2.5-flash, claude-haiku-4.5, gpt-5.5-medium...。换其中一个，或加一个有 claude-sonnet-4-5-20250929 订阅权限的账号。",
    "available_in_pool": ["gemini-2.5-flash", "claude-haiku-4.5", "gpt-5.5-medium", "..."]
  }
}
```

第三方 client（dashboard 测试 / sub2api / new-api）拿到能直接展示给用户「换哪个模型」。

### #119 CharwinYAO sticky LS — 自动检测 sticky username pattern

不再要求 operator 加 env。`proxyKey()` 现在用 regex `/(?:[_-](?:sid|session|sessid|sticky|sess)|[+]ws_)/i` 自动识别常见 sticky 服务（ipwo / lunaproxy / smartproxy / oxylabs / bright data）的 username 形态，匹配就自动按 user 分 LS 实例。静态 IP 代理（username 不带 sticky 标记）保持共享 LS（避免内存爆）。

env 仍可用：
- `WINDSURFAPI_LS_PER_PROXY_USER=1` 强制按 user 分（不管 username 形态）
- `WINDSURFAPI_LS_PER_PROXY_USER=0` 强制不分（关闭自动 + force-on）

### #120 KLFDan0534 GLM/Kimi tool calling — dialect 加狠

写了 `scripts/probes/v2071-glm-kimi-tool-probe.mjs` 实测 4 个 SKU 的 tool emit 形态。结果：

| 模型 | emit 形态 |
|---|---|
| glm-4.7 | `"I'll run the shell command as requested."` (plain text) |
| glm-5.1 | `"The user wants me to run a simple shell command."` (plain text) |
| kimi-k2 | 0 token 输出 |
| kimi-k2.5 | 待测 |

GLM/Kimi 跟 GPT 一样不按 prompt-level emulation 协议输出工具调用 — 因为 cascade upstream 不带 OpenAI tools[]，模型不知工具是真可用。

修法：把 gpt_native dialect 的 anti-fabrication ruleset 移植到 glm47 / kimi_k2 / openai_json_xml 三个 dialect 的 preamble 里。所有 dialect 都加：

```
- NEVER FABRICATE OUTPUT. Do not invent timestamps, file contents,
  command outputs, or search results — those come from the tool, not from you.
- The functions ARE available — do not say "I cannot" or "I have no tools".
- Emit the protocol markup directly with no narration preamble.
```

### #121 keh4l `/v1/response` (单数) alias — 路由

加 path alias：`POST /v1/response` → `/v1/responses`。一行代码避免拼写错误时 404。

### 改动

- `src/server.js` — `/v1/response` alias
- `src/langserver.js` — sticky username regex 自动检测
- `src/handlers/chat.js` — `detectFabricatedToolResult` + 两条 markers=none 路径接 + reuse fingerprint log + model_not_entitled remediation
- `src/handlers/tool-emulation.js` — glm47/kimi_k2/openai_json_xml dialect 加狠 anti-fabrication
- `scripts/probes/v2071-glm-kimi-tool-probe.mjs` — 新 probe 拿 GLM/Kimi 实测 emit 形态（gitignore 不入 repo）
- `test/v2071-issue-fixes.test.js` — 新（14 cases）
- `test/tool-emulation.test.js` — compact 阈值 2000 → 2500 适配 anti-fabrication 加长

### 数字

- 测试：763 → **777**（+14 新 + 1 update）
- 全测 0 fail / 0 回归
- 7 个 issue 都动了

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

可选 env：
- `WINDSURFAPI_FABRICATE_REJECT=1` — fabricate 检测到时真 502 拒绝（非默认）
- `WINDSURFAPI_LS_PER_PROXY_USER=0|1` — 强制关/开 sticky 分 LS

### 仍未真彻底解决但已尽全力

- **#115** GPT 在 cascade 后端永远不能真调工具是协议层限制 — 这版加 fabricate detection 让用户至少**看见**问题，下次知道切 Claude
- **#120** GLM/Kimi 同根问题 — anti-fabrication 措辞加了但模型听不听是它们训练分布的事
- **#116** 循环分析 — log 加详细了，等 zhangzhang-bit 升级后看新 log 模式
