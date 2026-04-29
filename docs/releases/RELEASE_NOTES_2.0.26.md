## v2.0.26 — Dashboard 登录 UX 修复（用户反馈：升级后设密码登录"没反应"）

用户反馈：更新到 v2.0.25 镜像后设置 dashboard 密码，输入密码点登录"没反应"。

排查发现：这是 dashboard 自打首版就存在的 UX 漏洞，被 v2.0.25 升级 + 设新密码场景放大了。`App.login()` 旧实现：

```js
login() {
  this.password = document.getElementById('login-password').value;
  localStorage.setItem('dp', this.password);
  this.init();   // 不 await，无 feedback
}
```

密码错误时 `/auth` 返 `{required:true, valid:false}`，`init()` 把 login overlay 重新 show 出来 —— 但 overlay **本来就在**显示，视觉上完全没变化，用户看到的就是"点了登录没反应"。

After upgrading to v2.0.25 and setting a fresh dashboard password, users reported login appeared to do nothing. Root cause was a long-standing UX hole in `App.login()`: a wrong password silently re-rendered the same login overlay with no visible change. v2.0.26 adds proper feedback — pre-flight password check, button "checking…" state, inline error message, network-error reporting.

### 改了什么 / What changed

`src/dashboard/index.html` + `src/dashboard/index-sketch.html`:

1. **Pre-flight password check before storing**：先 `fetch /dashboard/api/auth -H X-Dashboard-Password: <pw>`，看 `valid` 字段决定是否真的登录
2. **按钮 disabled + 显示 "验证中…"** 期间防止重复点击
3. **inline error 行**展示三种错误：
   - `wrong` → "密码不正确"（最常见）
   - `locked` → "后端未配置密码：请在服务端设置 DASHBOARD_PASSWORD 或 API_KEY 环境变量并重启"（用户压根没设密码或 .env 没加载的情况）
   - `networkError` → "无法连接服务器: <msg>"（nginx/CORS/防火墙挂了）
4. 默认 UI 走 `I18n.t('login.*')`；手绘草稿风走 `I18n.locale === 'en'` 三元

`src/dashboard/i18n/zh-CN.json` + `en.json`：新增 5 条 `login.{checking,wrong,empty,locked,networkError}`

### 为什么会触发

很多用户的升级流程：
1. `docker compose pull && docker compose up -d`
2. 想起来 dashboard 要设密码，编辑 `.env` 加 `DASHBOARD_PASSWORD=xxx`
3. `docker compose restart`
4. 浏览器输入新密码点登录 → 没反应（因为输错了 / .env 没生效 / 缓存了旧 localStorage 'dp'）

旧逻辑 silent 重渲染 overlay，用户找不到原因。

### Verification

- `node --test test/*.test.js`: **311/311 passing**（无后端改动）
- `src/dashboard/i18n/{zh-CN,en}.json`: JSON parse OK
- 手测：默认 UI 输错密码 → "密码不正确"红字；手绘草稿风同样

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- 纯前端 — 后端 API 不变
- localStorage 'dp' 兼容旧值；密码不变的用户登录不受影响
- 旧 i18n 缓存没新 key 时 fallback 到中文 hardcoded（默认 UI）/ 英文 hardcoded（sketch UI）
- 311/311 tests pass
