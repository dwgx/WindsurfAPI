<!-- 感谢贡献 / Thanks for contributing -->

## 改了什么 / What changed

<!-- 一两句话说明 / One or two sentences -->

## 为什么 / Why

<!-- 修哪个 bug 加哪个功能 关联 issue #xx / Which bug / feature / issue does this address? -->

## 测试 / Testing

<!-- 怎么验证改对了 / How did you verify it works?
     例子 / examples:
     - curl -X POST localhost:3003/v1/chat/completions -d '...' 返回了正确的 ...
     - dashboard 面板手动点了 ...
     - 没跑自动测试（项目暂无测试套件） -->

## Checklist

- [ ] 代码风格和现有文件一致 / Code style matches existing files
- [ ] 没有引入 npm 依赖 / No new npm dependencies (project is zero-dep)
- [ ] 涉及 LS binary 协议时 同步更新了 CLAUDE.md / Updated CLAUDE.md if LS protocol assumptions changed
- [ ] 涉及 dashboard UI 用 App.confirm / App.prompt 不用浏览器原生 alert/confirm / Uses App.confirm / App.prompt, not native dialogs (if dashboard)
