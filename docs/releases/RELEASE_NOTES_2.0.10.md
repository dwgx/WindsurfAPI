## v2.0.10 — hotfix: dynamic cloud probe was crashing silently

v2.0.9 部到 staging 跑端到端 probe 时发现的：每次账号 refresh 周期日志里都报

```
[WARN] Dynamic cloud probe failed: positiveIntEnv is not defined
```

`src/auth.js::probeAccount()` 调用了 `positiveIntEnv('MAX_CLOUD_PROBES', 10)`，但这个 helper 只在 `src/client.js` 和 `src/conversation-pool.js` 里各自局部定义了，没在 auth.js 里声明也没 import。runtime 第一次跑 cloud-probe 路径就 ReferenceError，被外层 try/catch 吞了变成一行警告，free 账号的 cloud 候选模型发现完全不工作。不影响主代理路径，所以一直没人察觉。

### 修复 (Bug fix)

- `src/auth.js`: 把 `positiveIntEnv` 在 module 顶部定义一份（跟 `client.js` / `conversation-pool.js` 同形态，零依赖）。

### Bug fix

- `src/auth.js`: define `positiveIntEnv` inline at the top of the module. The helper exists in the two other files that need it; auth.js just never got its copy and the cloud-probe path went silent.

### 致谢 (Acknowledgements)

- 端到端 probe 在 Tokyo VPS 上发现：`scripts/_v209_probe.py` + pm2 logs grep。
- Found while running `scripts/_v209_probe.py` against a v2.0.9 deployment on the Tokyo staging box and grepping pm2 logs for warnings.
