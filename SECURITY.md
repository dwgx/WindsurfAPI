# Security Policy / 安全漏洞披露

<p align="center">
  <a href="https://github.com/dwgx/WindsurfAPI/security/advisories/new"><img src="https://img.shields.io/badge/report-Security%20Advisory-d1242f?style=flat-square&logo=github" alt="Report via Security Advisory"></a>
  <img src="https://img.shields.io/badge/first%20response-72h-1f6feb?style=flat-square" alt="First response within 72 hours">
</p>

> **TL;DR** — 别开 public issue。用
> [Security Advisory](https://github.com/dwgx/WindsurfAPI/security/advisories/new)（推荐）
> 或邮件 `dwgx1337@gmail.com`，标题前缀 `[WindsurfAPI Security]`。72 小时内回复。
>
> **Do not open a public issue.** Use a Security Advisory (preferred) or the email above.

```mermaid
flowchart TD
    F["发现问题 / Found something"] --> Q{"能否被外部触发?<br/>externally triggerable?"}
    Q -->|"否 / no"| SCAN["扫描器报告但无实证影响<br/>→ 普通 issue<br/>scanner output, no demonstrated impact"]
    Q -->|"是 / yes"| W{"影响什么?<br/>what does it reach?"}
    W -->|"认证 / 凭证 / RCE / SSRF"| ADV["Security Advisory<br/>私下上报 · private"]
    W -->|"注入 XSS / command / prompt"| ADV
    W -->|"Dashboard API"| ADV
    W -->|"上游限流绕过<br/>upstream rate limit"| OUT["范围外 —— 属账号管理<br/>out of scope"]

    classDef danger fill:#d1242f22,stroke:#d1242f,stroke-width:2px
    classDef ok fill:#1a7f3722,stroke:#1a7f37
    class ADV danger
    class SCAN,OUT ok
```

## English

If you discover a security vulnerability in WindsurfAPI, **please do not open a public GitHub issue**.

Public issues are indexed by search engines and watched by forks — disclosing there exposes every deployed instance before a fix lands.

Instead, report privately via one of:

- GitHub Security Advisories: <https://github.com/dwgx/WindsurfAPI/security/advisories/new> (preferred — encrypted, tracks the fix)
- Email: `dwgx1337@gmail.com` with subject prefix `[WindsurfAPI Security]`

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (PoC appreciated)
- Affected version / commit SHA (check `/health` endpoint)
- Your contact for follow-up

You can expect a first response within **72 hours**. Valid reports will be credited in the release notes (unless you prefer anonymity).

### In scope
- Authentication bypass (dashboard, account pool)
- Account/token/credential leakage
- Remote code execution, SSRF, path traversal
- Injection attacks (XSS, command, prompt)
- Dashboard API vulnerabilities

### Out of scope
- Rate-limit bypass on upstream Windsurf (that's an account-management concern, not a vuln in this proxy)
- Issues requiring physical access to the host
- Findings from automated scanners without demonstrated impact

---

## 简体中文

发现安全漏洞请**不要开 public issue**。public issue 会被搜索引擎索引、被所有 fork 关注 —— 漏洞一旦公开，所有已部署的实例在补丁落地前都会暴露。

请用下面任一方式私下报告：

- GitHub Security Advisories（推荐，加密、跟进修复）：<https://github.com/dwgx/WindsurfAPI/security/advisories/new>
- 邮件：`dwgx1337@gmail.com`，标题前缀 `[WindsurfAPI Security]`

请附上：

- 漏洞描述 + 影响范围
- 复现步骤（有 PoC 最好）
- 受影响的版本 / commit SHA（看 `/health` 端点）
- 方便联系的方式

一般 **72 小时内**会首次回复。有效报告会在 release notes 里致谢（除非你要求匿名）。

---

## Acknowledgments / 致谢

Thanks to fishfish (https://github.com/fishfish57) for two responsible disclosures, both
CWE-1333 event-loop blocking: the quadratic scans in the client-identity neutralizer
(reported 2026-11-08) and the unbounded JSON Schema `pattern` evaluation in
`src/json-schema.js` (reported 2026-11-10). Tracked as GHSA-fx5f-49jr-fw6r (identity
neutralizer) and GHSA-r7v2-3h32-f5g6 (JSON Schema `pattern`); both are fixed in
3.141.592661 (`patched_versions: >= 3.141.592661`).

感谢 fishfish（https://github.com/fishfish57）负责任地披露两个 CWE-1333（event-loop 阻塞）
问题：客户端身份中和器的二次正则扫描（2026-11-08 报告）与 `src/json-schema.js` 中
JSON Schema `pattern` 的无界求值（2026-11-10 报告）。分别跟踪为 GHSA-fx5f-49jr-fw6r 与
GHSA-r7v2-3h32-f5g6。修复版本 **3.141.592661**（`patched_versions: >= 3.141.592661`），
细节见 [v3.141.592661 发布说明](docs/releases/RELEASE_NOTES_3.141.592661.md)。
