# v3.141.592661

**这是首个真正公开发布的修复版（first public fix release）。** `v3.141.592660` 的 tag 虽然
已经公开，但它的 Release/CI 失败、**零资产**——用户拿不到任何可安装产物。本版修掉导致那次
失败的两个 CI 阻断项，把发布指针推进到 3.141.592661；`src/` 树与 3.141.592660 逐字节相同
（`babafeef`），因此产品行为没有任何变化。

## 发布状态（先读这一节）

| 版本 | 状态 | 事实 |
|---|---|---|
| `v3.141.592659` | **从未发布，永久冻结** | 本地 annotated tag 对象 `1d63a030` → commit `d5519da3`。该 commit 早于 JSON Schema `pattern` 边界修复 `babafeef`，**未修复**；不 push、不删除、不复用，不在发布路径上。 |
| `v3.141.592660` | **公开 tag，Release 失败，零资产** | tag 对象 `2a705549` → commit `499fc285`。Release run `42910075837` 结论 `completed failure`：`TEST_SHARD_SUMMARY` 报 3 个失败——docs-guard 2 个（`CHANGELOG.md` 的 tag 行写 230，而 `fetch-depth: 0` 的 CI checkout 只有 229；同一行的生成器字节漂移）与 smoke 1 个（`docs.guard-passes-with-self-tests`，136/137）。**没有发布任何资产，连 draft 都没有。** |
| `v3.141.592661` | **本版** | 同一棵 `src/` 树（`babafeef`）+ 两个 CI 阻断项修复 + 版本/文档指针。本文件写于 tag 之前；资产由 tag 之后的 release workflow 生成。 |

`v3.141.592660` 的失败不是 `src/` 回归：两个阻断项都是发布基础设施与历史语料的问题。
本版只改生成器、登记册、基线、测试与文档；`git diff babafeef..HEAD -- src/` 为空。

## 0. 范围

- 产品代码：**零改动**。最后一个改 `src/` 的提交仍是 `babafeef`（JSON Schema `pattern`
  50 ms 共享预算 + `valid|invalid|unable` 三态判定）；`src/version.js` 不硬编码版本，
  继续从 `package.json` 读取，因此**不动**。
- 本版修复：
  1. `CHANGELOG.md` 的 `git tag` 计数改为 **checkout 不变量**（生成器 + 登记册 + 回归测试）。
  2. 历史 secret scan 收录一条 **SYNTHETIC** 旧 blob 基线（`test/auth-warning.test.js`，
     指纹 `291ca1d29216`），恢复 `0 unbaselined`。
- 本版升级：`package.json` 与 `package-lock.json`（两处）→ `3.141.592661`；发布说明、
  验收附录、`CHANGELOG.md`、活交接 §0、README/README.en、docs 索引、落地页 badge、
  `SECURITY.md` 的修复版本指针。
- 产品内容的完整说明仍在
  [`RELEASE_NOTES_3.141.592660.md`](RELEASE_NOTES_3.141.592660.md)：身份中和器
  WA-001/002/003、A4、CTX-01、S03、IMG-01、TRN-01 与 `pattern` 预算（§1.1–§1.8）。
  本版不重抄那些机制，也不改变它们。

## 1. 修了什么

### 1.1 `git tag` 计数：从「本 clone 抓到了什么」改为「仓库发布了什么」

**故障。** `CHANGELOG.md` 的 `| git tag | N 个 |` 行由
`scripts/sync-changelog-counts.mjs` 从 `git tag | wc -l` 生成。2026-11-11 的发布提交在作者
主机上测得 **230**，于是写进 CHANGELOG；任何 `fetch-depth: 0` 的 CI checkout 只有 **229**。
差值恰好是 `v3.141.592659`——一个只在本地创建、从未 push 的冻结 tag。`git tag` 回答的是
「这个 clone 抓到了哪些 ref」，不是「这个仓库发布了哪些 tag」；同一行不可能在两种 checkout
里都正确。release workflow 的 docs guard 在 tag 的 checkout 上重跑，于是 230-vs-229 把
Release 打成失败。

**修法。** 生成器把 tag 行改为**已发布命名空间**的计数：

- 新增 `docs/releases/UNPUBLISHED-TAGS.txt`：登记「存在于某些 checkout、但从未 push」的
  tag，一行一个版本，`#` 起注释。本版只登记 `v3.141.592659`。
- 新增 `unpublishedTagVersions()`：读登记册，拒绝非版本行（拼错不能静默变成零减法）。
- 新增纯函数 `countPublishedTags(tags, unpublished, packaged)`：
  `|本 checkout 的 tags| − |登记册 ∩ 本 checkout 的 tags| − [v<packaged> ∈ tags]`。登记册
  里但本 checkout 没有的条目不减——那正是 CI checkout；本版自己的 tag 按**名字**排除，
  创建前后都不计数。不按版本比较：`v3.2.6-rc4/rc5/rc6` 不是纯 `x.y.z`，`< package.json`
  会把它们静默丢掉。
- `changelogCounts()` 改用 `listGitTags()` + `countPublishedTags()`；`countGitTags()` 被
  替换，不保留兼容别名。
- tag 行的口径文字同步改为「`git tag \| wc -l` 减去
  `docs/releases/UNPUBLISHED-TAGS.txt` 里本 checkout 存在的未发布 tag，再减去
  `package.json` 版本的 tag——本次发布自己的 tag，创建前后都不计数」。

**算术（实测）。**

| checkout | `git tag` | 登记册命中 | 本版 tag 命中 | 行值 |
|---|---:|---:|---:|---:|
| 作者主机（661 本地已打） | 231 | 1（`.592659`） | 1（`.592661`） | **229** |
| master CI（661 未 push） | 229 | 0 | 0 | **229** |
| Release CI（661 tag checkout） | 230 | 0 | 1 | **229** |

三种 checkout 同值 **229**，打 tag 不移动这一行。**`.592660` 不能登记**：它是远端可见 tag
（每种 checkout 都有），登记它会在每种 checkout 都多减 1，反而制造新的不一致；它的零资产
状态是发布流水线事实，不是 `git tag` 事实。

**回归测试。** `test/changelog-counts.test.js`（6 个用例）：登记 tag 的存在与否不移动
计数；本版自己的 tag 出现与否也不移动计数；登记只在有它的 checkout 里减；无 tag 时返回
`null` 而不是 0；CHANGELOG 的行等于「从未抓取本地 tag 的 checkout」的计数；登记册的坏行
抛错而不是静默零减法。
`test/docs-consistency-guard.test.js` **未改**——它仍按字节比较生成器的输出。

### 1.2 历史 secret scan：一条 SYNTHETIC 旧 blob 基线

**故障。** CI 的 `History secret scan` 报 1 条未基线化发现：
`test/auth-warning.test.js:158 openai-api-key fp=291ca1d29216`。该值是**合成夹具**——修复前
`maskApiKey` 长度缩放测试用的 27 字符 `sk-` 前缀可读占位符，当时没有夹具标记。HEAD 的树
已把它换成自带标记的夹具，但旧 blob 永久留在历史里（`f43b5b7a`），扫历史就一定会再见到它。

**修法。** 在 `scripts/history-secret-scan.baseline` 的第 27 行（路径序：
`test/auth-warning.test.js` 在 `test/dashboard-devin-read.test.js` 之前）插入一条 reviewed
条目，指纹为 `sha256(secret)[:12]` = `291ca1d29216`，理由写明 SYNTHETIC 与旧 blob 的位置。
**不改** `test/auth-warning.test.js`、扫描器或规则：finding 是历史事实，测试树已经是正确的
自标记夹具。

**实测。** `node scripts/history-secret-scan.mjs` → `21 finding(s) (0 unbaselined)`，
`EXIT=0`。负向对照（故意写错指纹）→ `EXIT=1`，证明基线不是无条件放行。

### 1.3 版本与发布指针

- `package.json:3` 与 `package-lock.json:3,:9` → `3.141.592661`；`src/version.js` 未动。
- `CHANGELOG.md`：新增 v3.141.592661 索引行与 `当前` 行；两个计数行只由生成器写。
- `docs/HANDOFF-2026-10-15.md` §0：`产品 tag` → `v3.141.592661`，`package.json` →
  `3.141.592661`；冻结 tag 的 `v3.141.592659` 事实**逐字保留**。
- `docs/index.html` badge、`README.md` / `README.en.md` 发布段、`docs/README.md` 索引、
  `SECURITY.md` 致谢段 → 本版。
- `docs/UNVERIFIED.md` 是生成物：`node scripts/unverified-register.mjs` 重生成，
  `test/unverified-register.test.js` 7/7。

## 2. 风险与影响面

- **运行时：无变化。** `src/` 零差异；没有数据格式、配置键、环境变量或 API 形状变化。
  3.141.592660 的全部用户可见变化仍以
  [`RELEASE_NOTES_3.141.592660.md`](RELEASE_NOTES_3.141.592660.md) 为准。
- **发布基础设施：有变化。** `CHANGELOG.md` 的 tag 行从此在作者主机、master CI 与
  Release CI 三种 checkout 上给出同一个数（**229**）。tag 创建不再移动这一行，因此不需要
  在打 tag 后重生成、再提交或移动 tag；`.592660` 那种「一边 230、一边 229」的分裂不会再
  出现。
- **历史扫描：只增加一条 reviewed 合成夹具基线。** 不降低规则、不缩路径、不影响新发现；
  负向对照仍失败。
- **回滚成本：纯代码/文档回退。** 没有不可逆的数据迁移。

## 3. 验证证据（本树实测）

全部用 `node --import ./test/setup-env.mjs --test …`（禁止裸 `node --test`：它会重写
`runtime-config.json`）。本机 Windows `dwgx` / Node `v24.19.0`。

| 行 | 命令 | 结果 |
|---|---|---|
| D01 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | **47 pass / 0 fail** |
| C01 | `node --import ./test/setup-env.mjs --test test/changelog-counts.test.js` | **6 pass / 0 fail** |
| U01 | `node --import ./test/setup-env.mjs --test test/unverified-register.test.js` | **7 pass / 0 fail** |
| J01 | `node --import ./test/setup-env.mjs --test test/json-schema-pattern-safety.test.js test/json-schema-budget.test.js` | **38 pass / 0 fail** |
| N01 | `node scripts/sync-changelog-counts.mjs --check` | **exit 0** —— `notes=221 tags=229` |
| H01 | `node scripts/history-secret-scan.mjs` | **21 finding(s) (0 unbaselined)，exit 0** |
| SEC01 | `npm run secret-scan` | **exit 0**，0 字节输出 |
| G01 | `git diff --check` | **exit 0** |
| V01 | `node -p "require('./package.json').version"` | **`3.141.592661`** |
| V02 | `git diff HEAD -- src/`（发布提交前） | **空**；`src/version.js` 未动 |
| RC01 | `sha256sum runtime-config.json`（测试前后） | **`c97393756ce00a29aaf283b1d40488ff5c6d7abd162b48fd89b02893315bb82f` 未变** |

**三种 checkout 形状（一次性 clone，不动工作树）：**

- Shape A（作者主机，231 个 tag：含冻结 `.592659` 与本地 `.592661`）：docs guard
  **47/47**，`--check` **exit 0**（`notes=221 tags=229`）。
- Shape B（master CI，删除 clone 里两个 tag → 229 个 tag）：docs guard **47/47**，
  `--check` **exit 0**（`notes=221 tags=229`）。
- Shape C（Release CI，只删除冻结 tag、保留 `.592661` → 230 个 tag）：docs guard
  **47/47**，`--check` **exit 0**（`notes=221 tags=229`）。
- RED 对照（Shape C 里把行改成 `999`）：docs guard **45/47**，`--check` **exit 1**——
  `table says 999 tags, git lists 229`。

逐条命令与逐字输出见 [`ACCEPTANCE_3.141.592661.md`](ACCEPTANCE_3.141.592661.md) §2–§3。

## 4. 变更文件

| 文件 | 改动 |
|---|---|
| `scripts/sync-changelog-counts.mjs` | `listGitTags` + `unpublishedTagVersions` + `countPublishedTags(tags, unpublished, packaged)`；tag 行口径文字 |
| `docs/releases/UNPUBLISHED-TAGS.txt` | 只登记 `v3.141.592659`（冻结、从未 push） |
| `test/changelog-counts.test.js` | 6 个回归用例；登记 tag 与本版 tag 出现与否都不移动计数 |
| `docs/releases/README.md` | §7 增加一句：tag 计数是 checkout 不变量，登记册是减法来源 |
| `scripts/history-secret-scan.baseline` | 第 27 行新增一条 SYNTHETIC 基线 |
| `package.json` / `package-lock.json` | 版本 → `3.141.592661`（lock 两处） |
| `docs/releases/RELEASE_NOTES_3.141.592661.md` | 新增；本文件 |
| `docs/releases/ACCEPTANCE_3.141.592661.md` | 新增；验收附录 |
| `CHANGELOG.md` | 661 索引行 + `当前` 行；计数行由生成器重写 |
| `docs/UNVERIFIED.md` | 生成物重生成（新增 661 小节） |
| `docs/HANDOFF-2026-10-15.md` | §0 的 `产品 tag` 与 `package.json` 指针 |
| `README.md` / `README.en.md` / `docs/README.md` | 发布指针与发布说明计数 |
| `SECURITY.md` | 修复版本 → `3.141.592661` |
| `docs/index.html` | hero badge → `v3.141.592661` |

## 5. 回滚

本版没有数据格式、配置键或环境变量变更，回滚是纯代码/文档回退：

- **发布侧**：`v3.141.592661` 尚未 push 时，回滚就是放弃本分支；已 push 未打 tag 时，
  revert 发布提交并重新走 release 流程。不要 `git reset` 已推送的 master。
- **tag 侧**：`v3.141.592659` 与 `v3.141.592660` 都**不移动、不删除、不复用**；前者是冻结
  的未修复 tag，后者是公开但零资产的失败 tag。回滚不碰这两个 tag。
- **HMC**：本版没有部署（**2026-11-11 更正：这句写于发布前，已作废**——HMC 正跑
  `3.141.592661`，`/health` 为 `ok`、`NRestarts=0`、切换前备份 `prev27-20261111T002607Z`
  在位，R1/R2/R3 回滚演练 exit 0，见 §7「发布后核实」）；部署切换前的备份与回滚命令仍按
  3.141.592660 发布说明 §5 与 `ReleasePrep.md` §7 执行。
- **数据**：`data/` 不属于发布树的可替换部分；任何部署回滚都显式保留运行期间的账号与日志。

## 6. 发布门状态与阻断项

**本版修掉的两个阻断项：**

1. **docs guard 的 tag 计数（已修，本文件 §1.1）**：230-vs-229 的根因是 `git tag` 的
   checkout 局部性；登记册 + 纯函数减法（登记 tag 与本版自己的 tag）让三种 checkout 同值。
   回归测试 `test/changelog-counts.test.js` 钉住这两个不变量。
2. **History secret scan（已修，本文件 §1.2）**：旧 blob 的 SYNTHETIC 夹具已基线化；
   扫描 21 findings / 0 unbaselined，负向对照仍失败。

**tag 计数不再有时间窗。** 本提交时点 `--check` 是 `notes=221 tags=229`；创建
`v3.141.592661` 之后仍是 229（本版自己的 tag 按名字排除），所以**不需要**在 tag 所在提交
上重跑生成器、提交或移动 tag。作者主机、master CI、Release CI 三种 checkout 读同一棵树
都是 229；与 3.141.592660 不同，不会再一边 230、一边 229。

**仍未闭合的阻断项：** 见 §7。全量 `npm run test:release`、99 spec / 878 mutation 的全量
sweep、wire 270/270 的本树复测、POSIX `gate:release`、HMC 部署与真实客户端验证都**没有**
在本树完成；未跑完不得 push，也不得对外声称 ALL GREEN。

## 7. 已知 / 尚未验证

> 全部历史缺口见 [尚未验证登记册](../UNVERIFIED.md)；本版新增条目也在其中。

- **[UNVERIFIED] 99 spec / 878 mutation 的全量 sweep（本树）**：`babafeef` 改了
  `src/json-schema.js` 与 `src/handlers/chat.js`，两者都在 spec 覆盖范围内。
  `spec-baseline-check` 只证明锚点与基线成立、不执行变异体；本版没有新增 `src/` 改动，
  但也没有在本树复跑全量 sweep。闭合命令（POSIX，干净树）：
  `for s in test/mutations/*.json; do npm run mutate -- "$s"; done`。
- **[UNVERIFIED] `npm run test:release` 全量 shard（本树）**：本 checkout 的
  `listTopLevelTestFiles()` 发现 **627** 个 `*.test.js`（比 660 的 626 多出
  `test/changelog-counts.test.js`）；本版只跑了受影响集合（docs guard 47 + changelog-counts
  5 + unverified-register 7 + JSON Schema 38）。Windows 上该 shard 预期 103 条 skip
  （平台/环境守卫），skip 声明不是绿。
- **[UNVERIFIED] wire 270/270（本树）**：默认路径对 `v3.141.592658` 的 270/270 逐字节
  一致是在 `deeb2539` 上测的（距本树 87 个提交 / 34 个 `src/` 文件）；本树未复测，本机
  wire 门 inert（`skipped:1`）。`src/` 与 660 相同，但「相同」不是本树的测量。
- **[UNVERIFIED] POSIX 全量门 `gate:release`**：本机只跑 Windows 受影响集合；POSIX 干净树
  的 `npm run gate:release` 未跑。
- **[UNVERIFIED] 托管 CI**：本分支没有 upstream；本文件的所有计数都是本机测量。3.141.592660
  的失败正是托管 CI 的 docs-guard；本版的两种 checkout 形状已在一次性 clone 里复现，但
  GitHub Actions 上的真实运行要等 push。
- **[UNVERIFIED] HMC 部署与回滚演练**：本版没有部署；回滚命令见 §5 与
  `ReleasePrep.md` §7，未执行。
- **[UNVERIFIED] live 上游 / 真实 Desktop/客户端**：WA-001/002/003/A4 的验证全部是隔离
  函数与 hermetic 测试；没有把病态 payload 发给真实服务，也没有真实客户端复跑。HMC 的
  旧模块计时用的是 `/tmp` 副本，生产 `:18999` 未被写入。
- **[UNVERIFIED] 发布产物**：资产、cosign 签名、`SHA256SUMS`、release attestation 都要在
  tag 之后由 release workflow 生成；3.141.592660 的资产数是 **0**，本文件不代表 661 已经
  有产物。
- **[UNVERIFIED] pkg 单文件二进制**：本版未构建/启动 `@yao-pkg/pkg` 的 Windows/macOS 产物；
  `release.yml` 的 `exe-boot-smoke` 只在 tag 之后运行。
- **[UNVERIFIED] Node 22 全量（本树）**：`engines >=22.13.0`；22.23.4 的 605 文件全量跑在
  更早的树上，本树未跑。
- **[UNVERIFIED] GHSA 公告本身**：canonical 对象 D1 身份中和器 → `GHSA-fx5f-49jr-fw6r`、
  D2 JSON Schema `pattern` → `GHSA-r7v2-3h32-f5g6`；两者的 `patched_versions` 都是
  **`>= 3.141.592661`**。公告在 push + CI 绿之后才发布，写本文件时尚未发布——在此之前
  不得对外声称公告已存在。`GHSA-xp93-vpw9-39wx` 与 `GHSA-h858-8xv9-257g` 是重复草稿，
  应关闭，不发布。
- **沿用 3.141.592660 §7 的其余边界**：CTX-01 live、`clear_thinking` 模型族边界、S03 真实
  dashboard 客户端、IMG-01 真实 Cascade abort、TRN-01 上游角色语义、G01–G03/G06 真实客户端
  抓包、Q1 G4、support-bundle 生产形态、HTTP socket 端到端、进程级并发准入残余、Q4 G12、
  Q4 `messages.js` 日志、592658 的 M4/多段/`pr-gate` 边界——这些不因本版改变，逐条见
  `RELEASE_NOTES_3.141.592660.md` §7 与登记册。

### 发布后核实（2026-11-11）

> 本节在 tag、Release 与托管 CI 之后**追加**，不改写上面任何一条（它们记录的是写文件时点的
> 事实）。每条带 marker 与复核命令：`[VERIFIED]` = 2026-11-11 重测通过，`[UNVERIFIED]` = 仍未闭合。

- **[VERIFIED] 全量 shard（release run `42926473911` 的 `Test` job）**：2026-11-11 复核：该 run
  的 `Test` job `conclusion=success`，在 tag checkout 上跑的就是 `npm run test:release`
  （`.github/workflows/release.yml:79`）；本波在一次性 clone 的 Path C 树（只删冻结 tag、保留
  `.592661`，230 个 tag）上实测 **627** 文件 / **7,818** 测试 / 7,715 通过 / **0 失败** /
  103 跳过。skip 声明仍然不是绿——Node 22 与 POSIX 全量门见下面两条。
- **[VERIFIED] 托管 CI**：`CI` run `42925868761` = `completed` / `success`，`head_sha=fe98f0bc`
  （`gh api repos/dwgx/WindsurfAPI/actions/runs/42925868761`）；release run `42926473911` 的
  `Test` job 同样 `success`。
- **[VERIFIED] HMC 部署与回滚演练（§5 与 §7 #6 的「本版没有部署」作废）**：HMC `/health` 返回
  `version=3.141.592661`、`status=ok`；`systemctl show … -p NRestarts` = **0**；
  `accounts.active` = **1**；切换前备份 `prev27-20261111T002607Z` 在位；R1/R2/R3 回滚演练
  全部 exit 0。那两句是发布前的状态，已被本节取代（§5 另有 2026-11-11 的行内更正）。
- **[VERIFIED] 发布产物**：release `441079956`（`v3.141.592661`）`draft=false`、`assets=14`、
  `7` 个 `.sigstore.json`、每个资产都带 `digest`、`published_at=2026-11-11T00:18:15Z`，
  `/releases/latest` 指向同一 id；`SHA256SUMS` 4/4 与 REST `digest` 逐条一致。
- **[VERIFIED] pkg 三目标构建 + boot-smoke（CI 侧）**：Windows / macOS arm64 / macOS x64 三个
  构建 job 都在上传前调用 `scripts/exe-boot-smoke.mjs`
  （`release.yml:238`、`:277`、`:326`），run `42926473911` 里这三个 job 全 `success`。
- **[UNVERIFIED] pkg 残余：本机启动**：上面证明的是 CI 构建出的二进制通过 smoke；本机没有
  boot 过这三个产物，所以「本机启动」仍是未测项。
- **[VERIFIED] GHSA 公告**：`GHSA-r7v2-3h32-f5g6` 与 `GHSA-fx5f-49jr-fw6r` 均
  `state=published`、`patched_versions >= 3.141.592661`、`credits=fishfish57`、CVSS 6.5；
  重复草稿 `GHSA-xp93-vpw9-39wx` / `GHSA-h858-8xv9-257g` 已 `closed`。**`cve_id` 仍为
  `null`**（GitHub CNA 异步分配）——这一项未闭合。
- **[VERIFIED] wire 托管侧（部分闭合）**：CI 的 `Default-path request bytes` job 在 `fe98f0bc` 上
  `success`，且设了 `WIRE_BASE_REQUIRED=1`；基线由 `scripts/wire-base.mjs` 选最新严格祖先
  annotated tag，本版选到 `v3.141.592660`（不是 `.592658`）。**仍未闭合**：本机 wire 门 inert，
  270/270 没有在本树复测——所以本条不写成「本机 270/270 已复测」。
- **[VERIFIED] POSIX 全量门托管侧（部分闭合）**：`gate:release` 的 6 个步骤里 4 个已在托管 run 上
  分别跑过（`spec-static-check`、`spec-baseline-check --all`、`secret-scan`、`test:release`）。
  **仍未闭合**：`git diff --check` 与 `git diff --cached --check` 两步没有任何 workflow 运行
  （`grep -n 'diff --check' .github/workflows/*.yml` 为空），单命令 `npm run gate:release` 从未跑过。
- **[UNVERIFIED] 99 spec / 878 mutation 全量 sweep**：本机 0 次执行；托管侧
  `spec-baseline-check.mjs --all` 只校验锚点与基线、不执行变异体。闭合命令不变。
- **[UNVERIFIED] live 上游 / 真实 Desktop 客户端抓包**：仍是隔离函数与 hermetic 测试，
  没有把病态 payload 发给真实服务。
- **[UNVERIFIED] Node 22 全量**：便携 Node 22 只在隔离目录里解包，全量没有跑。
- **[UNVERIFIED] 沿用 3.141.592660 §7 的其余边界**：CTX-01 live、`clear_thinking` 族边界、
  S03、IMG-01、TRN-01、G01–G03/G06、Q1 G4、support-bundle 生产形态、HTTP socket 端到端、
  进程级并发准入残余、Q4 G12、Q4 `messages.js` 日志、592658 的 M4/多段/`pr-gate`——逐条见
  `RELEASE_NOTES_3.141.592660.md` §7。

**`Run 42926473911` 的 `conclusion=failure` 是历史记录，本节不替它改口。** 真因是
`.github/workflows/release.yml` 的 `files:` 同时用 `*.sigstore.json` glob 和两行显式条目
列举了 `image-digest.txt.sigstore.json` 与 `release-attestation.json.sigstore.json`
（16 条路径 / 14 个唯一名）：action 不去重、无上限并发上传，同名两路上传互相 422 删除，
幸存的那次 PUT 404，于是 `Create GitHub Release` 失败、两个 bundle 缺位，资产由 release id
带外补齐。修法（显式 14 条清单 + `preserve_order` + `overwrite_files: false` +
`fail_on_unmatched_files` + 独立 `verify` job + 每 ref 串行 concurrency）只对之后创建的 tag
生效，本版无法回改。

## Security acknowledgments / 致谢

Thanks to fishfish (https://github.com/fishfish57) for two responsible disclosures, both
CWE-1333 event-loop blocking: the quadratic regex scans in the client-identity neutralizer
(reported 2026-11-08) and the unbounded JSON Schema `pattern` evaluation in
`src/json-schema.js` (reported 2026-11-10). Tracked as GHSA-fx5f-49jr-fw6r (identity
neutralizer) and GHSA-r7v2-3h32-f5g6 (JSON Schema `pattern`); both are fixed in
3.141.592661 (`patched_versions: >= 3.141.592661`), after the tag is pushed and CI is green —
not before.

感谢 fishfish（https://github.com/fishfish57）负责任地披露两个 CWE-1333（event-loop 阻塞）
问题：客户端身份中和器的二次正则扫描（2026-11-08 报告）与 `src/json-schema.js` 中
JSON Schema `pattern` 的无界求值（2026-11-10 报告）。分别跟踪为 GHSA-fx5f-49jr-fw6r 与
GHSA-r7v2-3h32-f5g6；修复见 3.141.592660 发布说明 §1.1 与 §1.8；本版把修复版本指针推进到
**3.141.592661**，`patched_versions: >= 3.141.592661`，公告在 push + CI 绿之后才发布。
