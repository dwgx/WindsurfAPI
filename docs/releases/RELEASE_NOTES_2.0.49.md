## v2.0.49 — LS 更新现在能看出来到底干了啥

跟 v2.0.48 同一个用户的反馈："LS更新也没有效果"。背后是个 UX 缺陷：老的 LS 更新 toast 只说「重启 N 个实例」，但 N=0 这个数掩盖了三种完全不同的情况：

1. **二进制本来就是最新** —— install-ls.sh 跑了下载了一份字节级一样的，sha256 没变
2. **二进制确实更新了 但池里没有运行中的 LS** —— restart 不起来不是因为坏 是因为没东西可重启 下次请求会自动加载新版
3. **二进制更新了 池里也有 LS 但重启全失败** —— 真正的问题

老 toast 三种情况都只说「重启 0 个实例」 用户看着觉得"什么都没发生"。

### 修法

**后端 `/langserver/update`**：

- 跑 install-ls.sh **之前** 算一次 sha256（`beforeSha`）
- 跑完 **之后** 再算一次（`afterSha`）
- 算出 `binaryChanged = beforeSha !== afterSha`
- 加 `poolEmpty = restarted === 0 && restartErrors.length === 0` 用来区分"冷池"和"全失败"
- 全部塞进响应

**前端 `updateLsBinary()`**：根据这四个字段挑 toast key

```js
if (!r.binaryChanged && r.beforeSha)         → toast.lsBinaryAlreadyCurrent
else if (errs)                                 → toast.lsBinaryUpdatedWithErrors  // 真问题
else if (r.poolEmpty)                          → toast.lsBinaryUpdatedColdPool    // 冷池
else                                            → toast.lsBinaryUpdated            // 正常
```

i18n 文案对应改：

```
toast.lsBinaryAlreadyCurrent:    "LS 二进制已是最新（sha:{{sha}}），无需更新"
toast.lsBinaryUpdatedColdPool:   "LS 二进制已更新（{{before}} → {{after}}），暂无运行中实例，下次请求时自动加载"
toast.lsBinaryUpdated:           "LS 二进制已更新（{{before}} → {{after}}），重启 {{count}} 个实例"
toast.lsBinaryUpdatedWithErrors: "LS 二进制已更新（{{before}} → {{after}}），重启 {{count}} 个实例（{{errors}} 个失败）"
```

### 为什么之前会出现"冷池"

LS pool 是懒加载的——容器启动后没收到第一条 chat 请求之前 pool 是空的。用户开 dashboard 第一件事就是点「更新 LS」 这时 `_poolKeys()` 返回空数组 `restarted: 0`。从用户视角：点了按钮 toast 说重启 0 个 怀疑没生效。

新 toast 直接告诉你「暂无运行中实例 下次请求时自动加载」 一来就把这个误解消掉了。

### 数字

- 测试：v2.0.48 是 494 → v2.0.49 是 **497** (+3 / 0 失败)
- suites：104 → **105**
- 改动：
  - `src/dashboard/api.js`: before/after sha256 + binaryChanged + poolEmpty
  - `src/dashboard/index.html`: 三分支 toast 选择
  - `src/dashboard/i18n/{zh-CN,en}.json`: 4 个文案 key 改 + 加 lsBinaryAlreadyCurrent / lsBinaryUpdatedColdPool
  - `test/langserver-binary-update.test.js`: 3 个 regression 钉死 sha 抓取 / 响应字段 / toast 选择逻辑

3 个新 regression：
- `/langserver/update` 必须算 beforeSha + afterSha + binaryChanged
- 响应必须 surface 四个字段
- 前端 toast 必须按 binaryChanged + poolEmpty 选 key

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后再点「更新 LS」 三种情况各看到三种不同 toast。

### 跟 v2.0.48 一起说一句

v2.0.48 的 docker self-update 三连修和这一刀都已经 ship。`docker:24-cli` 镜像第一次会拉一下（30 MB） 之后走 cache。dashboard 里如果还看到那条 `Failed to execute 'querySelector'` 巨长红字 大概率是浏览器还在用老版 dashboard 的 JS，硬刷一下（Ctrl+Shift+R）。
