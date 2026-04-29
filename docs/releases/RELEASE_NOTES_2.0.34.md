## v2.0.34 — 修 fresh account 403 race（QQ 群反馈）

### 真的有

QQ 群反馈"获取不到模型，添加模型后也不能调用"，本来想着可能是用户操作问题，结果一查代码——**真有 bug**。

### 复现

写了 `tmp/probe-race.mjs` 直接 import 真模块跑，结果：

```
=== Tier model counts ===
pro:     120 models
free:    1 models [ 'gemini-2.5-flash' ]
unknown: 1 models [ 'gemini-2.5-flash' ]   ← ⚠️ 这就是 bug
expired: 0 models

=== Symptom check ===
catalog total: 111
Models a fresh account would be 403'd on: 110/111
Examples: [
  'claude-3.5-sonnet',
  'claude-3.7-sonnet',
  'claude-3.7-sonnet-thinking',
  'claude-4-sonnet',
  'claude-4-sonnet-thinking'
]
```

**110/111 个模型对刚加的账号立即 403**，唯一能用的就是 gemini-2.5-flash。

### 根因

新账号添加流程：
1. 用户加账号 → `tier='unknown'`
2. probe 是 fire-and-forget 异步跑（10-30s 才跑完）
3. probe 完成前调用任何模型 → `chat.js:1141 anyEligible` 检查 → `availableModels = getTierModels('unknown')` = `[gemini-2.5-flash]` 一个 → 不命中目标模型 → **403 "模型 X 在当前账号池中不可用（未订阅或已被封禁）"**

QQ 群说的"获取不到模型/添加模型后不能调用"翻译过来：
- 用户加完账号
- 立即试某个 Claude / GPT / GLM 模型
- 直接被 403 拦掉，错误信息还误导成"未订阅或已被封禁"
- 用户以为账号有问题，其实是 proxy 的 unknown tier 配置太保守

### 修法

两层保险：

**1. `MODEL_TIER_ACCESS.unknown` 改成乐观=pro 全集**

```diff
-get unknown() { return [...FREE_TIER_BASE, ..._discoveredFreeModels]; },
+get unknown() { return Object.keys(MODELS); },
```

新账号 probe 没跑完时假设是 pro，让用户能立即用。如果用户实际是 free/expired 账号，请求会到上游被真正拒绝（错误信息更准确——上游会说"not entitled"，而不是 proxy 含糊的"模型不可用"）。

**2. `chat.js anyEligible` 分支改进错误信息**

如果 `anyEligible=false` 但确实有 active 但 un-probed 账号（理论上现在 unknown=pro 后不会触发），surface 不一样的错：

```
模型 X 暂不可用：账号刚添加还未完成 tier 检测，
请稍候 10-30 秒后重试，或在 dashboard 手动点 Probe
```

错误 type 改成 `probe_pending`，跟真正的 `model_not_entitled` 区分开。

### 实测验证

修完后跑同一个 probe：

```
=== Tier model counts ===
pro:     120 models
free:    1 models
unknown: 120 models    ← 改对了
expired: 0 models

=== Symptom check ===
catalog total: 111
Models a fresh account would be 403'd on: 0/111   ← ✓
✓ Fix verified: NO models are 403d for fresh accounts.
```

### 数字

- **测试**：v2.0.33 之前 390 → v2.0.34 现在 **395**（+5 / 0 失败）
- **suites**：79 → **80** (+1)
- **代码改动**：+92 / -4
- **API 不变**：旧客户端不受影响
- **依赖不变**：仍然 zero-dep

### 副作用 / Compatibility

- **新账号现在能立即调任何模型**——如果实际是 pro，正常工作；如果是 free，第一次调非 free 模型会被上游 reject，proxy 把错误透传给客户端（错误信息更准确）
- Probe 完成后，capabilities 接管，错误的 entitlement 会被 proxy 在 `getAvailableModelsForAccount()` 第二条分支（`account.userStatusLastFetched > 0`）正确收紧
- 升级路径：`docker compose pull && docker compose up -d`
- 395/395 tests pass

### 没修的

- Probe 失败的情况：现在改成乐观默认，probe 失败的账号会一直被乐观对待，可能给用户造成困扰（"我加了账号但调用各种失败"）。后续可以加 dashboard 上的"probe 状态"指示器，或者 probe 失败时账号自动 disable。但这不是这次的范围
