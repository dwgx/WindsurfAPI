# v3.141.592659

自 `v3.141.592658`（`08a750d1`）以来，审计分支累计 **36 个提交 / 45 个文件**
（`git rev-list --count v3.141.592658..deeb2539`；`git diff --shortstat
v3.141.592658..deeb2539`：4,996 增 / 501 删）。产品变更集中在 `src/` 下 **6 个文件**：
`client.js`、`dashboard/api.js`、`handlers/identity-neutralize.js`、`handlers/messages.js`、
`image.js`、`server.js`。本版是 **patch**：默认路径的请求字节相对 `v3.141.592658` 仍是
**270/270 逐字节一致、0 差异**，没有协议兼容性破坏。

> **版本号**：`3.141.592658` 之后的 patch，语义化版本写作 **3.141.592659**（tag
> `v3.141.592659`，本文件 `RELEASE_NOTES_3.141.592659.md`）。发布提交、认证树、逐项门禁
> 计数与 skip 名单见同日验收附录 [`ACCEPTANCE_3.141.592659.md`](ACCEPTANCE_3.141.592659.md)
> —— 本文件只写内容与边界，附录是本次认证的唯一计数来源。

## Post-release hardening `c4931c40`（2026-11-09）

发布提交 `e0c5c715` 之后，审计分支追加 `c4931c40`（`fix(release): close audit and ecosystem
gaps`，49 文件 / +5,010 −324），收口审计波剩余缺口：auth/server（Anthropic 401 形状、载体按
surface 收窄、压缩体 415、selector 维度冷却、Gemini server-side tool 400）、streaming（拼接
SSE JSON、队列字节预算、按未确认字节计 drain、history 预算改为 messages+tools）、responses
（`encrypted_content`、`verbosity` 边界、custom-tool input delta/id）、identity/CTX（每条
`clear_thinking` 校验、catalogue 仅删 ID 正文）、connect（Chat 工具名净化、截断信号、session
连续性拼写、流式反查）。全量 release shard 在 `c4931c40` 上 **616 文件 / 7,603 测试 / 7,500
通过 / 0 失败 / 103 跳过 / 847.7 s，exit 0**（`wave4-test-release.log`）。这是 hardening
提交，**不是新 tag**：`v3.141.592659` 仍未创建，也没有 push/部署。

## Post-release 增补：复审修复波与范围更正（2026-11-10）

**范围更正。** §0 与文首的计数（36 提交 / 45 文件 / +4,996 −501 / 6 个 `src/` 文件）
度量的是 `v3.141.592658..deeb2539` 审计分支在发布提交前的冻结范围，**不包含**
`e0c5c715` 之后的 hardening 与复审修复。发布提交之后本分支另有 **24 个提交 /
64 个文件 / +6,627 −400 / 16 个 `src/` 文件**（`git rev-list --count
e0c5c715..4b061af1`；`git diff --shortstat e0c5c715..4b061af1`；
`git diff --name-only e0c5c715..4b061af1 -- src | wc -l`）：`c4931c40`（审计收口，
49 文件 / +5,010 −324）、`0aea4ea3`（connect 显式错误终止与 catalogue 边界）、
`911e6674` / `d0359733`（纯文档）、复审修复波 `04503830`–`4b061af1`（含 spec
基线重钉与文档订正）共 20 个提交。
逐提交证据记入验收附录的增补段（acceptance addendum，另行补写）；本文件只登记
范围与用户可见变化。

**tag 目标。** `v3.141.592659` 必须打在合并后的 master tip 上（流程：把
`origin/master` 合入本分支 → `master --ff-only` → 在 master tip 打 annotated tag →
push），**不是** `e0c5c715`——否则 `c4931c40`/`0aea4ea3` 与复审修复会被关在版本外。
写作时分支 HEAD 为 `4b061af1`，其后 `8e89af65`/`1490fe10` 只动 docs/test/mutation；
最后一个改 `src/` 的提交是 `5fb21e70`。最终 tag 目标记作 `<merge-tip>`，以合并
提交的实际 SHA 为准。

**复审修复波的用户可见变化**（`04503830`–`5fb21e70`，按面分组；`c4931c40` 已覆盖的
面见上节）：

- **auth/server**：`/v1/messages` 的 401 改用 Anthropic 错误形状（`type:'error'` +
  `authentication_error` + `request-id`）；Gemini 面（`/v1beta/*` 与
  `/v1/models/*:generateContent` 别名）的 401 改用 Gemini `UNAUTHENTICATED` 信封；
  凭据载体按 surface 收窄——`x-api-key` 不再能打开 `/v1/chat/completions`、
  `/v1/completions`、`/v1/responses`（这些面只认 Bearer），`x-goog-api-key` 与
  `?key=` 只在 `/v1/models` 与 Gemini 面有效，Bearer 处处有效，错配载体一律 401；
  压缩请求体按面返回 415 `unsupported_content_encoding`（不再是含混的 400）。
- **streaming**：SSE 队列字节预算改为只计行开销（修复 64 MB 帧帽被 8 MB 预算提前
  触发的回归；载荷仍由 64 MB 帧帽约束）；drain 等待的固定下限锚定在等待开始时刻，
  不再被后续背压帧无限推后，且按未确认字节计的比例预算封顶在
  `MAX_DRAIN_BUDGETED_BYTES`（4 MiB——默认速率下约 8.5 分钟），半开死连接不再
  按积压总量换无限等待（`5fb21e70`）；`c4931c40` 新增的
  `WINDSURFAPI_MIN_CLIENT_RATE_BPS`（默认 8192 B/s）给按字节背压预算定最短
  客户端吞吐假设。
- **responses**：`finish_reason:'error'` 一旦记录即终态，后续 chunk 不再把轮次降级为
  `response.completed`；未正常终止/出错轮次的 tool-call item 标 `incomplete`，
  且流式路径在 `finish()` 里封口的全部 item（message/reasoning/function_call）
  在失败轮次同样标 `incomplete`，与非流式一致（`5fb21e70`）；客户端断连时
  responses 的 capture shim 同样 dispose 有界 writer 与 SSE framer
  （`5fb21e70`）；blob-only reasoning 不再发空 `summary_text.done`；同一轮里
  无签名文本与签名 reasoning 共存时丢弃回放签名（`41c560f6`）。
- **messages**：缺省 `keep` 按模型族解析——keep-all 家族（Opus 4.5+/5、Sonnet 4.6+/5、
  Fable）照旧接受，其余模型（含无法分类的名字）按保守 keep-1 校验，宁可多拒不漏放；
  `redacted_thinking` 计入 keep 窗口；`{keep:{type:'all'}}` 与 `keep:'all'` 等价接受；
  非字符串 `model` 返回 400，translator 抛出的 400 补齐 `type:'error'`。
- **gemini**：`googleSearch`/`googleSearchRetrieval`/`codeExecution`/`urlContext`
  按键存在性拒绝（`{googleSearch:false}` 等 falsy 声明同样拒绝），返回 400
  `unsupported_server_side_tool`；未列入拒绝集的 server-side 工具
  （`googleMaps`/`fileSearch`/`computerUse`/`mcpServers`）丢弃时按请求 warn 留痕。
- **connect**：`0aea4ea3` 让显式错误 stop reason 优先于可解码 tool call 保留为
  `finish_reason=error`，chat/completions、messages、responses、gemini 四个协议面一致；
  catalogue 正文要求真实模型 ID 边界（`claude-3d.example.com`、
  `claude-1password.example.com`、`claude-opus.example.com` 等散文/主机形状不再误吞
  调用方文本）。
- **identity**：catalogue 行内 ID 扫描改为每行 memo（512 KiB 单行 3,439 ms → ~21 ms，
  消掉 `04503830` 复审发现的 anchors×line 二次复杂度）；`claude-` ID 语法收紧为
  封闭词表 + 干净边界；`isHorizontalSpaceCode` 恢复 `\s` 全类（除 LF）。
- **client/image**：prepend 进 Cascade 的 system prompt 在 fresh 单轮、多轮与 resume
  重建三处统一转义 `</human>`/`</assistant>` 闭合标签；`extractImages` 在最后一个块
  之后也拒绝已取消的轮次；translator SSE framer 在客户端断连时 dispose。

## 0. 范围

| 项 | 值 | 命令 |
|---|---|---|
| 提交 | **36**（截至审计分支 HEAD `deeb2539`；发布侧再加 2 个只动测试/版本/文档的提交：`bb81fa16` 与本发布提交） | `git rev-list --count v3.141.592658..deeb2539` |
| 文件 | **45**（+4,996 / −501） | `git diff --shortstat v3.141.592658..deeb2539` |
| 净产品变更 | **6 个 `src/` 文件** | `git diff --name-only v3.141.592658..deeb2539 -- src` |
| 测试 | 26 个文件 | `git diff --name-only v3.141.592658..deeb2539 -- test \| wc -l` |
| 文档 | 9 个文件 | `git diff --name-only v3.141.592658..deeb2539 -- docs \| wc -l` |

范围里的提交包含 master 合并 PR #282 的提交（`3816a47a` 及其第二父链）。这些内容在
`v3.141.592658` 的树里已经存在：`git diff --quiet v3.141.592658..HEAD -- src/devin-connect.js
src/claude-signature.js src/history-budget.js src/handlers/chat.js` → **exit 0**。所以本版对
已发布树的产品差异只有上面 6 个文件，不是把 #282 再发一次。

## 1. 修了什么

### 1.1 身份中和器：从“能让整个服务停摆”改为有界线性扫描（WA-001）

身份中和器（`src/handlers/identity-neutralize.js`）在每条请求的 system prompt 上运行，把
Windsurf/Devin 的客户端指纹改写成中性文本。旧实现用 9 条正则，其中多条带重叠的 `\s*` 量词；
在连续空行输入上呈**立方**增长，而函数是同步的、跑在服务唯一的 event-loop 线程上 —— 一次
请求就能让所有客户端一起等待（CWE-1333）。

在 HMC 上用**已部署的 3.141.592658 模块**（与生产 `sha256` 逐字节相同，隔离 `/tmp` 副本，
从未把 payload 发给 `:18999`）测得：

| 输入 | 旧模块耗时 |
|---|---|
| 513 B（`'\n'×512 + 'X'`） | 33.0 ms |
| 1,025 B | 253.2 ms |
| 2,049 B | 2,028.5 ms |
| 4,097 B | 16,097.1 ms |
| 65,537 B | 240 s 上限被杀，未完成 |

本版把 11 条高风险规则改为一次性线性扫描（`applySpans`），复杂度 O(规则数 × 文本长度)；
其余 11 条正则规则保留并做了静态边界说明（见 §4 的诚实边界）。本机实测（Windows，
Node 24.19.0）：

| 形状 | 旧实现 | 本版 | 测试上界 |
|---|---|---|---|
| 2,049 B 连续空行 | 1,140 ms | **2.57 ms** | 100 ms |
| 512 KiB brand（单锚点） | 8,619 ms | **11.88 ms** | 500 ms |
| 512 KiB 未闭合 care 段 | 703 ms | **15.60 ms** | 500 ms |
| 512 KiB 连续空行 | >300 s（超时） | **26.88 ms** | 500 ms |

影响面：所有经过身份中和的 system prompt；没有开关，默认生效。
`test/identity-neutralize-complexity.test.js` 把这四个形状连同 512 KiB Unicode 前缀一起钉住
（9 个用例）。

### 1.2 段落边界：不再跨段删除调用方内容（WA-002）

旧规则用 `\n(?!\s*\n)` 定义段落边界；`\s` 包含 NBSP、U+3000、U+2003、FF、VT 等。线性改写
的第一版 `paragraphEndAt` 只把空格/Tab/CR 当空行，于是**由 Unicode 空白组成的空行不再算
段落边界**，span 会跨过它、在下一段找到终止符，把中间的调用方 `RULE:` 行一起删掉 —— 正是
WA-002 要防的形状。

修复：`paragraphEndAt` 用与 `\s` 等价的 `isSpaceCode`（除 LF 外的 **24 个**空白码元）判定
空行；span 不越过段落边界。2 万例差分（旧模块 vs 本版，12 种分隔符）：

- Unicode 分隔符语料：旧保留 `RULE` 而新版丢失的例数 **85 → 17**；17 例全部是设计上全局的
  `b-security-line` 形状（`RULE` 文本与第二个 `IMPORTANT:` 锚点在同一行），**0 例无法解释**。
- ASCII 语料：**26 → 26**，没有新增删除。
- 已知、刻意保留的取舍：`b-security-line` 会改写同一行上所有指纹；`IMPORTANT:` 与其短语被
  空行隔开时，现在**保留短语**而不是跨段删除（防守换保守，测试钉住）。

### 1.3 FREEFORM 只在 apply_patch 描述里改写（WA-003 / H2）

旧 `a7-freeform` 无条件改写所有 `FREEFORM` 词元：SQL 枚举 `kind IN ('FREEFORM', …)`、JS
标识符 `mode === FREEFORM` 都会被静默改成 `free-form`。

本版改为来源边界：只有同一行出现 apply_patch 描述里的子句
`do not wrap the patch in JSON`（大小写不敏感）时，才改写该行的大写 `FREEFORM` 词元
（**大小写敏感**：小写 `freeform` 是调用方内容 —— SQL 类型名、列名、标识符 —— 原样保留）；
`freeformSpans` 是一次线性扫描。规则顺序固定为 a7-freeform 先于 a7-json-wrap，否则子句先被
改写、锚点消失。

诚实边界：这是**行级、字面**匹配。上游若换一种措辞或把子句折行，`FREEFORM` 不再被中和；
子句出现在同一行也会授权改写该行所有 `FREEFORM` 词元（包括调用方文本）。两个方向都写在
`H2Freeform.md` 的残留段里。

### 1.4 a4-cli-line 与 a4-catalogue-line 不再吃掉整行（A4，审计相邻发现）

旧 `a4-cli-line` 用 `[^\n]*` 删到行尾。对 Environment 里那条短句是原意；对调用方的一整行
长 prompt 就是删除载荷。实测：524,152 B 的单行输入 → **42 B**。

本版按 UTF-8 字节数分流：行 ≤ 4,096 B 时**从锚点到行尾**替换，锚点之前的调用方前缀保留
（无前缀时等价于整行替换）；行 > 4,096 B 时**只替换锚点短语**，其余字节原样保留；没有锚点
的长行完全不动。实测：524,152 B 的单行输入 → **524,160 B**（载荷完整、锚点消失）；
512 KiB 单行 10,280 个锚点 → 606,520 B，16–20 ms。前缀保留是后续补丁（`ad45bfb3`）修的：
第一版短行分支从行首开始，会把 `Always answer in French. Claude Code is available as a CLI`
前面的调用方规则一起删掉。

同一形状的第二个规则是 `a4-catalogue-line`。旧正则
`The most recent Claude models are[^\n]*\n?` 删除整行，调用方碰巧在同一行写下
`… are listed below; RULE: keep me` 时，`RULE:` 连同其后内容一起消失（实测 66 B → 4 B，
无 WARN）。`326880f5` 把它改成只替换锚点短语 `The available models are`，行内其余字节与
换行保留；完整的 `a4-catalogue` span（带 `… most capable Claude models.` 终止符）仍然整块
删除目录。

`8131848c` 补上拆分段落时的另一半：锚点所在行的剩余部分若带 ID 形态的
`claude-<组件>` 模型 ID 词元（整段 hyphen 词元须符合选择器语法并以干净边界收尾，
而非裸 `claude-` 前缀、`model ids` 短语或 `fable`/`opus`/`sonnet` 单词），说明这是
客户端目录头而不是恰好以该短语开头的调用方句子，span 从锚点删到行尾（锚点之前的
前缀仍保留）。实测：终止符落在另一
段落、`a4-catalogue` 正确地不跨段时，旧行为 253 → 244 B 且 `claude-fable-5` 仍在 wire 上；
本版把正文一并删除。没有标记的行仍然只改短语，`RULE:` 保留。

### 1.5 clear_thinking 与签名回放的条件冲突（CTX-01）

`DEVIN_CONNECT_REPLAY_SIGNED_THINKING=1` 时，翻译层会把历史里带签名的 Claude thinking 重新
编码进上游请求（`#11` + `#12`）。而有限的 `clear_thinking` keep 要求丢掉旧的 thinking 轮次 ——
两者相遇时，旧实现**拒绝所有有限 keep**（即使 keep 完全能满足），随后改成“比较可回放签名轮
次数”，又会在混合历史里接受一个实际会丢掉签名轮的 keep。

本版按**顺序**判断：`{thinking_turns,N}` 清掉的是 thinking 轮次前缀，因此

- N 覆盖**所有** thinking 轮次 → 接受；
- 否则只有被清掉的轮次里**没有**可回放的签名轮 → 接受；
- 被清掉的轮次里有签名轮 → 400 `unsupported_parameter`（`keep:"none"` 同理）。

影响面：只在 replay 开启 + 有限 keep + 带签名历史时触发；两个开关都默认关。400 的
param/message/code 形状不变。`test/context-management-signed-replay.test.js` 23 个用例
（发布时点 16，`c4931c40`/`29197941` 扩充），
`test/cc-claude-2-1-306.test.js` 12 个兼容用例。

残留（发布时点）：只独立校验第一个有限 keep 编辑。后续已修：`c4931c40` 改为逐条校验
每个 `clear_thinking` 编辑，`29197941` 让缺省 `keep` 按模型族解析（见文末增补）；
本版没有在真实上游复跑。

### 1.6 dashboard 写请求先过门、再读 body（S03）

`/dashboard/api/*` 的 POST/PUT/PATCH 旧顺序是：先 `readBody` 缓冲并 JSON.parse（上限
10 MiB），再执行 Host/mutation/lockout/auth 门。未认证调用方可以让服务为每个请求做这份工作。

本版把门提取为 `preflightDashboardRequest`，在 `server.js` 读 body 之前调用；通过后用一个
挂在 request 上的 **Symbol** 标记，handler 见到标记就跳过自己那份门。标记不可能来自 HTTP
头或 body；直接调用 handler 的单元测试/进程内调用方仍然走完整门，行为不变。

回归测试 `test/dashboard-preauth-body.test.js`（4 个用例）用“声明 10 MiB body 但一个字节
都不发”证明 401 在 body 仍未发送时就到达；同时钉住响应只发一次、认证只计数一次、有效空
POST 等既有契约。

### 1.7 Cascade：图片提取可取消、角色闭合标签全转义（IMG-01 / TRN-01）

**IMG-01（取消）。** `extractImages` 新增 `{signal, beforeFetch}`：每次远端 fetch 前、每次
push 前各检查一次（远端图片在 fetch 前后各一次），所以已经花掉的 turn 不会再把图片挂上去。
终止类错误（abort、deadline、budget）重新抛出；普通的单图失败（MIME、404、SSRF、大小、
解码）仍然是 log-and-continue。`fetchImageUrl` 把 signal 带过重定向，abort 时只 settle 一次
并销毁自己持有的 handle。5 MiB / 8 s / 3 次重定向 / MIME / SSRF / 像素防护全部保留；
`resumeTurn` 仍然跳过图片提取（它只续接已有轮询，不重复提取）。

红先证据：整文件回退 → 4 fail + 2 timeout；只清空 checkpoint → 2 fail；只移除根 abort
监听 → 1 cancelled（fetch 永不 settle）。

行为差异：budget 在图片提取开始时已经耗尽，现在直接以路由的 504 失败，而不是继续
fetch/attach —— 这是要求的终止语义。

**TRN-01（序列化）。** `escapeHistoryTags` 同时转义 `</human>` 与 `</assistant>`，用在三处：
历史字节计量、历史渲染、最新 `<human>…</human>` 插入；fresh 与 resume 后的 rebuild 走同一个
builder，不会分叉。只替换精确闭合标签：`<div>`、`</div>`、`<human-readable>` 原样通过。
计量与渲染共用同一个转义，600k/900k 字节预算语义不变（每个被转义闭合标签 +1 字节）。

红先证据：回退 `src/client.js` → 4 个用例 3 fail（最新轮、跨角色历史、rebuild），无关 XML
对照仍通过。定位是**结构/来源标记**问题，不声称已验证上游角色权限。

## 2. 风险与影响面

- **默认路径字节不变**：wire 对 `v3.141.592658` **270/270 逐字节一致、0 声明差异、0 未声明
  差异**（§3）。这是 patch 的依据。
- **身份中和器的输出会变**，且这是有意的：9+2 条规则的匹配形状被重新实现，a4-fastmode 的
  空行保留、a4-cli-line 的长行行为、b-security-line 的全局改写都是可观察差异。wire 矩阵只
  覆盖 protobuf 编码，不覆盖 system prompt 文本；文本面由 147 个身份测试 + 2 万例差分守。
- **CTX-01 / S03 / IMG-01 / TRN-01 都是条件路径**：replay 默认关、dashboard 只影响写端点、
  Cascade 只影响带图/带历史轮次。
- **没有新增默认开启的开关，没有数据库/数据格式变更**。`runtime-config.json` 在全部测试
  前后 `sha256 = c9739375…` 未变。
- 唯一的行为收紧：图片轮在预算已耗尽时从“继续尝试”变成 504（IMG-01，见 §1.7）。

## 3. 验证证据（本审计实测）

W01 在 `deeb2539`（发布提交的祖父，`src/` 与发布树逐字节相同）上执行；其余在发布树
（`bb81fa16` + 本提交，只动测试基线/版本/文档）上执行。Node `v24.19.0`。逐项计数、skip
名单与日志哈希同时记录在
[`ACCEPTANCE_3.141.592659.md`](ACCEPTANCE_3.141.592659.md)。

| 项 | 命令 | 结果 |
|---|---|---|
| 全量 release shard | `npm run test:release`（605 文件，单 shard） | **605 files / 7,455 tests / 7,352 pass / 0 fail / 103 skip**，exit 0，wall 1,310.6 s |
| 身份中和器 | 7 个身份测试文件（§1.1–1.4） | **147 pass / 0 fail** |
| CTX | `context-management-signed-replay` + `cc-claude-2-1-306` | **28 pass / 0 fail** |
| Cascade | `cascade-image-cancel` + `cascade-history-serialization` + `cascade-image-history` + `cascade-abort-side-effects` + `cascade-completion-controls` | **39 pass / 0 fail** |
| transport matrix | `node --import ./test/setup-env.mjs --test test/transport-matrix.test.js` | **22 pass / 0 fail** |
| docs guard | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | **47 pass / 0 fail** |
| spec 静态 | `node scripts/spec-static-check.mjs` | **exit 0 — 97 spec / 863 mutation，锚点唯一** |
| spec 基线（增量） | `node scripts/spec-baseline-check.mjs identity-neutralize-paragraph-bound.json neutralize-rewrite-visibility.json` | **2 spec measured, 0 drift, 0 untrustworthy** |
| spec 基线（全量） | `node scripts/spec-baseline-check.mjs --all` | **97 spec measured, 0 drift, 0 untrustworthy**（202.5 s） |
| wire 身份 | `WIRE_BASE_TREE=…/release-next-pr282 WIRE_BASE_TAG=v3.141.592658 WIRE_BASE_SHA=08a750d1… WIRE_BASE_REQUIRED=1 node --import ./test/setup-env.mjs --test test/wire-byte-identity.test.js` | **PASS exit 0 — 270/270 byte-identical, 0 expected, 0 unexpected** |
| secret scan（工作树） | `node scripts/secret-scan.mjs` | **exit 0** |
| history secret scan | `node scripts/history-secret-scan.mjs` | **exit 0 — 0 unbaselined** |

wire 的原始行（逐字）：

```text
WIRE_PROVENANCE {"tested_head":"deeb25394b8c77915dc42928cc940b9557187e77","tested_root":"D:\\Project\\WindsurfAPI","tested_dirty":true,"base_root":"D:\\Project\\WindsurfAPI\\.claude\\worktrees\\release-next-pr282","base_head":"08a750d1a6d26f5d3b2f010c878170a9508730a8","base_dirty":false,"expected_tag":"v3.141.592658","expected_sha":"08a750d1a6d26f5d3b2f010c878170a9508730a8","expected_from":"selection+env","expected_releases":135,"selection_error":null,"tag_ref_verified":true,"env":{"WIRE_BASE_SHA":"08a750d1a6d26f5d3b2f010c878170a9508730a8","WIRE_BASE_TAG":"v3.141.592658","WIRE_BASE_REQUIRED":true},"comparisons":270}
WIRE_PROVENANCE_COMPARED {"compared":270,"expected":270,"base_head":"08a750d1a6d26f5d3b2f010c878170a9508730a8"}
WIRE_EXPECTED_DIFFS {"byte_identical":270,"expected":0,"entries":0,"compared":270}
```

`tested_dirty:true` 是本地 checkout 的 600+ 个**未跟踪**证据文件造成的；跟踪树是干净的
（`git status --porcelain` 只有 `??` 行），基线 `base_dirty:false`。CI 的干净 checkout 上该
字段为 false。

**没有在本版实测的**（不得写成已通过）：托管 CI、HMC 部署与真实上游。原因与替代命令
见 §6–§7；Node 22 全量后来已补测，证据见 §7。mutation 变异体在发布提交后已由 HMC
在 `c4931c40` 上完成 97/97 sweep（§7），最终树的基线重钉与复跑仍 `[UNVERIFIED]`。

## 4. 变更文件与测试

产品：`src/client.js`、`src/dashboard/api.js`、`src/handlers/identity-neutralize.js`、
`src/handlers/messages.js`、`src/image.js`、`src/server.js`。

新增/扩展的守卫：

| 文件 | 用例 |
|---|---|
| `test/identity-neutralize-complexity.test.js` | 10（复杂度上界：2,049 B / 512 KiB × 4 形状 / Unicode 前缀；`04503830` 增补） |
| `test/identity-neutralize-integrity.test.js` | 51（含 WA-002 的 24 码元循环、H2 边界与大小写、A4 前缀保留、catalogue 短语/正文保留与删除；`04503830` 增补） |
| `test/identity-neutralize-paragraph-bound.test.js` | 36（ASCII + Unicode 段落边界；`c4931c40`/`0aea4ea3` 增补） |
| `test/neutralize-rewrite-visibility.test.js` | 11（WARN 语义；`c4931c40` 增补） |
| `test/context-management-signed-replay.test.js` | 23（接受/拒绝表 + 顺序前缀 + 缺省 keep 模型族；`c4931c40`/`29197941` 增补） |
| `test/dashboard-preauth-body.test.js` | 4（body 前 401、单次响应、单次计数） |
| `test/cascade-image-cancel.test.js` | 7（checkpoint、abort、settle once、404 对照、末块后取消；`a96c2ab4` 增补） |
| `test/cascade-history-serialization.test.js` | 7（两个闭合标签、无关 XML、rebuild；`15fc5df1` 增补） |
| `test/transport-matrix.test.js` | 22（四个协议族的流式/非流式矩阵，无产品变更） |

上表用例数按 `5a3ec2a9` 树逐文件实跑（`node --import ./test/setup-env.mjs --test`；
这 9 个文件在 `1490fe10` 未变）；
§3 的 pass 计数是发布时点的实测值，复审修复波又给其中 7 个文件各增补了用例。

mutation 语料同步：`identity-neutralize-paragraph-bound.json` 重钉锚点（`ad45bfb3` 把它指到
`applySpans('a4-cli-line', cli.short, CLI_LINE_REPLACEMENT, true)`），`8131848c` 加测试后
`bb81fa16` 把基线从 80 重钉到 **83**；`neutralize-rewrite-visibility.json` 的基线从 89
重钉到 **92**；`request-tail-contract.json` 等三份 spec 在 #282 时已重钉。
`spec-static-check` 现在 exit 0，锚点唯一；两份 spec 的基线实测 0 drift。

发布后语料又变为 **99 spec / 878 mutation**（`node scripts/spec-static-check.mjs` 实测）：
`c4931c40` 新增 `context-management-signed-replay.json` 与 `identity-neutralize-linear.json`
两份 spec；`29197941` 把 signed-replay 基线重钉到 **23**（3 条突变），`0aea4ea3` 把
linear spec 扩到 12 条突变、`04503830` 再把两条锚点改指重写后的分类器并把基线推到
**46**；`identity-neutralize-paragraph-bound.json` 基线 83→**89**、
`neutralize-rewrite-visibility.json` 基线 92→**100**（`c4931c40`/`0aea4ea3` 随被测文件
增补用例重钉）。`d142d06e` 把 `gemini-egress-parity`（→88）与
`gemini-schema-type-normalize`（→107）的 `expectBaselinePass` 重钉到实测值，
`1490fe10` 把 `responses-post-tool-text-item` 的锚点改指 sealed status 参数。
截至 `1490fe10`，`spec-baseline-check --all` 实测 **99 spec / 1 drift /
0 untrustworthy**——仅剩 `think-text-reroute`（实测 98、spec 期望 97）的
`expectBaselinePass` 待重钉（见 §7），重钉前该 spec 的突变判定不作为证据。

## 5. 回滚

本版没有数据格式、配置键或环境变量变更，回滚是纯代码回退：

- **HMC**：部署切换前把当时的树完整备份为 `/opt/windsurf-api.prev27-<TS>`（3.141.592658）。
  回滚 = 停服务 → 把当前树移走 → 恢复 `prev27-<TS>` → 用 `rsync --delete` 把运行期间的
  `data/`（账号、日志）覆盖回去 → 启动 → `/health` 200 且 `version=3.141.592658`。
- **更深的兜底**：`/opt/windsurf-api.prev26-20261029T220502Z` = **3.141.592657**。这是两版
  回退，会同时丢掉 592658 的 Gemini `type[]` 与签名回放；只在首选回滚也失败时使用。
- **代码**：本分支未合并时，回滚就是继续部署 `v3.141.592658`；已合并时，按 tag 重新部署或
  revert 该合并提交。不要 `git reset` 已推送的 master。
- **数据**：`data/` 不属于发布树的可替换部分；回滚命令显式保留运行期间的 `data/`，避免把
  账号刷新与日志退回到备份时点。
- 逐条命令（未执行）见 `ReleasePrep.md` §7。

## 6. 发布门状态与阻断项

本轮跟踪中修掉的三项（保留记录，避免下一轮重新发现）：

1. **mutation 锚点漂移（已修，`ad45bfb3`）**：`identity-neutralize-paragraph-bound.json`
   第 7 条的 anchor 曾指向 A4 修复删掉的 `rule('a4-cli-line', …)` 行 → `hits=0`。现在
   anchor 指到 `applySpans('a4-cli-line', cli.short, CLI_LINE_REPLACEMENT, true)`；
   `node scripts/spec-static-check.mjs` exit 0（97 spec / 863 mutation，锚点唯一）。
2. **docs guard §0（已修，`d5d44f6f` / `deeb2539`）**：§0 的 `master` 从 `36387a32` 指到
   `ad45bfb3`，再被 `326880f5` 的 src 变更拉开，最后由 `d5d44f6f` 重指到 `326880f5`；
   `deeb2539` 再重指到 catalogue-body 修复后的代码 HEAD `8131848c`。发布提交把 §0 的
   `产品 tag` 与 `package.json` 指到 3.141.592659，`master` 仍指代码 HEAD `8131848c`
   （发布侧只改测试/版本/文档，`src/` 滞后 0）。
3. **history secret scan（已修，`05dc9a71`）**：`3a9ae420` 的 transport fixture key
   在工作树被 `f1aaab56` 加上 `fixture` 标记，但旧 blob 永久在历史里。`05dc9a71` 在
   `scripts/history-secret-scan.baseline` 收录了 reviewed 条目
   （`openai-api-key test/transport-matrix.helpers.mjs 93d6533f4255 SYNTHETIC: …`），
   扫描恢复 **exit 0（0 unbaselined）**。

**当前阻断项（`1490fe10` 时点）：** mutation 语料有 1 份 spec（`think-text-reroute`）的
`expectBaselinePass` 待重钉（§4、§7），重钉后需在 POSIX 上对最终树复跑 mutation
sweep；`gate:release` 需在合并树上跑完（见 §7）。本机可跑的其余门禁绿。

## 7. 已知 / 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)；本版新增条目也在其中。

- **[VERIFIED] mutation 全量 sweep（HMC，`c4931c40`）**：POSIX `mutation-sweep.mjs`
  在 HMC clone `c4931c40` 上跑完 **97/97 spec 按预期行为，0 unexpected survivors，
  0 mismatch**（`.agent/HANDOFF.md` 记录，local evidence；日志 `/tmp/wsa-mutate2.log`，
  99 个 `SPEC_EXIT` 中 2 个零突变 spec）。旧的「1800 s 上限前 56/97、剩 41」是中途
  截断的中间态，已被该次完整 sweep 取代；`spec-baseline-check` 只证明锚点与基线
  成立，不执行变异体。
- **[UNVERIFIED] mutation 最终树复跑与基线重钉**：语料已扩到 **99 spec / 878
  mutation**；HMC 侧对合并树 `5a3ec2a9` 的 99/99 覆盖已测（其后 `5fb21e70` 又改
  `src/`），`spec-baseline-check --all` 本地实测（`1490fe10` 树）**99 spec /
  1 drift / 0 untrustworthy**——`d142d06e` 已把 `gemini-egress-parity` 与
  `gemini-schema-type-normalize` 的 `expectBaselinePass` 重钉到实测值，仅剩
  `think-text-reroute`（实测 98、期望 97）待重钉。重钉并在 POSIX 上
  复跑 `node scripts/mutation-sweep.mjs --shard 0/1` 与 `--verify` 前，最终树的
  变异体结论不作为证据。
- **[VERIFIED] mutation 全量基线（发布树）**：`spec-baseline-check.mjs --all`（97 spec）是 release
  workflow 的模式；发布树实测 **97 spec measured, 0 drift, 0 untrustworthy**，wall 202.5 s
  （`releasecommit-spec-baseline-all.log`，`sha256 da0d49db…`）。当前树的对应实测见 §4。
- **[VERIFIED] Node 22 全量**：`test:release` 的分片（`scripts/run-test-shard.mjs 0 1`）由
  Node 22.23.4 二进制直接运行，实测 **605 文件 / 7,455 测试 / 7,352 通过 / 0 失败 / 103 跳过 /
  801.6 s**（`node22-release-2.log`；
  `TEST_SHARD_SUMMARY {"files":605,"tests":7455,"pass":7352,"fail":0,"skipped":103}`）。
  `engines >=22.13.0` 的精确 floor（22.13.x）仍未单独跑矩阵，但 22.x 全量已不再是「未实测」。
- **[UNVERIFIED] 托管 CI**：分支 `fix/audit-wave-20261109` 没有 upstream，本版所有 CI 结论
  都是本机测量。
- **[UNVERIFIED] HMC 部署与回滚演练（592659）**：本版没有部署；回滚命令见 §5 与
  `ReleasePrep.md` §7，未执行。
- **[UNVERIFIED] live 上游**：WA-001/002/003/A4 的验证全部是隔离函数与 hermetic 测试；
  没有把病态 payload 发给真实服务，也没有真实客户端复跑。HMC 的旧模块计时用的是 `/tmp`
  副本，生产 `:18999` 未被写入。
- **[UNVERIFIED] CTX-01 live**：没有在真实上游跑 replay + 有限 keep 的组合。
- **[UNVERIFIED] `clear_thinking` 缺省 keep 的模型族边界**：`29197941` 按上游文档把
  缺省 `keep` 分为 keep-all 家族（Opus 4.5+/5、Sonnet 4.6+/5、Fable）与保守 keep-1，
  边界来自上游文档而非本后端实测（`src/handlers/messages.js` 注释同样标
  `[UNVERIFIED]`）；无法分类的模型名一律按 keep-1 校验，方向是多拒不少放。
- **[UNVERIFIED] S03 真实 dashboard 客户端**：只有隔离的排序测试（声明 10 MiB、不发 body）。
- **[UNVERIFIED] IMG-01 真实 Cascade abort**：取消语义由注入 signal 的测试覆盖；没有在
  真实长轮次里按 Ctrl-C/断连。
- **[UNVERIFIED] TRN-01 上游角色语义**：只证明序列化可逆、闭合标签计数正确；不证明上游
  会因未转义文本产生角色越权（本版不声称这是越权漏洞）。
- **[UNVERIFIED] 发布产物**：资产、cosign 签名、SHA256SUMS、release attestation 都要在 tag
  之后由 release workflow 生成；本文件不代表它们已经存在。
- **[FIXED] G01（`reasoning.encrypted_content` 从不发出）**：`c4931c40` 在
  `include:["reasoning.encrypted_content"]` 且上游提供值时发出该字段，并补了回放分支；
  证据 `test/responses-include-verbosity-custom.test.js` 的 G01 专项用例（现 17 条，
  全文件 30 条）。
- **[FIXED] G02（`text.verbosity` 未解析/未转发）**：`c4931c40` 解析 `text.verbosity` 并带入
  adapter 边界（`completionOverrides.verbosity`）；chat-compatible 上游没有该字段，因此这是
  有意记录的边界 no-op，不再是静默丢弃。证据同上测试文件。
- **[FIXED] G03（custom-tool 输入未流式）**：`c4931c40` 补了
  `response.custom_tool_call_input.delta` / `.done` 与最终 `custom_tool_call` item 的 `input`/`id`；
  证据同上测试文件。
- **[FIXED] G06（Gemini 静默丢弃 server-side tools）**：`c4931c40` 改为与其他协议面一致的
  400 `unsupported_server_side_tool`，不再只写日志；`b65e0446` 补 falsy 键按存在性拒绝
  与未列入工具的 warn。证据 `test/gemini.test.js`：2 个 `(G06)` 具名 `it`（translator 级
  拒绝 + `handleGemini` 路由级 400）加 falsy-presence 断言面。
- **[UNVERIFIED] G01–G03/G06 的真实客户端抓包**：上述修复由 hermetic 测试覆盖；没有真实
  Codex/Devin 客户端抓包确认 `reasoning.encrypted_content`、`text.verbosity`、custom-tool
  input delta 与 Gemini server-tool 400 在真实上游/客户端上的线上形状。
- **[UNVERIFIED] Q1 G4（`messagesRemaining:-1` 的语义）**：`CheckUserMessageRateLimit` 恒报
  `-1`；dashboard 把成功探测的 `-1` 读作 `unlimited: true`（`src/dashboard/devin-cards.js:532`），
  `test/dashboard-devin-cards.test.js` 有意固定该行为。审计要求常量落 `unknown`；本版把这一半
  作为 deferred 残差记录（`test/dashboard-capacity-unknown.test.js` 头部），未改 dashboard 契约。
- **[UNVERIFIED] support-bundle 生产形态**：`test/support-bundle.test.js:227` 断言
  `health.commit` 是 git sha，但 `src/version.js:40-47` 在非 git checkout 下回退为空串——
  HMC 生产形态正是 `commit:""`（`SYNTHESIS.md` §2）。测试只在 git checkout 内通过，打包部署
  形态未覆盖；本版只诊断，未改测试。
- **沿用 592658 的边界**：M4 rescue 未在真实上游触发、多段 `#10`/`#21` 未线上观测、
  官方 `pr-gate` 仍 `INCOMPLETE`（relogin 真实密码缺口）。这些不因本版改变。

## Security acknowledgments / 致谢

Thanks to 周fish for the responsible disclosure of the CWE-1333 event-loop blocking issue in the
client-identity neutralizer (reported 2026-11-08).

感谢 周fish 负责任地披露客户端身份中和器中的 CWE-1333（event-loop 阻塞）问题（2026-11-08
报告）。修复见 §1.1；报告者未要求匿名。
