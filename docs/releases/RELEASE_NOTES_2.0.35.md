## v2.0.35 — 修 #97 sub2api 缓存 + release notes 整理

### 真的有

937bb 提了 #97："把 WindsurfAPI 加到 sub2api 当上游账号的时候，会出现被 sub2api 优先缓存"。
本来想着是 sub2api 自己的策略问题，结果一查响应头——**proxy 返回的是 `Cache-Control: no-cache`**。

`no-cache` 在 HTTP 规范里的意思是 **"可以缓存，但每次用之前必须先 revalidate"**。问题是 sub2api 这种聚合层不一定严格走 revalidate，看到响应"理论上可缓存"就直接 priority-cache 了，下次同样的 request 直接命中缓存返回旧 chunk——同一个 prompt 永远拿同一个回复。

应该用 **`no-store`**——这才是 "完全不要缓存，连存都不要存" 的字面意思。

### 改动

`src/server.js` 的 `json()` helper：

```diff
 res.writeHead(status, {
   'Content-Type': 'application/json',
   'Access-Control-Allow-Origin': '*',
   ...
+  'Cache-Control': 'no-store',
 });
```

3 个 stream 路径（`chat.js` / `messages.js` / `responses.js`）：

```diff
-'Cache-Control': 'no-cache',
+'Cache-Control': 'no-store',
```

覆盖范围：
- `/v1/chat/completions` (stream + non-stream)
- `/v1/messages` (stream + non-stream)
- `/v1/responses` (stream + non-stream)
- `/v1/models`
- `/auth/*`
- `/health`
- 所有 dashboard JSON API

dashboard HTML 和 SSE log 流保持 `no-cache`——那是浏览器单连接消费，不会被中间层重放。

### 测试

新加 `test/http-cache-control.test.js` 5 个测试：
- 静态校验 `json()` helper 字符串包含 `no-store`
- 静态校验 3 个 stream 头块都是 `no-store`
- 动态起一个真 server，发请求，断响应头 `cache-control: no-store`

```
✔ HTTP Cache-Control: no-store on per-request responses (issue #97)
ℹ tests 5
ℹ pass 5
```

### 顺便整理的 release notes 目录

仓库根目录之前躺着 30+ 个 `RELEASE_NOTES_*.md`，太脏。这个版本一并迁到 `docs/releases/`：

```
RELEASE_NOTES_2.0.6.md  →  docs/releases/RELEASE_NOTES_2.0.6.md
RELEASE_NOTES_2.0.7.md  →  docs/releases/RELEASE_NOTES_2.0.7.md
...
```

`.github/workflows/release.yml` 的 release-notes 查找路径同步更新，新版本优先看 `docs/releases/`，找不到再回退到根目录（保历史 tag re-cut 的兼容）。

`docs/releases/README.md` 写了一个 index 说明发布流程。

### 顺手加的 .gitignore 收紧

补全各家 AI 工具的本地 config 文件（防止以后误提交）：
- `AGENTS.md`、`GEMINI.md`、`COPILOT.md`、`.cursorrules`、`.windsurfrules`
- `.aider*`、`.continue/`、`.codex/`、`.devin/`
- `tmp/`、`runtime-config.json`、`stats.json`

git 历史已经审过了，没有任何 AI agent config 文件被提交过，干净的。

### 数字

- **测试**：v2.0.34 之前 395 → v2.0.35 现在 **400**（+5 / 0 失败）
- **suites**：80 → **81** (+1)
- **代码改动**：4 处 `no-cache` → `no-store` + 1 处新增 header + 30 个文件 git mv
- **API 不变**：旧客户端不受影响
- **依赖不变**：仍然 zero-dep

### 升级路径

```
docker compose pull && docker compose up -d
```

升完之后 sub2api 那边把 WindsurfAPI 加回上游账号，每次请求都会走真路径不再被中间层缓存。
