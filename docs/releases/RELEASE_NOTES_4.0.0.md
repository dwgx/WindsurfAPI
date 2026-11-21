# v4.0.0 — 2026-11-22

主版本升级：协议可见行为有一处破坏性变更 —— 不可解析的模型名不再静默降级到免费档，直接报错。

## 行为变更（破坏兼容）

- **未知模型一律 400 `model_not_found`**。`WINDSURFAPI_STRICT_MODEL` 开关删除，不存在 opt-out；`adaptive`/`arena-*` 路由名仅在 `DEVIN_CONNECT_ASSIGN_MODEL=1` 下仍由 AssignModel 解析。
- **限流不再偷换变体**。`shouldAutoFallback` 改为默认关（`WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=1` 才启用）：上游对 `claude-*` 限流时不再自动重试同族低档变体并仍以原名返回。
- **池级目录缺失 = 不可重试 403 `model_unavailable`**。当 selector 在每个有权限账号的上游目录中被锁出（"model no longer available"），返回不可重试错误而非可重试 429。
- **快照刷新至线上 306 模型目录**，`SELECTOR_MAP` 剪掉了指向已下线模型的悬空别名（claude-4.5 代、gpt-5.2/5.3-codex、gemini-3.0/3.1、grok-4-5、inkling、swe-1.5/1-6-fast/1-7-lightning、deepseek-v4 等）。

## 修复

- `mergeCloudCostTiers`：`creditMultiplier` 只接受数字或非空数字串，`''`/`' '`/`false` 不再被当作 0（免费档）。
- `ToolNamePrefixBuffer`：出错或超限时先按序冲刷已排队帧，不再丢弃已确定的文本增量。
- 移植自游离分支：pooled connect admission 拒绝、buffered 取消门控、缓存键按路由身份、UTF-8 stdio、provider retry 提示、ACP 取消/权限/工具归属边界。

## 门禁

- `npm test` 8674 项全绿（Windows，Node 24.19）；Linux/HMC 全量复跑证据见发布审计。
- CI `specs` 任务改为 Node 22+24 双版本矩阵，守住 `package.json` 声明下限。

## 自更新

- 版本线跳到 4.x 一次性压过历史遗留 tag `v3.141.592661`，OTA 版本比较不再被三位数版本压住。

[Open verification register](https://github.com/dwgx/WindsurfAPI/blob/v4.0.0/docs/UNVERIFIED.md) · [Roadmap](https://github.com/dwgx/WindsurfAPI/blob/v4.0.0/docs/ROADMAP.md)
