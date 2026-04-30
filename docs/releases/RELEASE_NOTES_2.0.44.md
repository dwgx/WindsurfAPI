## v2.0.44 — #100 follow-up：剥 `<system-reminder>` 后再补一刀 cwd 抓取

issue #100 yunduobaba 追了一波 v2.0.42 还在复现，自己抓出根因贴在 thread 里：

> 根因是 `scanUserMessageForBareCwd` 只扫描用户消息前 300 字符，但 Claude Code 的 hooks 会在消息开头注入大量 `<system-reminder>` 块，将真正的路径推到 300 字符之后。

完全对。debug 日志里 `lastUser=len=14095`——14k 的 user message，用户实际敲的 `C:\Users\renfei\Downloads\WindsurfAPI-master 分析下这个项目` 被前面一层一层的 `<system-reminder>` wrapper 推到了 head 之外。pass 1 的 300 字符抓不到，整段 fallback 形同虚设，cascade 上游沿用 `/tmp/windsurf-workspace` 的内置先验，opus 又脑补出「Windows 路径在 Linux 上读不了」的 JSON 解释。

### 修法

`scanUserMessageForBareCwd` 加一道 pass 2：pass 1 抓不到时，**剥掉所有 `<system-reminder>...</system-reminder>` 块**，对剩下内容的前 500 字符再跑一遍同一个锚定正则。

```js
// Pass 1: head of the raw message
const direct = tryMatch(content.slice(0, 300));
if (direct) return direct;

// Pass 2 (#100 follow-up): strip Claude Code's <system-reminder> wrappers
if (!/<system-reminder\b/i.test(content)) continue;
const stripped = content.replace(/<system-reminder\b[\s\S]*?<\/system-reminder>\s*/gi, '');
const wrapped = tryMatch(stripped.slice(0, 500));
if (wrapped) return wrapped;
```

约束保持原样：

- 仍然只扫第一条 user message
- pass 2 仍然**锚定**正则（`^[\s,;:.，。、；：　"'`(\[]*` 开头），剥完 reminder 后路径必须仍是首个 token——避免「reminder + 一段散文 + 路径」被误当 cwd
- 文件后缀（.md / .js 等）仍然拒
- 没有 `<system-reminder>` 标记的 message 直接 skip pass 2，省得对每条 user message 跑一遍正则替换

4 个新 regression test：

- 1KB 单个 reminder + 路径在 reminder 之后 → 抓到（**核心修复证明**，复刻 yunduobaba 日志的 14k user message 形态）
- 三个堆叠的 reminder + 路径 → 抓到
- reminder 之后是散文再之后才有路径 → **不抓**（pass 2 锚定不能放松）
- 没有 reminder 标记时 pass 2 完全 skip

### 数字

- 测试：v2.0.43 是 466 → v2.0.44 是 **470** (+4 / 0 失败)
- suites：97 (无新文件，加在 `caller-environment.test.js` 已有的 `bare-path cwd fallback (#100)` 描述块里)
- 改动：仅 `src/handlers/chat.js` 的 `scanUserMessageForBareCwd`，约 25 行

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后 yunduobaba 那个 prompt 重发一次，proxy 应该 lift 出 `Working directory: C:\Users\renfei\Downloads\WindsurfAPI-master`，cascade 拿到正确 cwd 后 opus 应该正常 emit `Glob` / `Read` 的 tool_call，claudecode CLI 在 Windows 本地执行——你看到的 JSON 脑补回复就到此为止。

如果还复现，把 server 端 `LOG_LEVEL=debug` 重启后那条 `Chat[xxx]: env NOT lifted` 或 `env lifted: ...` 的日志贴出来定位下一层。
