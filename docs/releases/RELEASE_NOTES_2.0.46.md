## v2.0.46 — #107 follow-up：untrusted workspace 的两道补丁

zhangzhang-bit 升 v2.0.45 后回了新 log：cwd 提取这块好了一部分但又冒出来另一头——SendUserCascadeMessage 直接被上游 LS 拒了 `untrusted workspace`，他「一直换账号重试 提示 不信任的工作区」。env 提取从开关坏掉变成开关半开，合不上的那一半是这一刀解决的。

### 链路重看

把 LS 这套 warmup + Send 重新画一遍：

```
warmupCascade (per-LS one-shot, 4 步)
  ├─ InitializeCascadePanelState
  ├─ AddTrackedWorkspace        ← 注册 /home/user/projects/workspace-XXX
  ├─ UpdateWorkspaceTrust       ← 把这个 ws 标 trusted
  └─ Heartbeat
↓
StartCascade
↓
SendUserCascadeMessage          ← 在这里报 untrusted workspace 就说明上一步的 trust 没生效
```

UpdateWorkspaceTrust 这步老逻辑是这样：

```js
try {
  await grpcUnary(...UpdateWorkspaceTrust...);
} catch (e) { handleWarmupError('UpdateWorkspaceTrust', e); }
```

而 `handleWarmupError` 内部对**非 transport** 错误只 `log.warn(`${stage}: ${err.message}`)` 然后 return——**不抛**。结果是 trust 这步如果哪次悄悄失败了（比如 LS 那边版本变了、字段对不上、临时 grpc 5xx），warmup 流程不会停，后面 cascade init complete 也照常打印「workspace init complete」误导你以为一切正常。然后第一条真请求过来 → SendUserCascadeMessage → upstream LS 看 trust state 还是 default-untrusted → 拒 `untrusted workspace`。

更糟的是后面 per-Send 的 retry 循环：

```js
const isPanelMissing  = (e) => /panel state not found.../i.test(e?.message || '');
const isExpiredCascade = (e) => /not_found.*(cascade|trajectory).../i.test(e?.message || '');
...
if (!isPanelMissing(e) && !expired) throw e;   // ← untrusted 走不到这里 直接抛
```

`untrusted workspace` 既不是 panel-missing 也不是 cascade-expired，retry 守卫直接把错误重新扔出去，于是「可重试的可恢复错误」被当成「不可恢复 fatal」处理，retry budget 一次都没用上。zhangzhang-bit 看到的 `Stream error after retries: untrusted workspace` 这条 ERROR 字面就是这个意思——「retry 了之后还是失败」其实是「retry 一次都没真正发生过」。

### 修法

`src/client.js` 里三个补丁一起打：

**1 加 `isUntrustedWorkspace` 分类器**

```js
const isUntrustedWorkspace = (e) => /untrusted workspace|workspace.*not.*trusted/i.test(e?.message || '');
```

**2 把它接到 per-Send retry 循环里 跟 panel-missing / expired 享受同一套恢复路径**

```diff
- if (!isPanelMissing(e) && !expired) throw e;
+ const untrusted = isUntrustedWorkspace(e);
+ if (!isPanelMissing(e) && !expired && !untrusted) throw e;
...
+ } else if (untrusted) {
+   log.warn(`Untrusted workspace on Send (retry .../...), forcing UpdateWorkspaceTrust re-warm on port=...`);
```

force 模式下 `warmupCascade(true)` 会清掉 `lsEntry.workspaceInit` 然后从头跑四步——包括重新尝试 UpdateWorkspaceTrust。再 StartCascade 再 SendUserCascadeMessage，trust 这次大概率就成了。

**3 UpdateWorkspaceTrust 的 silent failure 从 warn 升 error**

```js
catch (e) {
  if (isCascadeTransportError(e)) handleWarmupError('UpdateWorkspaceTrust', e);
  else log.error(`UpdateWorkspaceTrust failed silently on port=... — SendUserCascadeMessage will likely return 'untrusted workspace' until the next force re-warm: ${e.message}`);
}
```

非 transport 的失败现在打 ERROR 等级 + 消息里直接告诉运维「下一次 send 大概率会报 untrusted workspace」。dashboard 里 ERROR 比 WARN 显眼很多，下次再有这个症状能在第一时间看到根因。

`MAX_PANEL_RETRIES` 用尽时抛的 detail message 也加了 untrusted-workspace 这个分支，跟「panel state lost」「cascade expired」并列，免得调试时根本分不清是哪条链路烂了：

```
untrusted workspace persisted across N re-warm attempts (LS UpdateWorkspaceTrust may be failing silently)
```

### 数字

- 测试：v2.0.45 是 476 → v2.0.46 是 **480** (+4 / 0 失败)
- suites：98 → **99**
- 改动：仅 `src/client.js` 约 30 行 + 一个新测试文件 `test/untrusted-workspace-retry.test.js`

4 个新 regression：

- `isUntrustedWorkspace` 分类器存在且匹配 LS 字面措辞
- per-Send retry 循环里 rethrow guard 确实带了 `!untrusted` 项 + 走专属 log 路径
- UpdateWorkspaceTrust 失败现在以 error 等级打且消息里点出 `force re-warm`
- 用尽 retry 抛出的错误信息能区分 untrusted-workspace 跟其他类别

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后 `untrusted workspace` 这种情况：
- 第一次 send 撞上 → log warn `Untrusted workspace on Send (retry 1/N)` → 自动 force re-warm → 多半第二次 send 就过
- 如果 N 次都没过 → ERROR 抛出来 + dashboard 上能看到 `UpdateWorkspaceTrust failed silently` 的 error 行 → 直接定位是 LS 那一步对不上

### 后续

如果 `UpdateWorkspaceTrust` 的 silent failure 在你 dashboard 上频繁出现，把那条 error log 完整贴 issue 里——很可能上游 LS 又改协议了，proto 字段需要重抓。`src/windsurf.js` 里那个注释「Field 1: metadata, Field 2: workspace_trusted, no path」几个版本前对的，现在万一不对了那是另一回事。
