## v2.0.81 — #125 中文 NLU + bilingual anti-narrate dialect

DuZunTianXia 在 #125 实测复现：GLM-5.1 + Claude Code 询问"本地有哪些文件"，server log 显示：

```
markers=none; head="用户想查看项目目录下的文件。让我用 Bash 来列出当前工作目录下的文件。"
markers=none; head="The user wants to see what files are in the current project directory. Let me list the files in the workspace."
```

工具调用一次也没发出。两条根因。

### 根因一：NLU Layer 3 verb regex 只识别英文

```js
const verbs = '(?:call|invoke|run|use|execute|exec|trigger|fire)';
```

GLM 中文 narrate "让我用 Bash" / "调用 shell_exec" 完全不命中 → Layer 3 不触发 → 0 tool_calls。

### 根因二：模型 narrate 不带 args 字面值

GLM-5.1 这种 case 直接说"让我用 Bash 来列出文件"没说"ls"或"ls /path"。即使 Layer 3 trigger 了也没东西可抠。

### 修

**A. NLU 三段中文化**

`extractLayer3` 的 verbs / suffix / argPatterns 全加中文：

```js
const verbs = '(?:call|invoke|run|use|execute|...|调用|使用|运行|执行|让我用|让我使用|我会用|...)';
const suffix = '(?:\\s+(?:function|tool|method|函数|工具|方法))?';
// 注意 suffix 拿掉了 "command"/"命令" — 这俩留给 argPattern 抓 value
```

新加 argPattern：

```js
// bare keyword + value: "command 'X'" / "命令 'X'" (no preamble required)
/(?:^|\s)(?:command|argument|...|命令|参数|路径|文件|查询)\s+["'`]...["'`]/
// 中文：用 'X' / 命令 'X' / 路径 'X'
/(?:用|使用|传入|...|命令(?:为)?|路径(?:为)?)\s*["'`「『]...["'`」』]/
```

`userPromptLooksActionable` 加中文动词 + 名词：

```js
if (/(?:运行|执行|读取|查看|列出|查找|搜索|...|看看|检查)/.test(text)) return true;
if (/(?:文件|目录|路径|命令|工具|函数|参数|项目|代码|配置)/.test(text)) return true;
```

`looksLikePlaceholderValue` 加中文占位词：

```js
PLACEHOLDER_KEYWORDS += ['命令', '参数', '文件', '路径', '输入', '值', '字符串', '文本', '名称', '查询', '输出'];
CN_VAGUE_PREFIX_RE = /^(?:某个?|一个|这个|那个|某种|什么|任何)/;
```

**B. dialect preamble bilingual anti-narrate**

glm47 / kimi_k2 / openai_json_xml 三个 dialect 的 protocol header 都加：

```
4. NEVER write narration like "I'll run X" / "Let me check Y" / "让我用 X 工具" / "我会调用 Y"
   — emit the <tool_call> block directly with no preamble. 中文也一样。
6. The functions ARE available — do not say "I cannot" / "我没有工具" / "我无法执行".
7. ALWAYS provide concrete argument values. Reject placeholders like "command" /
   "the file" / "用命令" / "执行一个命令".
```

让 GLM 中文输出时也按协议 emit `<tool_call>`，不靠 NLU 兜底。

### 仍解决不了的边界

GLM-5.1 实际报告的"让我用 Bash 来列出当前工作目录下的文件"**根本没说字面 command** — 模型只描述意图不给值。这种 case NLU 仍抠不到（v2.0.78 H-2 placeholder filter 拒绝 `the file` 类 prose 是必须的，否则 agent 拿到 `the file` 当 command 跑会失败循环）。

诚实结论：GLM-5.1 narrate 不给 args 字面是模型本身行为限制，proxy 这层 NLU 是兜底不能保证 100%。要稳定调工具用 Claude family（claude-haiku-4.5 / claude-sonnet-4.6）。

### 改动

- `src/handlers/intent-extractor.js` — verbs/suffix/argPatterns/actionable/placeholder 全中文化
- `src/handlers/tool-emulation.js` — glm47 / kimi_k2 / openai_json_xml dialect 加 bilingual anti-narrate 规则
- `test/v2081-chinese-nlu.test.js` — 新（14 case）
- `test/tool-emulation.test.js` — compact threshold 2500 → 3500（吸收新规则字节）

### 数字

- 测试 840 → **854**（+14）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```
