## v2.0.32 — 修 #94 Opus 4.7 thinking UID + #87 Docker 自更新降级 + #86 follow-up（Windows path sanitizer + i18n refactor）

四个独立 fix 一起发：

### 修 #94 — `claude-opus-4-7` 报 `unknown model UID`

用户 yangzailai 用 Claude Code `/model claude-opus-4-7` 后聊天，上游 LS 抛：

```
unknown model UID claude-opus-4-7-medium-thinking: model not found
```

**根因**：Catalog 声明了 `claude-opus-4-7-*-thinking` UID（v2.0.30 spark-C audit 加的），但 Windsurf 上游 LS 还没注册这些 UID。`chat.js` 的 wantThinking 路由把 `claude-opus-4-7-medium` 自动改写到 `-thinking` 兄弟模型，结果直接发了不存在的 UID。

**修法**：把 Opus 4.7 的 `-thinking` 自动路由临时禁用：
- 抽出 `resolveEffectiveModelKey(modelKey, wantThinking)` helper
- Opus 4.7 + thinking 现在停在 base UID（不上 `-thinking`）
- 加 warning 日志提示
- 加 env 开关 `WINDSURFAPI_OPUS47_THINKING_UIDS=1`，等上游注册后用户可以手动开
- 其他模型（Sonnet 4.6 thinking、Opus 4.6 thinking 等）自动路由不变

新增回归测试：`claude-opus-4-7` + thinking context → effective UID 不是 `claude-opus-4-7-medium-thinking`。

### 修 #87 — Docker 部署"检查更新"报 `spawn git ENOENT`

用户 wnfilm 报：dashboard 后台"检查更新"按钮在 docker 部署下报 `spawn git ENOENT`，因为容器里没装 git，而且 `/app` 不是 git 仓库。

**修法**：
- 后端 `runGit()` 检测 ENOENT（缺 git binary）+ 缺 `.git` 目录 → 统一映射为 `ERR_SELF_UPDATE_UNAVAILABLE`，`reason: "docker"`
- `/self-update/check` + `/self-update` 返回 200 + `{available:false, reason:"docker"}`，不再泄漏 raw spawn error
- 前端识别 `ERR_SELF_UPDATE_UNAVAILABLE` 友好提示 `docker compose pull && docker compose up -d`，隐藏一键更新按钮
- i18n 加 `en` + `zh-CN` 新 key

**没改**：OAuth/Firebase 自定义域名失败（#87 第二条）—— 信息不够，请单独开 issue 贴 F12 Network/Console + redirect URI + 反代结构。

### #86 follow-up — Windows path sanitizer

用户 oaskdosakdoakd 报 `C:\home\user\projects\workspace-devinxse` 路径泄露，老的 Unix-only regex (`/home/user/projects/workspace-...`) 漏了 Windows 形式。

**修法** (`src/sanitize.js`)：
- 加 `(?:[A-Za-z]:)?[/\\]home[/\\]user[/\\]projects[/\\]workspace-...` 覆盖：
  - `C:\home\user\projects\workspace-x` (Windows backslash + drive prefix)
  - `\home\user\projects\workspace-x` (backslash, no drive)
  - `C:\home/user/projects/workspace-x` (mixed separators，GLM-style 幻觉)
  - `d:\...` lowercase drive
- Path body char class 加 `\\` 让 backslash tail 不会提前 terminate match
- `SENSITIVE_LITERALS` 加 `\\home\\user\\projects\\workspace-` 让流式 cut-point 也覆盖

新增 4 条 sanitize 测试。

### #86 follow-up — Dashboard error i18n centralization (cherry-pick from PR #92)

@smeinecke 在 PR #92 里加的 `App.translateError(code, fallbackKey)` helper cherry-pick 进来，统一 6 处分散的 `r.error || I18n.t(...)` 调用。i18n 检查通过。

PR #92 测试部分跟 v2.0.30 spark-B audit 加的 `account-add-proxy-ordering.test.js` 重叠（7 条 vs 4 条且更全），所以测试部分 close 不合，credit 留 commit message + PR 评论里。

### 数字

- **测试**：v2.0.31 之前 365 → v2.0.32 现在 **373**（+8 条新测试 / 0 失败）
  - +4 sanitize Windows path 测试
  - +1 thinking-routing #94 回归
  - +3 self-update-docker 测试
- **suites**：77 → **78** (+1)
- **代码改动**：+248 / -21（4 commits）
- **API 不变**：所有现有客户端不受影响
- **依赖不变**：仍然 zero-dep
- **i18n guard**：✓ 全部通过

### 没修的（待用户补信息）

- **#93** zhangzhang-bit "上下文会丢" — 模型字段填的是 Opus 4.6 不是 GLM/Kimi，不是 v2.0.31 dialect fix 覆盖范围。已回评论要 endpoint / debug log / messages array shape。
- **#84** chukangkang 账号密码登录报 `proxy is not defined` — 当前 master 已审过没找到 scope 漏声明，怀疑用户跑的是旧 build。已要 docker tag + F12 console。
- **#79** laoma89 CodeBuddy CN IDE 截断 — v2.0.11 老 issue，没 endpoint / 模型 / debug 日志。已要 raw request + LOG_LEVEL=debug 截断前后 100 行。
- **#86** KLFDan0534 claudecode 无输出（4343434527）— 可能跟 #94 有关联，等他升 v2.0.32 后复测。
- **#86** OAuth-only 账号 path mapping 提示 — openclaw 客户端那边的事，不在 proxy 范围。

### Multi-stage codex orchestration (本次)

```
Issue #86 v2.0.31 之后用户继续追问 + #94 #87 #93 #84 #79 待处理
        │
        ▼
┌─────────────────────────────────────────────────┐
│ Stage 1: GPT-5.5 xhigh triage                   │
│ — 5 个 issue 分类 NEEDS_FIX vs NEEDS_INFO         │
│ — 每个给 file:line 证据                          │
│ — #94 #87 真 bug；#93 #84 #79 缺信息             │
└─────────────────────────────────────────────────┘
        │
        ▼ 并行 dispatch
┌─────────────────────────────────────────────────┐
│ Stage 2a: GPT-5.5 high #94 fix on master         │
│ — resolveEffectiveModelKey + Opus 4.7 disable    │
│ — 1 regression test                              │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│ Stage 2b: GPT-5.5 high #87 fix in worktree       │
│ — runGit ENOENT detection + error code           │
│ — frontend friendly hint + i18n                  │
│ — 3 tests                                        │
└─────────────────────────────────────────────────┘
        │ Claude 同时手动写 sanitizer + cherry-pick PR #92 i18n
        ▼
┌─────────────────────────────────────────────────┐
│ Stage 3: Claude commit + merge + ship           │
│ — 4 个 commit / 78 suites / 373 tests pass       │
│ — bump to v2.0.32                               │
└─────────────────────────────────────────────────┘
```

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- API 不变 / 依赖不变 / 旧客户端透明
- Opus 4.7 用户：thinking effort 暂时不会路由到 `-thinking` UID，即上游 LS 还没接受。等上游注册后设 `WINDSURFAPI_OPUS47_THINKING_UIDS=1` 重新启用
- Docker 用户：自更新按钮现在显示友好提示而不是报错；用户该用 `docker compose pull` 升级
- 373/373 tests pass
