# 环境变量参考（补 .env.example 未收录的部分）

README 的表格列常用变量，[.env.example](../.env.example) 是完整清单 —— 两者合计覆盖
**93** 个。本文补齐**剩下 90 个只存在于源码里**的开关：注释很全，但运营翻不到。
（2026-10-26 按 master `f6b843fe` 用下面的全形式脚本重测：三前缀开关 **183**。
`.env.example` + README 覆盖 93，本文覆盖 90 —— 其中 5 个此前只写了缩写
（`..._PROVIDERS` / `..._ROUTES` / `..._CALLERS` / `..._ACCOUNTS` /
`..._WEBFETCH_AUTO_APPROVE_ORIGINS`），现已补成完整名字。旧口径是 5 种读取形式，
本树只数到 172，漏掉的 9 个见下。
2026-10-16 按 `d3f0490` 重测：全量 **157**。旧值 158 / 74 / 84 是 `ab4e66f` 树的口径：
`9031b9b` 把 `CASCADE_MAX_WAIT_MS` 写进 README（覆盖 +1），`054806a` 删掉一个开关的读取点
（全量 −1）。重测命令就是下面那段脚本。
2026-10-18 @`706fc11` 重测：**160**；新增 `WINDSURFAPI_STREAM_COMMIT_MS`、
`WINDSURFAPI_TOOL_HYGIENE` 与 `DEVIN_BACKEND_TOKEN` 三个读取点/文档项。
2026-10-22 在有界队列分支（base `e2c8547`）重测：**164**；新增
`DEVIN_CONNECT_MAX_QUEUE_FRAMES`、`DEVIN_CONNECT_MAX_QUEUE_BYTES` 与
`DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS` 三个读取点，同时收录进 `.env.example`
（故上句覆盖数 78→81）。
2026-10-23 在 `release/3.9.53`（base `432aee3`，合入 7 条分支）重测：**168**（base 实测 164，
本树按同一脚本重跑）。新增 4 个读取点：`WINDSURFAPI_CASCADE_TURN`
（`src/cascade-turn.js`，只开生产者 `CascadeTurn`，默认关）、
`DEVIN_CONNECT_PROSE_INTENT_DETECT`（`src/devin-connect-openai.js`，默认开，仅记日志）、
`WINDSURFAPI_HISTORY_BUDGET_TURNS` 与 `WINDSURFAPI_HISTORY_BUDGET_BYTES`
（`src/history-budget.js`，`const X = 'FOO'` 形式），后两者同时收录进 `.env.example`。
2026-10-26 在 master `f6b843fe` 重测：**183**（D9 新增 `WINDSURFAPI_UPDATE_ATTESTATION` 与
`WINDSURFAPI_ATTESTATION_DIR`）。旧的 5 形式脚本只数到 **172**；差额 9 个是
`csvListEnv`/`csvSetEnv`（7 个 `WINDSURFAPI_NATIVE_TOOL_BRIDGE_*`：`TOOLS`、`MODELS`、
`PROVIDERS`、`ROUTES`、`CALLERS`、`ACCOUNTS`、`WEBFETCH_AUTO_APPROVE_ORIGINS`，
`src/cascade-native-bridge.js:127-134`）和 `env?.NAME`（`WINDSURFAPI_REQUEST_BUDGET_MS`、
`WINDSURFAPI_REQUEST_BUDGET_STREAM_MS`，`src/request-budget.js:46,48`）。下面的脚本已补上
这两种形式；守卫仍只扫 5 种形式（`test/docs-consistency-guard.test.js:513-524`），所以它对
这 9 个是盲的 —— 本文把这 9 个全名都写出来，可用 `grep -F` 直接核对。
2026-11-09 在 `e0c5c715` 树增补 `WINDSURFAPI_MIN_CLIENT_RATE_BPS`
（`src/stream-writer.js`，bounded writer 的最短客户端吞吐假设）；只补文档，不改读取逻辑。

数开关**别用裸 `grep 'env\.'`**，有两个坑：一是 `WINDSURFAPI_TRACE` 这类名字是
`WINDSURFAPI_TRACE_DIR` 的前缀，正则不加边界会重复计数；二是**相当一部分读取点
不长得像 `env.FOO`** —— `positiveIntEnv('FOO', 默认)`（`client.js`/`proto-trace.js`/
`conversation-pool.js`）和 `runtime-config.js` 里 `{env: 'FOO', def: …}` 的表驱动写法
都是真读取点。只匹配 `env.FOO` 会漏掉 **59** 个（2026-10-26 按当前树重测：全量 183、裸 `env.` 124；2026-10-16 @d3f0490 时点为 157 / 112，差值 45）。正确数法：

```bash
python3 - <<'PY'
import re,pathlib,subprocess
files=[f for f in subprocess.run(['git','ls-files','src'],capture_output=True,
       text=True).stdout.split() if f.endswith('.js')]
PAT=re.compile(r"""(?:(?:process\.)?env\??\.([A-Z][A-Z0-9_]{2,})
                 |(?:process\.)?env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]
                 |(?:[A-Za-z_$][\w$]*Env|envGateAllows|positiveNumber|nonNegativeNumber)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]
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
print(len(names))   # 183（2026-10-26 按 f6b843fe 重测）
PY
```

后两种形式（`{env: 'FOO'}` 表驱动、`const X = 'FOO'` 后 `env[X]`）都是真读取点；
`csvListEnv` / `csvSetEnv` 这类 helper 和 `env?.NAME` 可选链同样会绕过锚在 `env.`
上的正则（2026-10-26 实测：只扫前五种形式会漏 9 个）。所以这份清单的数字**不要手抄**，
跑上面的脚本。

每个默认值都是**逐个打开源码站点读出来的**，不是按名字推断。文档写错默认值比没文档更坏，
所以标了取值位置，可自行核对。

通用约定：这些开关**只认精确的 `'1'` 或 `'0'`**，不认 `true` / `yes` / `on`。这是刻意的——
历史上 `Number()` / 真值重写把开关静默翻转过（#241、#242）。

## 应用磁盘日志

`src/dashboard/logger.js` 默认按 UTC 日期追加 app/error JSONL 文件，内存环形缓冲最多
1000 条。Dashboard 的“清空”仅清当前页面，日志导出来自内存，不读取历史磁盘文件。
`LOG_LEVEL` 只控制控制台输出，文件与 Dashboard 保留所有级别。

以下限制由 `src/dashboard/log-files.js` 读取，**默认全部关闭**。修改环境变量或 `.env`
后重启服务；只接受非负安全整数，空值、负数、小数、无效值及换算后溢出的值视为 `0`。
三项可以独立启用，例如：

```dotenv
LOG_RETENTION_DAYS=14
LOG_MAX_FILE_MB=20
LOG_MAX_TOTAL_MB=500
```

| 变量 | 默认 | 行为 |
|---|---|---|
| `LOG_RETENTION_DAYS` | `0`（关闭） | 保留 N 个 UTC 日历日期，包含当天和前 N-1 天；根据文件名日期判断，不依赖 mtime。启动、每小时及跨 UTC 日写入时删除过期日志。 |
| `LOG_MAX_FILE_MB` | `0`（关闭） | 每个新写入文件最多 N MiB（1 MiB = 1048576 字节）。按 UTF-8 字节计数，在完整 JSONL 行之间轮转为 `app-YYYY-MM-DD-000001.jsonl` 等。重启后继续最新分段。历史已有大文件不会被拆分。 |
| `LOG_MAX_TOTAL_MB` | `0`（关闭） | app/error 文件合计最多 N MiB。启动、每小时及写入前清理，按日期、分段序号、文件名顺序淘汰最旧文件。容量优先于保留期限，必要时可淘汰当天日志。warn/error 在两类文件中各写一份，两份均计入容量。 |

只清理 `DATA_DIR/logs/` 内匹配 `app-YYYY-MM-DD[-NNNNNN].jsonl` 或
`error-YYYY-MM-DD[-NNNNNN].jsonl` 的普通文件；未知文件、无效日期、符号链接和子目录保留，
不计入容量。单条记录若大于单文件或总容量上限，跳过磁盘写入，不拆成无效 JSONL；
内存、SSE 和控制台行为不变，控制台会提示写入/清理失败。IO 错误同样不阻断请求，后续写入会重试。

此策略要求每个日志目录只有一个进程写入；多副本需隔离各自的数据目录，不能把共享目录的
并发写入视为受全局容量约束。检查和删除失败时也不能保证硬容量上限，需处理目录权限和磁盘故障。
本功能不清理 `.trace/`、`.wire-dump/`、proto-trace、Language Server 自身日志或
Docker/PM2/stdout 日志；这些由各自的调试开关或部署层保留策略管理。

## 会放宽隔离的（优先了解）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CASCADE_REUSE_ALLOW_SHARED_API_KEY` | 关 | 允许**多个调用方共享同一个上游账号**时复用 Cascade 会话（`handlers/chat.js`，`=== '1'`）。上游会保留会话状态，所以开启后不同调用方有可能看到彼此的上下文。默认关是刻意的隔离边界，**多租户场景不要开**。 |
| `DEVIN_CONNECT_ALLOW_REMOTE_CRED_STORE` | 关 | 允许**非本机**请求写凭证库（`dashboard/api.js:889-895`，`=== '1'`）。默认路径要求本机 bind **且** 对端是 loopback；设成 `1` 后**任何已认证对端**都能写，loopback/监听地址检查被整个绕过 —— 这正是 `ALLOW_REMOTE` 的含义，不是"允许远程但仍要求 loopback"。 |

## think-leak 防线与身份中和（#250）

前两个默认**开**，关掉会让思维链泄漏到内容通道 —— 客户端看到重复文本或裸 `<think>` 标记。
第三个默认关，且当前不改变输出。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_CASCADE_THINK_REROUTE` | **开** | Cascade 路径把带 think 标记的开头内容改道到 reasoning 通道（`handlers/chat.js`，`\|\| '1') !== '0'`）。设 `0` 关闭。 |
| `DEVIN_ACP_CONFIG_OPTIONS` | 关 | ACP `session/new` 后按 `configOptions` 调用 `session/set_config_option` 设置模型（`devin-acp.js`，`=== '1'`）。默认关：live 的 option id/value 尚未校准。 |
| `WINDSURFAPI_TOOL_HYGIENE` | **开** | 三方言请求/历史/egress 的工具名与 ID 卫生（读取点 `src/tool-ids.js:301` 的 `toolHygieneEnabled()`，三个 handler 导入它）。设 `0` 关闭，回到原始透传。 |
| `WINDSURFAPI_STREAM_COMMIT_MS` | `5000` | OpenAI chat 流的提交门等待窗口（`server.js`，0 = 关闭门，最大钳到 14000）。窗口内只缓冲 comment/role-only 帧；首个真实内容或错误帧立即决定提交。设 `0` 回到旧的「先写 200」行为。 |
| `WINDSURFAPI_REASONING_DEDUP` | **开** | 抑制 reasoning 与 content 逐字重复的那一份。 |
| `WINDSURFAPI_NEUTRALIZE_CC_AGGRESSIVE` | 关 | 强制走 Claude Code 的激进中和分支（`handlers/identity-neutralize.js`，`\|\| '') === '1'`）。检测到 CC 客户端时该分支本来就会走，这个变量只是手动强制。**目前该分支是保留状态** —— 源码注释写明「no CC-only rewrites are confirmed yet」，所以开它当前不改变输出。 |

## native tool bridge

这一组只在排查 native tool call 链路时才用得上。全部默认关或有内置默认值。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT` | 关 | 对**所有**模型强制用 GPT 原生 tool call 方言，不再按模型族判断（`handlers/tool-emulation.js`，`=== '1'`）。排查方言选择时用。 |
| `WINDSURFAPI_NATIVE_BRIDGE_NO_EMUL` | 关 | 走 native bridge 时不再叠加 prompt 层的工具模拟（`=== '1'`）。用来区分「原生解码坏了」和「模拟层坏了」。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_POLL_AFTER_TOOL` | 关 | 交出 tool result 后主动再轮询一次上游（`client.js`，`=== '1'`）。只在 native 模式下有意义。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE` | 关 | 自动批准 read_url 抓取，不等确认（`client.js` 的 `isReadUrlAutoApproveAllowed`）。**光开这个不够** —— 还必须用 `WINDSURFAPI_NATIVE_TOOL_BRIDGE_WEBFETCH_AUTO_APPROVE_ORIGINS` 列出允许的 origin，名单为空时一律返回 false。双重门是刻意的：让模型自行发外部请求必须显式指定去哪。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_CONFIG_RAW` | 空 | 直接塞一段原始 bridge 配置（`windsurf.js`，`\|\| ''` 后 trim）。留空则用正常构造流程。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_ALLOWLIST_NAMES` | 空 | 覆盖工具白名单的名字，逗号分隔（`cascade-native-bridge.js` 的 `csvListEnv`）。留空用内置名单。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_TOOLS` / `WINDSURFAPI_NATIVE_TOOL_BRIDGE_MODELS` / `WINDSURFAPI_NATIVE_TOOL_BRIDGE_PROVIDERS` / `WINDSURFAPI_NATIVE_TOOL_BRIDGE_ROUTES` / `WINDSURFAPI_NATIVE_TOOL_BRIDGE_CALLERS` | 空（= 全放行） | native bridge 的灰名单门（`cascade-native-bridge.js:176-186` 的 `envGateAllows`，逗号分隔，支持 `*` 前缀和 `all`）。名单非空时只有匹配的 tool / model / provider / route / caller 才走 native bridge，否则报 `native_bridge_*_not_allowed`。`_TOOLS` 为空时退回内置白名单（`isNativeBridgeToolAllowed`，`:156-163`）。 |
| `WINDSURFAPI_NATIVE_TOOL_BRIDGE_API_KEYS` / `WINDSURFAPI_NATIVE_TOOL_BRIDGE_ACCOUNTS` | 空（= 不设门） | 两个额外门：`_API_KEYS` 非空时 caller key 必须带 `:api_key_allowed` 标记；`_ACCOUNTS` 非空时只允许列出的 accountId / id / email（`cascade-native-bridge.js:188-200`）。 |
| `WINDSURFAPI_NATIVE_BRIDGE_STATS_KEY_LIMIT` | `200` | 统计里最多保留多少个 key（`native-bridge-stats.js:32-36`，非有限值或 ≤0 时回落 200，**上限硬钳到 2000**）。 |
| `WINDSURFAPI_NATIVE_BRIDGE_DECISION_RING_SIZE` | `25` | 决策环形缓冲保留多少条（`native-bridge-stats.js:58-62`，回落 25，**上限硬钳到 200**）。调大能看更长的决策历史，但超过 200 无效。 |

## Cascade 可恢复 turn（默认关）

`WINDSURFAPI_CASCADE_TURN=1` 时，`cascadeChat` 的轮询核心走 `src/cascade-turn.js`
的生产者对象：它拥有 `stepOffset` / `pollFloor` / `yieldedByStep` / `thinkingByStep`
和重叠窗口，并在返回的 chunks 上附带 `turnSnapshot`。**默认关**，关时走原有内联
轮询，行为与返回形状都不变。快照缺逐 step 游标会被 `CascadeTurnCursorError` 拒绝
—— 只凭 `stepOffset` 恢复会读到 0 个 step（Q10 E2b：596 → 16,632 字符发生在同
三个 step 内）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_CASCADE_TURN` | 关 | 启用生产者级 `CascadeTurn`（`src/cascade-turn.js`，`=== '1'`）。P1 阶段只做状态抽取与懒恢复快照；默认关，开它只改变内部轮询状态的所有者，不改变输出。 |
| `WINDSURFAPI_CASCADE_DETACH` | 关 | 客户端断线后把 turn 冻结进 `src/detached-registry.js`，同一 body + 同一可信 scope 的重试认领并继续原轮询（`=== '1'`，且要求 `WINDSURFAPI_CASCADE_TURN=1`）。**默认关**：只有 per-user / `session:` scope 会生效，`api:<hash>` 等不可信 scope 不准入。快照 v2 携带 `generatorOffset`（元数据 RPC 从该 offset 起，避免把整条 cascade 历史重复计费）、`consumedThrough`（未消费完的批次拒绝 detach）、`sawActive`、`usageByStep`。条目 TTL 120s、全局 8 条 / 每 caller 2 条 / 单条 4 MiB / **全局合计 32 MiB**（`src/detached-registry.js:51-54`），**不持有 `beginLsUse` 租约**（只在本请求内持有）；没有后台泵、没有 completed-entry 回放。 |

**Detach P1 的计费规则（两条都必须成立）：** ① 恢复轮的
`GetCascadeTrajectoryGeneratorMetadata` 从快照的 `generatorOffset` 发起 —— 从 0
发起会把该 cascade 之前所有 turn 的 usage 一起计入（over-bill）；② 恢复轮没有
checkout 账号（`acct === null`），成功尾必须把 usage 记到条目 owner
（`currentApiKeyForId(entry.accountId)`），否则静默不记账（under-bill）。

**默认开关的门禁：** gate 2（`LS_MAX_INSTANCES=2` 下 N 并发 abort 不饿死 live
请求）由 `test/detach-ls-pool-pressure.test.js` 覆盖；gate 1 的两周
`serve/admit` 计数从 dashboard `/overview` 的 `detach` 块读取。测量步骤、判读
阈值与回滚条件见 `docs/DETACH-ROLLOUT.md`。

## 默认开的功能开关

这五个默认**开**，其中四个只能往「关」的方向调。它们都是「设 `0` 才关闭」的写法 ——
写成别的值（`false` / `off`）不生效，除 `RESPONSE_CACHE` 外都只认精确的 `'0'`。
`LS_PER_PROXY_USER` 是例外：未设置时按 sticky 用户名自动判定；`=1` 强制每个不同
username 分池，`=0` 关闭。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_ENV_LIFT` | **开** | 把调用方的环境上下文提升进 prompt（`handlers/chat.js`，`?? '1'` 后 `=== '0'` 关闭）。注意这个用 `?? '1'` 而不是 `\|\| '1'`，且会 trim + 转小写。 |
| `WINDSURFAPI_LS_PER_PROXY_USER` | **按 sticky 用户名自动开** | 默认不是无条件按用户分池：只有 proxy username 命中 `STICKY_USER_RE` 才独立一个 LS 实例（`langserver.js:222` 的 `_sid` / `-session-` / `-sticky` / `+ws_` / `^user-` / `-cc-xx` / `-country-` / `-zone-` 等标记；判定在 `:248-255`）。普通静态用户名（如 `alice`）默认共享 LS；`=1` 强制每个不同 username 一个实例；`=0` 完全关闭分池。 |
| `WINDSURFAPI_NLU_RECOVERY` | **开** | 意图抽取失败时走恢复路径（`handlers/intent-extractor.js`，`=== '0'` 时直接返回空数组）。 |
| `WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT` | **开** | 撞限流时自动回落到同族其它变体（`handlers/chat.js`，`=== '0'` 关闭）。关掉后限流直接报错给客户端。 |
| `WINDSURFAPI_RESPONSE_CACHE` | **开** | 响应缓存（`cache.js`）。链式兜底：`RESPONSE_CACHE_ENABLED ?? WINDSURFAPI_RESPONSE_CACHE ?? '1'`，所以前者优先。这个认多种关闭写法（`0`/`false`/`off`/`no`）。 |

## 源码 OTA 来源证明（D9）

`/self-update` 和 `update.sh` 在改动 Git 之前会校验 Release 资产
`release-attestation.json`：它由 release workflow 生成（tag、commit、tree、各资产
SHA-256），并用与二进制相同的 cosign keyless 身份签名成
`release-attestation.json.sigstore.json`。校验要求 attestation 的 commit 等于所选
tag peel 出来的 commit；不一致或签名无效时**两种模式都拒绝**。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_UPDATE_ATTESTATION` | `warn` | `warn`：attestation 存在就校验；缺失（没有资产、没有签名 bundle、没有 cosign、网络失败）只记 warning 并继续，保证老安装不需要 cosign 也能升级。`required`：缺失即拒绝更新。只认 `warn` / `required`，其他值直接拒绝启动这次更新。 |
| `WINDSURFAPI_ATTESTATION_DIR` | 空 | 预置目录，里面放 `release-attestation.json` 与 `release-attestation.json.sigstore.json`。用于离线/内网主机和 fork；不设则从 `dwgx/WindsurfAPI` 的 GitHub Release 下载。fork 的签名身份不是本仓库时只能预置，或保持默认 `warn`。 |

## trace / dump / 运维

排查时才开。几个会往磁盘写内容，注意目录别落进打包或提交范围。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_TRACE` | 关 | 是否写 trace（`trace.js`，`\|\| ''` 后 `=== '1'`）。注意它**不门控** `WINDSURFAPI_TRACE_DIR` —— `traceRoot()` 无条件读目录变量，只是没开 trace 时不往里写。排查完用 `node scripts/support-bundle.mjs` 把最近几个 trace 目录打包成 `support-bundle-<utc>.zip`（先脱敏文本/请求凭证，再跑 secret scan，命中即拒绝），见 README「出问题了先看这里」。 |
| `WINDSURFAPI_TRACE_DIR` | `<cwd>/.trace` | trace 落盘根目录（`trace.js` 的 `traceRoot()`，`devin-connect.js` 写上游 wire 字节时也读同一个变量）。每个请求一个子目录，按固定 leg 名分片：`01-client-req` / `02-routing` / `03-upstream-req` / `04-upstream-res` / `05-client-res`。**上一行说过它不受 `WINDSURFAPI_TRACE` 门控**；此前只作为那条说明的一部分出现，没有自己的条目。 |
| `WINDSURFAPI_PROTO_TRACE_DIR` | `/data/proto-trace` | proto trace 落盘目录（`\|\| '/data/proto-trace'`）。注意这是**绝对路径**默认值，和 `WINDSURFAPI_TRACE_DIR`（默认 `<cwd>/.trace`）不是一套。 |
| `WINDSURFAPI_PROTO_TRACE_STRINGS` | 关 | 把 proto 字段的**字符串内容**写进 trace（`proto-trace.js:816`，`=== '1'`）。关闭时只落 sha256，不落原文。开启后走 `redactPreview()` 脱敏（`proto-trace.js:50-54`）：命名密钥、邮箱、32+ 字符的高熵串分别替换成 `<redacted-secret>` / `<redacted-email>` / `<redacted-token>`，再截断到 240 字符。**即便如此，开启后 trace 里会有真实 prompt 片段**，排查完就关。 |
| `WINDSURFAPI_PROTO_TRACE_ERROR_STRINGS` | 关 | 出错时额外输出字符串内容（`=== '1'`）。和 `PROTO_TRACE_STRINGS` 一样走脱敏。 |
| `WINDSURFAPI_DUMP_SYSTEM_PROMPT` | 关 | 把最终发给上游的 system prompt 打出来（`windsurf.js`，`=== '1'`）。**会输出完整 prompt 内容**，排查完记得关。 |
| `WINDSURFAPI_PROBE_CANARY` | 关 | 发探针金丝雀请求（`=== '1'`）。校准脚本用。 |
| `WINDSURFAPI_STABLE_DEVICE` | 关（只认 `1`） | 稳定设备指纹模式，**不是种子**：`String(env.WINDSURFAPI_STABLE_DEVICE \|\| '') === '1'`（`auth.js:1199`）。种子由服务端每账号生成并持久化（`ensureDeviceSeed`，`auth.js:1208`，存 `accounts.json` 的 `deviceSeed`），环境变量无法指定。设成 `my-capture-seed` 之类的值等于没开，指纹仍每次随机；只有 `1` 才让同一账号跨请求呈现同一设备。 |
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

## 未经抓包证实的 wire 坐标（默认关，开之前先读这段）

这几个开关控制**往上游 protobuf 里写新字段**。它们的 tag 号来自第三方 `.proto`
文件里的**声明顺序**，不是抓包测出来的 —— 而 prost 允许 tag 跳号，所以
**声明顺序 ≠ wire tag**。写错 tag 的表现不是报错，而是上游按别的字段解读那段字节。

所以：**除表中明确注明的家族级例外外，默认关是刻意的，不要因为"看起来该开"就打开**。
一次真实付费抓包能一起解锁这一组；在那之前，开了就得自己承担猜错 tag 的后果。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEVIN_CONNECT_PROMPT_CACHE` | gpt-6 家族开，其余关 | 往请求里写 prompt 缓存字段（`devin-connect.js`）。tag `#13` 猜自声明顺序。`1` = 所有家族开；`0`/其他非空值 = 全关；**未设置**时只对 gpt-6 家族默认开 —— 正则 `^(?:gpt-6\|gpt6)(?:[.-]1)?-(?:luna\|sol\|astra)(?:-\|$)`（`devin-connect.js:1482`），即 `gpt-6-*` / `gpt6-*` 的 luna/sol/astra，含 `gpt-6-1-*`、`gpt6.1-*` 变体。2026-10-23 实测五次相同 `gpt-6-luna-max` 请求每轮都报 cache-write 3984、cache-read 0，而 Claude 每轮读 6884，所以先让这个家族带上唯一的缓存控制字段去验证「是否必须」；读仍为 0 且写继续计数时，下一个怀疑对象是 tag 映射而不是本开关。 |
| `DEVIN_CONNECT_TOOL_CHOICE` | 关 | 发送 `tool_choice`（`=== '1'`）。tag `#12`/`#11` 同样猜自声明顺序。**关着的时候 `parallel_tool_calls:false` 照常放行，但提示不会被兑现**：请求被正常服务，上游可能在一个 turn 里返回多个 tool call；代理每个进程打一次 warn（`event=parallel_tool_calls_hint_ignored`，点名这个开关），并在 `/connect-metrics` 的 `parallel_tool_calls_hint_ignored` 计数里累加每一次（`handlers/chat.js`，只作用于 DEVIN_CONNECT 流；`true`/不传不计数也不告警；`/v1/messages` 的 `tool_choice.disable_parallel_tool_use` 映射成同一字段）。**绝不返回 400**：这是调用方的偏好而非正确性要求，而且 Codex CLI 0.164 每个请求都发这个字段（29/29），v3.10.x 的 400 让它在第一轮就 `turn.failed` 退出（`evidence/ClientSandboxes.md` §3.3 C1）。想让提示真正生效：开这个开关（或先抓包校准 tag），然后看计数是否归零。 |
| `DEVIN_CONNECT_TOOL_CHOICE_TAGS` | 空（= 用内置默认 tag） | 覆盖上面两个 tag，格式 `choice=N,parallel=M`（`getToolChoiceTags`）。**只认 `choice`/`parallel` 两个键**，其他键、非正整数、以及**撞上已占用 tag 的值**都会被跳过并打 warn，然后保留默认 —— 不是报错。撞 tag 的后果很隐蔽：`choice=1` 会和 814 字节的 `ClientMetadata` 同占 `#1`，protobuf 解码器取最后一个，等于**用 tool_choice 覆盖上游认证元数据**，表现为**认证失败**而不是"配置写错了"。这个防护是修过的真实缺陷，别绕过它。 |
| `DEVIN_CONNECT_SIGNATURE_TAG` | 空（= 整个解码关闭） | thinking `delta_signature` 的 tag。**这个是这组的总开关**：没设或不是 `(0, 2^29)` 内的整数时 `parseSignatureTagMap()` 返回 `null`，下面两个一起失效。 |
| `DEVIN_CONNECT_SIGNATURE_TYPE_TAG` | 空（= 该字段不解码） | signature `type` 的 tag，同样要求 `(0, 2^29)`。只在上一个已生效时才有意义。 |
| `DEVIN_CONNECT_SIGNATURE_THINKING_ID_TAG` | 空（= 该字段不解码） | signature `thinking_id` 的 tag，约束同上。 |
| `DEVIN_CONNECT_REPLAY_SIGNED_THINKING` | 关 | 设 `1` 后，`/v1/messages` 历史里**带签名**的 Claude thinking 块不再丢弃，而是在 assistant 消息上（工具调用轮和纯文本轮都包括）以 `#11` thinking 加 `#12` signature 原生回放（`=== '1'`）。2026-10-28 在 claude-opus-5-5 上实测：上游会校验签名（改一个字符即 `invalid_argument`），校验通过后模型在工具循环内能读到上一步的 thinking（秘密数字召回 2/2；只发 `#11` 不带签名 0/3）。用户发新消息之后同样有效（Opus 4.5 及以上本来就保留历史轮 thinking；强制作答对照下回放 3/3 召回，不回放 0/4），Devin 自家 CLI 也是这样。需要同时设 `DEVIN_CONNECT_SIGNATURE_TAG=10`，否则客户端拿不到签名、也就没有东西可回放。代理触发 rescue 重试的那一轮同样可回放：签名和 reasoning 一起缓冲，被放弃的尝试连同签名一起丢弃，最终那次尝试带自己的签名（签名与生成时的上下文无关，带 nudge 生成的签名回放进不含 nudge 的历史可被接受）。代价是每个工具轮多出约 1 到 2KB 的签名加 thinking 原文。只支持 Claude 家族、每个 assistant turn 一个不带 `#` 前缀且结构有效的 E/R/C/Q 签名段；其他 envelope 返回 400，带签名工具历史缺少 native tags 时也返回 400 而不退化为 emulation。多个输入 thinking 块与 `redacted_thinking` 不回放，`signatureType`/`thinkingId` 不传播；非流式 reasoning-only 回答提升为可见文本时不带签名。上游响应签名不做本地 envelope 拒绝，回放时由上游验证真实性。 |
| `DEVIN_CONNECT_USER_JWT` | 关 | 用 `GetUserJwt` 短期凭证走 devin-connect 路径（`=== '1'`）。写进 `Metadata #21`，tag 也来自声明顺序。 |
| `WINDSURFAPI_USER_JWT` | 关 | 同一个功能在 **Cascade 路径**的开关（`windsurf-api.js`，`=== '1'`）。两条路径各自独立，开一个不影响另一个。JWT 不落盘，剩余 TTL 低于 5 分钟（`USER_JWT_MIN_TTL_MS`）会重新领。 |

## 数值上限与超时（有非零默认值，改了会影响所有请求）

这些不是布尔开关，默认值都是实测或历史沿用下来的。**它们的回落逻辑不一样** ——
有的校验 `Number.isInteger` 有的只校验 `Number.isFinite`，写非法值时的行为要看具体那行。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEVIN_CONNECT_WIRE_MAX_TOKENS` | `8192` | 请求里 `max_tokens` 的默认值（`devin-connect.js`，要求正整数否则回落 8192）。和 `handlers/messages.js`、`gemini.js` 里的 `\|\| 8192` 是一套。**在模块加载时求值一次**，改它要重启。 |
| `DEVIN_CONNECT_CATALOG_TTL_MS` | `300000`（5 分钟） | 每账号成功在线目录的复用时长（`auth.js`，有限数且 `>=10000` 才接受，否则回落 5 分钟）。TTL 内复用 last-known-good；过期后并行按账号刷新。空响应和失败不覆盖已有目录，也不推进成功时间。 |
| `DEVIN_CONNECT_MAX_INFLIGHT_PER_ACCOUNT` | `0`（关闭） | 单账号并发在途请求硬上限（`auth.js`，非负安全整数；`0` = 不改变选择）。设为 `N > 0` 时，账号选择跳过已达 N 个在途请求的账号（含 sticky 绑定），让突发流量分散或 429，而不是继续堆在单账号。陈旧计数由 15 分钟下限的清扫回收。 |
| `DEVIN_CONNECT_MAX_QUEUE_FRAMES` | `4096` | DEVIN_CONNECT 流解码后事件队列的帧数上限（`devin-connect.js` 的 `streamChat`，`positiveIntEnv`，非正整数回落 4096）。队列到一半时 `res.pause()` 把背压交给 TCP；单个 chunk 仍把队列推过上限时以 `QUEUE_OVERFLOW` 失败并丢弃已缓冲事件（pause 拦不住同一个同步循环）。低于高水位时事件序列与暂停行为都不变。 |
| `DEVIN_CONNECT_MAX_QUEUE_BYTES` | `8388608`（8 MiB） | 同一队列的字节上限（`devin-connect.js`，`positiveIntEnv`）。按事件估算：文本长度 ×2 + reasoning 签名长度 ×2 + hex dump 长度 + 每事件 96 字节；与上一行任一先到即触发同样的 `QUEUE_OVERFLOW`。 |
| `DEVIN_CONNECT_RELOGIN_QUEUE_TIMEOUT_MS` | `60000`（60 秒） | 全局重登并发门（`auth.js` 的 `acquireReloginSlot`，`positiveIntEnv`）里排队等槽位的最长时间。超时后 waiter 从 FIFO 移除、该次 `reLoginAccount` 返回 `false`，不再无限挂起；持有槽位的登录本身不受此限制。调用方传 `AbortSignal` 可提前取消排队。 |
| `WINDSURFAPI_TOOL_DESC_MAX` | `500` | 工具描述的字符上限（`toolDescMax()`，要求 `>= 0` 的有限数否则回落 500）。**`0` = 不限长**，不是"全砍掉"。**当前不生效**：`capToolDescription` 已不再被 `encodeToolDef` 调用，变量只是保留的逃生口（`devin-connect.js:948-961`）。 |
| `CASCADE_1M_HISTORY_BYTES` | `900000` | 1M 上下文模型的历史字节预算（`client.js`，`positiveIntEnv`）。非 1M 模型走 `CASCADE_MAX_HISTORY_BYTES`（默认 `600000`）。 |
| `CASCADE_MAX_HISTORY_BYTES` | `600000` | 非 1M 模型的历史字节预算（`client.js`，`positiveIntEnv`）。源码注释记着这个默认值的来历：早先是 400KB，**200KB 曾导致 30+ 轮工具调用的会话静默丢上下文**，所以调到 600KB 留出余量。调小之前先想清楚这一点。此前只作为上一行的说明文字出现，没有自己的条目。 |
| `CASCADE_MAX_HISTORY_IMAGES` | `4` | 重放历史里最多附带几张历史图片（`client.js`，非负整数；`0` = 一张都不附带，非法值回落 4）。`SendUserCascadeMessage` 的历史是一个文本块（field 2），图片只能是消息级扁平 `repeated ImageData`（field 6），所以旧轮次的图片只能整体挂在同一条消息上、靠文本里的编号标记对应。按轮次从新到旧取，超出的会打一条 `cascade_image_history_dropped` WARN 并计数（dashboard `/connect-metrics` 的 `cascadeImages`），不再静默变成 `[Image omitted from text history]`。NO_TOOL 模式（有 `toolPreamble` 且未开 native bridge）不渲染 field 6，此时历史图按 `no_vision` 丢弃并计数。 |
| `CASCADE_MAX_HISTORY_IMAGE_BYTES` | `1600000` | 历史图片的 base64 字节上限（`client.js`，非负整数；`0` = 等同于不允许历史图，非法值回落 1600000）。与上一行的数量上限任一先到即停止附带，同样从新到旧取舍；`image.js` 的 400 KB 重编码目标决定了 4 张 ≈ 1.6 MB，所以两个默认值是一套。 |
| `WINDSURFAPI_HISTORY_BUDGET_TURNS` | `100` | **出站**历史预算的轮数上限（`history-budget.js`，非负整数；`0` = 关闭该维度，非法值回落 100）。`turns` 是 `messages.length`：`messages` 里的 system 轮次照常计入，顶层 `system` 字段不单独计一轮。在共享 chat 层、任何上游调用之前检查：超过即打一条带实测数字的 `WARN`，并返回 `413 payload_too_large`（`code: history_budget_exceeded`）。默认值取在实测死亡线之下 —— #136/#191 的 113 轮 / 128 KB 会话会在流中途被上游 `context deadline exceeded` 掐断，客户端已经收到半截字节且无法干净重试。注意它与 `CASCADE_MAX_HISTORY_BYTES` 是两层：后者只裁剪 Cascade 历史后缀（并且永远保留最新一轮），DEVIN_CONNECT 路径没有对应物，两者都不是准入检查。 |
| `WINDSURFAPI_HISTORY_BUDGET_BYTES` | `8000000`（8 MB） | 同一预算的字节上限（`history-budget.js`，非负整数；`0` = 关闭，非法值回落 8 MB）。统计 `messages` 里编码器会写出的载荷字段（content 文本/非文本部件、tool_calls 的 id/name/arguments、reasoning_content、name、tool_call_id）与 `tools[]` 的 JSON schema 的 UTF-8 字节；**顶层 `system` 字段不计入**（`messages` 里的 system 轮次按普通消息计入），不含传输框架 —— 是线上体积的**下界**，不是估计值。默认值压在入口 10 MB 上限之下、又高于 1M 模型的 900 KB 历史预算，所以它拦的是病态载荷（例如单条 10 MB 粘贴），不会拦正常会被裁剪的大转录。任一维度超限即拒绝。 |
| `CASCADE_MAX_WAIT_MS` | `600000` | Cascade 单次等待上限（`client.js`）。曾只出现在 2.0.74 的 release notes 里；`9031b9b` 起 README 两语的 FAQ 也点名了它（`README.md:745` / `README.en.md:630`，cold stall 的封顶值）—— 本文不再是它唯一的落点。 |
| `CASCADE_IDLE_GRACE_MS` | `8000` | 空闲宽限（`client.js`）。 |
| `CASCADE_COLD_STALL_BASE_MS` | `30000` | 冷启动停顿基数（`client.js`）。 |
| `WINDSURFAPI_MAX_DRAIN_MS` | `30000`（30 秒，固定部分） | SSE 写端背压的**固定**等待部分（解析点 `src/stream-writer.js` 的 `MAX_DRAIN_WAIT_DEFAULT_MS` / `resolveMaxDrainWaitMs`，chat/connect 的 bounded writer 共用）。一次 drain 等待的总预算是 `固定值 + 待排空字节 / WINDSURFAPI_MIN_CLIENT_RATE_BPS`，其中只有 `res.write()` 返回 `false` 的未确认字节才计费；收到 `drain` 后待排空字节清零、计时器撤销。半开客户端（不再读、TCP 还开着）永远不发 `drain`，预算耗尽就尽力写一帧 `DRAIN_TIMEOUT` 错误、中止该流并归还账号租约。要求正整数，否则回落 30000；计时器延迟钳到 Node 的 `2^31-1` ms 上限，避免大字节数/极小速率把延迟溢出成 1 ms。 |
| `WINDSURFAPI_MIN_CLIENT_RATE_BPS` | `8192`（8 KiB/s） | SSE 写端背压预算的最短客户端吞吐假设（解析点 `src/stream-writer.js` 的 `MIN_CLIENT_RATE_ENV` / `resolveMinClientRateBps`，chat/connect 的 bounded writer 共用）。每次背压按**待排空字节**计费：`预算 = WINDSURFAPI_MAX_DRAIN_MS 固定值 + pendingBytes / rate`，`drain` 到达后清零；5 MB 的慢读帧因此拿到约 640 s 的按字节预算，而停住的 4 KB 帧只在固定 30 s 附近中止。要求正整数，否则回落 8192。 |
| `WINDSURFAPI_REQUEST_BUDGET_MS` | `600000`（10 分钟） | 单请求绝对截止时间（`request-budget.js`，由 `server.js` 的路由在进入 handler 前创建为 `context.budget`）。账号队列等待、Cascade 轮询窗口（`maxWaitMs`）、connect 流 `deadlineMs` 与各层退避都只能缩短到剩余时间；到期后不再发起新的上游轮次，返回 504。每请求上游轮次硬上限 6（`DEFAULT_UPSTREAM_TURN_CAP`，暂不开放环境变量）。要求正数，否则回落 600000。 |
| `WINDSURFAPI_REQUEST_BUDGET_STREAM_MS` | `300000`（5 分钟） | 流式请求在上一行基础上额外允许的时间，两者相加即流式预算（默认 15 分钟）。要求非负数；`0` = 与基础预算相同，非法值回落 300000。 |

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

## Language Server 安装（`install-ls.sh`，不是服务运行时开关）

这些变量只被 `install-ls.sh` 读取；写进 `.env` 不会影响已经运行的服务，
请在命令行前设置（例如 `WINDSURFAPI_LS_VERSION=3.10.67 bash install-ls.sh`）。
默认路径是「上游 manifest → `ls-pins.json` 固定版本 → archive + 内层 binary
双 sha256 校验」，任何不符都退出非 0，没有静默回退。

| 变量 | 默认 | 说明 |
|---|---|---|
| `WINDSURFAPI_LS_VERSION` | 空 | 固定到某个版本。必须在 `ls-pins.json` 里；否则要显式 `--allow-unpinned`。 |
| `WINDSURFAPI_LS_CHANNEL` | `stable` | `stable` / `next`，决定默认 manifest。 |
| `WINDSURFAPI_LS_MANIFEST_URL` | 空（按 channel 推导） | 覆盖 manifest URL；也接受本地路径（测试/离线）。 |
| `WINDSURFAPI_LS_PINS` | 脚本同目录 `ls-pins.json` | 信任锚文件；改它等于改安装来源。 |
| `WINDSURFAPI_LS_ALLOW_MIRROR` | `0` | `1` 才允许 3.5.17 的 mirror 回滚 pin（`--rollback` 会隐含打开）。 |
| `WINDSURFAPI_LS_ALLOW_UNPINNED` | `0` | `1` 才允许安装 pin 里没有的版本；archive 仍按 manifest 校验，内层 hash 只记录不比对。 |
| `WINDSURFAPI_LS_PLATFORM` | 自动检测 | 覆盖目标平台（`linux-x64` / `linux-arm64` / `darwin-arm64` / `darwin-x64`），主要用于测试。 |
| `LS_INSTALL_PATH` | 平台默认路径 | 安装目标。 |

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

至此三前缀开关 **183** 个全部有据可查（2026-10-26 按 master `f6b843fe` 用上面的全形式脚本
重测；旧的 5 形式脚本在同树只数到 172，漏掉的 9 个见文首）：`.env.example` + README 覆盖
93 个（含 PR #249 的 `WINDSURFAPI_LEAK_TRACE` 与 D9 的两个 attestation 开关），本文覆盖其余 90 个。这个不变式由
[`test/docs-consistency-guard.test.js`](../test/docs-consistency-guard.test.js) 的
「every switch read in src/ is findable in some reader-facing doc」守着 ——
**加新开关不写文档会直接让测试变红**。注意守卫只认 5 种读取形式
（`test/docs-consistency-guard.test.js:513-524`），对 `csvListEnv`/`csvSetEnv`、`envGateAllows`
和 `env?.NAME` 是盲的；这 9 个名字本文已写全，但不能把守卫的绿色当成它们的证明。
