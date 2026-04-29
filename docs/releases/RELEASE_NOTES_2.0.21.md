## v2.0.21 — hotfix：回退 v2.0.19 GRPC_PROTOCOL Connect 默认（StartCascade 拿空 cascade_id 回归）

v2.0.19 把 `GRPC_PROTOCOL` 默认从 legacy gRPC 改成 Connect。本意是修代码与注释不一致 + Connect 更接近真实 client 指纹。生产部署后**所有 cascade 调用立刻挂** —— `StartCascade` 通过 Connect framing 走过去，但响应解析回来 cascade_id 是空字符串，整个 chat 流瞬间炸。Production 实测：

```
gemini-2.5-flash → "StartCascade returned empty cascade_id"
claude-sonnet-4.6 → "StartCascade returned empty cascade_id"
其他所有 cascade 模型 → 同样
```

回退方法是把 .env 里加 `GRPC_PROTOCOL=grpc` 强制走 legacy → 功能立刻恢复（gemini-2.5-flash 重新 200 OK）。

This is a hotfix for the v2.0.19 transport-default flip. Switching `GRPC_PROTOCOL` to default `connect` looked safe in unit tests, but the production LS 2.12.5 returns empty `cascade_id` from `StartCascade` when called via Connect framing — every cascade chat broke immediately on deploy. Reverting to legacy gRPC default restores all functionality. The Connect parser issue is now tracked for future investigation; until fixed, Connect remains explicit opt-in via `GRPC_PROTOCOL=connect`.

### 改了什么 / What changed

**🔴 `src/grpc.js:14` 默认值反向回 legacy gRPC**

```diff
-const USE_CONNECT = process.env.GRPC_PROTOCOL !== 'grpc';
+const USE_CONNECT = process.env.GRPC_PROTOCOL === 'connect';
```

文件顶部注释也更新成"legacy default + 何时可以再尝试 Connect default"，记下 v2.0.20 实测出的 cascade_id 解析问题，避免后人再踩。

`test/grpc-transport-default.test.js` 也对应改了：默认 unset → legacy（false），`GRPC_PROTOCOL=connect` → Connect（true）。

### Verification

- `node --test test/*.test.js`: **283/283 passing**
- 生产部署 v2.0.20 + 临时 `.env GRPC_PROTOCOL=grpc` 后 gemini-2.5-flash chat 200 OK 恢复 → 确认是 transport mode 问题
- v2.0.21 部署后预期能直接去掉 .env 里的 `GRPC_PROTOCOL=grpc` 临时项，让默认行为复位到 v2.0.18 的 legacy

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`。
- **回归 v2.0.18 之前的 transport 默认行为** —— 所有 v2.0.18 部署升 v2.0.21 行为 100% 一致，不再需要任何 env 调整
- 如果你在 v2.0.19/v2.0.20 部署后手动加了 `GRPC_PROTOCOL=grpc` 到 .env：升 v2.0.21 后可以删掉那一行，但保留也无害
- v2.0.19 的 `extension_version` / `ide_version` 改成 `2.0.67` + `WINDSURF_CLIENT_VERSION` env override 全部保留生效
- v2.0.20 的 Heartbeat + UpdatePanelStateWithUserStatus RPC 全部保留生效（这两个走 grpc-frame 不走 Connect frame，没有受影响）
- 283/283 tests pass。Zero npm dependencies, unchanged.

### 教训 / Postmortem

- 单元测试只验了 const 取值正确，没验 transport 端到端是否真能跟 LS 对话 —— 应该加 fake LS HTTP/2 server 真跑一次 Connect framing 的 StartCascade 才算 verified
- v2.0.19 release notes 明确写了"修注释/代码不一致"是非破坏性改动，但实际 Connect path 在 cascade RPC 上的回归没人测过 —— 后人改 transport mode 默认值时必须起 fake LS 端到端验证 cascade_id 真的解出来非空

后续会单独审计 Connect path 在 StartCascade / SendUserCascadeMessage 上的 response parsing 缺陷，修好后再考虑是否值得切回 Connect 默认。
