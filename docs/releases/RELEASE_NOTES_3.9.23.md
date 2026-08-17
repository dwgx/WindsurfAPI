# v3.9.23

SWE-1.7 原生视觉、按账号刷新的在线模型目录、Claude Code system 消息兼容，
以及 OTA 更新目标修正。无 API 破坏，升级不要求改配置。

---

## 用户可感知

### SWE-1.7 图片不再被代理改坏或硬拒绝（#244）

此前 DEVIN_CONNECT 图片路径会伪造一轮 assistant `read` tool call、对应的
synthetic tool result 和顶层 `read` ToolDef；随后又按 `swe-*` 名字把图片请求
硬拒绝为 `400 model_no_vision`。两条路径都与真实 Devin wire 不符。

报告者提供的第三方捕获把这件事定死了：真实 SWE-1.7 请求把图片直接挂在
`source=USER` 消息的 repeated field `#10`，响应仍由 `modelUid=swe-1-7` 服务，
并正确识别 macOS Dock、Sketch、QQ 和 WPS。提取出的 schema 也独立确认：

- `ChatMessagePrompt.images = #10`
- `ImageData.base64_data = #1`
- `ImageData.mime_type = #2`

现在普通图片保持在原 user 消息上，多图写进同一条消息的 repeated `#10`；原生
tool result 图片保持 `source=TOOL_RESULT`，并保留调用方的 `tool_call_id #7`。
代理不再制造 assistant/tool 历史，也不再按 SWE 家族名猜测能力。

`DEVIN_CONNECT_IMAGE_TAG` 默认值从关闭改为已验证的 `10`。如需紧急回退，设：

```sh
DEVIN_CONNECT_IMAGE_TAG=0
```

同步 builder 仍不会主动下载远程 `https://` 图片；请使用 data URL/base64，或显式
开启 `DEVIN_ACP_VISION=1` 走本机 Devin CLI 的 ACP 多模态通道。

### 在线模型目录不再被第一个账号锁死（#244）

旧实现只有一个全局同步 promise：多账号同时初始化会互相阻塞，新加入或换 key 的
账号也可能永远进不了在线目录。现在改为按账号独立同步并维护 pool union：

- 多账号首次目录请求可并发，同一账号的并发请求仍会合并
- 成功目录默认复用 5 分钟；过期后自动刷新
- 空响应和失败保留 last-known-good，不缩空目录，也不推进成功时间
- 账号移除、禁用或换 key 时同步撤销它对 union 的贡献
- 异步响应写回前重新确认账号仍 active 且 key 未变化，旧请求不能复活旧目录

新开关 `DEVIN_CONNECT_CATALOG_TTL_MS` 默认 `300000`，最小接受值 10 秒。

目录解码同时接入真实能力字段：`ClientModelConfig.disabled #4` 的条目不进入实时
可调用目录；`supports_images #5` 在上游明确给出 true/false 时通过 `/v1/models`
暴露为 `supports_images`。字段缺失保持未知，不伪造 false。

### Claude Code system 内容可选并入 user turn（PR #254）

新增默认关闭的：

```sh
DEVIN_CONNECT_COLLAPSE_SYSTEM=1
```

开启后，连续 system 内容按顺序包进 `<system>...</system>`，并入下一条真正的
`source=USER` 消息，避开上游对 request field `#2` 更严格的内容策略。

主线实现补齐了原 PR 未覆盖的顺序边界：assistant/tool 历史不会提前消费 pending
system；system 后的图片仍和文本同处一条 user 消息；末尾没有 user 时补一条 user；
continuity trail 也进入 collapsed system block，不会回漏到 field `#2`。默认关闭时
原 wire 保持不变。

---

## OTA 更新目标修正

v3.9.22 的第一版门禁把“远端 branch HEAD 比最新 tag 新”直接当成未发布，结果只要
tag 后落一条 release notes、生成资产或下一版提交，已经发布的版本也会被 OTA 拒绝。

现在普通 `/self-update` 和 `update.sh` 都跟随**最新已发布 tag**；只有显式强制更新
才跟未发布的 branch HEAD。更新前仍执行 dirty、分叉和防降级检查，失败回滚继续保留。

release workflow 还新增 tag 与 `package.json` 版本一致性校验；Dashboard i18n 的
单花括号占位符会在 CI 中失败，不再把无法替换的 `{commit}` 文案带进发布包。

---

## 验证

- `npm run test:release`：**4004 pass / 0 fail（307 个测试文件）**
- 38/38 mutation baseline 全部实测匹配，所有 anchor 唯一
- 38/38 mutation spec 全部执行：**281 CAUGHT**，11 条已登记 survivor 均符合预期
- `secret-scan`、`git diff --check`、Dashboard 文档/i18n/release workflow 守卫全绿
