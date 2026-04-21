# 贡献指南 / Contributing

感谢想贡献代码 / Thanks for wanting to contribute.

## 简体中文

### 开始之前

- 想加功能请先开 issue 讨论 免得撸完 PR 方向不对被打回
- 想修 bug 直接提 PR 就行 小改不用先开 issue
- 想改 README / docs 直接 PR
- 不清楚范围 看下 [CLAUDE.md](CLAUDE.md) 里的架构说明

### 代码风格

- 项目是 **零 npm 依赖** 纯 `node:*` 内置模块 PR 里不要 `npm install` 新包
- 用 ES Modules (`import/export`) 和 async/await
- 缩进 2 空格 单引号 带分号
- 新文件放 `src/` 对应目录 命名和现有保持一致
- LS 协议相关改动（`windsurf.js` / `proto.js` / `grpc.js`）如果改了字段号 记得同步 CLAUDE.md
- Dashboard UI 不要用 `alert()` / `confirm()` / `prompt()` 用 `App.confirm()` / `App.prompt()`

### Commit & PR

- commit 格式 `type: 简短说明` 例如 `fix: chat stream 漏 usage 字段`
- type 用 `feat` / `fix` / `refactor` / `docs` / `chore`
- 标题写清楚改了啥 Body 写为什么改 而不是怎么改（diff 自己会说）
- 一个 PR 解决一件事 多件事拆开提

### 测试

项目暂无自动测试 手动验证即可 最好在 PR 描述里贴上：

- 跑了什么 curl 命令
- dashboard 哪个面板点了
- 复测了哪些模型（gpt-4o-mini 这类免费模型最方便）

### CI

GitHub Actions 跑 `node --check` 做语法校验 过了就可以 review。

---

## English

### Before you start

- Got a feature idea? Open an issue first so we can discuss direction.
- Fixing a bug? Just send the PR.
- README / docs changes? Just send the PR.
- Unclear about project scope? Read [CLAUDE.md](CLAUDE.md) for architecture.

### Code style

- **Zero npm dependencies** — pure `node:*` builtins only. No `npm install` in PRs.
- ES Modules (`import/export`), async/await.
- 2-space indent, single quotes, semicolons.
- Put new files under `src/` in the matching directory. Follow existing naming.
- LS protocol changes (`windsurf.js` / `proto.js` / `grpc.js`): update CLAUDE.md if field numbers change.
- Dashboard UI: use `App.confirm()` / `App.prompt()` instead of native `alert()` / `confirm()` / `prompt()`.

### Commits & PRs

- Format: `type: short description` e.g. `fix: chat stream missing usage field`.
- Types: `feat` / `fix` / `refactor` / `docs` / `chore`.
- Title = what changed. Body = why (the diff speaks for how).
- One PR per concern. Split unrelated changes.

### Testing

No automated test suite yet. Manual verification is fine. In the PR description, include:

- What curl commands you ran
- Which dashboard panels you clicked through
- Which models you tested (free ones like `gpt-4o-mini` are easiest)

### CI

GitHub Actions runs `node --check` for syntax. Green CI is enough to ship to review.
