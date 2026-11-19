// Stop the background watcher (if running) and remove AGY Claude Style (agy-claude-style) from all Antigravity windows.
const fs = require('fs');
const { PID_FILE, LOCK_FILE, readActivePorts, listPages, CdpSession, REMOVE_EXPRESSION } = require('./cdp');
const { readWatcherPid, isPidAlive, waitForPidExit } = require('./lifecycle');

async function stopWatcher() {
  const pid = readWatcherPid(PID_FILE, LOCK_FILE);
  let stopped = false;
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid);
      await waitForPidExit(pid, 1500);
      console.log(`[✓] 已停止 agy-claude-style 后台守护进程 (PID ${pid})`);
      stopped = true;
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }
  for (const f of [PID_FILE, LOCK_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
  return stopped;
}

async function removeFromAllWindows({ log = console.log, warn = console.warn } = {}) {
  const ports = readActivePorts();
  const removedPages = [];
  for (const port of ports) {
    let pages = [];
    try {
      pages = await listPages(port);
    } catch {
      continue;
    }
    for (const page of pages) {
      try {
        const session = await CdpSession.connect(page.webSocketDebuggerUrl);
        try {
          const res = await session.evaluate(REMOVE_EXPRESSION);
          log(`[✓] 已移除 agy-claude-style: ${page.title || page.url} (清理节点: ${res.removed})`);
          removedPages.push({ title: page.title || page.url, removed: res.removed });
        } finally {
          session.close();
        }
      } catch (err) {
        warn(`[!] 清理失败: ${page.title || page.url} — ${err.message}`);
      }
    }
  }
  return removedPages;
}

if (require.main === module) {
  (async () => {
    const stopped = await stopWatcher();
    const ports = readActivePorts();
    if (!ports.length) {
      if (!stopped) console.log('[*] 未发现运行中的 agy-claude-style 守护进程或 Antigravity 调试端口');
      return;
    }
    await removeFromAllWindows();
  })();
}

module.exports = {
  stopWatcher,
  removeFromAllWindows,
};
