// Aux Pane Sidecar UI server for AGY Claude Style.
// Uses sidecar_sdk and cleans up cleanly via host /healthz watchdog when Antigravity exits.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cdp = require('../../cdp.js');
const lifecycle = require('../../lifecycle.js');
const { updateConfigSetting, injectOnce } = require('../../inject.js');
const { removeFromAllWindows } = require('../../remove.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'index.html');
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

async function getStudioStatus() {
  const config = cdp.readConfig();
  const ports = cdp.readActivePorts();
  const watcherPid = lifecycle.readWatcherPid(cdp.PID_FILE, cdp.LOCK_FILE);
  const watcherAlive = Boolean(watcherPid && lifecycle.isPidAlive(watcherPid));

  let activePort = null;
  let pages = [];
  for (const port of ports) {
    try {
      const list = await cdp.listPages(port);
      activePort = port;
      pages = list.map((p) => ({
        id: p.id,
        title: p.title || p.url || 'Antigravity',
      }));
      if (pages.length > 0) break;
    } catch {}
  }

  return {
    ok: true,
    version: cdp.PLUGIN_VERSION,
    config,
    defaults: cdp.DEFAULT_CONFIG,
    watcher: {
      alive: watcherAlive,
      pid: watcherAlive ? watcherPid : null,
    },
    cdp: {
      port: activePort,
      candidatePorts: ports,
      pageCount: pages.length,
      pages,
    },
  };
}

async function applyConfigUpdate(data) {
  const updates = data && typeof data.updates === 'object' && data.updates !== null
    ? data.updates
    : data && typeof data.key === 'string'
    ? { [data.key]: data.value }
    : {};

  const applied = [];
  const rejected = [];
  for (const [k, v] of Object.entries(updates)) {
    if (updateConfigSetting(k, v)) {
      applied.push(k);
    } else {
      rejected.push(k);
    }
  }

  const watcherPid = lifecycle.readWatcherPid(cdp.PID_FILE, cdp.LOCK_FILE);
  const watcherAlive = Boolean(watcherPid && lifecycle.isPidAlive(watcherPid));
  if (applied.length > 0 && !watcherAlive) {
    try {
      await injectOnce({ log: () => {} });
    } catch {}
  }

  return {
    ok: rejected.length === 0,
    applied,
    rejected,
    config: cdp.readConfig(),
  };
}

async function resetStudioConfig() {
  writeFileSync(cdp.CONFIG_FILE, JSON.stringify(cdp.DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  const watcherPid = lifecycle.readWatcherPid(cdp.PID_FILE, cdp.LOCK_FILE);
  if (!watcherPid || !lifecycle.isPidAlive(watcherPid)) {
    try {
      await injectOnce({ log: () => {} });
    } catch {}
  }
  return { ok: true, config: cdp.readConfig() };
}

async function startStudioSidecar() {
  const { Response, SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => {
    const html = readFileSync(HTML_PATH, 'utf8');
    return new Response(html, {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      headers: NO_STORE_HEADERS,
    });
  });

  app.api('/api/status', async () => getStudioStatus(), 'GET');
  app.api('/api/config', async (data) => applyConfigUpdate(data), 'POST');
  app.api('/api/reset', async () => resetStudioConfig(), 'POST');
  app.api('/api/reinject', async () => {
    const res = await injectOnce({ log: () => {} });
    return { ok: true, ...res };
  }, 'POST');
  app.api('/api/remove', async () => {
    const removed = await removeFromAllWindows({ log: () => {}, warn: () => {} });
    return { ok: true, removed };
  }, 'POST');

  let shuttingDown = false;
  let watchdog = null;
  let detachErrors = null;
  let logger = null;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => process.exit(0), 1500);
    forceTimer.unref?.();
    try {
      watchdog?.stop();
      detachErrors?.();
      logger?.dispose();
      await app.close();
    } catch {
      // Ignore close errors
    } finally {
      clearTimeout(forceTimer);
      lifecycle.exitProcessCleanly(0, 50);
    }
  };

  logger = lifecycle.createSafeLogger({
    enableConsole: false,
    logFile: null,
    onBrokenPipe: () => {
      void shutdown();
    },
  });
  detachErrors = logger.installProcessErrorGuards({
    onFatalPipe: () => {
      void shutdown();
    },
  });

  watchdog = lifecycle.startHostWatchdog({
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
    watchStdin: false,
    checkIntervalMs: 3000,
    maxLsFailures: 2,
    onShutdown: () => {
      void shutdown();
    },
  });

  await app.run();
  return app;
}

function safeRealpath(filePath) {
  if (!filePath) return '';
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function isSameEntryPath(a, b) {
  if (!a || !b) return false;
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

const invokedPath = process.argv[1] ? safeRealpath(process.argv[1]) : '';
const currentPath = safeRealpath(fileURLToPath(import.meta.url));
if (isSameEntryPath(invokedPath, currentPath)) {
  startStudioSidecar().catch((err) => {
    console.error('[agy-claude-style studio sidecar] failed:', err?.message || err);
    process.exit(1);
  });
}

export {
  getStudioStatus,
  applyConfigUpdate,
  resetStudioConfig,
  startStudioSidecar,
};
