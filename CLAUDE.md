# WindsurfAPI

Windsurf Cascade → OpenAI/Anthropic 兼容 API 反代。零 npm 依赖，Node.js ESM。dwgx 的项目。

## 铁律

- **零依赖** — 不 npm install
- **不写 Co-Authored-By** — 没有任何 AI/工具的 attribution
- **不写文档** — 除非 dwgx 明确要求。不创建 .md
- **不加注释** — 除非 WHY 不明显
- **不加抽象/功能** — 修复就是修复，不顺手重构
- **不改 release workflow** — `.github/workflows/release.yml` 不动
- **commit 英文** — `fix:` / `feat:` 格式
- **直接 push master** — 不建分支不建 PR
- **push 前跑 `node --check`** — 至少语法对
- **测试脚本放 `tmp-testing/`** — 已 gitignore，不提交

## VPS

```
154.40.36.22:3888  root:22  pass: JbjBsBz3v8sDWGXsUUN
API_KEY: sk-dwgxnbnb888
DASHBOARD_PASSWORD: sk-dwgxnbnb888
```

SSH 需要 SSH_ASKPASS trick（Git Bash 没 TTY）:
```bash
export SSH_ASKPASS=/tmp/askpass.sh
export DISPLAY=:0
echo '#!/bin/bash' > /tmp/askpass.sh
echo 'echo "JbjBsBz3v8sDWGXsUUN"' >> /tmp/askpass.sh
chmod +x /tmp/askpass.sh
```

## 部署流程

```bash
git add -A && git commit -m "fix: ..." && git push origin master
# 然后 VPS:
ssh root@154.40.36.22 'cd /root/WindsurfAPI && git fetch origin && git reset --hard origin/master && docker compose up -d --build'
# 验证:
curl -sS 154.40.36.22:3888/health
```

## Issue 处理规则

- **先测再回** — VPS 上写脚本实测，有结果了再回复。不要猜
- **中文简短** — 3-5 句话说清楚。不要列表、不要 emoji、不要结构化
- **不说版本号** — 永远说"升级到 latest"，不说"v2.0.xx"
- **贴实测输出** — 不要只说"已修复"，贴 curl 结果
- **上游限制说死** — Windsurf Cascade 的问题不是 proxy bug，别装能修
- **不轻易关 issue** — 除非 VPS 实测复现不了且有合理解释
- **撤回垃圾评论** — 说错了就编辑掉，不要留着丢人

## 回复模板

```
问题确认。VPS 实测 [模型] [场景]: [结果]。
原因: [一句说清]
解决: [一句说清]
还不行贴 LOG_LEVEL=debug 日志。
```

## 版本发布

当前版本看 `package.json` → `version` 字段。

```bash
# 改版本号
编辑 package.json version
# 写 release notes
编辑 RELEASE_NOTES_2.0.XX.md
# 提交 + tag
git add package.json RELEASE_NOTES_2.0.XX.md
git commit -m "release: 2.0.XX"
git tag -a v2.0.XX -m "v2.0.XX: ..."
git push origin master --tags
# CI 自动构建 Docker 镜像 + GitHub Release
```

## 常见问题速查

| 症状 | 原因 | 处理 |
|---|---|---|
| kimi-k2 空返回 | Cascade 上游宕机 | 返回 `upstream_model_unavailable` |
| GLM-5.1 不调工具 | Cascade idle_empty | 建议换 glm-4.7 或 sonnet |
| free 账号只有 gemini | Windsurf free tier 限制 | 不是 proxy bug |
| 全部号 rate-limited | Windsurf IP 级限流 | 需多出口代理 |
| 上下文丢失 | 客户端没发完整历史 或 history budget 截断 | 600KB 默认，查 turns=N |
| opus-max 超时 | 重型模型输出长 | 建议换 sonnet，maxWait 600s |
| 多人同时用报 502 | sub2api 瓶颈或账号不够 | proxy 并发本身没问题 |

## 环境变量关键默认

- `CASCADE_MAX_HISTORY_BYTES` = 600000
- `CASCADE_MAX_WAIT_MS` = 600000
- `CASCADE_WARM_STALL_TOOL_ACTIVE_MS` = 180000
- `CASCADE_WARM_STALL_THINKING_MS` = 120000
- `CASCADE_WARM_STALL_MS` = 45000
- NLU retry: GLM/Kimi 默认 ON，设 `WINDSURFAPI_NLU_RETRY=0` 关
