# v2.0.92

## 修复
- **kimi-k2 空响应检测**: Cascade 返回 idle_empty 时不再静默传递空内容，改为返回 502 + 替代模型建议
- **GLM/Kimi NLU 重试默认启用**: GLM-4.7/Kimi 第一次 narrate 不调工具→自动检测→第二次重试正确 emit 工具调用。无需手动设 `WINDSURFAPI_NLU_RETRY=1`
- **Cascade 历史预算 400KB→600KB**: 减少长对话工具调用场景的上下文截断
- **Windsurf 内容过滤绕过扩展**: prompt-injection / jailbreak / bypass safety 触发词处理，Devin session token 标准化

## v2.0.91 修复 (包含)
- #135 P0: `ReferenceError: context is not defined` — 全部 Claude 模型 stream 路径崩溃
- #134: Auth1 邮箱登录 — PostAuth 空 proto body + X-Devin-Auth1-Token header + Referer
- #137: parseProxyUrl 空格分隔 + 前端 API error check
- #132: IP 级限流断路器
- `RESPONSE_CACHE_ENABLED` 环境变量

## 社区贡献
- @Await-d (PR #144): PostAuth 空 proto body + raw token 解析
- @suhaihui-git (PR #142): 响应缓存开关
- @chukangkang (PR #139): batch import 去重

## VPS 实测
- 10轮上下文: claude-sonnet-4.6 4/4 ✅ gemini-2.5-flash 4/4 ✅
- GPT 全系 (5.5/5.4-mini-low/5.2) ✅
- opus-4-7-max + 工具 ✅
- GLM-4.7 NLU 重试 → Bash 工具调用 ✅
- kimi-k2: 返回 upstream_model_unavailable + 替代建议
- Devin token 内容过滤: 不触发 ✅
