## v2.0.6 — Hardening release

### 安全 (Security)
- 修复 Cascade conversation pool 的跨调用方复用风险：fingerprint 现在包含 callerKey，API key、dashboard session 或 IP/User-Agent 会隔离相同首轮 prompt 的 hidden state。
- 修复多模态响应缓存污染：图片和 PDF data URL 的 MIME、内容 hash 与字节数进入 cache key，避免同文本不同图片命中旧回答。
- 代理、请求日志和 dashboard 登录返回值加强脱敏：LS proxy 日志不再输出账号密码；请求 probe 默认只记录长度和 hash；登录取号默认只返回 masked API key，并提供受 dashboard auth 保护的 reveal-key 接口。
- 加强 SSRF 防护：统一 DNS 后校验，覆盖 IPv4 私网、link-local、loopback、CGNAT、IPv6 ULA/link-local/loopback 和 IPv4-mapped IPv6。
- PDF FlateDecode 增加 zip bomb 防护：单 stream、累计解压和 stream 数量都有限制，超限时降级为“PDF 内容无法提取”。
- 未配置 API_KEY / DASHBOARD_PASSWORD 且服务监听非 localhost 时，启动横幅会输出中英双语高强度警告，保持兼容但明确暴露风险。

Security:
- Fixed cross-caller Cascade conversation reuse by including callerKey in fingerprints, isolating identical prompts by API key, dashboard session, or IP/User-Agent fallback.
- Fixed multimodal cache poisoning by adding image/PDF MIME, content hash, and byte size to cache keys.
- Hardened proxy, request, and dashboard key redaction: LS proxy logs no longer expose credentials, request probes default to length/hash, and login endpoints return masked API keys by default with a dashboard-authenticated reveal endpoint.
- Strengthened SSRF checks with post-DNS validation for private IPv4, link-local, loopback, CGNAT, IPv6 local ranges, and IPv4-mapped IPv6.
- Added PDF FlateDecode zip-bomb limits with a graceful “PDF 内容无法提取” fallback.
- Added loud bilingual startup warnings when auth is not configured on non-localhost binds.

### 修复 (Bug fixes)
- 修复 #57 thinking-only 长流被 cold-stall 误杀的问题，并将 stall 分类拆成 `transient_stall` / `model_error`，避免污染 capability 与限流判断。
- 修复 Responses API 对 `reasoning_content` 的流式和非流式映射，输出 Responses reasoning item 与 summary delta。
- 修复 dashboard batch import 使用 `result.accountId` 导致 per-account proxy 未绑定的问题，现在读取 `result.account.id`。
- 修复三层 stream 错误协议：Chat 发送结构化 OpenAI error SSE，Messages 转成 Anthropic `event: error`，Responses 转成 `response.failed`。
- 修复 Linux auto-install 缺少 `dirname/fileURLToPath/join` import 的问题。
- 修复 account reprobe 并发入口，避免重复 probe 同时运行。

Bug fixes:
- Fixed #57 cold-stall false positives during thinking-only streams, and split stall/model classifications to avoid capability and rate-limit pollution.
- Mapped `reasoning_content` for both streaming and non-streaming Responses API output.
- Fixed dashboard batch import proxy binding by reading `result.account.id`.
- Structured stream errors across Chat, Anthropic Messages, and Responses protocols.
- Fixed missing imports in the Linux language-server auto-install path.
- Added a reprobe in-flight guard to prevent overlapping account probes.

### 健壮性 (Robustness)
- SIGTERM/SIGINT shutdown now aborts active SSE streams with a structured `server shutting down` error before draining HTTP connections.
- Cache normalization now includes `response_format`、`reasoning_effort`、`thinking`、`stream_options`，避免不同请求选项互相污染。
- Proto tool preamble 去除 `Ignore` / `---` 等 jailbreak-shaped wording，并新增 forbidden wording 回归测试。
- 新增 23 个回归测试，覆盖 caller 隔离、cache 多模态 key、proxy 脱敏、stream error、SSRF、PDF 限制、auth warning、SSE registry 和 tool preamble 禁词。

Robustness:
- SIGTERM/SIGINT now abort active SSE streams with a structured `server shutting down` error before HTTP drain.
- Cache normalization now includes `response_format`, `reasoning_effort`, `thinking`, and `stream_options`.
- Removed jailbreak-shaped wording such as `Ignore` and `---` from the proto tool preamble and added forbidden-word regression tests.
- Added 23 regression tests covering caller isolation, multimodal cache keys, proxy redaction, stream errors, SSRF, PDF limits, auth warnings, SSE registry, and tool preamble forbidden wording.

### 致谢
- 本版改动由 codex 全项目审计驱动；致谢 dwgx 主审 + codex worker
- 关联 issue: #57, #59

Acknowledgements:
- This hardening release was driven by the codex full-project audit; thanks to dwgx for primary review and the codex worker.
- Related issues: #57, #59
