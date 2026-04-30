## v2.0.45 — #106 / #107：Claude Code 2.x cwd 提取的两道窟窿

#100 之后 v2.0.44 修了一刀 `<system-reminder>` wrapper 剥皮再扫，本以为这条线收尾。zhangzhang-bit 在 #106 升完后回了「好像没有提取到」+ 一段 26 KB system prompt 的 debug log，紧接着另开 #107 单独贴这个 bug。挖下去发现 v2.0.44 的修法只解决了 user message 那一侧，**system prompt 这一侧 Claude Code 2.x 用的是新措辞，老正则不认**。

### 症状

debug 日志关键行：

```
Probe[k89i9g] msg[0] role=system len=26892
...
Chat[k89i9g]: env NOT lifted (extractor returned empty);
nearest env-shaped substring in messages: tware engineering tasks and the current working directory
```

`nearest env-shaped substring` 摸到了 "...software engineering tasks and the current working directory" 然后**没下文**——意味着这句话后面紧跟的是句号或换行，路径不在原地。真路径埋在 26 KB system prompt 的别处，长这样：

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: D:\Project\foo
 - Is a git repository: true
 - Platform: win32
```

### 三个老正则匹不到

1. **形容词前缀**：`Working directory:` 老正则只认裸 key，Claude Code 2.x 写的是 `Primary working directory:`，前面多了一个 `Primary`，整条直接跳过
2. **first-match 短路**：cwd 正则用 `match()` 只取首个文本命中。26 KB 系统提示里"current working directory" 这个 prose 提法在前，`Primary working directory:` 那条 bullet 在后。首个命中没带 path，循环直接走下一条 message，不会接着找
3. **git repo 措辞**：老正则匹 `Is directory a git repo`，Claude Code 2.x 写 `Is a git repository`，又跳过

### 修法

`extractCallerEnvironment` 三处一起改：

```diff
- const PATTERNS = [
-   ['cwd', new RegExp(
-     `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:Working directory|cwd|<cwd>)\\s*[:=]\\s*\`?(${PATH_TAIL})\`?` +
-     `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${PATH_TAIL})\`?`,
-     'i'
-   ), ...],
-   ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is directory a git repo\s*[:=]\s*([^\n<]+)/i, ...],
+ const ADJ = `(?:Primary|Current|Initial|Default|Active|Project|My)\\s+`;
+ const PATTERNS = [
+   ['cwd', new RegExp(
+     `(?:^|\\n)\\s*(?:[-*]\\s+)?(?:${ADJ})?(?:Working\\s+directory|cwd|<cwd>)\\s*[:=]\\s*\`?(${PATH_TAIL})\`?` +
+     `|(?:current\\s+working\\s+directory(?:\\s+is)?)\\s*[:=]?\\s*\`?(${PATH_TAIL})\`?`,
+     'gi'  // global so we can iterate matches
+   ), ...],
+   ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is(?:\s+(?:directory\s+)?(?:a\s+)?)git\s+repo(?:sitory)?\s*[:=]\s*([^\n<]+)/i, ...],
```

cwd 正则同时改成 global flag + 在 `for ... of content.matchAll(re)` 里跳过空捕获组，找到第一个**真带 path** 的 match 才算命中。这样 prose 提法在前 + bullet 在后的情况能正确取到 bullet 里的路径。

### 还加了一道 bullet 兜底

某些自定义 agent prompt 不写 `Working directory:` key，直接列 bullet：

```
Environment facts:
 - D:\Project\foo
 - some other note
```

加了 `scanForBulletCwdInSystem`：所有 system message 里找 `^\s*[-*•]\s+<absolute-path>$` 形态的独立 bullet 行，文件后缀照旧拒，`<workspace>` redaction marker 照旧拒。只扫 system role 不扫 user 避免聊天里随口提的路径被误当 cwd。

### 数字

- 测试：v2.0.44 是 470 → v2.0.45 是 **476** (+6 / 0 失败)
- suites：97 → **98**
- 改动：仅 `src/handlers/chat.js` `extractCallerEnvironment` 内部 + 新加一个 ~25 行的 `scanForBulletCwdInSystem` helper

6 个新 regression 覆盖：

- `Primary working directory:` 形容词形式能 lift
- `Is a git repository:` 新措辞能 lift
- prose-then-bullet 26 KB 长 prompt 能跳过 prose 取到后面的 bullet（**#107 复刻**）
- 没 key 只有 bullet path 能兜底
- bullet 兜底拒文件后缀路径 + `<workspace>` 标记
- bullet 兜底只扫 system 不扫 user
- 老的 `Working directory:` 裸 key 形态保持工作

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后 zhangzhang-bit 那个场景应该看到 `env lifted: - Working directory: D:\xxx` 而不是 `env NOT lifted (extractor returned empty)`。

### 还要听反馈

- #105 nalayahfowlkest-ship-it Windows 客户端 + Linux 反代 那条之前误关了 已重开
- v2.0.45 升完同样形态再试一次 把 `Chat[xxx]` 那行贴出来确认

### 后续 backlog

- 如果还有 client 的 system prompt 用了完全不同的 cwd 措辞 比如 `Workspace at:` 或 `Project root:` 之类的 现在抓不到 收集到样本后再加
- 也许该把 cwd 提取从「每次请求扫整段 prompt」换成「客户端首次握手 register cwd 进 callerKey」 减小重复扫 26 KB 的开销 排到性能 backlog 里
