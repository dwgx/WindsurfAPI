## v2.0.75 — Claude 工具卡死回归紧急修 + 登录 cross-host 重试 + UI N/A

### #124 zhqsuo · v2.0.70 引入的 critical regression（紧急）

zhqsuo 诊断到 file:line — v2.0.70 把 `shouldUseNativeBridge` 改成 Claude 家族 auto-on，结果**所有 Claude Code / Cline / Codex 走 Claude 模型的工具调用全部卡死**。Cascade 进 DEFAULT planner mode 后把 `Read` / `Bash` / `view_file` 路由到 Windsurf 远程沙箱 `/home/user/projects/workspace-devinxse` 执行，但**沙箱里没有用户本地文件**，工具 `lastStatus=2` 永远不返，撞 warm stall 180s 才报错，然后无限循环重试。

```
[INFO] Cascade tool calls: 1 {names=["run_command"]}
[WARN] Cascade warm stall ... toolCalls=1 lastStatus=2 ceilingMs=180000
[INFO] Cascade done ... reason=aborted polls=753 ms=379197
```

修法（[`src/cascade-native-bridge.js:967`](src/cascade-native-bridge.js)）— 把 v2.0.70 加的 `if (isClaude) return true` 直接移除。**默认所有客户端都走 emulation 路径**（客户端本地执行工具，proxy 只翻译协议）。要远程执行的部署用 `WINDSURFAPI_NATIVE_TOOL_BRIDGE=1` 显式打开。

```js
// 改前 (v2.0.70-v2.0.74)
const isClaude = String(provider).toLowerCase() === 'anthropic'
  || /^claude-/i.test(String(modelKey).toLowerCase());
if (isClaude) return true;

// 改后 (v2.0.75)
return explicitOn;
```

不能只看 `tools[]` 判断"客户端要本地执行还是远程执行"— 默认 OFF 才安全。Claude Code 工具调用从这版起走跟之前一样的 NO_TOOL emulation 路径。

### #123 wnfilm · UI 把上游没返回的 daily quota 显示成"似乎失败了"

dashboard 默认皮 + sketch 皮的余额条都改了：

- daily/weekly 任一 bucket 是 null → 显示 **`N/A`**（斜体灰色）+ 虚线边框 bar
- title tooltip 显示 "upstream returned no data for this bucket" / "Windsurf 未返回每日配额数据"
- 跟 `--%` / 0%（refresh 失败）视觉上明显不同

后端字段语义不变（`dailyPercent: null` 仍表示上游没给）。

### #114 CharwinYAO · v2.0.71 仍然 OneTimeToken legacy HTTP 401 invalid_token

v2.0.61 已经做了"OneTimeToken 走 PostAuth 用过的同 host"。CharwinYAO v2.0.71 log 显示同 host 取也 401 — 上游 gateway 偶发对自己刚发的 sessionToken 也拒识。

加 cross-host 重试：第一遍 PostAuth=A → OneTimeToken=A 拿到 401 invalid_token 时，自动重做 PostAuth=B（opposite host）→ 用新 sessionToken 取 OneTimeToken=B。两边都炸再报 ERR_TOKEN_FETCH_FAILED。

```
[WARN] OneTimeToken legacy returned invalid_token on legacy-bridge sessionToken
       — retrying with PostAuth on new host
[INFO] OneTimeToken cross-host retry succeeded: PostAuth=new OTT=new
```

`postAuthDualPath` 加 `preferredHost` 参数支持这个用法（v2.0.57 起就该有的 cap）。

### 改动

- `src/cascade-native-bridge.js` — `shouldUseNativeBridge` 撤掉 Claude auto-on
- `src/dashboard/index.html` + `src/dashboard/index-sketch.html` — daily/weekly bar `N/A` 渲染
- `src/dashboard/windsurf-login.js` — `postAuthDualPath` 加 `preferredHost` + Auth1 流程加 cross-host retry
- `test/cascade-native-bridge.test.js` + `test/v2070-issue-fixes.test.js` — Claude 默认 OFF + explicit env on 行为更新

### 数字

- 测试：805（原版本基础上调整 6 case 适配新行为，net +0）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

升级后 Claude Code 跑工具不再卡死。要回到 native bridge（远程沙箱执行）的部署：

```bash
WINDSURFAPI_NATIVE_TOOL_BRIDGE=1
```

### 未做但接下来要做

- 用 e2e probe 真跑 Claude Code / Codex CLI / GLM / Kimi 全场景（之前光改代码没实测，#117 / #118 / #115 / #120 都靠这一波 probe 才能定出来还有没有真问题）
- #117 xiaoxin-zk codex GPT-5.5 被 content policy block 单独看
- #118 0a00 31 账号 200 次后全 unavailable — 等 log
