/**
 * 飞书Watcher守护进程
 *
 * 职责：确保所有watcher实例永远在线
 * - 每5秒检查一次子进程状态
 * - 进程退出自动重启
 * - 监听引擎代码变化，所有实例一起重启
 * - 网络中断、异常崩溃都能恢复
 *
 * 用法: node watcher-guard.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WATCHERS_DIR = path.join(ROOT, 'watchers');
const ENGINE = path.join(ROOT, 'feishu-watcher.js');
const LOG_FILE = path.join(WATCHERS_DIR, '.guard.log');
const CHECK_INTERVAL = 5000;
const RESTART_DELAY = 3000;

let restarting = false;

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const line = `[${ts}] [守护] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function scanConfigs() {
  return fs.readdirSync(WATCHERS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.'))
    .map(f => path.join(WATCHERS_DIR, f));
}

const children = new Map();

function startWatcher(configPath) {
  const name = path.basename(configPath, '.json');
  const existing = children.get(configPath);
  if (existing && !existing.killed && existing.exitCode === null) return;

  const child = spawn('node', [ENGINE, configPath], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true
  });

  // 将子进程 stdout 写入各自的日志文件（watcher 自己也会写，这里做备份）
  const childLogFile = path.join(WATCHERS_DIR, `.${name}-stdout.log`);
  child.stdout?.on('data', (data) => {
    fs.appendFileSync(childLogFile, data.toString());
  });
  child.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('DeprecationWarning')) {
      log(`[${name}] stderr: ${msg.substring(0, 200)}`);
    }
  });

  child.on('exit', (code, signal) => {
    log(`[${name}] 进程退出 (code=${code}, signal=${signal})`);
    children.delete(configPath);
  });

  child.on('error', (err) => {
    log(`[${name}] 进程异常: ${err.message}`);
    children.delete(configPath);
  });

  children.set(configPath, child);
  log(`[${name}] 已启动 (PID: ${child.pid})`);
}

function stopAll() {
  for (const [configPath, child] of children.entries()) {
    const name = path.basename(configPath, '.json');
    if (child && !child.killed) {
      log(`[${name}] 停止...`);
      child.kill('SIGTERM');
    }
  }
  children.clear();
}

function restartAll(reason) {
  if (restarting) return;
  restarting = true;
  log(`全部重启: ${reason}`);
  stopAll();
  setTimeout(() => {
    const configs = scanConfigs();
    for (const configPath of configs) {
      startWatcher(configPath);
    }
    restarting = false;
  }, RESTART_DELAY);
}

function healthCheck() {
  if (restarting) return;
  const configs = scanConfigs();

  for (const configPath of configs) {
    const name = path.basename(configPath, '.json');
    const child = children.get(configPath);
    if (!child || child.killed || child.exitCode !== null) {
      log(`[${name}] 检测到未运行，启动...`);
      children.delete(configPath);
      startWatcher(configPath);
    }
  }

  for (const [configPath, child] of [...children.entries()]) {
    if (!configs.includes(configPath)) {
      log(`[${path.basename(configPath, '.json')}] 配置已删除，停止进程`);
      if (child && !child.killed) child.kill('SIGTERM');
      children.delete(configPath);
    }
  }
}

// 监听引擎代码变化
fs.watchFile(ENGINE, { interval: 3000 }, (curr, prev) => {
  if (curr.mtimeMs !== prev.mtimeMs) {
    restartAll('引擎代码更新');
  }
});

// 监听配置文件变化（新增/修改/删除）
fs.watch(WATCHERS_DIR, (eventType, filename) => {
  if (filename && filename.endsWith('.json') && !filename.startsWith('.') && !filename.startsWith('_')) {
    log(`配置文件变化: ${filename} (${eventType})`);
    restartAll(`配置文件变化: ${filename}`);
  }
});

log('========================================');
log('守护进程启动');
const configs = scanConfigs();
log(`发现 ${configs.length} 个配置: ${configs.map(c => path.basename(c, '.json')).join(', ')}`);
log('========================================');

for (const configPath of configs) {
  startWatcher(configPath);
}

setInterval(healthCheck, CHECK_INTERVAL);

process.on('uncaughtException', (err) => {
  log(`守护进程异常: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`守护进程Promise拒绝: ${String(reason).substring(0, 200)}`);
});

process.on('SIGINT', () => {
  log('守护进程收到SIGINT，停止所有watcher...');
  stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('守护进程收到SIGTERM，停止所有watcher...');
  stopAll();
  process.exit(0);
});
