## v2.0.27 — 社区 PR 合并 + i18n guard 收尾

把 @smeinecke 提的两个 PR 合进来，顺手把 i18n 检查脚本的洞补一下。

### 合并的 PR

**#88 — `feat: add ALLOW_PRIVATE_PROXY_HOSTS config for local proxy testing`**
- 新增 `ALLOW_PRIVATE_PROXY_HOSTS=1` 环境变量，opt-in 放开 proxy test 对内网/本地 host 的限制
- 默认 fail-closed（空值 = 沿用 `assertPublicUrlHost` 公网校验），公网部署不受影响
- 新增 `validateHostFormat()` helper（`src/net-safety.js`）
- 把 batch import 的 proxy URL 解析抽成 `parseProxyUrl()`

**#89 — `Fix missing/broken i18n`**
- 修 dashboard 登录错误码（`ERR_NO_PASSWORD_SET` 等）在 toast / result panel / login history 里裸露未翻译
- 引入 `error.${code}` 翻译查表模式（6 处调用点）
- 新增 `ERR_PROXY_PRIVATE_HOST` 翻译
- 切换语言后自动重渲染当前 panel 的 i18n 内容（`refreshActivePanelI18n()`）
- 切语言按钮文案从 `中 / EN` 改成 `中文` / `English`（更直观）

### v2.0.27 自身改动

`src/dashboard/i18n/{zh-CN,en}.json`：
- 补 `action.revealKey` —— v2.0.26 之前就缺，check-i18n 一直报
- 新增 `footer.langToggleToEn` / `footer.langToggleToZh` 给切语言按钮的 `title` 用

`src/dashboard/index.html`：
- `toggleBtn.title` 走 `I18n.t('footer.langToggleTo*')`，不再 hardcode `'切换到中文'`（PR #89 引入的硬编码）
- `code title="${I18n.t('action.revealKey')}"` 去掉 `|| 'reveal & copy'` dead fallback

`src/dashboard/check-i18n.js`：
- I18n.t() 变量调用扫描升级，bare identifier（`errKey` / `errCode` 之类纯变量）不再误报为缺失 key
- 之前只硬编码豁免 `'key'` 一个名字，现在用 `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/` 通用判定

### 没合的 PR

**#90 — `Add proxy support for add account by token`**
- 方向对、需求合理，但当前实现先创建账号 / 后校验 proxy，proxy 校验失败会留下僵尸账号 + 接口返 400 → 用户重试 → 重复账号 / 配额异常
- 已经 review 留了具体修法（顺序倒过来 + 加测试 + rebase 到 #88 之上），等作者更新

### Issues 处理

关掉 5 条已修 / 不可执行：
- **#85** 服务器 Linux + 客户端 Windows 命令错乱 + 上下文丢失 → v2.0.25 / v2.0.26 已通过 `extractCallerEnvironment()` + cascade reuse 加固覆盖
- **#83** `cachePolicy is not defined` → v2.0.13 commit 637d17e 已修
- **#77** claude code 返回 JSON → v2.0.26 三层 tool preamble + JSON intent 检测 + cascade reuse 等多管齐下覆盖
- **#75** Tool definitions 79KB > 47KB → v2.0.10+ compact fallback + v2.0.26 schema-compact / skinny tier 已修
- **#6** 社区感谢讨论串 → 关闭，建议挪 Discussions

留 5 条等用户补信息：#84（OAuth 账号 ReferenceError，要 docker tag + stack）、#79（CodeBuddy 截断，要 endpoint + debug 日志）、#87（Docker `git ENOENT` v2.0.27 修，OAuth 部分等截图）、#86（GLM free tier，要模型名 + tools 数 + Probe 日志）、#91（导入本地 windsurf 凭证，要支持 OS / 路径 / 安全边界对齐）

### Verification

- `node src/dashboard/check-i18n.js`：✓ All i18n checks passed
- `node --test test/*.test.js`：**311/311 passing**
- 默认 UI / 手绘草稿风手测 OK

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- 纯前端 + 配置项新增 —— 后端 API 不变
- `ALLOW_PRIVATE_PROXY_HOSTS` 默认空 —— 公网部署行为不变
- 311/311 tests pass
