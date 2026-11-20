// Chrome DevTools Protocol (CDP) helpers for AGY Claude Style (agy-claude-style).
// Node >= 22: uses built-in fetch and WebSocket (zero external dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');

const STYLE_ID = 'ag-claude-style-css';
const PLUGIN_VERSION = '1.0.0';
const SETTING_BINDING = '__agClaudeStyleSetting';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const APP_DATA = IS_MAC
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : IS_WIN
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

const STATE_DIR_ENV = process.env.AGY_CLAUDE_STYLE_STATE_DIR
  ? path.resolve(process.env.AGY_CLAUDE_STYLE_STATE_DIR)
  : '';
const CONFIG_FILE_ENV = process.env.AGY_CLAUDE_STYLE_CONFIG
  ? path.resolve(process.env.AGY_CLAUDE_STYLE_CONFIG)
  : '';

function resolvePluginDataDir(env = process.env) {
  const pluginData = String(env?.AGY_CLAUDE_STYLE_PLUGIN_DATA || '').trim();
  if (pluginData && !pluginData.includes('${')) {
    return path.resolve(pluginData);
  }
  const sidecarData = String(env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR || '').trim();
  const lsAddr = String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim();
  if (sidecarData && lsAddr !== 'test.invalid') {
    const resolvedSidecar = path.resolve(sidecarData);
    let cur = resolvedSidecar;
    let prevChild = '';
    for (let depth = 0; depth < 8 && cur && path.dirname(cur) !== cur; depth += 1) {
      const base = path.basename(cur);
      const isSidecarData = process.platform === 'win32'
        ? base.toLowerCase() === 'sidecar_data'
        : base === 'sidecar_data';
      if (isSidecarData && prevChild) {
        return path.join(path.dirname(cur), 'plugin_data', prevChild);
      }
      prevChild = base;
      cur = path.dirname(cur);
    }
    return resolvedSidecar;
  }
  return null;
}

const PLUGIN_DATA_DIR = resolvePluginDataDir(process.env);
const PORT_FILE = path.join(APP_DATA, 'Antigravity', 'DevToolsActivePort');
const STATE_DIR = STATE_DIR_ENV || PLUGIN_DATA_DIR || __dirname;
const PID_FILE = path.join(STATE_DIR, '.watch.pid');
const LOCK_FILE = path.join(STATE_DIR, '.watch.lock.json');
const LEGACY_CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_FILE =
  CONFIG_FILE_ENV ||
  (PLUGIN_DATA_DIR ? path.join(PLUGIN_DATA_DIR, 'config.json') : LEGACY_CONFIG_FILE);

function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function ensureMigratedPluginConfig({
  pluginDataDir = PLUGIN_DATA_DIR,
  configFile = CONFIG_FILE,
  legacyConfigFile = LEGACY_CONFIG_FILE,
  explicitConfig = Boolean(CONFIG_FILE_ENV),
} = {}) {
  if (!pluginDataDir || explicitConfig) return false;
  if (path.resolve(configFile) === path.resolve(legacyConfigFile)) return false;
  try {
    if (fs.existsSync(configFile) || !fs.existsSync(legacyConfigFile)) return false;
    const raw = fs.readFileSync(legacyConfigFile, 'utf8');
    const sanitized = sanitizeConfig(JSON.parse(raw));
    atomicWriteFileSync(configFile, JSON.stringify(sanitized, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG = {
  language: 'zh-CN',
  palette: 'obsidian',
  homeLayout: 'studio',
  homeRipple: true,
  composerRestyle: true,
  mascot: 'crab',
  logoInk: 'accent',
  effortSliderStyle: 'claude',
  effortAccent: true,
  performanceBackdrop: 'card',
  smoothCaret: true,
  sidebarRestyle: true,
  sidebarCompact: false,
  placeholderStyle: 'studio',
  pollIntervalMs: 2500,
};

function sanitizeConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) {
      out[key] = raw[key];
    }
  }
  return out;
}

function readConfig() {
  ensureMigratedPluginConfig();
  try {
    return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function resolvePortCandidates() {
  if (IS_MAC) {
    return [
      PORT_FILE,
      path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'DevToolsActivePort'),
    ];
  }
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return Array.from(
      new Set([
        PORT_FILE,
        path.join(localAppData, 'Antigravity', 'DevToolsActivePort'),
        path.join(APP_DATA, 'Antigravity IDE', 'DevToolsActivePort'),
        path.join(localAppData, 'Antigravity IDE', 'DevToolsActivePort'),
      ])
    );
  }
  return [
    PORT_FILE,
    path.join(APP_DATA, 'Antigravity IDE', 'DevToolsActivePort'),
  ];
}

function readActivePorts() {
  if (process.env.AG_CDP_PORT) {
    const envPort = parseInt(process.env.AG_CDP_PORT, 10);
    return Number.isInteger(envPort) && envPort > 0 ? [envPort] : [];
  }
  const ports = [];
  const seen = new Set();
  for (const candidate of resolvePortCandidates()) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      const port = parseInt(text.split(/\r?\n/)[0].trim(), 10);
      if (Number.isInteger(port) && port > 0 && !seen.has(port)) {
        seen.add(port);
        ports.push(port);
      }
    } catch {}
  }
  return ports;
}

function readPort() {
  const ports = readActivePorts();
  return ports.length > 0 ? ports[0] : null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SIDECAR_TITLE_RE = /^(?:AGY Claude Style(?:\s+Studio)?|(?:Antigravity\s+)?Usage\s+Monitor|Swarm\s+Board)\b/i;

function isLoopbackHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isIdeExtensionChatTarget(t) {
  if (!t || typeof t !== 'object' || !t.webSocketDebuggerUrl) return false;
  const type = String(t.type || '').trim().toLowerCase();
  if (type !== 'iframe' && type !== 'webview' && type !== 'page') return false;
  const url = String(t.url || '').trim();
  if (!isLoopbackHttpUrl(url)) return false;
  return (
    /[?&]extension(?:View|Variant)=/i.test(url) ||
    /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i.test(url)
  );
}

function isAntigravityPageTarget(t) {
  if (!t || typeof t !== 'object' || !t.webSocketDebuggerUrl) return false;
  const type = String(t.type || '').trim().toLowerCase();
  const url = String(t.url || '').trim();
  const title = String(t.title || '').trim();
  if (!url) return false;
  if (/^(?:devtools|chrome|chrome-extension|data|about|vscode-webview|plugin|agy-favicon):/i.test(url)) return false;
  if (SIDECAR_TITLE_RE.test(title) || /\/sidecars?\//i.test(url)) return false;
  if (/sharedProcess\.html/i.test(url)) return false;
  if (type !== 'page') {
    return isIdeExtensionChatTarget(t);
  }
  if (/^https?:/i.test(url)) {
    return isLoopbackHttpUrl(url);
  }
  return /^(?:file|vscode-file):\/\//i.test(url);
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = await res.json();
  return targets.filter((t) => isAntigravityPageTarget(t));
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onClose = null;
    this.listeners = new Map();
    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
        return;
      }
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    ws.addEventListener('close', () => this._handleClose());
    ws.addEventListener('error', () => this._handleClose());
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
    if (this.onClose) {
      try {
        this.onClose();
      } catch {}
    }
  }

  static connect(wsUrl, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpSession(ws));
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connect failed'));
        },
        { once: true }
      );
    });
  }

  send(method, params = {}, timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  async evaluate(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  close() {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {}
    this._handleClose();
  }
}

function readCss() {
  return fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
}

const RUNTIME_PARTS = ['i18n-locales.js', 'i18n-core.js', 'usage-core.js', 'ripple-core.js', 'mascot-core.js', 'crab-assets.js', 'effort-core.js', 'perf-assets.js', 'ui-runtime.js'];

function readRuntimeBundle() {
  return RUNTIME_PARTS.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
}

function computeHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildInjectExpression(customConfig) {
  const config = customConfig || readConfig();
  const css = readCss();
  const bundle = readRuntimeBundle();
  const codeHash = computeHash(bundle);
  return `(() => {
    const css = ${JSON.stringify(css)};
    const applyStyle = () => {
      const targetParent = document.head || document.documentElement;
      if (!targetParent) return;
      let style = document.getElementById(${JSON.stringify(STYLE_ID)});
      if (!style) {
        style = document.createElement('style');
        style.id = ${JSON.stringify(STYLE_ID)};
      }
      if (style.textContent !== css) style.textContent = css;
      if (style.parentNode !== targetParent || targetParent.lastElementChild !== style) {
        targetParent.appendChild(style);
      }
    };

    const isHostDocument = () => {
      const proto = typeof location !== 'undefined' && location?.protocol ? String(location.protocol).toLowerCase() : '';
      if (!proto || (proto !== 'http:' && proto !== 'https:')) return true;
      if (typeof window !== 'undefined' && (window.electronNative || window.nativeStorage || window.__APP_CONFIG__)) {
        return true;
      }
      const href = typeof location !== 'undefined' && location?.href ? String(location.href) : '';
      if (
        /[?&]extension(?:View|Variant)=/i.test(href) ||
        new RegExp('/c/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)', 'i').test(href)
      ) {
        return true;
      }
      if (typeof document === 'undefined') return false;
      if (document.title === 'Jetski Web') return true;
      if (
        typeof document.querySelector === 'function' &&
        document.querySelector(
          'link[href="/jetbox.css"], link[href*="jetbox.css"], script[src="/prism_bundle.js"], script[src*="prism_bundle.js"], [data-testid="conversation-view"], [data-testid="agent-input-box"], [data-testid="home-greeting"], [data-testid="new-conversation-button"], [data-testid="sidebar-split"], .agy-home, body.theme-standalone, body[data-agy-theme]'
        )
      ) {
        return true;
      }
      return false;
    };

    let status = 'ok';
    let mounted = false;
    let hostDeferred = false;
    const mount = () => {
      if (mounted || !document.documentElement) return;
      if (!isHostDocument()) {
        if (document.readyState === 'loading') {
          status = 'deferred';
          if (!hostDeferred) {
            hostDeferred = true;
            document.addEventListener('DOMContentLoaded', mount, { once: true });
          }
          return;
        }
        status = 'skipped-non-host';
        return;
      }
      mounted = true;
      status = 'ok';
      try {
        if (document.head) applyStyle();
        else document.addEventListener('DOMContentLoaded', applyStyle, { once: true });
        ${bundle}
        if (typeof globalThis.__agCsUiMain === 'function') {
          globalThis.__agCsUiMain(${JSON.stringify({ ...config, binding: SETTING_BINDING, codeHash })});
        }
      } catch (e) {
        status = 'error: ' + (e && e.message ? e.message : String(e));
        if (typeof console !== 'undefined' && console.error) {
          console.error('[agy-claude-style] init error:', e);
        }
      }
    };

    if (document.documentElement) {
      mount();
    } else {
      status = 'deferred';
      const onReady = () => {
        if (document.documentElement) {
          document.removeEventListener('readystatechange', onReady);
          document.removeEventListener('DOMContentLoaded', onReady);
          mount();
        }
      };
      document.addEventListener('readystatechange', onReady);
      document.addEventListener('DOMContentLoaded', onReady);
    }
    const st = window.__agClaudeStyle && window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null;
    return {
      version: ${JSON.stringify(PLUGIN_VERSION)},
      status,
      state: st,
    };
  })()`;
}

const REMOVE_EXPRESSION = `(() => {
  if (Array.isArray(globalThis.__agCsCleanups)) {
    while (globalThis.__agCsCleanups.length) {
      const fn = globalThis.__agCsCleanups.pop();
      try {
        if (typeof fn === 'function') fn();
      } catch (e) {}
    }
  }
  delete globalThis.__agCsCleanups;
  try {
    if (window.__agClaudeStyle && typeof window.__agClaudeStyle.destroy === 'function') {
      window.__agClaudeStyle.destroy();
    }
  } catch (e) {}
  if (window.__agCsI18n && typeof window.__agCsI18n.destroy === 'function') {
    window.__agCsI18n.destroy();
  }
  delete window.__agClaudeStyle;
  delete window.__agCsI18n;
  delete globalThis.__agCsUiMain;
  delete globalThis.__agCsCrabAssets;
  delete globalThis.__agCsMascotCore;
  delete globalThis.__agCsRippleCore;
  delete globalThis.__agCsUsageCore;
  delete globalThis.__agCsEffortCore;
  delete globalThis.__agCsPerfAssets;
  delete globalThis.__agCsI18nCore;
  delete globalThis.__agCsLocales;
  const root = document.documentElement;
  if (root) {
    root.removeAttribute('data-ag-cs-effort-accent');
    root.removeAttribute('data-ag-cs-perf-backdrop');
    root.removeAttribute('data-ag-cs-hud-compact');
    root.removeAttribute('data-ag-cs-lang');
    root.removeAttribute('data-ag-cs-cjk');
    if (root.getAttribute('data-ag-cjk') === '1') root.removeAttribute('data-ag-cjk');
  }
  const nodes = document.querySelectorAll(
    'style#${STYLE_ID}, style#ag-token-hud-style, .ag-cs-home-panel-seat, .ag-cs-ripple-host, .ag-cs-ripple-canvas, .ag-cs-crab, .ag-cs-inline-stats, .ag-cs-context-ring, .ag-cs-ctx-popover, .ag-cs-effort-popover, .ag-cs-perf-backdrop, .ag-cs-smooth-caret, .ag-cs-turn-bar, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip, #ag-cs-settings-sec, .ag-th-top-bar, .ag-th-bottom-bar, .ag-th-rim-progress, .ag-th-footer-chip, .ag-th-popover, .ag-th-turn-bar, .ag-th-reopen-pill'
  );
  nodes.forEach((n) => n.remove());
  return { removed: nodes.length };
})()`;

module.exports = {
  STYLE_ID,
  PLUGIN_VERSION,
  SETTING_BINDING,
  RUNTIME_PARTS,
  STATE_DIR,
  PLUGIN_DATA_DIR,
  LEGACY_CONFIG_FILE,
  PORT_FILE,
  PID_FILE,
  LOCK_FILE,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  resolvePluginDataDir,
  atomicWriteFileSync,
  ensureMigratedPluginConfig,
  sanitizeConfig,
  isIdeExtensionChatTarget,
  isAntigravityPageTarget,
  resolvePortCandidates,
  readActivePorts,
  readConfig,
  readPort,
  listPages,
  CdpSession,
  readCss,
  readRuntimeBundle,
  buildInjectExpression,
  REMOVE_EXPRESSION,
};
