# 3.141.592658 验收附录（2026-10-30）

本附录是 `3.141.592658` 的认证记录，与
[`RELEASE_NOTES_3.141.592658.md`](RELEASE_NOTES_3.141.592658.md) 一起构成唯一的不可变验收记录。
它记录 Gemini `type[]` 修复与签名 thinking 回放的发布提交、逐项门禁命令、精确计数、skip 名单，
以及 tag/push 之后的发布结果。

- 发布版本：**3.141.592658**
- 发布提交：**本文件所在的提交** —— `chore(release): 3.141.592658 — version, notes, acceptance`。
  提交 SHA 由 tag 固定：`git rev-parse 'v3.141.592658^{commit}'`。逐次执行的原始输出、两次运行
  的对照与 push/tag 结果记录在仓库外的执行报告
  `pr282-signed-thinking-20261029/RELEASE-EXECUTION.md`（本文件冻结时 tag 尚不存在，不能自指）。
- 发布提交的父提交：`84a54bbb0c69617395d2fcedeb2680f3efbf29b2`（`chore(contributors): record
  PsychMing #282`，只改 `src/dashboard/data/contributors.json` 与 `docs/dashboard/data/contributors.json`）；
  再前是 `18879611c6d9dddfa25e3e3a3c2e0267525facba`（`release/next-pr282` 的 combined tip，PR #282
  signed-thinking 与 Gemini `type[]` 修复的全部 `src/` 逻辑变更）。
- 上一个已发布 tag：`v3.141.592657` → `a7d2e33f5e2c6c11c85f82dc50f18f2c7b1cd2d8`。
- 基线：`c5564f9ac213427ab467aebf0c2b0c49f4b7d911`（`origin/master`）。
- 发布范围：自 `v3.141.592657` 到 combined tip `18879611` 共 27 个提交 / 29 个文件
  （`git rev-list --count v3.141.592657..18879611`；`git diff --shortstat v3.141.592657..18879611`
  = 1,358 增 / 116 删），发布侧另有 2 个只改数据/文档的提交（贡献者台账 + 本发布提交）。其中
  产品变更是 `src/` 下 7 个文件（1 个新增）：`claude-signature.js`、`devin-connect-openai.js`、
  `devin-connect.js`、`handlers/chat.js`、`handlers/messages.js`、`handlers/tool-emulation.js`、
  `history-budget.js`。
- 本发布提交自身只改版本、notes、本附录与文档（含 `docs/UNVERIFIED.md` 的重新生成）；
  `git diff --name-only HEAD^ HEAD -- src` 为空，贡献者台账在前一个提交里。发布侧两个提交都
  不含 `src/` 逻辑改动 —— 这是 §3 沿用 `15dd8904` 全量 mutation 计数的唯一理由。

## 1. 发布范围（产品变更）

| 变更 | 实现 | 证明测试 |
|---|---|---|
| Gemini 原生 ToolDefs `type` 数组 | `normalizeSchemaTree` 把 `type: [a,b]` 降为 `anyOf: [{type:a},{type:b}]`，无损；与已有 `anyOf` 冲突时经 `allOf` 求交；`default`/`examples`/`enum`/`const` 按字面量保留 | `test/native-schema-unions.test.js`（339 行）、`test/q4-gate-candidates.test.js` |
| 签名 thinking 回放（默认关） | `DEVIN_CONNECT_REPLAY_SIGNED_THINKING=1` 时，`/v1/messages` 的带签名 Claude thinking 以 `#11` + `#12` 回放到 assistant 帧；需要 `DEVIN_CONNECT_SIGNATURE_TAG=10` 客户端才拿得到签名 | `test/thinking-signature-replay.test.js`（502 行）、`test/messages-thinking-contract.test.js`、`test/claude-signature.test.js` |
| M1 流式签名累加 | `AnthropicStreamTranslator` 的 `pendingThinkingSignature` 由赋值改为累加，块结束清空 | `test/thinking-signature-replay.test.js`、`test/claude-signature.test.js` |
| M2 builder 保留 | 带签名 + 非空 reasoning 的 reasoning-only assistant 轮不再被丢弃 | `test/thinking-signature-replay.test.js`、`test/history-budget.test.js` |
| M3 `/v1/messages` 入口保留 | thinking-only assistant 轮保留为 `content: null` + `reasoning_content` + `reasoning_signature` | `test/thinking-signature-replay.test.js` |
| M4 rescue 保留 | rescue 过滤保留带签名的 reasoning-only 历史；`attempt_reset` 时签名与该次 reasoning 一起丢弃 | `test/thinking-signature-replay.test.js` |
| 守卫 | provider 门、E/R/C/Q 信封门（`src/claude-signature.js`）、强制 emulation 400、签名字节预算、多段抑制、`claude-*`/`anthropic/` 别名兜底 | `test/claude-signature.test.js`、`test/history-budget.test.js`、`test/s1-p2-token-pass.test.js`、`test/thinking-signature-replay.test.js` |

## 2. 变更的 mutation 语料

三个 spec 的锚点/基线随产品代码移动，已重钉并在 `15dd8904` 的全量 sweep 中逐条验证：

| spec | 变更 |
|---|---|
| `test/mutations/request-tail-contract.json` | 重钉 `src/handlers/messages.js` 的 `} else if (textParts.length) {` 锚点（M3 在其后插入 `} else if (signedReplay) {`，旧替换会让 `else` 悬空） |
| `test/mutations/wire-h1-empty-assistant.json` | 基线随保留规则变化重钉 |
| `test/mutations/wire-h3-reasoning-policy.json` | 基线随 `#11`/`#12` 编码路径重钉 |

## 3. 认证执行记录（发布提交上实测）

**本节记录实测计数。** 所有命令都在发布侧两轮运行上执行：第一轮 `R1' = b27b6be6f496b9d2ff47750239110d9fe01faf2b`（与发布提交同树，只有本附录的计数文本不同；写入计数后它被 amend 成发布提交，因此不再是历史的一部分），第二轮是发布提交自身。两轮逐项一致，所以下面的计数对发布提交成立；本表记录第一轮的日志哈希，发布提交重跑的原始输出记录在执行报告 §6 —— 把它写进本文件会改变 tag 指向的提交。Node 一律用 `node --import ./test/setup-env.mjs`（禁止裸 `node --test`）。Windows 主机为 `dwgx`（Windows 10.0.26300，Node `v24.19.0`），POSIX 主机为 HMC（Debian，Node `v24.21.0`）。日志目录 `evidence/final/logs/`（`*.log` 被 gitignore，哈希记录在本表）。

| 行 | 命令 / 环境 | 结果 | 日志 |
|---|---|---|---|
| W01 | Windows `dwgx`（Node `v24.19.0`）`npm run test:release` | **exit 0 — 597/597 files, 7,306 tests / 7,203 pass / 0 fail / 103 skip**。103 skip 全是平台守卫：`update-script-release-target` 46、`mutate-verify-harness` 27、`docker-oneclick-update` 13、`self-update-attestation` 5、`self-update-gate` 3、`release-signing` 2、`self-update-untracked-safety` 2、`log-files`/`ota-fixture-containment-static`/`release-attestation`/`wire-byte-identity`/`wire-provenance` 各 1（`wire-byte-identity` 在 Windows 上没有基线树，wire 身份在 P01 上实测） | `evidence/final/logs/W02-windows-test-release-b27b6be6.log`，3,620,189 B，`sha256 9d4e85d6cc83a72038b2bba28d1db9643863c66f450ecefa2ae1459468cc4244`；wall 1500.54 s |
| P01 | HMC（Node `v24.21.0`）`DETACH_SOAK=1 GATE_INERT_SKIP_PATHS=test/devin-connect-relogin-live.test.js TEST_FILE_TIMEOUT_MS=300000 WIRE_BASE_TREE=… WIRE_BASE_TAG=v3.141.592657 WIRE_BASE_SHA=a7d2e33f… WIRE_BASE_REQUIRED=1 NODE_OPTIONS="--import …/scripts/mutation-network-deny.mjs" npm run gate:release` | **RELEASE GATE: PASS exit=0 — 7,312 pass / 0 fail / 4 skip（597 文件），1 inert file(s) / 1 declared**；spec-static `specs: 97 mutations: 863`；spec-baseline `97 spec(s) measured, 0 drift, 0 untrustworthy`；secret-scan / `git diff --check` / `git diff --cached --check` 全 PASS。4 skip 全是 `test/fs-atomic-windows-acl.test.js`（Windows-only ACL）；唯一 inert 文件是 `test/devin-connect-relogin-live.test.js`（无 unused 声明） | `/root/gate-582658/logs/P02-gate-release-b27b6be6.log`，3,854,484 B，`sha256 1c3362a2ae0c25f9fb7f69384d6dfad0af898adfa163ad0542cc6e93c00940ea`；wall 1080.21 s |
| D01 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js`（Windows 与 P01 内部各一次） | **exit 0 — 47 pass / 0 fail（9 suites）**，两端计数一致 | 独立运行在 `evidence/final/logs/W02-…` 内（`ℹ tests 47`）；P01 内 `[test/docs-consistency-guard.test.js] ℹ pass 47` |
| B01 | HMC `NODE_OPTIONS="--import …/scripts/mutation-network-deny.mjs" node scripts/spec-baseline-check.mjs --all` | **exit 0 — `97 spec(s) measured, 0 drift, 0 untrustworthy`**（逐 spec `MEASURED_NO_SKIPS`） | `/root/gate-582658/logs/P03-spec-baseline-all-b27b6be6.log`，`sha256 36068dfb314b8d7f8b8db89dfd748bad6df27051bc17f2c7acff4e82011c5718`；wall 195.23 s |
| S01 | `node scripts/secret-scan.mjs` | **exit 0**，0 字节输出 | P01 内 `PASS secret-scan exit=0`；发布前在暂存树上也单独跑过 exit 0 |
| G01 | `git diff --check` / `git diff --cached --check` | **exit 0**（无空白损坏） | P01 内两行 `PASS … exit=0` |

### 3.1 wire 身份

| 项 | 值 |
|---|---|
| 比较数 | **270**（`EXPECTED_COMPARISONS = 270`） |
| 基线 | `v3.141.592657` → `a7d2e33f5e2c6c11c85f82dc50f18f2c7b1cd2d8`（`expected_from: selection+env`，`expected_releases: 134`，`tag_ref_verified: true`） |
| 结果 | **270/270 byte-identical，0 expected diffs，0 unexpected**（`WIRE_EXPECTED_DIFFS {"byte_identical":270,"expected":0,"entries":0,"compared":270}`） |
| tested / base dirty | `tested_dirty:false` / `base_dirty:false`；`base_head` 与 `expected_sha` 相等，且不等于 `tested_head`（拒绝自比较） |
| 原始行 | 见下 |

```text
WIRE_PROVENANCE_COMPARED {"compared":270,"expected":270,"base_head":"a7d2e33f5e2c6c11c85f82dc50f18f2c7b1cd2d8"}
WIRE_EXPECTED_DIFFS {"byte_identical":270,"expected":0,"entries":0,"compared":270}
```

`WIRE_PROVENANCE` 的完整一行（含 `tested_head`）随运行而变：它在第一轮里是 `b27b6be6`（发布提交的
父树），在发布提交自身的重跑里是发布提交的 SHA。两行原文都记录在执行报告 §5/§6 —— 把它写进本
文件会改变 tag 指向的提交。

### 3.2 mutation（沿用 `15dd8904` 的全量 sweep）

| 项 | 值 |
|---|---|
| sweep 所在提交 | `15dd8904bc231bcd31369e3cf9c6a37136981eaf`（combined candidate，`test(mutations): keep the request-tail Anthropic mutation parseable`） |
| 结果 | **97/97 spec，863 条 = 846 caught + 17 declared survived，0 unexpected，0 drift，0 untrustworthy**（`node scripts/mutation-sweep.mjs --report-dir …` 与 `--verify` 均 exit 0；wall 3212 s） |
| 原始记录 | `pr282-signed-thinking-20261029/RELEASE-GATE.md` §Step 5（manifest / verdicts.log / sweep log 逐项重算） |
| 为什么可以沿用 | `git diff --name-only 15dd8904 18879611 -- src` = **0 行**（rebase 只改了 `docs/assets/star-history.svg`）；发布侧两个提交的 `src/` 改动只有 `src/dashboard/data/contributors.json`（数据，不含逻辑） |
| 本版仍然实测的部分 | 语料形状与锚点：P01 的 spec-static `specs: 97 mutations: 863`、锚点唯一；基线值：B01 `--all` 97 specs / 0 drift / 0 untrustworthy。也就是说本版验证了「spec 仍然指向正确的代码、基线值仍然成立」，没有重跑变异体本身 |

### 3.3 live 证据（产品行为，不在发布提交上重跑）

live 证据在 combined candidate `2b9adae9` 上采集，`15dd8904` 只在其上改了一行 mutation spec
（`test/mutations/request-tail-contract.json`），`src/` 逐字节相同。因此下面的产品行为证据对发布
提交同样成立；发布提交本身没有新增 live 采集。表中**唯一**一行不是本机实测的是「后续用户轮
A/B（作者侧）」，行内已标明来源与未复跑。

| 面 | 结果 | 证据 |
|---|---|---|
| 上游签名真实性 | 200；1440 字符 CAIS `C` 信封；`compatibleClaudeSignature=true`、`candidateValidatorAccepts=true`；另有 1028/1036/1580 字符样本 | `req_45d8910a…`；`LIVE-REPORT.md` §签名 |
| 工具循环 A/B | 回放臂 **2/3** 召回 vs 不带签名对照 **0/3**，全部 200 | `req_34e3806b…`、`req_c942139c…` |
| 后续用户轮 A/B（**作者侧，未本机复跑**） | **3/3 vs 0/4**（强制作答设计）是 PR 作者在 [`pr://282`](https://github.com/dwgx/WindsurfAPI/pull/282) 公布的测量（2026-10-28），不是本机的实测；本机在后续用户轮只有一次真实 Claude Code `--resume`（wire `#11` 72 B + `#12` 936 B），不构成对该对照的复现 | `pr://282`；`RELEASE_NOTES_3.141.592658.md` §2 |
| 篡改负对照 | 未篡改 200；改一个 payload 字节 → 上游 `invalid_argument` 400；破坏信封 → 本地 400 | `req_76fc139f…`、`req_f88d9b87…` |
| 真实客户端 | Claude Code 2.1.306 `Read` 工具循环 + `--resume`；客户端回传 936 字符签名；后续轮 wire `#11` 72 B + `#12` 936 B，回放关闭 `#11` 0 / `#12` 0 | `capture-final-on.jsonl` / `capture-final-off.jsonl` |
| M3 空文本轮 | 带签名 reasoning-only 轮 200，`#11` + `#12`，文本为空 | `req_303ab87d…` |
| 流式签名 | 单个 `#10` 分片 1580 字符，客户端收到的与 wire 一致；`#21` 未出现 | `capture-final-on.jsonl` |

## 4. 发布与部署记录

| 行 | 内容 | 结果 |
|---|---|---|
| 分支 push | `git push -u origin release/next-pr282`（新分支，非 force） | 见执行报告 |
| master 合并 | `git merge --ff-only origin/master`，再 `git merge --ff-only release/next-pr282` | 见执行报告 |
| master push | `git push origin master` | 见执行报告 |
| tag | `git tag -a v3.141.592658 -m "3.141.592658"` + `git push origin v3.141.592658` | 见执行报告 |
| 部署 | 本任务**不部署**；部署是独立 worker | 未执行 |

> tag 与 push 在本文件冻结之后执行，因此结果不能写进本文件（写入就会改变 tag 指向的提交）。
> 命令、输出与 `git ls-remote` 的逐字结果记录在执行报告
> `pr282-signed-thinking-20261029/RELEASE-EXECUTION.md`。

## 5. 残差与 `[UNVERIFIED]` 边界

以下不是「已认证」，不得在发布说明或部署验收中写成已完成：

- **M4 rescue 未在真实上游触发**：`rescueObserved=false`；修复只有 hermetic 证据。
- **多段签名未在线上观察**：只有一段 `#10`（1580 字符）；`#21` 未出现；多段抑制只有 hermetic 证据。
- **只有一个 `/v1/messages` 客户端实测**：Claude Code 2.1.306。`omp` 18.13.3 收到签名但不回放
  （潜在第二路径，未实测）；Codex 走 `/v1/responses`；DSH 未安装。
- **官方 `pr-gate` 仍 `INCOMPLETE`**：`test/devin-connect-relogin-live.test.js` 需要真实密码；
  发布门把它声明为 inert 后 PASS。两个入口不可互相替代。
- **上游验签是唯一真实性来源**：本版不做客户端侧验签；上游改算法/信封时回放会 400 失败关闭。
- **Node 下限未实测**：只跑 Node 24；`>=22.13.0` floor 本身 `[UNVERIFIED]`。
- **托管 CI / 发布产物 / 部署**：tag 触发的 release workflow、cosign 资产核验与 HMC 部署都在
  tag 之后另行执行与核对；本附录不代表它们已经发生。
