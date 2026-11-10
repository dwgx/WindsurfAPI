# 3.141.592661 验收附录（2026-11-11）

本附录是 `3.141.592661` 的认证记录，与
[`RELEASE_NOTES_3.141.592661.md`](RELEASE_NOTES_3.141.592661.md) 一起构成本版的验收记录。
它记录发布提交、本树重测的逐项门禁计数，以及**明确没有测的东西**。

**与 3.141.592660 / 3.141.592659 的关系。**

- `3.141.592659` 从未发布：本地 annotated tag `1d63a030` → `d5519da3`，该 commit 早于
  JSON Schema `pattern` 边界修复 `babafeef`，**未修复**；永久冻结，不 push、不删除、不复用。
- `3.141.592660` 的 tag **公开**（对象 `2a705549` → commit `499fc285`），但它的 Release
  run `42910075837` 是 `completed failure`：`TEST_SHARD_SUMMARY` 3 个失败——docs guard 2
  （`CHANGELOG.md` tag 行 230 vs CI checkout 229，加生成器字节漂移）与 smoke 1
  （`docs.guard-passes-with-self-tests`，136/137）。**零资产，连 draft 都没有。**
- 本版 `3.141.592661` 是同一棵 `src/` 树（`babafeef`）+ 两个 CI 阻断项修复 + 版本/文档
  指针；这是首个真正能产出资产的公开发布。

- 发布版本：**3.141.592661**
- 发布提交：**本文件所在的提交**（分支 `fix/ci-tag-count-20261111`，基于 `master`
  `499fc285`）。提交 SHA 由后续 tag 固定；本文件冻结时 tag 尚不存在，不能自指。
- 发布提交的父提交：`499fc285b7b4a50e45cca8ce5a2182027a5ee6ec`（`v3.141.592660` 的
  commit；该 tag 的 Release 失败）。
- 最后一个改 `src/` 的提交：`babafeef28f5e264b96386919b9303d90a7fac3b`；
  `git diff --name-only babafeef..HEAD -- src/` 为空。
- 冻结 tag（**不在发布路径上**）：`v3.141.592659`，对象 `1d63a030` → commit `d5519da3`。
- 上一个公开 tag（**零资产**）：`v3.141.592660`，对象 `2a705549` → commit `499fc285`。
- 本提交只改版本、测试、生成器与文档：`git diff HEAD^ HEAD -- src/` 为空。

## 1. 本提交改了什么

| 文件 | 改动 | 为什么 |
|---|---|---|
| `scripts/sync-changelog-counts.mjs` | `countGitTags` → `listGitTags` + `unpublishedTagVersions` + `countPublishedTags`；tag 行口径文字 | tag 行必须数「已发布命名空间」，不是本 clone 的 ref 数 |
| `docs/releases/UNPUBLISHED-TAGS.txt` | 新增；只登记 `v3.141.592659` | 登记册是减法的唯一来源；`.592660` 不能登记（远端可见，减了会变 228） |
| `test/changelog-counts.test.js` | 新增；5 个用例 | 钉住「登记 tag 的存在与否不移动计数」；guard 本身不改 |
| `docs/releases/README.md` | §7 增加一句登记册说明 | 发布者要知道 tag 计数为什么是 checkout 不变量 |
| `scripts/history-secret-scan.baseline` | 第 27 行新增一条 SYNTHETIC 基线 | 旧 blob 永久在历史里；树已是自标记夹具，扫描器/规则/test 不改 |
| `package.json` | `3` 行版本 → `3.141.592661` | 发布版本；`src/version.js` 从它读版本，因此**不改** `src/version.js` |
| `package-lock.json` | `3`、`9` 两处版本 → `3.141.592661` | 锁文件把版本写两次；docs guard 断言两处都等于 `package.json` |
| `docs/releases/RELEASE_NOTES_3.141.592661.md` | 新增 | 本版发布说明：两个 CI 修复 + 发布状态 + 边界 |
| `docs/releases/ACCEPTANCE_3.141.592661.md` | 新增 | 本文件 |
| `CHANGELOG.md` | 新增 v3.141.592661 索引行；`当前` 行；计数行由脚本重生成 | 计数行**不手写**：`node scripts/sync-changelog-counts.mjs` |
| `docs/UNVERIFIED.md` | 全量重生成 | 登记册是生成物：`node scripts/unverified-register.mjs` |
| `docs/HANDOFF-2026-10-15.md` | §0 的 `产品 tag`、`package.json` 行 | §0 只写当前状态；`.592659` 的冻结事实逐字保留 |
| `README.md` / `README.en.md` | 发布指针 → v3.141.592661；发布说明 220→221 | 读者看到的「本版发布」必须是本版 |
| `docs/README.md` | 发布说明计数 220→221；验收附录指向本版 | 索引与磁盘一致 |
| `SECURITY.md` | 修复版本 `3.141.592661` + 指向本版发布说明 | 漏洞修复在哪个版本，读者要能一眼看到 |
| `docs/index.html` | hero badge → v3.141.592661 | 落地页版本指针 |

## 2. 本树门禁实测（2026-11-11，本机 Windows `dwgx` / Node `v24.19.0`）

全部用 `node --import ./test/setup-env.mjs --test …`（禁止裸 `node --test`：它会重写
`runtime-config.json`）。

| 行 | 命令 | 结果 |
|---|---|---|
| D01 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | **47 pass / 0 fail**（9 suites） |
| C01 | `node --import ./test/setup-env.mjs --test test/changelog-counts.test.js` | **6 pass / 0 fail** |
| U01 | `node --import ./test/setup-env.mjs --test test/unverified-register.test.js` | **7 pass / 0 fail** |
| J01 | `node --import ./test/setup-env.mjs --test test/json-schema-pattern-safety.test.js test/json-schema-budget.test.js` | **38 pass / 0 fail**（13 + 25） |
| N01 | `node scripts/sync-changelog-counts.mjs --check` | **exit 0** —— `notes=221 tags=229` |
| H01 | `node scripts/history-secret-scan.mjs` | **21 finding(s) (0 unbaselined)，exit 0** |
| SEC01 | `npm run secret-scan`（`node scripts/secret-scan.mjs`） | **exit 0**，0 字节输出 |
| G01 | `git diff --check` | **exit 0** |
| V01 | `node -p "require('./package.json').version"` | **`3.141.592661`** |
| V02 | `git diff HEAD -- src/`（提交前）/ `git diff HEAD^ HEAD -- src/`（提交后） | **空**（`src/version.js` 未动） |
| RC01 | `sha256sum runtime-config.json`（测试前后各一次） | **`c97393756ce00a29aaf283b1d40488ff5c6d7abd162b48fd89b02893315bb82f` 未变** |

## 3. 三种 checkout 形状与 RED 对照（一次性 clone，不动工作树）

| 形状 | 命令 | 结果 |
|---|---|---|
| A（作者主机，231 tag：含冻结 `.592659` 与本地 `.592661`） | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` + `node scripts/sync-changelog-counts.mjs --check` | **47/47**，`--check` **exit 0**（`notes=221 tags=229`） |
| B（master CI，clone 里删除 `.592659` 与 `.592661` → 229 tag） | 同上 | **47/47**，`--check` **exit 0**（`notes=221 tags=229`） |
| C（Release CI，只删除冻结 `.592659`、保留 `.592661` → 230 tag） | 同上 | **47/47**，`--check` **exit 0**（`notes=221 tags=229`） |
| RED（Shape C 里把行改成 `999`） | 同上 | docs guard **45/47**，`--check` **exit 1** —— `table says 999 tags, git lists 229` |

三种形状同值 **229**：登记册把主机独有的冻结 tag 减掉，`countPublishedTags()` 再把
`package.json` 版本的 tag 按**名字**减掉（本版自己的 tag，创建前后都不计数）。因此打 tag
不移动这一行，不需要第二次提交或移动 tag。登记册**不能**列出 `.592660`（远端可见，列了会
在每种 checkout 都多减 1）。逐字输出见本次交付报告。

## 4. 发布顺序（本任务未执行）

按 `skill://release` 与 `docs/releases/README.md` §7 的顺序，每步都要在下一步之前绿：

1. 本提交（版本 + 测试 + 文档）→ 干净树。
2. POSIX 干净树跑 99 spec 全量 sweep 与 `npm run test:release`（§5 两条 `[UNVERIFIED]`）。
3. `git switch master && git merge --ff-only fix/ci-tag-count-20261111`。
4. `git push origin master`（推送门三条：`git status --porcelain` 空、`git fetch` 后
   `git log --oneline origin/master..HEAD` 全是本波产物、`git diff --stat origin/master...HEAD`
   无夹带）。
5. `git tag -a v3.141.592661 -m "3.141.592661"` → `git push origin v3.141.592661`。
6. release workflow 产出资产、`SHA256SUMS`、cosign 签名与 attestation。**3.141.592660 的
   资产数是 0**；本版必须等第 6 步的产物才算真正发布。
7. GHSA 两个 canonical 对象发布，`patched_versions: >= 3.141.592661`。
8. HMC 部署与回滚演练。

**tag 计数不随时间窗移动（本版修复）。** `CHANGELOG.md` 的 `git tag` 行由
`node scripts/sync-changelog-counts.mjs` 生成，口径是「本 checkout 的 `git tag` 数减去
`docs/releases/UNPUBLISHED-TAGS.txt` 里存在的未发布 tag，再减去 `package.json` 版本的
tag」。作者主机 231−1−1、master CI 229−0−0、Release CI 230−0−1 都是 **229**。第 5 步
创建 tag 之后**不需要**再跑生成器、再提交或移动 tag；三种 checkout 读同一棵树都得到 229，
`.592660` 那种「主机 230 / CI 229」的分裂不会出现。

## 5. 仍未测 —— 不得写成已通过

- **99 spec / 878 mutation 的全量 sweep（本树）`[UNVERIFIED]`**：`babafeef` 改了
  `src/json-schema.js` 与 `src/handlers/chat.js`，两者都在 spec 覆盖范围内。
  `spec-baseline-check` 只证明锚点与基线成立、不执行变异体；本版只跑了受影响集合。
  闭合命令（POSIX，干净树）：
  `for s in test/mutations/*.json; do npm run mutate -- "$s"; done`（`CONTRIBUTING.md:96`）。
- **`npm run test:release` 全量 shard（本树）`[UNVERIFIED]`**：本 checkout 的
  `listTopLevelTestFiles()` 发现 **627** 个 `*.test.js`（660 的 626 + 本版新增的
  `test/changelog-counts.test.js`）；最后一次全量是 `d5519da3` 的 605 文件 / 7,455 测试。
  Windows 上该 shard 预期 103 条 skip（平台/环境守卫），skip 声明不是绿。
- **wire 270/270（本树）`[UNVERIFIED]`**：默认路径对 `v3.141.592658` 的 270/270 逐字节
  一致是在 `deeb2539` 上测的（距本树 87 个提交 / 34 个 `src/` 文件）；本树未复测，本机
  wire 门 inert（`skipped:1`）。`src/` 与 660 相同，但「相同」不是本树的测量。
- **POSIX 全量门 `gate:release` `[UNVERIFIED]`**：本机只跑 Windows 受影响集合；POSIX
  干净树的 `npm run gate:release` 未跑。
- **托管 CI `[UNVERIFIED]`**：分支 `fix/ci-tag-count-20261111` 没有 upstream；本附录所有
  计数都是本机测量。两种 checkout 形状已在一次性 clone 里复现，但 GitHub Actions 上的真实
  运行要等 push。
- **HMC 部署与回滚演练 `[UNVERIFIED]`**：本版没有部署。回滚命令见发布说明 §5 与
  `ReleasePrep.md` §7，未执行。
- **live 上游 / 真实 Desktop/客户端 `[UNVERIFIED]`**：全部验证都是隔离函数与 hermetic 测试；
  病态 payload 没有发给真实服务。
- **pkg 单文件二进制 `[UNVERIFIED]`**：本版未构建/启动 `@yao-pkg/pkg` 产物。
- **GHSA 公告 `[UNVERIFIED]`**：`GHSA-fx5f-49jr-fw6r` 与 `GHSA-r7v2-3h32-f5g6` 的
  `patched_versions` 是 `>= 3.141.592661`，但公告在 push + CI 绿之后才发布；写本文件时
  尚未发布。
- **Node 22 全量（本树）`[UNVERIFIED]`**：`engines >=22.13.0`；22.23.4 的 605 文件全量跑
  在更早的树上，本树未跑。

## 6. D5 准入残余 — 与 3.141.592660 相同（**仍未签字**）

本版 `src/` 零改动，不新增候选 SHA，因此不改变
[`ACCEPTANCE_3.141.592660.md`](ACCEPTANCE_3.141.592660.md) §5 的 D5 决策：`babafeef` 只有
每请求 50 ms 预算、无进程级并发/连续滥用准入；Owner 可选 **(a) 作为 P2 残余在本版接受并
延后至下一版** 或 **(b) 本版即闭合**（= 新 src 改动 + 新测试 + 新候选 SHA + 重跑 D1 门禁）。
默认按 (a) 推进；未签字前不得对外宣称「无已知缺口 / ALL GREEN / ready to push」。
