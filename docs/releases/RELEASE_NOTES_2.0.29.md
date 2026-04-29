## v2.0.29 — 模型目录补全 + GitHub Pages 自动同步

跟 codex 一起对了一波最新 Windsurf 模型清单，补上之前缺的，修了几个 enum 配错的，并把 GitHub Pages 改成自动从 `src/models.js` 生成（之前 docs 跟代码漂移很久了）。

### 新增模型

**Claude Opus 4.7**（Windsurf changelog 2026-04-16）—— 4 个 reasoning 等级 + 3 个 thinking 变体：

| 名字 | UID | credit |
|------|-----|--------|
| `claude-opus-4-7-low` | `claude-opus-4-7-low` | 6 |
| `claude-opus-4-7-medium` | `claude-opus-4-7-medium` | 8 |
| `claude-opus-4-7-high` | `claude-opus-4-7-high` | 10 |
| `claude-opus-4-7-xhigh` | `claude-opus-4-7-xhigh` | 12 |
| `claude-opus-4-7-medium-thinking` | `claude-opus-4-7-medium-thinking` | 10 |
| `claude-opus-4-7-high-thinking` | `claude-opus-4-7-high-thinking` | 12 |
| `claude-opus-4-7-xhigh-thinking` | `claude-opus-4-7-xhigh-thinking` | 16 |

`claude-opus-4.7` / `opus-4.7` / `claude-opus-4.7-thinking` 这些常见缩写都已加 alias，自动解析。

**Kimi K2 Thinking** — 之前漏了，proto 里有 `MODEL_KIMI_K2_THINKING = 394`：

```
'kimi-k2-thinking': enumValue 394, MODEL_KIMI_K2_THINKING, credit 1
```

**GLM 4.7 Fast** — proto 里有 `MODEL_GLM_4_7_FAST = 418`：

```
'glm-4.7-fast': enumValue 418, MODEL_GLM_4_7_FAST, credit 0.5
```

**SWE 1.5 Thinking** — proto 里有 `MODEL_SWE_1_5_THINKING = 369`：

```
'swe-1.5-thinking': enumValue 369, MODEL_SWE_1_5_THINKING, credit 0.75
```

**Adaptive Model Router**（Windsurf changelog 2026-04-06）—— 自动选模型 + reasoning tier：

```
'adaptive': uid 'adaptive', credit 1
```

### 修正错误的 enum

之前 SWE 1.5/1.6 的 enum 和 UID 对不上，请求虽然能跑（modelUid 优先），但 enumValue 是错的。校对 proto 后修：

| 模型 | 之前 | 现在 |
|------|------|------|
| `swe-1.5` | enum 369 (THINKING) + UID SLOW | enum **377** (SLOW) + UID SLOW ✓ |
| `swe-1.6` | enum 0 + UID `swe-1-6` | enum **420** + UID `MODEL_SWE_1_6` ✓ |
| `swe-1.6-fast` | enum 0 + UID `swe-1-6-fast` | enum **421** + UID `MODEL_SWE_1_6_FAST` ✓ |
| `minimax-m2.5` | enum 0 + UID `minimax-m2-5` | enum **419** + UID `MODEL_MINIMAX_M2_1` ✓ |

### 新增脚本：`scripts/gen-docs-models.js`

之前 `docs/index.html` 里的模型清单是手写硬编码，跟 `src/models.js` 漂移得很厉害（缺 GLM 4.7/5/5.1、缺 Kimi K2.5/K2-6、缺 GPT-5.4 全系、缺 Gemini 3.x 详细变体...）。

新增脚本从 `src/models.js` 单一来源直接生成 docs MODELS 数组：

```bash
node scripts/gen-docs-models.js
```

跑完会自动重写 `docs/index.html` 的 MODELS literal、刷新所有 provider count。以后 src/models.js 加新模型只要跑一遍就同步过去。

### Dashboard / 网页改动

- GitHub Pages 模型 grid 现在显示 **111 个**（v2.0.28 之前展示 80 个，跟实际 101 差 21 个，加 v2.0.29 新增 10 个变体）
- 加了 MiniMax 的 filter 按钮（之前只有 8 个 provider 按钮，缺 MiniMax）
- 移除了 DeepSeek filter 按钮（DeepSeek v3/r1 全 deprecated 了，没现役模型可显示）
- 所有 provider 按钮都显示数字（之前只有 Claude / GPT / Gemini 显示）
- 「免费帐号只支持 gpt-4o-mini 和 gemini-2.5-flash」改成「只支持 gemini-2.5-flash（gpt-4o-mini 已被上游下架）」
- 架构图 "107+ 模型" 改 "100+ 模型"

### README 改动

- README.md / README.en.md 模型分类全面刷新，加上 Claude Opus 4.7、Kimi K2.x、GLM 4.7/5/5.1、GPT-5.4 等
- 删掉「107 个」硬编码数字，改成 "100+" + 链接到 GitHub Pages 实时清单
- `setup.sh` 里 `DEFAULT_MODEL=gpt-4o-mini` 改成 `DEFAULT_MODEL=claude-4.5-sonnet-thinking`（gpt-4o-mini 已下架）

### Verification

- `node --test test/*.test.js`：**327/327 passing**
- `node src/dashboard/check-i18n.js`：✓ 全部通过
- `resolveModel('claude-opus-4.7')` → `claude-opus-4-7-medium`（alias OK）
- `resolveModel('claude-opus-4.7-xhigh-thinking')` → `claude-opus-4-7-xhigh-thinking`（变体 OK）
- 模型总数：catalog 113（含 deprecated）/ 111 active

### Compatibility

- 升级路径：`docker compose pull && docker compose up -d`
- 模型加项 + alias 加项 —— 没改任何已有模型的 UID，旧客户端不受影响
- SWE 1.5/1.6 enum 修正：modelUid 优先级仍高于 enumValue，旧请求路径不变
- README/docs 纯文档刷新
- 327/327 tests pass
