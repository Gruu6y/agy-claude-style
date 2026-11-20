// Inject AGY Claude Style (agy-claude-style) into every open Antigravity window over CDP.
//
//   node inject.js           one-shot: inject now and exit
//   node inject.js --watch   daemon mode: auto-inject into new/reloaded windows
//                            and hot-reload style.css / *.js / config.json
const {
  PORT_FILE,
  CONFIG_FILE,
  readConfig,
  sanitizeConfig,
  atomicWriteFileSync,
  ensureMigratedPluginConfig,
  readActivePorts,
  listPages,
  CdpSession,
  buildInjectExpression,
} = require('./cdp');
const { startWatchController, shortTitle } = require('./watcher-core');
const { exitProcessCleanly } = require('./lifecycle');

function parseCliArgs(argv) {
  const opts = {
    watch: argv.includes('--watch'),
    keepAlive: argv.includes('--keep-alive'),
    stdioWatchdog: argv.includes('--stdio-watchdog'),
    replaceExisting: argv.includes('--replace'),
    parentPid: 0,
    maxIdleFailures: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parent-pid' && i + 1 < argv.length) {
      const p = parseInt(argv[++i], 10);
      if (Number.isInteger(p) && p > 0) opts.parentPid = p;
    } else if (a === '--max-idle-failures' && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (Number.isInteger(n) && n > 0) opts.maxIdleFailures = n;
    }
  }
  return opts;
}

const validators = {
  language: (v) => v === 'zh-CN' || v === 'zh-TW' || v === 'yue' || v === 'en' || v === 'ja',
  palette: (v) => v === 'obsidian' || v === 'claude' || v === 'host',
  homeLayout: (v) => v === 'studio' || v === 'classic' || v === 'off',
  homeRipple: (v) => typeof v === 'boolean',
  composerRestyle: (v) => typeof v === 'boolean',
  mascot: (v) => v === 'crab' || v === 'off',
  logoInk: (v) => v === 'accent' || v === 'foreground',
  effortSliderStyle: (v) => v === 'claude' || v === 'chatgpt' || v === 'liangwufeng',
  effortAccent: (v) => typeof v === 'boolean',
  performanceBackdrop: (v) => v === 'off' || v === 'card' || v === 'page',
  smoothCaret: (v) => typeof v === 'boolean',
  sidebarRestyle: (v) => typeof v === 'boolean',
  sidebarCompact: (v) => typeof v === 'boolean',
  placeholderStyle: (v) => v === 'studio' || v === 'host',
};

function updateConfigSetting(key, value) {
  if (!Object.prototype.hasOwnProperty.call(validators, key) || !validators[key](value)) return false;
  ensureMigratedPluginConfig();
  const next = sanitizeConfig({ ...readConfig(), [key]: value });
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return true;
}

async function injectOnce({ log = console.log } = {}) {
  const ports = readActivePorts();
  if (!ports.length) {
    throw new Error(`未找到调试端口文件，Antigravity 可能未运行: ${PORT_FILE}`);
  }

  let activePort = null;
  let pages = null;
  for (const port of ports) {
    try {
      const found = await listPages(port);
      activePort = port;
      pages = found;
      if (found.length > 0) break;
    } catch {}
  }

  if (!activePort || pages === null) {
    throw new Error(`端口 ${ports[0]} 无响应：请确认 Antigravity 正在运行`);
  }
  if (pages.length === 0) throw new Error('未找到 Antigravity 窗口页面');

  log(`[+] 调试端口 ${activePort}，发现 ${pages.length} 个窗口`);
  const expr = buildInjectExpression();
  const injected = [];
  for (const page of pages) {
    const session = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      const res = await session.evaluate(expr);
      log(`[✓] ${shortTitle(page)} (agy-claude-style ${res.version} · 状态: ${res.status})`);
      injected.push({ title: shortTitle(page), version: res.version, status: res.status });
    } finally {
      session.close();
    }
  }
  return { port: activePort, pages: injected };
}

async function watch(cliOpts = {}) {
  try {
    return await startWatchController({
      mode: cliOpts.keepAlive ? 'autostart' : 'cli',
      keepAlive: Boolean(cliOpts.keepAlive),
      watchHostExit: true,
      maxIdleFailures: cliOpts.maxIdleFailures,
      parentPid: cliOpts.parentPid || 0,
      watchStdin: Boolean(cliOpts.stdioWatchdog),
      replaceExisting: Boolean(cliOpts.replaceExisting),
      enableConsole: true,
      updateConfigSetting,
      onExit: (code) => {
        exitProcessCleanly(code, 50);
      },
    });
  } catch (err) {
    if (err && err.code === 'WATCHER_LOCKED') {
      console.error(`[!] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

if (require.main === module) {
  const cliOpts = parseCliArgs(process.argv.slice(2));
  (cliOpts.watch ? watch(cliOpts) : injectOnce()).catch((err) => {
    console.error(`[✗] ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  validators,
  updateConfigSetting,
  injectOnce,
  watch,
  parseCliArgs,
};
