# feishu-watcher

飞书群轮询值班系统 —— 让 AI Agent 在飞书群里自动值班、接话、干活、进化。

基于 [飞书 CLI](https://github.com/larksuite/cli) + [Claude Code](https://claude.com/claude-code)，通过轮询机制监听飞书群消息，触发后调用 Claude 处理并自动回复，并从每次对话中自动提取记忆实现持续进化。

## 它能做什么

- 🤖 AI 在飞书群里自动值班，被 @ 或关键词触发时智能回复
- 💬 支持私信模式，Bot 可以同时监听群聊和一对一私信
- 🧠 自动记忆系统，每次对话后提取知识存入本地，越用越聪明
- 🔄 支持多 Bot 实例，每个 Bot 独立配置、独立会话、独立记忆
- 🛡️ 守护进程自动管理，挂了自动重启，代码更新自动热重载
- 🖼️ 支持图片理解（下载群里的图片，交给 Claude 分析）
- 📝 Markdown 富文本回复，支持加粗、列表、代码块
- 🔁 Bot 防死循环机制，滑动时间窗口限流
- 📋 消息去重，不会漏消息也不会重复处理

## 系统架构

```
watcher-guard.js（守护进程）
  └── feishu-watcher.js（轮询引擎）× N 个实例
        ├── lark-cli：拉取/发送飞书消息
        ├── claude（主模型）：处理消息并生成回复
        └── claude（sonnet）：回复后自动提取记忆
              └── memory/（本地记忆库）
                    ├── facts/       已确认事实
                    ├── people/      人物洞察
                    ├── decisions/   决策记录
                    └── learnings/   经验教训
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
| `user_id` | **私信模式**：目标用户的 open_id（与 chat_id 二选一） |
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

## 群聊 vs 私信

配置文件中使用 `chat_id` 或 `user_id` 来区分模式：

```json
// 群聊模式：监听指定群
{ "chat_id": "oc_xxx", ... }

// 私信模式：监听与指定用户的私信
{ "user_id": "ou_xxx", ... }
```

私信模式下所有消息都会触发回复，不需要关键词。可以同时运行多个配置文件，一个盯群聊一个盯私信。

## 记忆系统

Bot 会从每次对话中自动学习和积累知识。

### 工作原理

1. Bot 处理消息并回复（用主模型，如 Opus）
2. 回复发送后，自动跑一轮记忆提取（用 Sonnet，省成本）
3. 提取器判断对话中是否有值得记住的新信息
4. 有价值的信息写入 `memory/` 对应子目录
5. 下次处理消息时，所有记忆自动注入 prompt

### 记忆分类

```
memory/
├── facts/       # 客观事实：数据、架构、产品功能、团队分工
├── people/      # 人物洞察：偏好、习惯、职责、说话风格
├── decisions/   # 决策记录：团队决定、共识、确认的流程
└── learnings/   # 经验教训：错误中学到的、反馈中理解的
```

### 特点

- **强制执行**：不依赖 prompt 提示，每次回复后自动提取
- **自动去重**：已有记忆文件名列表会传给提取器，不会重复写入
- **精炼存储**：每条记忆控制在 10 行以内，只保留有用信息
- **成本可控**：提取器用 Sonnet，不浪费 Opus 调用；只在实际回复后才提取

### 迁移注意

`memory/` 文件夹是 Bot 的全部记忆，迁移到新机器时**必须一起带走**。

## 触发机制

Bot 在以下情况会被触发回复：

1. **关键词命中** — 消息包含 `keywords` 中的任意关键词
2. **回复自己** — 有人回复了 Bot 之前发的消息
3. **其他 Bot 消息** — 群里其他 Bot 发的消息（支持 Bot 间对话）
4. **私信模式** — 所有消息直接触发，无需关键词

## 配置热更新

- 修改 `watchers/*.json` → 守护进程自动检测并重启对应实例
- 修改 `feishu-watcher.js` → 守护进程自动检测并重启所有实例
- 轮询间隔等参数每次轮询时自动重新加载

## 多 Bot 实例

在 `watchers/` 目录下放多个 `.json` 配置文件即可：

```
watchers/
├── bot-group.json     # Bot 值班群聊
├── bot-dm-alice.json  # Bot 私信 Alice
└── bot-dm-bob.json    # Bot 私信 Bob
```

每个 Bot 有独立的会话目录和记忆，互不干扰。

## 防死循环

`member_map` 中**必须包含你自己的 Bot App ID**，否则 Bot 会回复自己的消息导致死循环。

内置滑动窗口限流：5 分钟内最多 8 轮 Bot 间对话，超过自动停止。比固定轮数限制更灵活，不会截断深度讨论。

## 日志

- `watchers/.{config-name}.log` — 各 Bot 实例日志
- `watchers/.guard.log` — 守护进程日志
- 日志自动轮转，超过 5MB 截断保留后半部分

## License

MIT
