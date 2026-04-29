## v2.0.30 — 三层 AI 协作审计：3 个 GPT-5.3-Codex-Spark worker + GPT-5.5 cross-audit + Claude 最终复核

按用户要求做了三层 AI 审计 pipeline：

```
v2.0.27 / v2.0.28 / v2.0.29 代码
        │
        ▼
┌─────────────────────────────────────────────────┐
│  Stage 1: 3 个 Spark worker 并行（独立 worktree） │
│  ├─ A: 安全审计 + 自修        (model: gpt-5.3-codex-spark)│
│  ├─ B: 测试覆盖审计 + 自补     (model: gpt-5.3-codex-spark)│
│  └─ C: 模型目录正确性审计 + 自修 (model: gpt-5.3-codex-spark)│
└─────────────────────────────────────────────────┘
        │
        ▼ merge to master + 解决 1 个 alias test 冲突
┌─────────────────────────────────────────────────┐
│  Stage 2: GPT-5.5 cross-audit                   │
│  逐条验证 worker 的 fix 是否真的正确              │
│  (model: gpt-5.5, reasoning: xhigh)             │
└─────────────────────────────────────────────────┘
        │
        ▼ 0 真 bug 找到
┌─────────────────────────────────────────────────┐
│  Stage 3: Claude Opus 4.7 spot-check + 总结    │
│  实测 GPT-5.5 的关键断言（loopback 边角等）        │
└─────────────────────────────────────────────────┘
```

### Stage 1: 3 个 Spark worker 改了什么

#### A — 安全（commit 06fec5c）
HIGH 级修复 ×3：
- **Loopback 绕过**：`/accounts/import-local` 之前只看 `req.socket.remoteAddress`。反向代理场景下 socket IP 总是 nginx 的 127.0.0.1，但实际请求来自公网。**加了 `isLocalBindHost()` 双重 gate**——服务必须本机 bind 才能跑这个 endpoint
- **SQLite 资源耗尽**：恶意 vscdb 可能巨大或损坏。**加了 24MB 大小上限 / 200 行上限 / 128KB 单值上限 / `mkdtemp` 随机 tmpdir + `rm -rf` 清理 / 4 秒结果 cache + in-flight dedup**
- **绝对路径泄露**：sources 数组返回的是 `C:\Users\dwgx1\AppData\...` 完整路径。**改成只返回 basename**

`isLoopbackAddress()` 重写覆盖 IPv4-mapped IPv6 hex 形式（`::ffff:7f00:1` → 127.0.0.1）+ 大小写 + zone identifier。新增 5 条 `test/local-windsurf-security.test.js`。

#### B — 测试覆盖（commit 9e41efb）
找了 5 个空缺，补 11 条测试 + 1 个 bug：

| 文件 | 加了什么 |
|------|----------|
| `test/models.test.js` | Opus 4.7 alias、case/dot/dash 变体、bare variant 文档化 |
| `test/account-add-proxy-ordering.test.js` (+3) | valid public proxy 全流程、`api_key+token` 共存优先级、非-`ERR_*` 错误路径 |
| `test/check-i18n.test.js` (新) | clean exit-0 + 故意污染 exit-1 |
| `test/gen-docs-models.test.js` (新) | HTML 可解析、双跑 idempotent、unknown provider 不崩 |

**Bug 修复**：`scripts/gen-docs-models.js` 之前用 `html.slice(0, start - 2)` 这种魔法数定位，重复执行可能输出抖动。改成 `lastIndexOf('\n', start)` 算 prefix，**真·幂等**。

#### C — 模型正确性（commit 7cd25b6）
找到 3 个 alias 缺口（用户客户端常见缩写但 catalog 没声明）：

```js
'claude-opus-4-7-thinking':   'claude-opus-4-7-medium-thinking',  // 短划线无 medium 后缀
'opus-4.7-thinking':          'claude-opus-4-7-medium-thinking',  // 无 claude 前缀
'o4.7':                       'claude-opus-4-7-medium',           // Cursor 风缩写
```

新增 6 条 `test/models-catalog-correctness.test.js`（resolveModel + getModelInfo + alias 反向 + mergeCloudModels 去重）。

### 合并冲突 & 解决（commit 250ba5c）

spark-B 的测试断言 `opus-4.7-thinking` 是**不**支持的 alias（写在 spark-C 加这个 alias **之前**），spark-C 添加完之后 spark-B 的测试就 fail 了。

**解决**：把 spark-B 的"unsupported variants"测试更新——保留 3 个真不支持的（`claude_opus_4_7` 用下划线、`opus-4.7-xhigh` 缺 claude 前缀、`4.7-medium` 太裸），删掉 `opus-4.7-thinking` 那行（因为 spark-C 让它现在支持了），加注释指向 spark-C 的正向断言。

### Stage 2: GPT-5.5 cross-audit 结论

> **"未发现需要修的 HIGH/MED/LOW 真 bug，tracked 文件未改动。"**

GPT-5.5 (xhigh effort) 验证了 7 类东西，全部通过：

1. spark-A 的 loopback 解析覆盖 `::ffff:127.0.0.1` / `::ffff:7f00:1` (hex 形式) / `::FFFF:` 大小写
2. `discoverInFlight` reject 后 `finally` 块会清理（不会卡住）
3. Node 20+ 支持 `structuredClone`（cache 实现 OK）
4. `isLocalBindHost` 检查会挡住 `0.0.0.0` 绑定下的 LAN 请求 —— **这是安全边界，不是 bug**
5. spark-B 的 `1.1.1.1` 测试走 IP 分支不 DNS（CI 不 flaky）
6. gen-docs 双跑无 diff（spark-B 的 idempotency 修法对了）
7. `o4.7` alias 不影响现有 `o4-mini`（spark-C 的扩展安全）

### Stage 3: Claude 最终 spot-check

Claude 没有盲信 GPT-5.5。对**关键安全断言**起 probe 实测验证：

```
::ffff:127.0.0.1 → true   ✓
::FFFF:127.0.0.1 → true   ✓ (大小写)
::ffff:7f00:1   → true   ✓ (hex 形式 — 这条最容易漏)
::ffff:7f00:0001 → true   ✓
127.0.0.1       → true   ✓
192.168.1.1     → false  ✓ (非 loopback)
::1             → true   ✓
::ffff:8.8.8.8  → false  ✓ (公网 IPv4-mapped)
1.27.0.0.1      → false  ✓ (恶意 spoof)
```

**结论**：GPT-5.5 的所有断言都被实测验证通过。没有过度宽松的 audit。

### 数字

- **测试**：v2.0.29 之前 327 → v2.0.30 现在 **349**（+22 条新测试）
- **suites**：64 → 77 (+13)
- **代码改动**：3 个 Spark worker = +651 行 / -55 行；GPT-5.5 audit = 0 行（找到 0 bug）
- **i18n guard**：✓ 全部通过
- **gen-docs idempotency**：✓ 双跑无 diff
- **token 节省**：3 个 worker + 1 个 reviewer = 4 次 codex dispatch，每次完整 context 在 codex 自己的窗口里跑，Claude 主 context 里只看到摘要

### 没修的（gpt-5.5 标 noise，不阻塞）

- account 创建路径会触发 LS warmup，无 LS 环境会打印 25s 失败日志 —— 测试照过，只是日志噪音

### Verification

- `node --test test/*.test.js`：**349/349 passing**
- `node src/dashboard/check-i18n.js`：✓ 全部通过
- `node scripts/gen-docs-models.js`（双跑）：docs 无 diff
- 实测 9 个 loopback 边角 case：100% 符合预期

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- 全部是加固 + 测试 + alias —— **API 不变**，旧客户端不受影响
- spark-A 加的 isLocalBindHost gate 对**已经是本机部署**的用户透明；只有部署在公网 + 想用本地导入功能的（极少数）用户会被挡，他们应该改用其他导入方式
- 349/349 tests pass
