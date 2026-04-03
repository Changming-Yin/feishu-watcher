/**
 * 飞书群值班监控 - 通用版
 * 通过配置文件驱动，可裂变出任意数量的值班实例
 *
 * 用法: node feishu-watcher.js <config.json>
 * 示例: node feishu-watcher.js watchers/bot-r.json
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ========== 读取配置 ==========
const configPath = process.argv[2];
if (!configPath) {
  console.error('用法: node feishu-watcher.js <config.json>');
  console.error('示例: node feishu-watcher.js watchers/bot-r.json');
  process.exit(1);
}

const configFile = path.resolve(configPath);
if (!fs.existsSync(configFile)) {
  console.error(`配置文件不存在: ${configFile}`);
  process.exit(1);
}

// 状态和日志文件
const configDir = path.dirname(configFile);
const configName = path.basename(configFile, '.json');
const STATE_FILE = path.join(configDir, `.${configName}-state.json`);
const LOG_FILE = path.join(configDir, `.${configName}.log`);

// 会话隔离目录：每个watcher实例用独立目录保持Claude会话连续性（--continue）
const SESSION_DIR = path.join(configDir, `.${configName}-session`);
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ========== 配置热更新 ==========

let CHAT_ID, BOT_NAME, SELF_NAMES, SELF_IDS, KEYWORDS, POLL_INTERVAL, PAGE_SIZE;
let MODEL, IDENTITY_PROMPT;
let WORKING_DIR, LARK_CLI, CLAUDE_CLI, MEMBER_MAP;

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  CHAT_ID = config.chat_id;
  BOT_NAME = config.bot_name || '值班机器人';
  SELF_NAMES = config.self_names || [BOT_NAME];
  SELF_IDS = new Set(config.self_ids || []);
  KEYWORDS = config.keywords || [BOT_NAME];
  PAGE_SIZE = config.page_size || 20;
  MODEL = config.model || 'sonnet';
  IDENTITY_PROMPT = config.identity_prompt || `你是${BOT_NAME}，一个飞书群值班机器人。`;
  WORKING_DIR = config.working_dir || process.cwd();
  LARK_CLI = config.lark_cli_path || 'lark-cli';
  CLAUDE_CLI = config.claude_cli_path || 'claude';
  MEMBER_MAP = config.member_map || {};

  const newInterval = (config.poll_interval_seconds || 60) * 1000;
  if (POLL_INTERVAL !== undefined && newInterval !== POLL_INTERVAL) {
    log(`轮询间隔变更: ${POLL_INTERVAL / 1000}秒 → ${newInterval / 1000}秒`);
    // setTimeout 模式下，下一轮 schedulePoll 自动使用新间隔，无需额外操作
  }
  POLL_INTERVAL = newInterval;
}

let pollTimer = null;
loadConfig();

// ========== 工具函数 ==========

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const line = `[${ts}] [${BOT_NAME}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
  // 日志轮转：超过 5MB 时截断保留后半部分
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, content.slice(content.length / 2));
    }
  } catch {}
}

// 状态管理：基于时间戳 + 已处理消息ID去重
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastPollTime: null, processedIds: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function larkCli(...args) {
  try {
    const raw = execFileSync(LARK_CLI, args, {
      encoding: 'utf8',
      timeout: 30000
    });
    return JSON.parse(raw);
  } catch (e) {
    log(`lark-cli 异常: ${e.message.substring(0, 200)}`);
    return { ok: false, error: e.message };
  }
}

function larkCliReply(messageId, text) {
  try {
    // 使用 execFileSync 不走 shell，直接把 markdown 内容作为参数传入
    // execFileSync 无 shell 时不存在特殊字符转义问题，参数长度限制约 256KB 足够
    const raw = execFileSync(LARK_CLI, [
      'im', '+messages-reply',
      '--message-id', messageId,
      '--as', 'bot',
      '--markdown', text
    ], { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(raw);
  } catch (e) {
    log(`lark-cli 回复异常: ${e.message.substring(0, 200)}`);
    // 回退：截取前2000字符用 text 方式发送
    try {
      const raw = execFileSync(LARK_CLI, [
        'im', '+messages-reply',
        '--message-id', messageId,
        '--as', 'bot',
        '--text', text.substring(0, 2000)
      ], { encoding: 'utf8', timeout: 30000 });
      return JSON.parse(raw);
    } catch (e2) {
      log(`lark-cli 回退回复也失败: ${e2.message.substring(0, 200)}`);
      return { ok: false, error: e2.message };
    }
  }
}

// ========== 图片处理 ==========

function downloadImage(messageId, imageKey) {
  try {
    const imgDir = path.join(WORKING_DIR, '.watcher-images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

    const outputName = `${imageKey}.png`;
    const outputPath = path.join(imgDir, outputName);
    if (fs.existsSync(outputPath)) return outputPath;

    execFileSync(LARK_CLI, [
      'im', '+messages-resources-download',
      '--message-id', messageId,
      '--file-key', imageKey,
      '--type', 'image',
      '--output', outputName,
      '--as', 'bot'
    ], { encoding: 'utf8', timeout: 30000, cwd: imgDir });

    return fs.existsSync(outputPath) ? outputPath : null;
  } catch (e) {
    log(`图片下载失败: ${e.message.substring(0, 100)}`);
    return null;
  }
}

function extractImageKey(content) {
  const match = content.match(/\[Image:\s*(img_[^\]]+)\]/);
  return match ? match[1] : null;
}

// ========== 触发判断 ==========

function quickFilter(text) {
  const lowerText = text.toLowerCase();
  return KEYWORDS.some(kw => lowerText.includes(kw.toLowerCase()));
}

function isReplyToSelf(msg, allMessages) {
  if (!msg.reply_to) return false;
  const repliedMsg = allMessages.find(m => m.message_id === msg.reply_to);
  return repliedMsg ? isSelfMessage(repliedMsg) : false;
}

function isSelfMessage(msg) {
  const senderId = msg.sender?.id || '';
  // 优先用 sender_id 精确匹配（最可靠，不依赖 name）
  if (SELF_IDS.size > 0 && SELF_IDS.has(senderId)) return true;
  // 兜底：用 name 匹配
  const senderName = msg.sender?.name || MEMBER_MAP[senderId] || '';
  const senderType = msg.sender?.sender_type || '';
  return senderType === 'app' && senderName && SELF_NAMES.some(n => senderName.includes(n));
}

// ========== Bot连续对话限流 ==========
const BOT_LOOP_LIMIT = 5;

function isBotLooping(msg, allMessages) {
  const senderType = msg.sender?.sender_type || '';
  if (senderType !== 'app') return false;

  const idx = allMessages.findIndex(m => m.message_id === msg.message_id);
  if (idx < 0) return false;

  let botStreak = 0;
  for (let i = idx - 1; i >= 0 && i >= idx - BOT_LOOP_LIMIT; i--) {
    if (allMessages[i].sender?.sender_type === 'app') botStreak++;
    else break;
  }
  return botStreak >= BOT_LOOP_LIMIT;
}

// ========== 构建上下文字符串 ==========

function buildContext(allMessages, currentMsgId, count) {
  if (count <= 0) return '';
  const idx = allMessages.findIndex(m => m.message_id === currentMsgId);
  if (idx <= 0) return '';

  const contextMsgs = allMessages.slice(Math.max(0, idx - count), idx);
  if (contextMsgs.length === 0) return '';

  const lines = contextMsgs.map(m => {
    const sid = m.sender?.id || '';
    const sname = m.sender?.name || MEMBER_MAP[sid] || '未知';
    const stype = m.sender?.sender_type || '';
    const label = (stype === 'app' && SELF_NAMES.some(n => sname.includes(n))) ? `${BOT_NAME}(你自己)` : sname;
    return `[${label}]: ${(m.content || '').substring(0, 300)}`;
  });

  return `\n\n--- 最近的对话上下文（共${lines.length}条） ---\n${lines.join('\n')}\n--- 上下文结束 ---`;
}

// ========== Claude会话处理 ==========

function handleWithClaude(senderName, text, messageId, imagePath, contextStr) {
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `${IDENTITY_PROMPT}

现在是 ${today}。
${contextStr}
飞书群里有人发了一条消息：
发送人：${senderName}
内容：${text}

请你处理这条消息。

规则：
1. 直接输出你要回复的内容，不要调用lark-cli，不要执行发送命令——系统会自动帮你发送
2. 如果与你无关或不需要回复，只输出"[跳过]"
3. 只输出一段回复内容，不要输出多段、不要输出思考过程
4. 回复要简洁自然

${imagePath ? `这条消息附带了一张图片，已下载到本地：${imagePath.replace(/\\/g, '/')}
请用Read工具读取这个图片文件来查看内容，然后基于图片内容回复。` : ''}

工作目录是 ${WORKING_DIR.replace(/\\/g, '/')}，如果需要读写文件或执行命令可以使用。`;

  try {
    log(`→ 启动Claude Code会话处理...`);
    const tmpFile = path.join(os.tmpdir(), `${configName}-prompt.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf8');
    const tmpPath = tmpFile.replace(/\\/g, '/');

    const response = execSync(`cat "${tmpPath}" | "${CLAUDE_CLI}" -p --continue --dangerously-skip-permissions --model ${MODEL}`, {
      encoding: 'utf8',
      timeout: 300000,
      shell: 'bash',
      cwd: SESSION_DIR
    });

    const output = response.trim();

    if (output.includes('[跳过]')) {
      log(`→ Claude判断不需要回复`);
      return;
    }

    log(`→ Claude处理完成: ${output.substring(0, 100)}...`);
    log(`→ 发送回复`);
    larkCliReply(messageId, output);
  } catch (e) {
    log(`Claude会话异常: ${e.message.substring(0, 200)}`);
  }
}

// ========== 处理单条消息 ==========

function processOneMessage(msg, allMessages) {
  const senderId = msg.sender?.id || '';
  const senderName = msg.sender?.name || MEMBER_MAP[senderId] || '';

  const text = msg.content || '';
  if (!text.trim()) return;

  log(`处理消息 [${senderName}]: ${text.substring(0, 80)}`);

  const keywordHit = quickFilter(text);
  const replyHit = isReplyToSelf(msg, allMessages);
  const senderType = msg.sender?.sender_type || '';
  const isBotMsg = senderType === 'app' && !isSelfMessage(msg);

  if (!keywordHit && !replyHit && !isBotMsg) {
    log(`→ 未触发，跳过`);
    return;
  }

  const triggerReason = keywordHit ? '关键词命中' : replyHit ? '回复自己消息' : `bot消息(${senderName})`;
  log(`→ 触发（${triggerReason}）`);

  if (isBotLooping(msg, allMessages)) {
    log(`→ Bot连续对话已达${BOT_LOOP_LIMIT}轮，跳过防循环`);
    return;
  }

  // 图片处理
  let imagePath = null;
  let replyContext = '';
  const imageKey = extractImageKey(text);
  if (imageKey) {
    imagePath = downloadImage(msg.message_id, imageKey);
  } else if (msg.reply_to) {
    const repliedMsg = allMessages.find(m => m.message_id === msg.reply_to);
    if (repliedMsg) {
      const repliedImageKey = extractImageKey(repliedMsg.content || '');
      if (repliedImageKey) {
        imagePath = downloadImage(repliedMsg.message_id, repliedImageKey);
      } else {
        replyContext = `\n（此消息是回复另一条消息，被回复的内容是：「${repliedMsg.content || ''}」）`;
      }
    }
  }

  // 取最近3条作为即时上下文，会话记忆由 --continue 维持
  const contextStr = buildContext(allMessages, msg.message_id, 3);
  handleWithClaude(senderName, text + replyContext, msg.message_id, imagePath, contextStr);
}

// ========== 主循环 ==========

function poll() {
  try { loadConfig(); } catch (e) { log(`配置加载失败: ${e.message.substring(0, 100)}`); }
  log('--- 开始轮询 ---');

  const state = loadState();

  const result = larkCli('im', '+chat-messages-list', '--chat-id', CHAT_ID, '--as', 'bot', '--page-size', String(PAGE_SIZE));
  if (!result.ok) {
    const errStr = JSON.stringify(result).substring(0, 300);
    log(`拉取消息失败: ${errStr}`);
    // 检测 auth 过期，输出醒目告警
    if (errStr.includes('token') || errStr.includes('auth') || errStr.includes('expired') || errStr.includes('99991663') || errStr.includes('99991664')) {
      log(`⚠️ 疑似 AUTH TOKEN 过期，请执行: lark-cli auth login --recommend`);
    }
    return;
  }

  const messages = result.data?.messages || [];
  if (messages.length === 0) {
    log('没有消息');
    return;
  }

  messages.sort((a, b) => (a.create_time || '').localeCompare(b.create_time || ''));

  // 基于时间戳过滤新消息，用 message_id 去重（解决分钟级精度丢消息问题）
  const lastTime = state.lastPollTime;
  const processedIds = new Set(state.processedIds || []);
  let newMessages;

  if (!lastTime) {
    // 首次运行：记录当前最新时间，不处理历史消息
    const latestTime = messages[messages.length - 1].create_time;
    const allIds = messages.map(m => m.message_id);
    log(`首次运行，记录时间基线: ${latestTime}，共 ${messages.length} 条历史消息`);
    saveState({ lastPollTime: latestTime, processedIds: allIds });
    log('--- 轮询结束 ---\n');
    return;
  }

  // 取时间戳 >= 上次轮询时间的消息，再用 processedIds 排除已处理的
  newMessages = messages.filter(m => (m.create_time || '') >= lastTime && !processedIds.has(m.message_id));
  log(`发现 ${newMessages.length} 条新消息`);

  const newProcessedIds = [];
  for (const msg of newMessages) {
    newProcessedIds.push(msg.message_id);
    if (isSelfMessage(msg)) {
      log(`跳过自己发的消息`);
      continue;
    }
    processOneMessage(msg, messages);
  }

  // 更新时间戳和已处理ID（只保留最近100条ID防止无限增长）
  if (messages.length > 0) {
    const latestTime = messages[messages.length - 1].create_time;
    const allProcessed = [...processedIds, ...newProcessedIds].slice(-100);
    saveState({ lastPollTime: latestTime, processedIds: allProcessed });
  }

  log('--- 轮询结束 ---\n');
}

// ========== 启动 ==========
log('========================================');
log(`${BOT_NAME} 值班监控启动`);
log(`群: ${CHAT_ID}`);
log(`关键词: ${KEYWORDS.join(', ')}`);
log(`模型: ${MODEL}`);
log(`会话目录: ${SESSION_DIR}`);
log(`轮询间隔: ${POLL_INTERVAL / 1000}秒`);
log('========================================');

// 使用 setTimeout 递归代替 setInterval，防止 Claude 处理耗时导致轮询堆积
function schedulePoll() {
  poll();
  pollTimer = setTimeout(schedulePoll, POLL_INTERVAL);
}
schedulePoll();

// ========== 进程守护 ==========
process.on('uncaughtException', (err) => {
  log(`未捕获异常: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`未处理Promise拒绝: ${String(reason).substring(0, 200)}`);
});

process.on('SIGINT', () => { log(`${BOT_NAME} 下班`); process.exit(0); });
process.on('SIGTERM', () => { log(`${BOT_NAME} 下班`); process.exit(0); });
