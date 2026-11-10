# 3.141.592660 验收附录（2026-11-11）

本附录是 `3.141.592660` 的认证记录，与
[`RELEASE_NOTES_3.141.592660.md`](RELEASE_NOTES_3.141.592660.md) 一起构成本版的验收记录。
它记录发布提交、本树重测的逐项门禁计数，以及**明确没有测的东西**。

**与 3.141.592659 的关系。** `3.141.592659` 从未发布：它的本地 annotated tag 指向
`d5519da3`，而该 commit 早于 JSON Schema `pattern` 边界修复 `babafeef`。Owner 选择升版
（Path B）：同一棵代码树以 `3.141.592660` 发布，`.592659` 的 tag 永久冻结、不 push、
不删除、不复用。那份草稿的全部冻结测量保留在
[`ACCEPTANCE_3.141.592659.md`](ACCEPTANCE_3.141.592659.md)（§0.1–§0.5 各波记录、§3 逐行
门禁表、§3.1 wire 逐字行、§3.3 103 条 skip 名单）——**本附录不重抄它们**，只记录
3.141.592660 这一版新增、重测与仍然缺失的内容。

- 发布版本：**3.141.592660**
- 发布提交：**本文件所在的提交** —— `docs(release): cut 3.141.592660 under path b`。
  提交 SHA 由 tag 固定：`git rev-parse 'v3.141.592660^{commit}'`（本文件冻结时 tag 尚不
  存在，不能自指）。
- 发布提交的父提交：`babafeef28f5e264b96386919b9303d90a7fac3b`（`fix(json-schema): bound
  pattern evaluation; never fold "unable" into a pass`）——最后一个改 `src/` 的提交，
  `src/` 树 `8ad39c24e3bd090d48a9e2d41c30298969d6e27c`。
- 上一个已发布 tag：`v3.141.592658` → `08a750d1a6d26f5d3b2f010c878170a9508730a8`。
- 冻结 tag（**不在发布路径上**）：`v3.141.592659`，对象 `1d63a030…` → commit `d5519da3…`。
- 基线：`origin/master` = `111e2c4e`（2026-11-11 实测；已合并，merge `388da84f`；
  `111e2c4e` 是 HEAD 的祖先，本分支领先 103 个提交、落后 0）。
- 本提交只改版本与文档：`git diff --name-only HEAD^ HEAD -- src` 为空。

## 1. 本提交改了什么

| 文件 | 改动 | 为什么 |
|---|---|---|
| `package.json` | `3` 行版本 → `3.141.592660` | 发布版本；`src/version.js:11` 从它读版本，因此**不改** `src/version.js` |
| `package-lock.json` | `3`、`9` 两处版本 → `3.141.592660` | 锁文件把版本写两次；docs guard 的 `test/docs-consistency-guard.test.js:243-246` 断言这两处都等于 `package.json` 的版本 |
| `docs/releases/RELEASE_NOTES_3.141.592660.md` | 新增 | 本版发布说明：3.141.592659 草稿的同树内容 + 发布指针改到本版 |
| `docs/releases/ACCEPTANCE_3.141.592660.md` | 新增 | 本文件 |
| `docs/releases/RELEASE_NOTES_3.141.592659.md` | 致谢段一句 | 草稿里「两份公告随本版发布」是**发布时点条件句**：`.592659` 从未发布，改为「随 v3.141.592660 发布、`patched_versions >= 3.141.592660`」 |
| `docs/releases/ACCEPTANCE_3.141.592659.md` | 冻结记录（本波之前已写） | 保留为历史；本版不改它的测量 |
| `CHANGELOG.md` | 新增 v3.141.592660 条目；`当前` 行；计数行由脚本重生成 | 计数行**不手写**：`node scripts/sync-changelog-counts.mjs` |
| `docs/UNVERIFIED.md` | 全量重生成 | 登记册是生成物：`node scripts/unverified-register.mjs` |
| `docs/HANDOFF-2026-10-15.md` | §0 的 `package.json` 行、`产品 tag` 行的发布决定、`master` 行措辞 | §0 只写当前状态；`.592659` 的 tag 事实保留（它仍是 `d5519da3`、仍禁止发布） |
| `docs/README.md` | 发布说明计数 219→220；验收附录指向本版 | 索引与磁盘一致 |
| `README.md` / `README.en.md` | 发布指针 → v3.141.592660，发布说明 219→220 | 读者看到的「本版发布」必须是本版 |
| `SECURITY.md` | 致谢段：修复版本 `3.141.592660` + 指向本版发布说明 | 漏洞修复在哪个版本，读者要能一眼看到 |
| `docs/index.html` | hero badge → v3.141.592660 | 落地页版本指针 |

## 2. 本树门禁实测（2026-11-11，本机 Windows `dwgx` / Node `v24.19.0`）

全部用 `node --import ./test/setup-env.mjs --test …`（禁止裸 `node --test`：它会重写
`runtime-config.json`）。

| 行 | 命令 | 结果 |
|---|---|---|
| D01 | `node --import ./test/setup-env.mjs --test test/docs-consistency-guard.test.js` | **47 pass / 0 fail**（9 suites，1.51 s） |
| U01 | `node --import ./test/setup-env.mjs --test test/unverified-register.test.js` | **7 pass / 0 fail**（0.39 s） |
| J01 | `node --import ./test/setup-env.mjs --test test/json-schema-pattern-safety.test.js test/json-schema-budget.test.js` | **38 pass / 0 fail**（13 + 25，5.48 s） |
| SEC01 | `npm run secret-scan`（`node scripts/secret-scan.mjs`） | **exit 0**，0 字节输出 |
| G01 | `git diff --check` | **exit 0**（两条 CRLF→LF 归一化提示，不是空白错误） |
| C01 | `node scripts/sync-changelog-counts.mjs --check` | **exit 0** —— `notes=220 tags=229` |
| RC01 | `sha256sum runtime-config.json`（测试前后各一次） | **`c97393756ce00a29aaf283b1d40488ff5c6d7abd162b48fd89b02893315bb82f` 未变** |
| V01 | `node -p "require('./package.json').version"` | **`3.141.592660`** |
| V02 | `git diff --name-only HEAD -- src/` | 空（`src/version.js` 未动） |

## 3. 仍未测 —— 不得写成已通过

- **99 spec / 878 mutation 的全量 sweep（本树）`[UNVERIFIED]`**：`babafeef` 改了
  `src/json-schema.js` 与 `src/handlers/chat.js`，两者都在 spec 覆盖范围内。
  `spec-baseline-check` 只证明锚点与基线成立、不执行变异体；本轮只跑了受影响集合。
  闭合命令（POSIX，干净树）：
  `for s in test/mutations/*.json; do npm run mutate -- "$s"; done`（`CONTRIBUTING.md:96`）。
- **`npm run test:release` 全量 shard（本树）`[UNVERIFIED]`**：本 checkout 的
  `listTopLevelTestFiles()` 发现 **626** 个 `*.test.js`；最后一次全量是 `d5519da3` 的
  605 文件 / 7,455 测试（见 3.141.592659 附录 §3 W01）。Windows 上该 shard 预期 103 条
  skip（平台/环境守卫），skip 声明不是绿。
- **托管 CI `[UNVERIFIED]`**：分支 `fix/audit-wave-20261109` 没有 upstream；本附录所有
  计数都是本机测量。
- **HMC 部署与回滚演练 `[UNVERIFIED]`**：本版没有部署。回滚命令见发布说明 §5 与
  `ReleasePrep.md` §7，未执行。
- **live 上游 / 真实客户端 `[UNVERIFIED]`**：全部验证都是隔离函数与 hermetic 测试；
  病态 payload 没有发给真实服务。
- **pkg 单文件二进制 `[UNVERIFIED]`**：本版未构建/启动 `@yao-pkg/pkg` 产物。
- **GHSA 公告 `[UNVERIFIED]`**：`GHSA-fx5f-49jr-fw6r` 与 `GHSA-r7v2-3h32-f5g6` 的
  `patched_versions` 是 `>= 3.141.592660`，但公告在 push + CI 绿之后才发布；写本文件时
  尚未发布。
- **Node 22 全量（本树）`[UNVERIFIED]`**：`engines >=22.13.0`；22.23.4 的 605 文件全量跑
  在更早的树上，本树未跑。

## 4. 发布顺序（本任务未执行）

按 `skill://release` 与 `docs/releases/README.md` §7 的顺序，每步都要在下一步之前绿：

1. 本提交（版本 + 文档）→ 干净树。
2. POSIX 干净树跑 99 spec 全量 sweep 与 `npm run test:release`（§3 两条 `[UNVERIFIED]`）。
3. `git switch master && git merge --ff-only fix/audit-wave-20261109`。
4. `git push origin master`（推送门三条：`git status --porcelain` 空、`git fetch` 后
   `git log --oneline origin/master..HEAD` 全是本波产物、`git diff --stat origin/master...HEAD`
   无夹带）。
5. `git tag -a v3.141.592660 -m "3.141.592660"` → `git push origin v3.141.592660`。
6. release workflow 产出资产、`SHA256SUMS`、cosign 签名与 attestation。
7. GHSA 两个 canonical 对象发布，`patched_versions: >= 3.141.592660`。
8. HMC 部署与回滚演练。

**tag 计数的时间窗（已知，必须在第 5 步处理）。** `CHANGELOG.md` 的 `git tag` 行是
`node scripts/sync-changelog-counts.mjs` 从 `git tag | wc -l` 生成的实测值：本提交时点
**229**。第 5 步创建 `v3.141.592660` 之后该值为 **230**，而 release workflow
（`.github/workflows/release.yml`，`fetch-depth: 0`）在 tag 的 checkout 上会重跑
`npm run test:release`，其中 docs guard 的
`the CHANGELOG release counts are the ones the checkout has` 会断言这一行等于 230。
因此第 5 步之后必须再跑一次 `node scripts/sync-changelog-counts.mjs`、提交、并把 tag
移到新提交（尚未 push，可以移动），否则 tag 上的 CI 会在这一行失败。

## 5. D5 准入残余 — (a)/(b) Owner 决策（**仍未签字**）

> **D5 准入残余 — Owner 签字（2026-11-11，待填）**：本人已读
> `RELEASE_NOTES_3.141.592660.md` §1.8 残余段与 §7 `[UNVERIFIED]` 条目、
> `VM-BUDGET-BOUNDARY.md`、外部任务书 `TASK.md` §C 方案2:103
> （`C:/Users/dwgx1/OneDrive/Desktop/Setukou-Dispatch-20261111/02-WindsurfAPI/TASK.md`，
> 不在本仓库内）。
> 知悉 `babafeef` 仅有每请求 50 ms 预算、无进程级并发/连续滥用准入，连续 50 个病态请求
> ≈ 3.1 s 主 event-loop（~62 ms/次，全部 `unable`）。选择：**(a) 作为 P2 残余在本版接受并
> 延后至下一版**（不新增 src 改动、不新增候选 SHA），或 **(b) 本版即闭合**（= 新 src 改动
> + 新测试 + 新候选 SHA + 重跑 D1 门禁）。默认按 (a) 推进；未签字前不得对外宣称
> 「无已知缺口 / ALL GREEN / ready to push」。签字：__________ 日期：__________
