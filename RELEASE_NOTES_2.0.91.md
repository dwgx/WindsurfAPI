# v2.0.91

## 修复
- **#135 P0**: `ReferenceError: context is not defined` — 全部 Claude 模型 stream 路径崩溃
- **#134**: Auth1 邮箱登录 — PostAuth 改用空 proto body + X-Devin-Auth1-Token header + Referer + 原始响应解析
- **#137**: 全局代理 SOCKS5 添加问题 — parseProxyUrl 支持空格分隔, 前端检查 API 错误再弹 toast
- **#132**: IP 级限流断路器 — 同模型 8s 内 3+ 账号被限流时停止轮询

## 新增
- `RESPONSE_CACHE_ENABLED` 环境变量可关闭响应缓存
- `recordPolicyBlocked()` / `recordRateLimited()` 统计数据

## 社区贡献
- @Await-d (PR #144): PostAuth 空 proto body + raw token 解析
- @suhaihui-git (PR #142): 响应缓存开关
- @chukangkang (PR #139): batch import 去重建议
- @Chengjian-Lin, @1404872321: #133 上下文丢失复现

## 测试
- VPS 10轮上下文: claude-sonnet-4.6 ✅ gemini-2.5-flash ✅
- GPT 全系 (5.5/5.4-mini-low/5.2) ✅
- 工具调用 6/7 模型通过 (kimi-k2 上游宕机)
