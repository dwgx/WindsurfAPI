## v2.0.47 — #108：模型把代理脚手架当成用户项目"分析"

nalayahfowlkest-ship-it 报的，zhangzhang-bit 跟着挖出根因贴了原始数据。用户在 Windows 上有一个真项目 `E:\Desktop\新建文件夹`，让模型「分析项目」，结果模型回的是另一个 `workspace-devinxse` 目录，里面有空的 `src/index.js`、`README.md`、`package.json`——用户从没见过这些文件。

zhangzhang-bit 把模型上下文里收到的原始数据贴出来了：

```
<user_information>
The USER's OS version is linux.
<workspace> -> <workspace> (git root: <workspace>)

<workspace_information>
<workspace_layout workspace="<workspace>">
- .git/
- src/
  - index.js
- .gitignore
- README.md
- package.json
</workspace_layout>
```

也就是说 cascade 上游的 system prompt 里硬塞了一份 `<workspace_layout>` 快照，列出来一个 Linux 上的目录结构。模型读到这个就当成用户的真实项目去"分析"了，完全无视 v2.0.45 注进 tool_calling_section 的 Environment facts 里写的 Windows cwd。

### 根因两层

**第一层 / 脚手架本身长得像项目**

`src/client.js:ensureWorkspaceDir` 一直在每个 account 的 `/home/user/projects/workspace-${apiKeyHash}` 目录下铺一份"最小项目"模板：

```js
package.json: { name: 'my-project', description: 'A development project', scripts: {...} }
README.md:    "# My Project\n\nA development project.\n\n## Getting Started\n..."
src/index.js: '// Entry point\nconsole.log("Hello, world!");'
.gitignore:   'node_modules/\n.env\n...'
+ git init
```

这套脚手架的存在是为了给 LS 一个真目录索引（fingerprint gap，原注释里写过），单看没问题。但 cascade 上游会把这目录扫一遍，把文件树嵌进 system prompt 当 `<workspace_layout>`。模型一看「哦这是个 Node 项目，有 package.json README src/index.js」，再叠加用户那句"分析这个项目"，最自然的反应就是把这份脚手架当用户项目分析。

**第二层 / Environment facts 没说清楚优先级**

我们在 tool_calling_section 注的 Environment facts 块只列 cwd / platform / OS，没说"如果你看到 `<workspace_information>` 那个东西是代理塞进去的 stub 不是用户的项目"。模型在两个看似都权威的来源之间没有依据偏向哪个，于是按自己直觉走——直觉就是相信 cascade system prompt 的 `<workspace_layout>`。

### 修法两层都改

**改一 / 脚手架文件名换皮 不再像项目**

把 `package.json` 的 name 从 `my-project` 改成 `proxy-workspace-stub`，description 直白写「Empty placeholder created by the WindsurfAPI proxy. NOT the user project — the user's real workspace lives on the calling client」。`README.md` 第一行 `# Proxy workspace placeholder`。`.gitignore` 注释 `# proxy workspace placeholder — see README.md`。`src/index.js` 整个删掉——本来就只是用来填目录树。

LS 仍然能拿到 `package.json` + git 仓 + 文件树这三件套，fingerprint gap 不退化。但模型读到 `<workspace_layout>` 看到的不再是「Node 项目模板」，是一份每个文件都白纸黑字写着「我是代理 placeholder 不是你的项目」的目录。

**升级路径：** 老 account 已经创建过旧版 `my-project` 脚手架，靠 `existsSync()` 短路新写入。加了一个 `isLegacyScaffold()` 检查 `package.json` 的 name，不等于 `proxy-workspace-stub` 就视为旧版 → 重写 `package.json` / `README.md` / `.gitignore` + 删掉旧的 `src/index.js`，记一行 `Workspace scaffold migrated to #108 stub-labeled form`。下次 cascade init 上游重新扫，拿到的就是新内容。

**改二 / Environment facts 块加一句优先级说明**

`src/handlers/tool-emulation.js` 四个 preamble tier（full / schema-compact / skinny / compact）的 Environment facts 块统一加一句：

> Any `<workspace_information>` or `<workspace_layout>` block elsewhere in this conversation describes a placeholder directory created by the proxy infrastructure, not the user's project. Treat the path above as the authoritative working directory and use Read / Glob / Bash to discover real project contents.

措辞专门挑过——`feedback_tool_preamble_rules.md` 里 PR #51 验过 Opus 自己的 injection guard 会把"ignore prior" / "for this request only" / "[Tool-calling context]" 这种激进说法当 prompt injection 拦下来。这一句保持中性陈述句，没有一个被 ban 的词。回归测试里专门 cover 了这一点。

只在 env 实际有 cwd 注入时才加这句——没 cwd 时这句话指代不明反而误导。

### 数字

- 测试：v2.0.46 是 480 → v2.0.47 是 **490** (+10 / 0 失败)
- suites：99 → **101** (+2)
- 改动：
  - `src/client.js`: 脚手架重写 + legacy migration + readFileSync/rmSync import
  - `src/handlers/tool-emulation.js`: WORKSPACE_STUB_OVERRIDE 常量 + 四个 tier 的 env 块挂上
  - `test/workspace-stub-108.test.js`: 新文件，10 个 case

10 个新 regression 覆盖：

- 4 个 preamble tier 都带新句子
- 没 env 时不加这句（指代不明）
- 措辞不踩 PR #51 banned 列表
- 脚手架 package.json name 是 proxy-workspace-stub
- README 标题 + description 明确否认是用户项目
- legacy migration detector + log message
- 老的 my-project / Hello world / Getting Started 字串彻底从 client.js 消失（防回归）

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后第一次 cascade init 会自动 migrate 老脚手架，日志里能看到 `Workspace scaffold migrated to #108 stub-labeled form: /home/user/projects/workspace-xxx`。再让模型「分析项目」，模型应该不再去描述那个空 Node 模板，而是按 Environment facts 里的真 cwd 调 Read / Glob 读用户实际的文件。

### 已知遗留

LS 启动时如果 `_seededWorkspaces` Set 已经记过这个 path（比如热重启而非进程重启），migration 会被 in-memory cache 跳过。docker `compose up -d` 会冷启动整个容器所以没事，但 `docker exec` 里手 reload 之类的就不会触发——重启容器即可。
