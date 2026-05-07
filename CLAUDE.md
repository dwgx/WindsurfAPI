# WindsurfAPI — AI Agent Rules

## 项目定位
Windsurf Cascade → OpenAI/Anthropic 兼容 API 反代。零 npm 依赖，纯 Node.js ESM。1055+ stars。

## 核心规则

### 代码风格
- **零依赖** — 永远不 `npm install`，只用 Node.js 标准库
- **不加注释** — 除非 WHY 不好看出来（隐藏约束、bug workaround、惊人行为）
- **不加抽象** — 三个相似行好过一个过早抽象。不要 helper、不要 util 文件
- **不加功能** — 修复就是修复，不要顺手重构。不要 feature flag、不要向后兼容 shim
- **不加文档** — 除非用户明确要求。不要 README、CHANGELOG 或任何 .md
- **不改 release workflow** — `.github/workflows/release.yml` 保持不变

### Git 规则
- **绝不写 Co-Authored-By** — 没有 "Claude"、"AI" 或任何工具的 attribution
- **commit 用英文** — `fix: ...` / `feat: ...` 格式
- **直接 push master** — 不建分支，不建 PR（dwgx 自己的改动）
- **push 前跑测试** — `node --check` 至少过语法

### 测试与部署
- **VPS 部署** — 154.40.36.22:3888, SSH root:22
- **每次 push 后部署** — `git pull && docker compose up -d --build`
- **用 API 实测** — curl 或 Python 脚本验证修复效果后再关 issue
- **测试脚本放 tmp-testing/** — 不提交到仓库

### Issue 处理
- **中文回复** — 直接、简洁
- **贴实测结果** — 不要只说"已修复"，贴上测试输出
- **上游限制说清楚** — Windsurf Cascade 的问题不是 proxy 的 bug
- **关闭前至少一次 VPS 实测** — 尤其是 bug 类 issue

### 社区 PR
- **cherry-pick 独特部分** — 把新功能摘出来单独合入
- **在 commit message 里给 credit** — `PR #XX by @作者`
- **关闭 PR 时说明原因** — 哪个部分合入了，哪个没合
- **不要 squash merge 大 PR** — 拆开 cherry-pick

### 版本发布
- **tag 格式** `v2.0.XX` — 递增版本号
- **release notes** 可放 `docs/releases/RELEASE_NOTES_2.0.XX.md`
- **Docker 镜像** tag push 后 CI 自动构建推 GHCR
- **手动创建 GitHub Release** — 不自动

### 环境变量速查
| 变量 | 用途 |
|---|---|
| `API_KEY` | API 认证密钥 |
| `DASHBOARD_PASSWORD` | Dashboard 密码 |
| `WINDSURFAPI_NLU_RETRY=1` | GLM/Kimi 工具调用重试 |
| `ALLOW_PRIVATE_PROXY_HOSTS=1` | 允许代理连内网 IP |
| `RESPONSE_CACHE_ENABLED=0` | 关闭响应缓存 |
| `CASCADE_MAX_HISTORY_BYTES` | 历史预算 (默认 400KB) |
| `CASCADE_WARM_STALL_TOOL_ACTIVE_MS` | 工具活跃超时 (默认 180s) |
