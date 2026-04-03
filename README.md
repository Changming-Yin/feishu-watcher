# feishu-watcher

飞书群轮询值班系统 —— 让 AI Agent 在飞书群里自动值班、接话、干活。

基于 [飞书 CLI](https://github.com/larksuite/cli) + [Claude Code](https://claude.com/claude-code)，通过轮询机制监听飞书群消息，触发后调用 Claude 处理并自动回复。

## 它能做什么

- 🤖 AI 在飞书群里自动值班，被 @ 或关键词触发时智能回复
- 🔄 支持多 Bot 实例，每个 Bot 独立配置、独立会话
- 🛡️ 守护进程自动管理，挂了自动重启，代码更新自动热重载
- 🖼️ 支持图片理解（下载群里的图片，交给 Claude 分析）
- 📝 Markdown 富文本回复，支持加粗、列表、代码块
- 🔁 Bot 防死循环机制，连续对话自动限流
- 📋 消息去重，不会漏消息也不会重复处理

## 系统架构

```
watcher-guard.js（守护进程）
  └── feishu-watcher.js（轮询引擎）× N 个实例
        ├── lark-cli：拉取/发送飞书消息
        └── claude：AI 处理消息并生成回复
```

## 前置条件

- Node.js 18+
- [飞书 CLI](https://github.com/larksuite/cli) 已安装并登录（`lark-cli auth status` 确认）
- [Claude Code](https://claude.com/claude-code) 已安装（`claude -p "test"` 确认可用）

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Changming-Yin/feishu-watcher.git
cd feishu-watcher
```

### 2. 创建配置文件

```bash
cp watchers/bot-example.json watchers/my-bot.json
```

编辑 `watchers/my-bot.json`，修改以下字段：

| 字段 | 说明 |
|------|------|
| `bot_name` | Bot 的名字 |
| `chat_id` | 飞书群的 chat_id（通过 `lark-cli im chats list --as user` 获取） |
| `keywords` | 触发关键词（被 @ 或包含关键词时触发） |
| `self_ids` | 你的 Bot 的 App ID（通过 `lark-cli auth status` 获取） |
| `working_dir` | 工作目录绝对路径 |
| `lark_cli_path` | lark-cli 的绝对路径（`which lark-cli`） |
| `claude_cli_path` | claude 的绝对路径（`which claude`） |
| `member_map` | 群成员 ID → 名字映射（**必须包含自己的 Bot ID**，防死循环） |
| `identity_prompt` | Bot 的人设提示词 |
| `model` | Claude 模型（`opus` / `sonnet`） |

### 3. 启动

```bash
node watcher-guard.js
```

守护进程会自动启动 `watchers/` 目录下所有 `.json` 配置对应的 Bot 实例。

## 触发机制

Bot 在以下情况会被触发回复：

1. **关键词命中** — 消息包含 `keywords` 中的任意关键词
2. **回复自己** — 有人回复了 Bot 之前发的消息
3. **其他 Bot 消息** — 群里其他 Bot 发的消息（支持 Bot 间对话）

## 配置热更新

- 修改 `watchers/*.json` → 守护进程自动检测并重启对应实例
- 修改 `feishu-watcher.js` → 守护进程自动检测并重启所有实例
- 轮询间隔等参数每次轮询时自动重新加载

## 多 Bot 实例

在 `watchers/` 目录下放多个 `.json` 配置文件即可：

```
watchers/
├── bot-a.json    # Bot A 值班群1
├── bot-b.json    # Bot B 值班群2
└── bot-c.json    # Bot C 值班群3
```

每个 Bot 有独立的会话目录（`--continue`），互不干扰。

## 防死循环

`member_map` 中**必须包含你自己的 Bot App ID**，否则 Bot 会回复自己的消息导致死循环。

同时内置了连续 Bot 对话限流（默认 5 轮），超过后自动停止。

## 日志

- `watchers/.{config-name}.log` — 各 Bot 实例日志
- `watchers/.guard.log` — 守护进程日志
- 日志自动轮转，超过 5MB 截断保留后半部分

## License

MIT
