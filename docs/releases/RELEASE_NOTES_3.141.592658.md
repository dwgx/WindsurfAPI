# v3.141.592658

自 v3.141.592657 以来 **27 个提交 / 29 个文件**（`git rev-list --count v3.141.592657..18879611`；
`git diff --shortstat v3.141.592657..18879611`：1,358 增 / 116 删；`18879611` 是合并前的
`release/next-pr282` tip，发布侧另有贡献者台账与发布提交两个只改数据/文档的提交）。产品变更是两件：Gemini 原生
ToolDefs 的 JSON Schema `type` 数组不再被上游以 400 拒绝；以及一个**默认关闭**的签名 thinking
回放开关，让 Claude 模型在工具循环内和后续用户轮里都能读到自己之前那段带签名的推理。本版是
**patch**：默认路径的请求字节相对 `v3.141.592657` 仍是 **270/270 逐字节一致、0 差异**。

> **版本号**：`3.141.592657` 之后的 patch，语义化版本写作 **3.141.592658**（tag `v3.141.592658`，
> 本文件 `RELEASE_NOTES_3.141.592658.md`）。发布提交、认证树、逐项门禁计数和 skip 名单见同日
> 验收附录 [`ACCEPTANCE_3.141.592658.md`](ACCEPTANCE_3.141.592658.md) —— 本文件只写内容与边界，
> 附录是本次认证的唯一计数来源。

## 1. Gemini 原生工具定义：`type` 数组降为 `anyOf`

上游的原生 `ToolDefs` 解码器不接受 JSON Schema 里数组形式的 `type`。`omp` 的 `grep` 工具带一个
`"type": ["number","null"]` 的 `skip` 参数，整条请求因此被上游 `invalid_argument` 拒绝 ——
一个合法 schema 让整个请求失败。

- `src/devin-connect.js` 的 `normalizeToolSchema` 现在调用 `normalizeSchemaTree`：除原有的
  `description` 注解剥离外，把每个 `type: [a, b]` 降为等价的
  `anyOf: [{type:"a"}, {type:"b"}]`。降级是无损的 —— 每个成员一个单类型分支，接受的值集合与
  nullable 语义完全一致，而 `anyOf` 上游接受。
- 遍历保留原有的「按对象重建」写法（调用方的 schema 不会被改写），`description` 剥离的结果与
  旧实现逐字节相同；`properties` 映射里名为 `type` / `default` 的**参数**不会被误当关键字，
  `default` / `examples` / `enum` / `const` 里的值按数据整棵保留（不再往下当 schema 看）。
- 已有 `anyOf` 的 schema 不覆盖：降级出的并集经 `allOf` 与之求交
  （`anyOf(A…) AND allOf(anyOf(T…))`），两个语义都不丢；`oneOf` / `allOf` 与之独立共存。
- 回归：`test/native-schema-unions.test.js`（339 行）覆盖顶层/嵌套/属性映射/字面量/冲突组合。

## 2. 签名 thinking 回放（opt-in，默认关闭）

Claude 的 thinking 块带一个上游签名的 `signature`：签名封住那段推理文本，上游会校验。历史
翻译过去把这整块丢掉，于是模型在工具循环里读不到自己上一步的推理，只能重新猜。

两个开关，**都默认关**：

- `DEVIN_CONNECT_SIGNATURE_TAG=10` —— 解码上游响应字段 `#10` 的 thinking 签名并交给客户端
  （`/v1/messages` 的 `signature_delta` / 非流式的 `signature`）。这是总闸：不设它，客户端根本
  拿不到签名，回放也就无从谈起。
- `DEVIN_CONNECT_REPLAY_SIGNED_THINKING=1` —— 把 `/v1/messages` 历史里**带签名**的 Claude
  thinking 块重新编码进上游请求：assistant 帧上 `#11` thinking 加 `#12` signature，工具调用轮
  与纯文本轮都包括，文本按原样（不 trim，签名封的是精确字节）。

实测（`claude-opus-5-5`，真实上游；本机复核是工具循环 A/B 与真实客户端抓包）：

- 上游签名为真：1440 字符的 CAIS `C` 信封，`compatibleClaudeSignature=true`、
  `candidateValidatorAccepts=true`；另有 1028 / 1036 / 1580 字符样本。
- 工具循环内（本机复核）：回放臂按上一步 thinking 里的秘密数字作答 **2/3**，不带签名的对照组
  **0/3**，全部 200。后续用户轮的同型对照（强制作答设计下回放 **3/3**、不回放 **0/4**）是
  **PR 作者在 [`pr://282`](https://github.com/dwgx/WindsurfAPI/pull/282) 公布的测量**
  （2026-10-28），**本机未重跑**；本机在后续用户轮上只测到一次真实 Claude Code `--resume`
  （见下条 wire），不构成对该 3/3 vs 0/4 的复现。
- 负对照：同一段历史改一个字节，上游以 `invalid_argument` 400 拒绝；未改动的同一请求 200。
  这说明上游确实在验签，不是把签名当摆设。
- 真实客户端：Claude Code 2.1.306 跑完一个 `Read` 工具循环并 `--resume` 追问，收到 936 字符
  签名并原样回传；后续轮的上游 wire 是 `#11` 72 B + `#12` 936 B，回放关闭时 `#11` 0 / `#12` 0。
- `/v1/messages` 的空文本轮：带签名 reasoning-only 的 assistant 轮被上游接受（200，`#11` +
  `#12`，文本为空）。

## 3. M1–M4：签名在四个环节被静默丢掉

PR #282 的诊断成立，但它自己的实现里有四处会让签名在默认路径上悄悄消失。四处都按红先测试
修掉：

- **M1（流式累加）**：`AnthropicStreamTranslator` 的 `emitThinkingDelta` 把
  `pendingThinkingSignature` 每次赋值而不是累加，多段 `signature_delta` 只剩最后一段。
  这是 master 上就存在的缺陷，不是 PR 引入的；现在累加，并在块结束时清空。
- **M2（builder 保留）**：历史构造器在旧回放探测关闭时丢掉「只有 reasoning、没有文本」的
  assistant 轮，带签名的推理随之消失；现在只要签名与非空 reasoning 同时存在就保留该轮。
- **M3（`/v1/messages` 入口）**：翻译层在进入 builder 之前就把 thinking-only 的 assistant
  轮丢掉了；现在保留为 `content: null` + `reasoning_content` + `reasoning_signature`。
- **M4（rescue 保留）**：空响应 rescue 的过滤把带签名的 reasoning-only 历史当空轮剔除；现在
  保留，并且 rescue 替换尝试时签名与那次的 reasoning 一起丢弃（不会把两次尝试拼在一起）。

## 4. 守卫与边界（都是失败关闭）

- **provider 门**：只有 Claude 家族回放。模型目录里 `provider === 'anthropic'` 才算；目录里
  没有的名字按 `claude-*` / `anthropic/` 前缀兜底识别（`claude-opus-5-5`、`claude-opus-4.9`
  这类未入目录的裸名此前会静默关闭回放）。
- **E/R/C/Q 信封门**：`src/claude-signature.js` 解码 base64 并检查外层结构，只接受未加前缀的
  `E` / `R` / `C` / `Q` 信封；其他形状（含 `#` 缓存前缀）返回 400
  `unsupported_thinking_signature`。接受的字节永不改写、不做规范化。
- **强制 emulation 400**：带签名的工具历史遇到 prompt 模拟（`DEVIN_CONNECT_TOOL_CALL_TAGS=invalid`
  或 `DEVIN_CONNECT_TOOL_DEF_TAGS=invalid`）时返回 400
  `signed_thinking_tool_history_unsupported` —— 模拟路径必然丢掉带签名的 assistant 轮，
  静默降级比报错更坏。
- **签名字节预算**：`src/history-budget.js` 把 `reasoning_signature` 计入 payload 字节，历史
  预算不再少算一段 1 KB 级的签名字节串。
- **多段抑制**：一轮里出现多个签名段时签名整体不发送（流式与非流式都一样），只回放
  「一段 thinking + 一个签名」；多段拼起来是无效签名，宁可丢也不伪造。
- **别名兜底**：`claude-*` / `anthropic/` 前缀的未知模型按 Claude 处理，而不是「未知 provider
  → 静默关闭」。
- 不支持的形状明确不碰：`redacted_thinking` 不回放；同一轮里有未签名 thinking 块时整轮不回放
  （部分签名集无法通过上游验签）；`signatureType` / `thinkingId` 解码但不向客户端传播；非流式
  reasoning-only 答案提升为可见文本时不带签名。

## 5. 门禁与认证

本版在发布提交上实测（Windows 本地 `test:release`、POSIX `gate:release`、wire 身份、docs 守卫、
secret scan、`git diff --check`、spec-baseline）。**逐项命令、精确计数、skip 名单与日志哈希全部
记录在同日验收附录** [`ACCEPTANCE_3.141.592658.md`](ACCEPTANCE_3.141.592658.md)；该附录与本节
在同一个 tag 树上。

- wire：基线由外部选择并证明为 `v3.141.592657` → `a7d2e33f5e2c6c11c85f82dc50f18f2c7b1cd2d8`，
  要求 **270/270 逐字节一致、0 未声明差异**。
- release gate：`RELEASE GATE: PASS`，7,312 pass / 0 fail / 4 skip（597 文件），
  `test/devin-connect-relogin-live.test.js` 是唯一声明 inert 的文件。
- mutation：**97 份 spec / 863 条突变**（846 捕获 + 17 条声明 survivor）。发布侧两个提交
  （贡献者台账 + 发布提交）只改数据与文档，`src/` 逻辑与 `15dd8904` 逐字节相同，因此沿用该
  提交上的全量 sweep 结果（97/97、0 mismatch），不重跑；理由与两次计数都记在验收附录 §3。

## 6. 已知 / 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)；本版新增的条目也在其中。

- **M4 的 rescue 路径没有在真实上游触发过**：M4 的修复由 hermetic 测试覆盖（注入空响应触发
  rescue），live 会话里 `rescueObserved=false` —— 真实上游这次没有给出空响应，所以「rescue
  后签名仍在」只有测试证据，没有线上证据。
- **多段签名没有在线上观察到**：live 抓包里只有一段 `#10` 分片（1580 字符，客户端收到与 wire
  一致），`#21` 未出现。多段抑制逻辑因此只有 hermetic 证据。
- **回放只验证了 `/v1/messages` 客户端**：Claude Code 2.1.306 是唯一实测的客户端。`omp`
  18.13.3 走 Anthropic provider 时能收到签名，但不回放它（潜在的第二条签名路径，未实测）；
  Codex 走 `/v1/responses`；DSH 未安装。
- **官方 `pr-gate` 仍是 `INCOMPLETE`**：它没有 inert 白名单，`test/devin-connect-relogin-live.test.js`
  需要真实密码才能跑；发布门 `gate:release` 把该文件声明为 inert 后 PASS。两者是不同的入口，
  不能把发布门的结果当作官方 PR 门的 PASS。
- **上游验签是唯一真实性来源**：本版不做客户端侧的签名验证，回放之所以有效是因为上游校验；
  如果上游改变签名算法或信封形状，回放会退化为 400（失败关闭），而不是静默降级。
- **Node 下限未实测**：本版只在 24.x 上跑发布门；`>=22.13.0` 的 floor 本身仍是 `[UNVERIFIED]`。
- **托管 CI / 发布产物 / 部署**：tag 触发 release workflow、cosign 资产核验与 HMC 部署都在
  tag 之后另行执行；本文件与验收附录不代表它们已经发生。
