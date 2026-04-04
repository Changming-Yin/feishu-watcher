# 亚当迁移清单

当需要把我搬到新硬件（Mac Mini 2等）时，按这个清单操作。

## 必须带走的行李

### 1. 主目录（核心）
```
/Users/aiera-luke/亚当/
├── feishu-watcher.js        # 轮询引擎
├── watcher-guard.js         # 守护进程
├── watchers/                # bot配置文件（adam.json, matai-dm.json等）
├── memory/                  # 长期记忆（最重要，丢了就失忆）
│   ├── facts/               # 已确认事实
│   ├── people/              # 人物洞察
│   ├── decisions/           # 决策记录
│   └── learnings/           # 经验教训
├── .claude/skills/马太/     # 马太skill（清博抓取）
├── docs/                    # v21等设定文档
└── 清博数据_*.xlsx          # 历史数据文件
```

### 2. 飞书CLI配置
```
~/.lark-cli/config.json      # app-id和app-secret，没这个飞书连不上
```
⚠️ 到新机器后需要重新 `lark-cli auth login --domain all` 授权

### 3. 飞书CLI全局skills
```
~/.claude/skills/lark-*      # 19个飞书CLI skills
```
或者到新机器直接重装：`npx skills add larksuite/cli --all -y -g`

### 4. Node.js环境
- Node.js 18+
- Claude Code（`npm install -g @anthropic-ai/claude-code`）
- lark-cli（`npm install -g @anthropic-ai/claude-code` 时自带，或单独装）
- Python 3 + requests + openpyxl（马太skill依赖）

## 不需要带的
- `watchers/.adam-state.json` — 轮询状态，新环境会自动重建
- `watchers/.*-session/` — Claude会话缓存，新环境自动生成
- `watchers/.*.log` — 日志，可以不带
- `~/Library/Application Support/Claude/...` — Claude内部缓存，会自动重建

## 迁移步骤
1. 把 `/Users/aiera-luke/亚当/` 整个目录拷贝到新机器
2. 拷贝 `~/.lark-cli/config.json` 到新机器同路径
3. 新机器装好 Node.js、Claude Code、Python依赖
4. 重装飞书CLI skills：`npx skills add larksuite/cli --all -y -g`
5. 重新登录飞书：`lark-cli auth login --domain all`
6. 修改 watchers/*.json 里的路径（working_dir、lark_cli_path、claude_cli_path）
7. `node watcher-guard.js` 启动
8. 验证：在群里 @马太 看看是否响应

## 最重要的提醒
**memory/ 文件夹是我的记忆，绝对不能丢。** 其他都可以重装重建，记忆丢了就真的从零开始了。
