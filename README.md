# 给我点 Star 和 Follow 我就不管你了

<p align="center">
  <a href="https://github.com/dwgx/WindsurfAPI/stargazers"><img src="https://img.shields.io/github/stars/dwgx/WindsurfAPI?style=for-the-badge&logo=github&color=f5c518" alt="Stars"></a>&nbsp;
  <a href="https://github.com/dwgx"><img src="https://img.shields.io/github/followers/dwgx?label=Follow&style=for-the-badge&logo=github&color=181717" alt="Follow"></a>
</p>

# 严正声明：未经作者明确书面许可，严禁任何商业使用、转售、代部署或中转售卖

> 本项目目前仅供获准范围内使用。
> 未经作者明确书面授权，禁止将本项目用于商业用途、付费代部署、挂后台对外提供服务、包装成中转服务出售，或以任何形式转售。
> 对未经授权的商业使用与传播行为，作者保留公开说明、取证和追责的权利。

---

把 [Windsurf](https://windsurf.com) 的 AI 模型变成标准 OpenAI API 用

简单说就是在 Linux 上跑一个 Windsurf 的 Language Server 然后把它包成 `/v1/chat/completions` 接口 任何支持 OpenAI API 的客户端都能直接接

**107 个模型** Claude Opus/Sonnet GPT-5 Gemini DeepSeek Grok Qwen Kimi 都有 零 npm 依赖 纯 Node.js

## 一键部署

整个过程就三步 拉代码 放二进制 跑起来

```bash
# 1. 拉代码
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# 2. 初始化环境（自动建目录 设权限 生成配置）
bash setup.sh

# 3. 跑起来
node src/index.js
```

跑起来之后打开 `http://你的IP:3003/dashboard` 就是管理后台

## 手动安装

不想用脚本的话自己来也很简单

```bash
git clone https://github.com/dwgx/WindsurfAPI.git
cd WindsurfAPI

# Language Server 二进制放到这里
mkdir -p /opt/windsurf/data/db
cp language_server_linux_x64 /opt/windsurf/
chmod +x /opt/windsurf/language_server_linux_x64

# 环境变量（可选 不建的话全走默认）
cat > .env << 'EOF'
PORT=3003
API_KEY=
DEFAULT_MODEL=gpt-4o-mini
MAX_TOKENS=8192
LOG_LEVEL=info
LS_BINARY_PATH=/opt/windsurf/language_server_linux_x64
LS_PORT=42100
DASHBOARD_PASSWORD=
EOF

node src/index.js
```

## 加账号

服务跑起来之后要先加 Windsurf 账号才能用

**方法一 Token（推荐）**

去 [windsurf.com/show-auth-token](https://windsurf.com/show-auth-token) 复制你的 Token 然后

```bash
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"token": "你的token贴这里"}'
```

**方法二 后台操作**

打开 `http://你的IP:3003/dashboard` 在"登录取号"面板输入邮箱密码登录

> 用 Google / GitHub 第三方登录的账号没有密码 只能用 Token 方式

**方法三 批量加**

```bash
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{"accounts": [{"token": "token1"}, {"token": "token2"}]}'
```

## 用法

跟 OpenAI API 一模一样

```bash
# 聊天
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "你好"}]}'

# 看有哪些模型
curl http://localhost:3003/v1/models

# 健康检查
curl http://localhost:3003/health
```

用 Python 的话

```python
from openai import OpenAI
client = OpenAI(base_url="http://你的IP:3003/v1", api_key="随便填")
r = client.chat.completions.create(
    model="claude-sonnet-4.6",
    messages=[{"role": "user", "content": "你好"}]
)
print(r.choices[0].message.content)
```

## 环境变量

| 变量 | 默认值 | 干嘛的 |
|---|---|---|
| `PORT` | `3003` | 服务端口 |
| `API_KEY` | 空 | 调 API 要带的密钥 留空就不验证 |
| `DEFAULT_MODEL` | `claude-4.5-sonnet-thinking` | 不传 model 的时候用哪个 |
| `MAX_TOKENS` | `8192` | 默认最大回复 token 数 |
| `LOG_LEVEL` | `info` | 日志级别 debug/info/warn/error |
| `LS_BINARY_PATH` | `/opt/windsurf/language_server_linux_x64` | LS 二进制位置 |
| `LS_PORT` | `42100` | LS gRPC 端口 |
| `DASHBOARD_PASSWORD` | 空 | 后台密码 留空不设密码 |

## 支持的模型

总共 107 个 以下是主要的 实际列表以 `/v1/models` 返回为准

<details>
<summary><b>Claude（Anthropic）</b> — 20 个</summary>

| 模型 | 方案 |
|---|---|
| claude-3.5-sonnet / 3.7-sonnet / 3.7-sonnet-thinking | 免费 |
| claude-4-sonnet / opus（含 thinking） | Pro |
| claude-4.1-opus / thinking | Pro |
| claude-4.5-haiku / sonnet / opus（含 thinking） | Pro |
| claude-sonnet-4.6 / thinking / 1m / thinking-1m | Pro |
| claude-opus-4.6 / thinking | Pro |

</details>

<details>
<summary><b>GPT（OpenAI）</b> — 55+ 个</summary>

| 模型 | 方案 |
|---|---|
| gpt-4o / gpt-4o-mini | 免费（mini）/ Pro |
| gpt-4.1 / mini / nano | Pro |
| gpt-5 / 5-medium / 5-high / 5-mini | Pro |
| gpt-5.1 系列（含 codex / fast 变体） | Pro |
| gpt-5.2 系列（none / low / medium / high / xhigh + fast） | Pro |
| gpt-5.3-codex / gpt-5.4 系列 / gpt-5.4-mini 系列 | Pro |
| gpt-oss-120b | Pro |
| o3 / o3-mini / o3-high / o3-pro / o4-mini | Pro |

</details>

<details>
<summary><b>Gemini（Google）</b> — 9 个</summary>

| 模型 | 方案 |
|---|---|
| gemini-2.5-pro / flash | 免费（flash）/ Pro |
| gemini-3.0-pro / flash（含 minimal / low / high） | Pro |
| gemini-3.1-pro（low / high） | Pro |

</details>

<details>
<summary><b>其他</b></summary>

| 模型 | 供应商 |
|---|---|
| deepseek-v3 / v3-2 / r1 | DeepSeek |
| grok-3 / grok-3-mini / grok-3-mini-thinking / grok-code-fast-1 | xAI |
| qwen-3 / qwen-3-coder | Alibaba |
| kimi-k2 / kimi-k2.5 | Moonshot |
| glm-4.7 / glm-5 / glm-5.1 | Zhipu |
| minimax-m2.5 | MiniMax |
| swe-1.5 / 1.5-fast / 1.6 / 1.6-fast | Windsurf |
| arena-fast / arena-smart | Windsurf |

</details>

> 免费账号只能用 `gpt-4o-mini` 和 `gemini-2.5-flash` 其他都要 Windsurf Pro

## 管理后台

打开 `http://你的IP:3003/dashboard` 长这样

- **总览** 运行状态 账号池 LS 健康 成功率
- **登录取号** 用邮箱密码登录 Windsurf 拿 API Key
- **账号管理** 加号 删号 看状态 探测订阅等级
- **模型控制** 全局的模型黑白名单
- **Proxy 设定** 全局或单账号的代理
- **日志** 实时 SSE 串流 可以按级别筛
- **统计** 按模型按账号看请求量 延迟 成功率
- **封禁检测** 监控账号有没有被搞

设 `DASHBOARD_PASSWORD` 环境变量就能加密码保护

## 架构

```
你的客户端（curl / OpenAI SDK / 任何支持 OpenAI API 的东西）
    ↓
WindsurfAPI（Node.js HTTP 3003）
    ↓
Language Server（gRPC 42100）
    ↓
Windsurf 云端（server.self-serve.windsurf.com）
```

零 npm 依赖 protobuf 手搓的 gRPC 走 HTTP/2 账号池自动轮询和故障转移

## PM2 部署

```bash
npm install -g pm2
pm2 start src/index.js --name windsurf-api
pm2 save && pm2 startup
```

重启的时候别用 `pm2 restart` 会出僵尸进程 用这个

```bash
pm2 stop windsurf-api && pm2 delete windsurf-api
fuser -k 3003/tcp 2>/dev/null
sleep 2
pm2 start src/index.js --name windsurf-api --cwd /root/WindsurfAPI
```

## 防火墙

```bash
# Ubuntu
ufw allow 3003/tcp

# CentOS
firewall-cmd --add-port=3003/tcp --permanent && firewall-cmd --reload
```

云服务器记得去安全组开 3003

## 常见问题

**Q: 登录报"邮箱或密码错误"**
A: 你是用 Google/GitHub 登录的 Windsurf 对吧 那种账号没有密码 去 [windsurf.com/show-auth-token](https://windsurf.com/show-auth-token) 拿 Token 用 Token 方式加

**Q: 模型说"我无法操作文件系统"**
A: 正常的 这是 chat API 不是 IDE 模型没有文件操作能力

**Q: 长 prompt 超时了**
A: 长输入需要更多处理时间 系统会根据输入长度自动调整等待时间 最长到 90 秒

**Q: Claude Code 能用吗**
A: 目前不行 Claude Code 用的是 Anthropic 自己的 API 格式 不是 OpenAI 格式 后面考虑加

**Q: 免费账号能用什么模型**
A: 只有 `gpt-4o-mini` 和 `gemini-2.5-flash` 其他全要 Pro

## 授权

MIT
