# 环境变量参考（补 .env.example 未收录的部分）

README 的表格列常用变量，[.env.example](../.env.example) 是完整清单 —— 两者合计覆盖
74 个。本文补齐**剩下 84 个只存在于源码里**的开关：注释很全，但运营翻不到。

数开关**别用裸 `grep 'env\.'`**，有两个坑：一是 `WINDSURFAPI_TRACE` 这类名字是
`WINDSURFAPI_TRACE_DIR` 的前缀，正则不加边界会重复计数；二是**相当一部分读取点
不长得像 `env.FOO`** —— `positiveIntEnv('FOO', 默认)`（`client.js`/`proto-trace.js`/
`conversation-pool.js`）和 `runtime-config.js` 里 `{env: 'FOO', def: …}` 的表驱动写法
都是真读取点。只匹配 `env.FOO` 会漏掉 70 个。正确数法：

```bash
python3 - <<'PY'
import re,pathlib,subprocess
files=[f for f in subprocess.run(['git','ls-files','src'],capture_output=True,
       text=True).stdout.split() if f.endswith('.js')]
PAT=re.compile(r"""(?:(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})
                 |(?:process\.)?env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]
                 |positiveIntEnv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]
                 |\benv:\s*['"]([A-Z][A-Z0-9_]{2,})['"]
                 |\bconst\s+[A-Za-z_$][\w$]*\s*=\s*['"]([A-Z][A-Z0-9_]{2,})['"])""",re.X)
def strip(s):                                       # 注释里的名字不算读取点
    # 不能用 re.sub(r'/\*.*?\*/', '', s, flags=re.S) —— 本仓库有两个文件的
    # **正则字面量里含 `*/`**（如 /\*\//），于是 `*/` 比 `/*` 多（identity-neutralize.js
    # 是 9 比 7）。惰性匹配会在正则内部的 `*/` 处收尾，从那之后全部错配，把真代码删掉。
    # 实测代价：WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE 和 DEVIN_CONNECT_CRED_KEY
    #（一个凭证开关）对统计和守卫双双隐形，而两者都是绿的。逐行处理即可避免。
    out=[]; inB=False
    for raw in s.split('\n'):
        line=raw
        if inB:
            c=line.find('*/')
            if c==-1: out.append(''); continue
            line=line[c+2:]; inB=False
        line=re.sub(r'/\*.*?\*/','',line)           # 单行内自闭合的块注释
        o=line.find('/*'); lc=line.find('//')
        if o!=-1 and (lc==-1 or o<lc): inB=True; line=line[:o]
        out.append(re.sub(r'//.*$','',line))
    return '\n'.join(out)
names=set()
for f in files:
    for m in PAT.finditer(strip(pathlib.Path(f).read_text(errors='replace'))):
        n=next(g for g in m.groups() if g)
        if n.startswith(('DEVIN_CONNECT_','WINDSURFAPI_','CASCADE_')): names.add(n)
print(len(names))   # 158（2026-08-10，合入 PR #249 之后）
PY
```

第五种形式（`const X = 'FOO'` 然后 `env[X]`）是 PR #249 带进来的,当时前四种
全部漏掉了它 —— 守卫绿着,统计却少算一个。所以这份清单的数字**不要手抄**,
跑上面的脚本。

每个默认值都是**逐个打开源码站点读出来的**，不是按名字推断。文档写错默认值比没文档更坏，
所以标了取值位置，可自行核对。

通用约定：这些开关**只认精确的 `'1'` 或 `'0'`**，不认 `true` / `yes` / `on`。这是刻意的——
历史上 `Number()` / 真值重写把开关静默翻转过（#241、#242）。

## 会放宽隔离的（优先了解）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CASCADE_REUSE_ALLOW_SHARED_API_KEY` | 关 | 允许**多个调用方共享同一个上游账号**时复用 Cascade 会话（`handlers/chat.js`，`=== '1'`）。上游会保留会话状态，所以开启后不同调用方有可能看到彼此的上下文。默认关是刻意的隔离边界，**多租户场景不要开**。 |
| `DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE` | 关 | 允许**非本机**请求写凭证库（`dashboard/api.js`，`=== '1'`）。还要求对端是 loopback —— 校验的是 peer 地址而不只是监听地址，因为反向代理后面监听地址永远是本机。 |

## think-leak 防线与身份中和（#250）

前两个默认**开**，关掉会让思维链泄漏到内容通道 —— 客户端看到重复文本或裸 `<think>` 标记。
第三个默认关，且当前不改变输出。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_CASCADE_THINK_REROUTE` | **开** | Cascade 路径把带 think 标记的开头内容改道到 reasoning 通道（`handlers/chat.js`，`\|\| '1') !== '0'`）。设 `0` 关闭。 |
| `WINDSURFAPI_REASONING_DEDUP` | **开** | 抑制 reasoning 与 content 逐字重复的那一份。 |
| `WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE` | 关 | 强制走 Claude Code 的激进中和分支（`handlers/identity-neutralize.js`，`\|\| '') === '1'`）。检测到 CC 客户端时该分支本来就会走，这个变量只是手动强制。**目前该分支是保留状态** —— 源码注释写明「no CC-only rewrites are confirmed yet」，所以开它当前不改变输出。 |

## native tool bridge

这一组只在排查 native tool call 链路时才用得上。全部默认关或有内置默认值。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT` | 关 | 对**所有**模型强制用 GPT 原生 tool call 方言，不再按模型族判断（`handlers/tool-emulation.js`，`=== '1'`）。排查方言选择时用。 |
| `WINDSURFAPI_NATIVE_BRIDGE_NO_EMUL` | 关 | 走 native bridge 时不再叠加 prompt 层的工具模拟（`=== '1'`）。用来区分「原生解码坏了」和「模拟层坏了」。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL` | 关 | 交出 tool result 后主动再轮询一次上游（`client.js`，`=== '1'`）。只在 native 模式下有意义。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE` | 关 | 自动批准 read_url 抓取，不等确认（`client.js` 的 `isReadUrlAutoApproveAllowed`）。**光开这个不够** —— 还必须用 `..._WEBFETCH_AUTO_APPROVE_ORIGINS` 列出允许的 origin，名单为空时一律返回 false。双重门是刻意的：让模型自行发外部请求必须显式指定去哪。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_READ_URL_LEGACY_SUMMARY` | 关 | read_url 结果回到旧版摘要格式（`windsurf.js`，`=== '1'`）。兼容老客户端。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW` | 空 | 直接塞一段原始 bridge 配置（`windsurf.js`，`|| ''` 后 trim）。留空则用正常构造流程。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES` | 空 | 覆盖工具白名单的名字，逗号分隔（`cascade-native-bridge.js` 的 `csvListEnv`）。留空用内置名单。 |
| `WINDSURFAPI_NATIVE_BRIDGE_STATS_KEY_LIMIT` | `200` | 统计里最多保留多少个 key（`native-bridge-stats.js`，非有限值或 ≤0 时回落 200）。 |
| `WINDSURFAPI_NATIVE_BRIDGE_DECISION_RING_SIZE` | `25` | 决策环形缓冲保留多少条（同上，回落 25）。调大能看更长的决策历史。 |

## 默认开的功能开关

这五个默认**开**，所以只能往「关」的方向调。它们都是「设 `0` 才关闭」的写法 ——
写成别的值（`false` / `off`）不生效，除 `RESPONSE_CACHE` 外都只认精确的 `'0'`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_ENV_LIFT` | **开** | 把调用方的环境上下文提升进 prompt（`handlers/chat.js`，`?? '1'` 后 `=== '0'` 关闭）。注意这个用 `?? '1'` 而不是 `\|\| '1'`，且会 trim + 转小写。 |
| `WINDSURFAPI_LS_PER_PROXY_USER` | **开** | 每个 proxy 用户独立一个 LS 实例（`langserver.js`，`=== '0'` 关闭）。关掉会让不同用户共享 LS，省内存但失去隔离。 |
| `WINDSURFAPI_NLU_RECOVERY` | **开** | 意图抽取失败时走恢复路径（`handlers/intent-extractor.js`，`=== '0'` 时直接返回空数组）。 |
| `WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT` | **开** | 撞限流时自动回落到同族其它变体（`handlers/chat.js`，`=== '0'` 关闭）。关掉后限流直接报错给客户端。 |
| `WINDSURFAPI_RESPONSE_CACHE` | **开** | 响应缓存（`cache.js`）。链式兜底：`RESPONSE_CACHE_ENABLED ?? WINDSURFAPI_RESPONSE_CACHE ?? '1'`，所以前者优先。这个认多种关闭写法（`0`/`false`/`off`/`no`）。 |

## trace / dump / 运维

排查时才开。几个会往磁盘写内容，注意目录别落进打包或提交范围。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_TRACE` | 关 | 是否写 trace（`trace.js`，`\|\| ''` 后 `=== '1'`）。注意它**不门控** `WINDSURFAPI_TRACE_DIR` —— `traceRoot()` 无条件读目录变量，只是没开 trace 时不往里写。 |
| `WINDSURFAPI_TRACE_DIR` | `<cwd>/.trace` | trace 落盘根目录（`trace.js` 的 `traceRoot()`，`devin-connect.js` 写上游 wire 字节时也读同一个变量）。每个请求一个子目录，按固定 leg 名分片：`01-client-req` / `02-routing` / `03-upstream-req` / `04-upstream-res` / `05-client-res`。**上一行说过它不受 `WINDSURFAPI_TRACE` 门控**；此前只作为那条说明的一部分出现，没有自己的条目。 |
| `WINDSURFAPI_PROTO_TRACE_DIR` | `/data/proto-trace` | proto trace 落盘目录（`\|\| '/data/proto-trace'`）。注意这是**绝对路径**默认值，和 `WINDSURFAPI_TRACE_DIR`（默认 `<cwd>/.trace`）不是一套。 |
| `WINDSURFAPI_PROTO_TRACE_STRINGS` | 关 | 把 proto 字段的**字符串内容**写进 trace（`proto-trace.js:814`，`=== '1'`）。关闭时只落 sha256，不落原文。开启后走 `redactPreview()` 脱敏：命名密钥（`devin-session-token`/`api_key`/`idToken`/`refreshToken` 等）、邮箱、任何 32+ 字符的高熵串都替换成 `<redacted>`，再截断到 240 字符。**即便如此，开启后 trace 里会有真实 prompt 片段**，排查完就关。 |
| `WINDSURFAPI_PROTO_TRACE_ERROR_STRINGS` | 关 | 出错时额外输出字符串内容（`=== '1'`）。和 `PROTO_TRACE_STRINGS` 一样走脱敏。 |
| `WINDSURFAPI_DUMP_SYSTEM_PROMPT` | 关 | 把最终发给上游的 system prompt 打出来（`windsurf.js`，`=== '1'`）。**会输出完整 prompt 内容**，排查完记得关。 |
| `WINDSURFAPI_PROBE_CANARY` | 关 | 发探针金丝雀请求（`=== '1'`）。校准脚本用。 |
| `WINDSURFAPI_STABLE_DEVICE` | 空（= 每次随机） | 固定设备指纹种子（`\|\| ''`）。设成固定值可让请求可复现 —— 对比抓包时有用，**生产别设**，指纹固定会更容易被识别。 |
| `WINDSURFAPI_SKIP_LS_CLEANUP` | 关（= 会清理） | **名字是反的**：`!== '1'` 时执行清理，所以设 `1` 才是「跳过」（`index.js`）。自更新后残留的 LS 会占着池端口累积，默认清理。同一台机器跑多个 WindsurfAPI 时才需要设 `1`。 |
| `WINDSURFAPI_RESTART_SUPERVISED` | 关（= 自动探测） | **强制**声明自己跑在守护进程下（`restart.js`，命中时返回 `kind: 'override'`）。平时不需要设 —— systemd 自己会导出 `INVOCATION_ID`，代码据此自动识别。只在自动探测判错时用它兜底。 |

## 模型与工具行为微调

针对具体模型或具体客户端的窄开关。除末两个有数值默认外，其余默认关。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_FORCE_TOOL_DIALECT` | 空（= 按模型族判断） | 强制指定工具方言。**只接受这四个值**：`glm47` / `openai_json_xml` / `kimi_k2` / `gpt_native`（`handlers/tool-emulation.js` 的白名单正则），写别的会被忽略而不是报错。比 `FORCE_GPT_NATIVE_DIALECT` 精确。 |
| `WINDSURFAPI_DISABLE_SONNET_TOOL_REUSE` | 关 | 关掉 Sonnet 的工具复用（`=== '1'`）。怀疑复用导致串工具时用。 |
| `WINDSURFAPI_OPUS47_THINKING_UIDS` | 关 | Opus 4.7 用 thinking 专用的模型 uid（`=== '1'`）。 |
| `WINDSURFAPI_FABRICATE_REJECT` | 关 | 让上游拒绝时构造一个可读的拒绝响应而不是原样透传（`handlers/chat.js`，`=== '1'`）。 |
| `DEVIN_CONNECT_COLLAPSE_SYSTEM` | 关 | 把连续 system 内容包成 `<system>...</system>`，并入下一条 source=USER 消息。assistant/tool 历史不会提前消费它；末尾没有 user 时补一条 user。开启后原始 system 不再进入 request field `#2`，只有 tools 空-system guard 需要时才保留 benign placeholder。 |
| `WINDSURFAPI_NEUTRALIZE_CLINE_OBJECTIVE` | 空（= 关） | 中和 Cline 客户端的 objective 段（`\|\| ''`）。 |
| `WINDSURFAPI_SHOW_DISABLED_SPECIAL_AGENT_MODELS` | 关 | 在模型列表里也显示上游标记为 disabled 的 special agent 模型（`models.js`，`=== '1'`）。默认隐藏 —— 列出来客户端也调不通。 |
| `WINDSURFAPI_WEAK_MODEL_TOOL_LIMIT` | `8` | 弱模型最多带几个工具定义（`handlers/tool-emulation.js`，非有限值或 ≤0 回落 8）。工具多了弱模型会选错。 |
| `DEVIN_CONNECT_RELOGIN_MAX_CONCURRENT` | `2` | 同时最多几个账号并发重登（`auth.js`，`>= 1` 才生效否则回落 2，且会 `Math.floor`）。调大会更快恢复但更容易撞上游限流。 |

## 未经抓包证实的 wire 坐标（全部默认关，开之前先读这段）

这几个开关控制**往上游 protobuf 里写新字段**。它们的 tag 号来自第三方 `.proto`
文件里的**声明顺序**，不是抓包测出来的 —— 而 prost 允许 tag 跳号，所以
**声明顺序 ≠ wire tag**。写错 tag 的表现不是报错，而是上游按别的字段解读那段字节。

所以：**默认关是刻意的，不要因为"看起来该开"就打开**。一次真实付费抓包能一起
解锁这一组；在那之前，开了就得自己承担猜错 tag 的后果。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEVIN_CONNECT_PROMPT_CACHE` | 关 | 往请求里写 prompt 缓存字段（`devin-connect.js`，`=== '1'`）。tag `#13` 猜自声明顺序。 |
| `DEVIN_CONNECT_TOOL_CHOICE` | 关 | 发送 `tool_choice`（`=== '1'`）。tag `#12`/`#11` 同样猜自声明顺序。 |
| `DEVIN_CONNECT_TOOL_CHOICE_TAGS` | 空（= 用内置默认 tag） | 覆盖上面两个 tag，格式 `choice=N,parallel=M`（`getToolChoiceTags`）。**只认 `choice`/`parallel` 两个键**，其他键、非正整数、以及**撞上已占用 tag 的值**都会被跳过并打 warn，然后保留默认 —— 不是报错。撞 tag 的后果很隐蔽：`choice=1` 会和 814 字节的 `ClientMetadata` 同占 `#1`，protobuf 解码器取最后一个，等于**用 tool_choice 覆盖上游认证元数据**，表现为**认证失败**而不是"配置写错了"。这个防护是修过的真实缺陷，别绕过它。 |
| `DEVIN_CONNECT_SIGNATURE_TAG` | 空（= 整个解码关闭） | thinking `delta_signature` 的 tag。**这个是这组的总开关**：没设或不是 `(0, 2^29)` 内的整数时 `parseSignatureTagMap()` 返回 `null`，下面两个一起失效。 |
| `DEVIN_CONNECT_SIGNATURE_TYPE_TAG` | 空（= 该字段不解码） | signature `type` 的 tag，同样要求 `(0, 2^29)`。只在上一个已生效时才有意义。 |
| `DEVIN_CONNECT_SIGNATURE_THINKING_ID_TAG` | 空（= 该字段不解码） | signature `thinking_id` 的 tag，约束同上。 |
| `DEVIN_CONNECT_USER_JWT` | 关 | 用 `GetUserJwt` 短期凭证走 devin-connect 路径（`=== '1'`）。写进 `Metadata #21`，tag 也来自声明顺序。 |
| `WINDSURFAPI_USER_JWT` | 关 | 同一个功能在 **Cascade 路径**的开关（`windsurf-api.js`，`=== '1'`）。两条路径各自独立，开一个不影响另一个。JWT 不落盘，剩余 TTL 低于 5 分钟（`USER_JWT_MIN_TTL_MS`）会重新领。 |

## 数值上限与超时（有非零默认值，改了会影响所有请求）

这些不是布尔开关，默认值都是实测或历史沿用下来的。**它们的回落逻辑不一样** ——
有的校验 `Number.isInteger` 有的只校验 `Number.isFinite`，写非法值时的行为要看具体那行。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEVIN_CONNECT_WIRE_MAX_TOKENS` | `8192` | 请求里 `max_tokens` 的默认值（`devin-connect.js`，要求正整数否则回落 8192）。和 `handlers/messages.js`、`gemini.js` 里的 `\|\| 8192` 是一套。**在模块加载时求值一次**，改它要重启。 |
| `DEVIN_CONNECT_CATALOG_TTL_MS` | `300000`（5 分钟） | 每账号成功在线目录的复用时长（`auth.js`，有限数且 `>=10000` 才接受，否则回落 5 分钟）。TTL 内复用 last-known-good；过期后并行按账号刷新。空响应和失败不覆盖已有目录，也不推进成功时间。 |
| `WINDSURFAPI_TOOL_DESC_MAX` | `500` | 工具描述的字符上限（`toolDescMax()`，要求 `>= 0` 的有限数否则回落 500）。**`0` = 不限长**，不是"全砍掉"。注释说明当前只用于长度阈值判断。 |
| `CASCADE_1M_HISTORY_BYTES` | `900000` | 1M 上下文模型的历史字节预算（`client.js`，`positiveIntEnv`）。非 1M 模型走 `CASCADE_MAX_HISTORY_BYTES`（默认 `600000`）。 |
| `CASCADE_MAX_HISTORY_BYTES` | `600000` | 非 1M 模型的历史字节预算（`client.js`，`positiveIntEnv`）。源码注释记着这个默认值的来历：早先是 400KB，**200KB 曾导致 30+ 轮工具调用的会话静默丢上下文**，所以调到 600KB 留出余量。调小之前先想清楚这一点。此前只作为上一行的说明文字出现，没有自己的条目。 |
| `CASCADE_MAX_WAIT_MS` | `600000` | Cascade 单次等待上限（`client.js`）。曾出现在 2.0.74 的 release notes 里，但没进过参考文档。 |
| `CASCADE_IDLE_GRACE_MS` | `8000` | 空闲宽限（`client.js`）。 |
| `CASCADE_COLD_STALL_BASE_MS` | `30000` | 冷启动停顿基数（`client.js`）。 |

## 一个必须保持关闭的（不是调优项）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEVIN_CONNECT_ACCOUNT_HOST` | 关 | 允许账号的 `apiServerUrl` 覆盖请求 host（`devin-connect.js` + `handlers/chat.js`，`=== '1'`）。**生产环境必须保持关闭。** 它当初是为"teams/自助 token 必须把 `GetChatMessage` 发去自己的 apiServerUrl"这个假设建的，而**实测抓包已经否证了该假设** —— 真实 teams CLI 也发往 `server.codeium.com`。代码只留着供逆向时强制指定 host，**不是修复手段**；指错 host 会直接让对话不可用。 |

### Cascade 停顿与轮询（`client.js` / `conversation-pool.js`，均 `positiveIntEnv`）

`positiveIntEnv` 的回落规则统一：**非正整数一律用默认值**，写 `0` 或负数不会"关掉"它。

| 变量 | 默认 | 说明 |
|---|---|---|
| `CASCADE_POLL_INTERVAL_MS` | `500` | 轮询间隔。调小会显著增加上游请求数。 |
| `CASCADE_WARM_STALL_MS` | `45000` | 已出过内容后的停顿判定。 |
| `CASCADE_WARM_STALL_THINKING_MS` | `120000` | 同上，但处于 thinking 阶段时用这个（更宽松，推理本来就慢）。 |
| `CASCADE_WARM_STALL_TOOL_ACTIVE_MS` | `180000` | 同上，工具执行中用这个（最宽松）。 |
| `CASCADE_TOOL_ACTIVE_GRACE_MS` | `60000` | 工具活跃的宽限窗口。 |
| `CASCADE_STALL_RETRY_MIN_TEXT` | `300` | 停顿重试要求的最小已出文本量（字符）。低于这个量才认为值得重试。 |
| `CASCADE_POOL_TTL_MS` | `1800000`（30 分钟） | 会话池条目存活时间（`conversation-pool.js`）。 |

### proto trace 的深度与截断上限（`proto-trace.js`，均 `positiveIntEnv`）

只在 `WINDSURFAPI_PROTO_TRACE` 开启后才有意义。调大全都是**放大输出体积**，
排查完记得调回去。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_PROTO_TRACE_DEPTH` | `8` | 递归解析深度上限（调用方显式传 `opts.maxDepth` 时以传入值为准）。 |
| `WINDSURFAPI_PROTO_TRACE_MAX_BYTES` | `524288`（512 KiB） | 单次 trace 的字节上限。 |
| `WINDSURFAPI_PROTO_TRACE_ERROR_DEPTH` | `4` | 错误路径单独的深度上限。 |
| `WINDSURFAPI_PROTO_TRACE_ERROR_STRING_LIMIT` | `8` | 错误里最多抽几个字符串。 |
| `WINDSURFAPI_PROTO_TRACE_SEMANTIC_FIELD_LIMIT` | `12` | 语义化输出保留的字段数。 |
| `WINDSURFAPI_PROTO_TRACE_SEMANTIC_STEP_LIMIT` | `40` | 语义化输出保留的步骤数。 |
| `WINDSURFAPI_PROTO_TRACE_READ_WRAPPER_CHILD_LIMIT` | `24` | read wrapper 展开的子字段数。 |
| `WINDSURFAPI_PROTO_TRACE_TOOL_CONFIG_UNKNOWN_LIMIT` | `24` | tool config 里未知字段的保留数。 |

## 熔断 / 限流 / 配额（`runtime-config.js` 表驱动，可热改）

这一组的特点是**同时能从环境变量和运行时配置改**（面板里也有），而且表里写着
`min`/`max` 边界，**超界会被夹回而不是报错** —— 所以设了个离谱的值不会有任何提示。
表在 `src/runtime-config.js`，每行形如
`{env: 'WINDSURFAPI_ERROR_STREAK_THRESHOLD', kind: 'int', def: 3, min: 1, max: 50}`。

下面只列本文档其他小节没覆盖的部分（`.env.example` 已收录的不重复）。

| 变量 | 默认 | 边界 | 说明 |
|---|---|---|---|
| `WINDSURFAPI_BREAKER` | **开**（`true`） | `bool` | 熔断总开关。关掉后下面所有 `BREAKER_*` 旋钮都不再起作用，坏账号也不会被摘掉。 |
| `WINDSURFAPI_ERROR_STREAK_THRESHOLD` | `3` | 1–50 | 连续几次错误把账号摘出去（`runtime-config.js` 的 `BREAKER_TUNABLES`，表驱动）。和下一行的窗口配对：**窗口内**攒到这个次数才熔断。此前只作为下一行的说明文字出现，没有自己的条目 —— 表驱动开关容易这样漏掉，因为按 `env.NAME` 搜不到它。 |
| `WINDSURFAPI_ERROR_WINDOW_MS` | `1800000`（30 分钟） | 1e3–8.64e7 | 错误计数的统计窗口，和 `ERROR_STREAK_THRESHOLD` 配对使用。 |
| `WINDSURFAPI_SPEND_ON_DEMAND` | **开**（`true`） | `bool` | 是否允许按需消费。**涉及真实花钱**，和下面的 `ON_DEMAND_RESERVE_USD` 是一套。 |
| `WINDSURFAPI_INTERNAL_ERROR_THRESHOLD` | `2` | 1–50 | 连续几次内部错误触发隔离。 |
| `WINDSURFAPI_INTERNAL_QUARANTINE_MS` | `120000` | 1e3–8.64e7 | 内部错误隔离时长。 |
| `WINDSURFAPI_ERROR_RECOVERY_MS` | `900000` | 1e3–8.64e7 | 错误计数的恢复窗口。 |
| `WINDSURFAPI_BREAKER_BASE_MS` | **`null`** | 1e3–8.64e7 | 熔断退避基数。默认 `null` 表示**不覆盖代码内的既有基数**，不是 0。 |
| `WINDSURFAPI_BREAKER_FACTOR` | `1.5` | 1.1–10 | 退避倍率（`float`）。 |
| `WINDSURFAPI_BREAKER_MAX_MS` | `3600000` | 1e3–8.64e7 | 退避上限。 |
| `WINDSURFAPI_BREAKER_STREAK_START` | `2` | 1–50 | 第几次连续失败开始退避。 |
| `WINDSURFAPI_NEW_ACCOUNT_GRACE_MS` | `600000` | 0–8.64e7 | 新账号宽限期。 |
| `WINDSURFAPI_LAST_ACCOUNT_EXEMPT` | **开**（`true`） | `bool` | 只剩最后一个账号时豁免熔断。**这是默认开的**，关掉意味着可能把全部账号熔断干净、服务完全不可用。 |
| `WINDSURFAPI_NEW_ACCOUNT_BASELINE` | **开**（`true`） | `bool` | 新账号建立基线。 |
| `WINDSURFAPI_QUOTA_COOLDOWN` | **开**（`true`） | `bool` | 配额冷却。 |
| `WINDSURFAPI_ON_DEMAND_RESERVE_USD` | `0` | 0–100000 | 按需消费的预留额度（`float`，美元）。**涉及真实花钱，改前想清楚。** |

至此三前缀开关 158 个全部有据可查：`.env.example` + README 覆盖 74 个（含 PR #249
的 `WINDSURFAPI_LEAK_TRACE`），本文覆盖其余 84 个。这个不变式由
[`test/docs-consistency-guard.test.js`](../test/docs-consistency-guard.test.js) 的
「every switch read in src/ is findable in some reader-facing doc」守着 ——
**加新开关不写文档会直接让测试变红**，不再依赖人记得。
