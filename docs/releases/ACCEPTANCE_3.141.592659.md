# 3.141.592659 验收附录（2026-11-09）

本附录是 `3.141.592659` 的认证记录，与
[`RELEASE_NOTES_3.141.592659.md`](RELEASE_NOTES_3.141.592659.md) 一起构成唯一的不可变验收记录。
它记录发布提交、逐项门禁命令、精确计数、skip 名单，以及 tag/push 之后的发布结果。

- 发布版本：**3.141.592659**
- 发布提交：**本文件所在的提交** —— `chore(release): 3.141.592659`。
  提交 SHA 由 tag 固定：`git rev-parse 'v3.141.592659^{commit}'`（本文件冻结时 tag 尚不存在，不能自指）。
- 发布提交的父提交：`bb81fa16`（`test(mutations): refresh baselines after the catalogue-body tests`，
  只改两份 mutation spec 的 `expectBaselinePass`）。再前是 `deeb2539`（`docs(handoff): re-point §0
  to the catalogue-body-fixed HEAD`）与代码 HEAD `8131848c`（`fix(identity): remove catalogue
  model-ID body in the split-paragraph fallback`）。
- 上一个已发布 tag：`v3.141.592658` → `08a750d1a6d26f5d3b2f010c878170a9508730a8`。
- 基线：`origin/master` = `1dc8ef3a`（tag 之后的 star-history 机器人提交；`v3.141.592658` 是它的祖先）。
- 发布范围：自 `v3.141.592658` 到审计分支 HEAD `deeb2539` 共 **36 个提交 / 45 个文件**
  （`git rev-list --count v3.141.592658..deeb2539`；`git diff --shortstat v3.141.592658..deeb2539`
  = 4,996 增 / 501 删）。发布侧另有 `bb81fa16`（mutation 基线）与本发布提交（版本/文档）两个
  只动测试/文档的提交。其中产品变更是 `src/` 下 6 个文件：`client.js`、`dashboard/api.js`、
  `handlers/identity-neutralize.js`、`handlers/messages.js`、`image.js`、`server.js`。
- 本发布提交自身只改版本、notes、本附录、`CHANGELOG.md`、`docs/README.md`、
  `docs/UNVERIFIED.md`、§0 与 `SECURITY.md` 的致谢；`git diff --name-only HEAD^ HEAD -- src`
  为空。发布侧两个提交都不含 `src/` 逻辑改动。

## 1. 发布范围（产品变更）

| 变更 | 实现 | 证明测试 |
|---|---|---|
| WA-001 身份中和器立方回溯（CWE-1333） | 11 条高风险规则改为 `applySpans` 一次性线性扫描；同步、无开关、默认生效 | `test/identity-neutralize-complexity.test.js`（9）、`test/client-identity-neutralize.test.js`（42） |
| WA-002 跨段落删除 | `paragraphEndAt` 用 24 个非 LF 空白码元判定空行；span 不越过段落边界 | `test/identity-neutralize-paragraph-bound.test.js`（30）、`test/identity-neutralize-integrity.test.js`（36） |
| WA-003 / H2 FREEFORM 全局改写 | 只在同一行出现 `do not wrap the patch in JSON`（大小写不敏感）时改写大写词元；小写原样保留 | `test/identity-neutralize-integrity.test.js`、`test/identity-neutralize-shapes.test.js`（11） |
| A4 `a4-cli-line` 过删 | ≤4,096 B 从锚点到行尾、保留前缀；>4,096 B 只替换锚点短语 | `test/identity-neutralize-integrity.test.js`、`test/identity-neutralize-paragraph-bound.test.js` |
| A4 `a4-catalogue-line` 过删 | 无正文标记只改短语；有 `claude-`/`model ids`/`fable`/`opus`/`sonnet` 时删到行尾；前缀保留 | `test/identity-neutralize-integrity.test.js`、`test/identity-neutralize-paragraph-bound.test.js` |
| CTX-01 有限 keep 与签名回放 | 按顺序前缀判断：N 覆盖全部 thinking 轮，或清掉的轮次里没有签名轮，才接受；否则 400 | `test/context-management-signed-replay.test.js`（16）、`test/cc-claude-2-1-306.test.js`（12） |
| S03 dashboard 预认证 body | `preflightDashboardRequest` 在 `readBody` 之前执行；Symbol 标记让 handler 跳过重复门 | `test/dashboard-preauth-body.test.js`（4） |
| IMG-01 Cascade 图片取消 | `extractImages` 检查 `signal`/`beforeFetch`；终止错误重抛；`fetchImageUrl` 传 signal | `test/cascade-image-cancel.test.js`（6）、`test/cascade-abort-side-effects.test.js`（11） |
| TRN-01 角色闭合标签 | `escapeHistoryTags` 同时转义 `</human>` 与 `</assistant>`，计量/渲染/插入共用 | `test/cascade-history-serialization.test.js`（4）、`test/cascade-image-history.test.js`（9） |
| 测试守卫 | 无产品变更，覆盖复杂度、段落、A4、CTX、S03、Cascade 与四协议 transport 矩阵 | `test/transport-matrix.test.js`（22）、`test/neutralize-rewrite-visibility.test.js`（9） |

## 2. 变更的 mutation 语料

`8131848c` 给两个被 mutation spec 覆盖的测试文件各加了 3 个用例，`expectBaselinePass` 随套件
变化重钉。这是 `bb81fa16` 的唯一内容：

| spec | 旧值 | 新值 | 实测 |
|---|---:|---:|---|
| `test/mutations/identity-neutralize-paragraph-bound.json` | 80 | **83** | `83 pass + 0 approved skips = 83 [MEASURED_NO_SKIPS]` |
| `test/mutations/neutralize-rewrite-visibility.json` | 89 | **92** | `92 pass + 0 approved skips = 92 [MEASURED_NO_SKIPS]` |

`node scripts/spec-static-check.mjs` 同时确认 **97 份 spec / 863 条突变**、锚点唯一、基线为正整数。

## 3. 认证执行记录

**本节记录实测计数。** 所有命令都在 `D:/Project/WindsurfAPI`、`fix/audit-wave-20261109` 上执行；
W01 在 `deeb2539`（发布提交的祖父，`src/` 与发布树逐字节相同）上跑，其余在发布树上跑。Node
一律用 `node --import ./test/setup-env.mjs`（禁止裸 `node --test`）。Windows 主机为 `dwgx`
（Windows 10.0.26300，Node `v24.19.0`）。日志目录
`C:/Users/dwgx1/.dwgx/work/audit-20261109/`（仓库外；`*.log` 不进仓库）。

| 行 | 命令 / 环境 | 结果 | 日志 |
|---|---|---|---|
| W01 | Windows `dwgx`（Node `v24.19.0`）`npm run test:release`（`node scripts/run-test-shard.mjs 0 1`） | **exit 0 — 605/605 files, 7,455 tests / 7,352 pass / 0 fail / 103 skip**；wall **1,310.6 s**。103 skip 全是平台/环境守卫（见 §3.3） | `final-test-release-2.log`，3,699,432 B，`sha256 2bdf5bdce5e1123c6b51add46798be89f0c0685910a3fb6d719482465531d3ba` |
| I01 | 7 个身份测试文件（`client-identity-neutralize`、`identity-neutralization`、`identity-neutralize-paragraph-bound`、`identity-neutralize-shapes`、`neutralize-rewrite-visibility`、`identity-neutralize-complexity`、`identity-neutralize-integrity`） | **exit 0 — 147 pass / 0 fail / 0 skip** | `releasecommit-identity.log`，16,900 B，`sha256 2be74da7466dc6c3c6f5646f60eb278f8654001f16e169b6829b43397fb2d4ae` |
| C01 | `context-management-signed-replay` + `cc-claude-2-1-306` | **exit 0 — 28 pass / 0 fail / 0 skip** | `releasecommit-ctx.log`，4,038 B，`sha256 77a3a780b72ee88834a0a16ae60eb1e9124fdae420b7fbc4a35fd56552377b3e` |
| K01 | `cascade-image-cancel` + `cascade-history-serialization` + `cascade-image-history` + `cascade-abort-side-effects` + `cascade-completion-controls` | **exit 0 — 39 pass / 0 fail / 0 skip** | `releasecommit-cascade.log`，38,910 B，`sha256 e27295fbbd8676c9e1c1f83604abe7c92ac80ce1c4b9d07b3a80e5f13455fc38` |
| T01 | `node --import ./test/setup-env.mjs --test test/transport-matrix.test.js` | **exit 0 — 22 pass / 0 fail / 0 skip** | `releasecommit-transport.log`，34,433 B，`sha256 335670b2829a4929477140832488354d0803e464a62a9f1c427f1840d156a716` |
| D01 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | **exit 0 — 47 pass / 0 fail（9 suites）** | `releasecommit-docs-guard.log`，5,088 B，`sha256 0a96cf699afb11ea454bb6fdc6e3f2631bd77eabb03388174b8316963fc880f4` |
| S01 | `node scripts/spec-static-check.mjs` | **exit 0 — `specs: 97  mutations: 863`，anchors unique，baselines positive integers** | `releasecommit-spec-static.log`，140 B，`sha256 b64bdf4ed6e0478a49e65a483c8079942b1697514e6448d7f9f3d37c683cc85a` |
| B01 | `node scripts/spec-baseline-check.mjs identity-neutralize-paragraph-bound.json neutralize-rewrite-visibility.json` | **exit 0 — 2 spec measured, 0 drift, 0 untrustworthy** | `mutation-baseline-refresh.log`，233 B，`sha256 3c4e2d30f089307e5226a8e2bc62c35662fee1417393d7afe20c3b5a952d2d2b` |
| B02 | `node scripts/spec-baseline-check.mjs --all`（release workflow 模式） | **exit 0 — 97 spec measured, 0 drift, 0 untrustworthy**，wall 202.5 s | `releasecommit-spec-baseline-all.log`，8,096 B，`sha256 da0d49db2fc3abbfa1422087b9f08b56e3812a00d07a0a1e90545d3d57fa7528` |
| W02 | `WIRE_BASE_TREE=…/release-next-pr282 WIRE_BASE_TAG=v3.141.592658 WIRE_BASE_SHA=08a750d1… WIRE_BASE_REQUIRED=1 node --import ./test/setup-env.mjs --test test/wire-byte-identity.test.js` | **exit 0 — 270/270 byte-identical, 0 expected, 0 unexpected** | `releasecommit-wire.log`，12,188 B，`sha256 7a3fc3547c4d965c209641de79e0b9013a7caea0760e2ddcf3a45af21ce3659f` |
| SEC01 | `node scripts/secret-scan.mjs` | **exit 0**，0 字节输出 | `releasecommit-secret-scan.log`，`sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| H01 | `node scripts/history-secret-scan.mjs` | **exit 0 — 464 refs / 2,336 commits / 7,332 blobs, 20 findings，0 unbaselined** | `releasecommit-history-scan.log`，2,397 B，`sha256 31b9ae42cca058c858c1b6f914a31afd11e020594b329b582b7b10fa95a3dff6` |
| RC01 | `sha256sum runtime-config.json`（全部测试前后） | **`c97393756ce00a29aaf283b1d40488ff5c6d7abd162b48fd89b02893315bb82f` 未变** | 运行记录；备份 `runtime-config.pre-releasecommit.json` 同哈希 |
| G01 | `git diff --check` | **exit 0**（无空白损坏） | 终端 |

### 3.1 wire 身份

| 项 | 值 |
|---|---|
| 比较数 | **270**（`EXPECTED_COMPARISONS = 270`） |
| 基线 | `v3.141.592658` → `08a750d1a6d26f5d3b2f010c878170a9508730a8`（`expected_from: selection+env`，`expected_releases: 135`，`tag_ref_verified: true`） |
| tested | `deeb25394b8c77915dc42928cc940b9557187e77`（发布提交的祖父；发布侧只改测试/文档/版本，`src/` 逐字节相同） |
| 结果 | **270/270 byte-identical，0 expected diffs，0 unexpected** |
| tested / base dirty | `tested_dirty:true` / `base_dirty:false`；`tested_dirty` 只反映 600+ 个**未跟踪**证据文件，跟踪树干净；`base_head` 与 `expected_sha` 相等且不等于 `tested_head`（拒绝自比较） |

```text
WIRE_PROVENANCE {"tested_head":"deeb25394b8c77915dc42928cc940b9557187e77","tested_root":"D:\\Project\\WindsurfAPI","tested_dirty":true,"base_root":"D:\\Project\\WindsurfAPI\\.claude\\worktrees\\release-next-pr282","base_head":"08a750d1a6d26f5d3b2f010c878170a9508730a8","base_dirty":false,"expected_tag":"v3.141.592658","expected_sha":"08a750d1a6d26f5d3b2f010c878170a9508730a8","expected_from":"selection+env","expected_releases":135,"selection_error":null,"tag_ref_verified":true,"env":{"WIRE_BASE_SHA":"08a750d1a6d26f5d3b2f010c878170a9508730a8","WIRE_BASE_TAG":"v3.141.592658","WIRE_BASE_REQUIRED":true},"comparisons":270}
WIRE_PROVENANCE_COMPARED {"compared":270,"expected":270,"base_head":"08a750d1a6d26f5d3b2f010c878170a9508730a8"}
WIRE_EXPECTED_DIFFS {"byte_identical":270,"expected":0,"entries":0,"compared":270}
```

### 3.2 mutation 与 history 扫描

| 项 | 值 |
|---|---|
| mutation 静态 | **97 spec / 863 mutation**，锚点唯一（S01） |
| mutation 基线（全量） | **exit 0 — 97 spec measured, 0 drift, 0 untrustworthy**（`--all`，wall 202.5 s） |
| mutation 变异体本身 | **未跑（`[UNVERIFIED]`）**。本机 checkout 有 600+ 未跟踪文件，`mutate-verify` 要求干净树；sweep 的 `git clone --local` 工作区按 POSIX 设计。发布前在 HMC 上补跑 `node scripts/mutation-sweep.mjs --shard 0/1 --report-dir /tmp/mutation-592659` 与 `--verify` |
| history secret scan | **exit 0 — 464 refs / 2,336 commits / 7,332 blobs，20 findings，0 unbaselined**（`05dc9a71` 已收录 pre-fix fixture 的 reviewed 条目；原始行 `history-secret-scan: 464 refs, 2336 commits, 7332 blobs scanned, … 20 finding(s) (0 unbaselined)`） |

### 3.3 skip 名单（103）

| 文件 | skip | 原因（测试自带 skip 文案） |
|---|---:|---|
| `update-script-release-target.test.js` | 46 | real-Git fixtures require git at a trusted absolute POSIX system path |
| `mutate-verify-harness.test.js` | 27 | 同上 |
| `docker-oneclick-update.test.js` | 13 | `deploy/update.sh` integration fixtures require a POSIX host |
| `self-update-attestation.test.js` | 5 | real-Git fixtures require git at a trusted absolute POSIX system path |
| `self-update-gate.test.js` | 3 | 同上 |
| `release-signing.test.js` | 2 | requires a POSIX host to exec a shebang fake cosign |
| `self-update-untracked-safety.test.js` | 2 | real-Git fixtures require git at a trusted absolute POSIX system path |
| `log-files.test.js` | 1 | file symlinks require Developer Mode on this Windows host |
| `ota-fixture-containment-static.test.js` | 1 | real-Git fixtures require git at a trusted absolute POSIX system path |
| `release-attestation.test.js` | 1 | requires a POSIX host to exec a shebang fake cosign |
| `wire-byte-identity.test.js` | 1 | no pre-change tree to compare against — set `WIRE_BASE_TREE`（wire 身份在 W02 单独实测） |
| `wire-provenance.test.js` | 1 | real-Git fixtures require git at a trusted absolute POSIX system path |

## 4. 发布与部署记录

| 行 | 内容 | 结果 |
|---|---|---|
| 分支 | `fix/audit-wave-20261109`，无 upstream | 未 push |
| 合并 | 本任务**不合并**；runbook 要求分支 → review → `git merge --ff-only` | 未执行 |
| tag | `git tag -a v3.141.592659 -m "3.141.592659"` + `git push origin v3.141.592659` | **未执行**（本任务禁止 tag/push） |
| 部署 | HMC 切换与回滚见发布说明 §5 / `ReleasePrep.md` §7 | **未执行** |

> tag 与 push 在本文件冻结之后执行，因此结果不能写进本文件（写入就会改变 tag 指向的提交）。
> 命令、输出与 `git ls-remote` 的逐字结果应记录在仓库外的执行报告里。

## 5. 残差与 `[UNVERIFIED]` 边界

以下不是「已认证」，不得在发布说明或部署验收中写成已完成：

- **mutation 变异体本身未跑**：`spec-baseline-check` 只证明锚点与基线成立，不执行变异体。
  A4、messages、identity 的改动动了 spec 覆盖的文件，不能沿用旧 sweep 的结论。
- **Node 22 全量已实测**：`test:release` 的分片（`scripts/run-test-shard.mjs 0 1`）由
  Node 22.23.4 二进制直接运行，**605 文件 / 7,455 测试 / 7,352 通过 / 0 失败 / 103 跳过 /
  801.6 s**（`node22-release-2.log`；
  `TEST_SHARD_SUMMARY {"files":605,"tests":7455,"pass":7352,"fail":0,"skipped":103}`）。
  `engines >=22.13.0` 的精确 floor（22.13.x）仍未单独跑矩阵。
- **托管 CI 未运行**：分支没有 upstream；所有 CI 结论都是本机测量。
- **HMC 部署/回滚未执行**：发布说明 §5 与 `ReleasePrep.md` §7 只有命令，没有运行记录。
- **live 上游/真实客户端未复跑**：WA-001/002/003/A4、CTX-01、S03、IMG-01、TRN-01 的验证
  全部是隔离函数与 hermetic 测试；没有把病态 payload 发给真实服务。
- **发布产物不存在**：资产、cosign 签名、SHA256SUMS、release attestation 都要在 tag 之后由
  release workflow 生成；本附录不代表它们已经发生。
- **沿用 592658 的边界**：M4 rescue 未在真实上游触发、多段 `#10`/`#21` 未线上观测、官方
  `pr-gate` 仍 `INCOMPLETE`（relogin 真实密码缺口）。这些不因本版改变。
