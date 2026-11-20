import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Isolate in-process module tests from any live plugin state in ROOT_DIR
const IN_PROCESS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-inproc-'));
process.env.AGY_CLAUDE_STYLE_STATE_DIR = IN_PROCESS_STATE_DIR;
process.env.AGY_CLAUDE_STYLE_CONFIG = path.join(IN_PROCESS_STATE_DIR, 'config.json');

const { buildInstaller } = await import('../scripts/build-installer.mjs');
const cdp = require(path.join(ROOT_DIR, 'cdp.js'));
const lifecycle = require(path.join(ROOT_DIR, 'lifecycle.js'));
const { startWatchController } = require(path.join(ROOT_DIR, 'watcher-core.js'));
const { updateConfigSetting } = require(path.join(ROOT_DIR, 'inject.js'));

function createMockCdpServer() {
  const receivedCalls = [];
  const sockets = new Set();
  let lastInjectedExpr = null;
  let lastRemovedExpr = null;

  function encodeWsTextFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  function sendWsMessage(socket, obj) {
    if (!socket.destroyed) {
      socket.write(encodeWsTextFrame(JSON.stringify(obj)));
    }
  }

  function handleCdpCommand(socket, msg) {
    receivedCalls.push(msg);
    let result = {};
    if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
      result = { identifier: 'script-' + receivedCalls.length };
    } else if (msg.method === 'Runtime.evaluate') {
      const expr = msg.params && msg.params.expression ? msg.params.expression : '';
      if (expr.includes('delete globalThis.__agCsUiMain')) {
        lastRemovedExpr = expr;
        result = { result: { type: 'object', value: { removed: 3 } } };
      } else {
        lastInjectedExpr = expr;
        result = {
          result: {
            type: 'object',
            value: { version: cdp.PLUGIN_VERSION, status: 'ok', state: { mounted: true } },
          },
        };
      }
    }
    sendWsMessage(socket, { id: msg.id, result });
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'PAGE_1',
            type: 'page',
            title: 'Antigravity',
            url: 'https://127.0.0.1:9999/',
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/PAGE_1`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    let buf = Buffer.alloc(0);
    let fragChunks = [];
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + payloadLen) return;
        let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ mask[i & 3];
          }
          payload = unmasked;
        }
        buf = buf.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          const pong = Buffer.alloc(2 + payload.length);
          pong[0] = 0x8a;
          pong[1] = payload.length;
          payload.copy(pong, 2);
          socket.write(pong);
          continue;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          fragChunks.push(payload);
          if (fin) {
            const fullText = Buffer.concat(fragChunks).toString('utf8');
            fragChunks = [];
            try {
              const msg = JSON.parse(fullText);
              handleCdpCommand(socket, msg);
            } catch {}
          }
        }
      }
    });
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    emitBindingCalled(name, payload) {
      for (const s of sockets) {
        sendWsMessage(s, {
          method: 'Runtime.bindingCalled',
          params: { name, payload: JSON.stringify(payload) },
        });
      }
    },
    getActiveSocketCount: () => sockets.size,
    getLastInjectedExpr: () => lastInjectedExpr,
    getLastRemovedExpr: () => lastRemovedExpr,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitFor(fn, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Process ${child.pid} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('Issue #3: inject.js --watch auto-exits cleanly after host CDP closes and cleans lock files', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-watch-exit-'));
  const mockCdp = createMockCdpServer();
  let child = null;

  try {
    const port = await mockCdp.start();
    child = spawn(process.execPath, [path.join(ROOT_DIR, 'inject.js'), '--watch', '--max-idle-failures', '2'], {
      cwd: ROOT_DIR,
      stdio: 'ignore',
      env: {
        ...process.env,
        AG_CDP_PORT: String(port),
        ANTIGRAVITY_LS_ADDRESS: '',
        AGY_CLAUDE_STYLE_STATE_DIR: workDir,
        AGY_CLAUDE_STYLE_CONFIG: path.join(workDir, 'config.json'),
      },
    });

    await waitFor(() => mockCdp.getLastInjectedExpr() && fs.existsSync(path.join(workDir, '.watch.pid')));
    await mockCdp.close();

    const code = await waitForExit(child, 9000);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(workDir, '.watch.pid')), false);
    assert.equal(fs.existsSync(path.join(workDir, '.watch.lock.json')), false);
  } finally {
    try { if (child && child.exitCode === null) child.kill(); } catch {}
    await mockCdp.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('Issue #3: inject.js --watch exits cleanly on broken stdout/stderr pipes without uncaughtException spin', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-pipe-'));
  const mockCdp = createMockCdpServer();
  let child = null;

  try {
    const port = await mockCdp.start();
    child = spawn(process.execPath, [path.join(ROOT_DIR, 'inject.js'), '--watch'], {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AG_CDP_PORT: String(port),
        ANTIGRAVITY_LS_ADDRESS: '',
        AGY_CLAUDE_STYLE_STATE_DIR: workDir,
        AGY_CLAUDE_STYLE_CONFIG: path.join(workDir, 'config.json'),
      },
    });

    await waitFor(() => mockCdp.getLastInjectedExpr());

    // Destroy stdout/stderr pipes and trigger console output via Runtime.bindingCalled
    child.stdout.destroy();
    child.stderr.destroy();
    mockCdp.emitBindingCalled(cdp.SETTING_BINDING, { key: 'palette', value: 'claude' });

    const code = await waitForExit(child, 5000);
    assert.equal(code, 0);
  } finally {
    try { if (child && child.exitCode === null) child.kill(); } catch {}
    await mockCdp.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('Issue #3: startHostWatchdog triggers ls-dead when ANTIGRAVITY_LS_ADDRESS /healthz disappears', async () => {
  const lsServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => lsServer.listen(0, '127.0.0.1', resolve));
  const lsPort = lsServer.address().port;

  let shutdownReason = null;
  const watchdog = lifecycle.startHostWatchdog({
    lsAddress: `127.0.0.1:${lsPort}`,
    checkIntervalMs: 120,
    maxLsFailures: 2,
    onShutdown: (reason) => {
      shutdownReason = reason;
    },
  });

  try {
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(shutdownReason, null);

    await new Promise((resolve) => lsServer.close(resolve));
    const reason = await waitFor(() => shutdownReason, 3000, 50);
    assert.equal(reason, 'ls-dead');
  } finally {
    watchdog.stop();
    await new Promise((resolve) => lsServer.close(() => resolve()));
  }
});

test('Issue #3: watcher closes stale CdpSession when CDP debug port changes', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-port-switch-'));
  const mockA = createMockCdpServer();
  const mockB = createMockCdpServer();
  const prevPortEnv = process.env.AG_CDP_PORT;
  let ctrl = null;

  try {
    const portA = await mockA.start();
    const portB = await mockB.start();

    process.env.AG_CDP_PORT = String(portA);
    ctrl = await startWatchController({
      mode: 'test-port-switch',
      stateDir: workDir,
      tickIntervalMs: 60000,
      enableConsole: false,
      lsAddress: '',
      updateConfigSetting,
    });

    await waitFor(() => mockA.getLastInjectedExpr() && mockA.getActiveSocketCount() === 1);
    assert.equal(ctrl.getLastPort(), portA);

    process.env.AG_CDP_PORT = String(portB);
    await ctrl.tick();

    await waitFor(() => mockB.getLastInjectedExpr() && mockB.getActiveSocketCount() === 1);
    await waitFor(() => mockA.getActiveSocketCount() === 0);
    assert.equal(ctrl.getLastPort(), portB);
  } finally {
    if (ctrl) await ctrl.stop({ removeFromPages: false });
    if (prevPortEnv === undefined) delete process.env.AG_CDP_PORT;
    else process.env.AG_CDP_PORT = prevPortEnv;
    await mockA.close().catch(() => {});
    await mockB.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('Native plugin: mcp-host.js serves 0-tool MCP over stdio, injects via CDP, and un-injects live on disable', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-mcp-'));
  const mockCdp = createMockCdpServer();
  const lsServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  let child = null;

  try {
    const port = await mockCdp.start();
    await new Promise((resolve) => lsServer.listen(0, '127.0.0.1', resolve));
    const lsPort = lsServer.address().port;

    child = spawn(process.execPath, [path.join(ROOT_DIR, 'plugin', 'mcp-host.js')], {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AG_CDP_PORT: String(port),
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsPort}`,
        AGY_CLAUDE_STYLE_STATE_DIR: workDir,
        AGY_CLAUDE_STYLE_CONFIG: path.join(workDir, 'config.json'),
        AGY_CLAUDE_STYLE_SKIP_LAUNCHER_PROVISION: '1',
      },
    });

    const responses = [];
    let stdoutBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        // Must be strictly valid JSON-RPC on stdout (zero console.log pollution)
        responses.push(JSON.parse(line));
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n'
    );
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

    await waitFor(() => responses.length >= 2);
    const initResp = responses.find((r) => r.id === 1);
    const toolsResp = responses.find((r) => r.id === 2);
    assert.equal(initResp.result.serverInfo.name, 'agy-claude-style-host');
    assert.deepEqual(toolsResp.result.tools, []);

    await waitFor(() => mockCdp.getLastInjectedExpr());

    // Simulate user disabling the plugin in Customizations (host closes stdin while LS stays up)
    child.stdin.end();
    const code = await waitForExit(child, 6000);
    assert.equal(code, 0);
    assert.equal(mockCdp.getLastRemovedExpr(), cdp.REMOVE_EXPRESSION);
  } finally {
    try { if (child && child.exitCode === null) child.kill(); } catch {}
    await mockCdp.close().catch(() => {});
    await new Promise((resolve) => lsServer.close(() => resolve()));
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test(
  'Issue #3 (Windows C# watcher): agy-claude-style-watcher.exe auto-exits when Antigravity CDP closes',
  { skip: process.platform !== 'win32' ? 'Windows-only watcher test' : false },
  async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-cs-exit-'));
    const installerExe = path.join(workDir, 'installer.exe');
    const installDir = path.join(workDir, 'installed');
    const outInstall = path.join(workDir, 'install.json');
    const mockCdp = createMockCdpServer();

    try {
      buildInstaller({ outputPath: installerExe });
      const port = await mockCdp.start();

      await new Promise((resolve, reject) => {
        const proc = spawn(
          installerExe,
          [
            '--silent',
            '--no-autostart',
            '--no-kill-legacy',
            '--install-dir',
            installDir,
            '--cdp-port',
            String(port),
            '--out',
            outInstall,
          ],
          {
            stdio: 'ignore',
            windowsHide: true,
            env: {
              ...process.env,
              AG_WATCH_MAX_IDLE_FAILURES: '2',
            },
          }
        );
        const timer = setTimeout(() => {
          try { proc.kill(); } catch {}
          reject(new Error('installer timeout'));
        }, 20000);
        proc.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`installer exited ${code}`));
        });
      });

      const pidPath = path.join(installDir, '.watch.pid');
      assert.equal(fs.existsSync(pidPath), true);
      const watcherPid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
      assert.ok(lifecycle.isPidAlive(watcherPid));

      await mockCdp.close();

      await waitFor(() => !lifecycle.isPidAlive(watcherPid) && !fs.existsSync(pidPath), 10000, 150);
      assert.equal(lifecycle.isPidAlive(watcherPid), false);
      assert.equal(fs.existsSync(pidPath), false);
    } finally {
      try {
        const pidPath = path.join(installDir, '.watch.pid');
        if (fs.existsSync(pidPath)) {
          const pid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
          if (pid) process.kill(pid);
        }
      } catch {}
      await mockCdp.close().catch(() => {});
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
);

test('Native plugin manifests and sidecar definitions are structurally valid', () => {
  const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'plugin.json'), 'utf8'));
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'mcp_config.json'), 'utf8'));
  const sidecarJson = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'studio', 'sidecar.json'), 'utf8')
  );

  assert.equal(pluginJson.name, 'agy-claude-style');
  assert.ok(fs.existsSync(path.join(ROOT_DIR, pluginJson.logo)));
  assert.ok(mcpConfig.mcpServers['agy-claude-style-host']);
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
  assert.equal(fs.existsSync(path.join(ROOT_DIR, 'skills')), false);
});

test('ensureRemoteDebugFlagInArgs appends, preserves custom port, and strips managed =0 flag', () => {
  const appended = lifecycle.ensureRemoteDebugFlagInArgs('', { enabled: true });
  assert.deepEqual(appended, {
    changed: true,
    configured: true,
    args: '--remote-debugging-port=0',
  });

  const withOther = lifecycle.ensureRemoteDebugFlagInArgs('--foo --bar', { enabled: true });
  assert.equal(withOther.changed, true);
  assert.equal(withOther.args, '--foo --bar --remote-debugging-port=0');

  const idempotent = lifecycle.ensureRemoteDebugFlagInArgs('--foo --remote-debugging-port=0', {
    enabled: true,
  });
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.alreadyConfigured, true);
  assert.equal(idempotent.configured, true);

  const customPort = lifecycle.ensureRemoteDebugFlagInArgs('--remote-debugging-port=9222 --foo', {
    enabled: true,
  });
  assert.equal(customPort.changed, false);
  assert.equal(customPort.configured, true);
  assert.equal(customPort.args, '--remote-debugging-port=9222 --foo');

  const keepCustomOnDisable = lifecycle.ensureRemoteDebugFlagInArgs('--remote-debugging-port=9222 --foo', {
    enabled: false,
  });
  assert.equal(keepCustomOnDisable.changed, false);
  assert.equal(keepCustomOnDisable.configured, true);
  assert.equal(keepCustomOnDisable.args, '--remote-debugging-port=9222 --foo');

  const stripZero = lifecycle.ensureRemoteDebugFlagInArgs('--foo --remote-debugging-port=0 --bar', {
    enabled: false,
  });
  assert.equal(stripZero.changed, true);
  assert.equal(stripZero.removed, true);
  assert.equal(stripZero.configured, false);
  assert.equal(stripZero.args, '--foo --bar');
});

test('patchWindowsRunRegistryCommand targets Antigravity.exe only and manages --remote-debugging-port=0', () => {
  const quoted = lifecycle.patchWindowsRunRegistryCommand(
    '"C:\\Users\\Demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --hidden',
    { enabled: true }
  );
  assert.equal(quoted.matched, true);
  assert.equal(quoted.changed, true);
  assert.equal(quoted.configured, true);
  assert.equal(
    quoted.value,
    '"C:\\Users\\Demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --hidden --remote-debugging-port=0'
  );

  const unquoted = lifecycle.patchWindowsRunRegistryCommand('C:\\Antigravity\\Antigravity.exe', {
    enabled: true,
  });
  assert.equal(unquoted.matched, true);
  assert.equal(unquoted.changed, true);
  assert.equal(unquoted.value, 'C:\\Antigravity\\Antigravity.exe --remote-debugging-port=0');

  const ideIgnored = lifecycle.patchWindowsRunRegistryCommand(
    '"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe" --minimized',
    { enabled: true }
  );
  assert.equal(ideIgnored.matched, false);
  assert.equal(ideIgnored.changed, false);

  const toolsIgnored = lifecycle.patchWindowsRunRegistryCommand(
    '"C:\\Users\\Demo\\AppData\\Local\\Antigravity Tools\\antigravity-tools.exe"',
    { enabled: true }
  );
  assert.equal(toolsIgnored.matched, false);
  assert.equal(toolsIgnored.changed, false);

  const customKept = lifecycle.patchWindowsRunRegistryCommand(
    '"C:\\Antigravity\\Antigravity.exe" --remote-debugging-port=9222',
    { enabled: false }
  );
  assert.equal(customKept.matched, true);
  assert.equal(customKept.changed, false);
  assert.equal(customKept.configured, true);

  const stripped = lifecycle.patchWindowsRunRegistryCommand(
    '"C:\\Antigravity\\Antigravity.exe" --remote-debugging-port=0 --tray',
    { enabled: false }
  );
  assert.equal(stripped.matched, true);
  assert.equal(stripped.changed, true);
  assert.equal(stripped.configured, false);
  assert.equal(stripped.value, '"C:\\Antigravity\\Antigravity.exe" --tray');
});

test('patchLinuxDesktopEntryText inserts flag before XDG field codes, preserves EOL, and ignores IDE', () => {
  const src = '[Desktop Entry]\r\nName=Antigravity\r\nExec=/opt/Antigravity/antigravity --ozone-platform=wayland %U\r\n';
  const enabledRes = lifecycle.patchLinuxDesktopEntryText(src, { enabled: true });
  assert.equal(enabledRes.matched, true);
  assert.equal(enabledRes.changed, true);
  assert.equal(enabledRes.configured, true);
  assert.equal(
    enabledRes.text,
    '[Desktop Entry]\r\nName=Antigravity\r\nExec=/opt/Antigravity/antigravity --ozone-platform=wayland --remote-debugging-port=0 %U\r\n'
  );

  const disabledRes = lifecycle.patchLinuxDesktopEntryText(enabledRes.text, { enabled: false });
  assert.equal(disabledRes.matched, true);
  assert.equal(disabledRes.changed, true);
  assert.equal(disabledRes.configured, false);
  assert.equal(disabledRes.text, src);

  const ideSrc = '[Desktop Entry]\nName=Antigravity IDE\nExec=/usr/bin/antigravity-ide %F\n';
  const ideRes = lifecycle.patchLinuxDesktopEntryText(ideSrc, { enabled: true });
  assert.equal(ideRes.matched, false);
  assert.equal(ideRes.changed, false);
  assert.equal(ideRes.text, ideSrc);
});

test('ensureDesktopRemoteDebuggingLaunchers honors test guards, win32 PS JSON, and linux .desktop copy', async () => {
  const skippedByFlag = await lifecycle.ensureDesktopRemoteDebuggingLaunchers({
    env: { AGY_CLAUDE_STYLE_SKIP_LAUNCHER_PROVISION: '1' },
    platform: 'win32',
    execFileFn: async () => {
      throw new Error('should not be called');
    },
  });
  assert.equal(skippedByFlag.checked, false);
  assert.equal(skippedByFlag.reason, 'skipped');

  const skippedByLs = await lifecycle.ensureDesktopRemoteDebuggingLaunchers({
    env: { ANTIGRAVITY_LS_ADDRESS: 'test.invalid' },
    platform: 'win32',
    execFileFn: async () => {
      throw new Error('should not be called');
    },
  });
  assert.equal(skippedByLs.checked, false);
  assert.equal(skippedByLs.reason, 'skipped');

  // PowerShell 5.1 single-item array serialization collapses 1-element arrays to strings
  const winRes = await lifecycle.ensureDesktopRemoteDebuggingLaunchers({
    enabled: true,
    platform: 'win32',
    allowInTest: true,
    execFileFn: async (file, args, opts) => {
      assert.equal(file, 'powershell.exe');
      assert.equal(opts.env.AGY_CS_LAUNCH_ENABLED, '1');
      assert.ok(args.includes('-Command'));
      return JSON.stringify({
        ok: true,
        updatedPaths: 'C:\\Users\\Demo\\Desktop\\Antigravity.lnk',
        configuredPaths: 'C:\\Users\\Demo\\Desktop\\Antigravity.lnk',
      });
    },
  });
  assert.equal(winRes.checked, true);
  assert.equal(winRes.updated, true);
  assert.equal(winRes.configured, true);
  assert.deepEqual(winRes.updatedPaths, ['C:\\Users\\Demo\\Desktop\\Antigravity.lnk']);
  assert.deepEqual(winRes.configuredPaths, ['C:\\Users\\Demo\\Desktop\\Antigravity.lnk']);

  // Mocked Linux copy from /usr/share/applications/antigravity.desktop to XDG_DATA_HOME
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-linux-desktop-'));
  try {
    const xdgDataHome = path.join(tmpRoot, 'xdg-data');
    const xdgConfigHome = path.join(tmpRoot, 'xdg-config');
    const sysDesktop = '/usr/share/applications/antigravity.desktop';
    const userDesktop = path.join(xdgDataHome, 'applications', 'antigravity.desktop');
    const vfs = new Map([
      [sysDesktop, '[Desktop Entry]\nName=Antigravity\nExec=/usr/bin/antigravity %U\n'],
    ]);
    const fsOps = {
      existsFn: (p) => vfs.has(p),
      readFn: (p) => vfs.get(p),
      writeFn: (p, content) => vfs.set(p, content),
      mkdirFn: () => {},
    };

    const linuxRes = await lifecycle.ensureDesktopRemoteDebuggingLaunchers({
      enabled: true,
      platform: 'linux',
      homeDir: tmpRoot,
      env: { XDG_DATA_HOME: xdgDataHome, XDG_CONFIG_HOME: xdgConfigHome },
      fsOps,
      allowInTest: true,
    });
    assert.equal(linuxRes.checked, true);
    assert.equal(linuxRes.updated, true);
    assert.equal(linuxRes.configured, true);
    assert.deepEqual(linuxRes.updatedPaths, [userDesktop]);
    assert.deepEqual(linuxRes.configuredPaths, [userDesktop]);
    assert.equal(
      vfs.get(userDesktop),
      '[Desktop Entry]\nName=Antigravity\nExec=/usr/bin/antigravity --remote-debugging-port=0 %U\n'
    );

    const macRes = await lifecycle.ensureDesktopRemoteDebuggingLaunchers({
      enabled: true,
      platform: 'darwin',
      allowInTest: true,
    });
    assert.equal(macRes.checked, true);
    assert.equal(macRes.updated, false);
    assert.equal(macRes.reason, 'macos_app_bundle_signed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('desktop relaunch helpers sanitize env, resolve host executables across OSes, and guard test sandboxes', async () => {
  const { relaunchDesktopHost } = await import('../sidecars/studio/main.mjs');
  const sidecarJson = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'sidecars', 'studio', 'sidecar.json'), 'utf8')
  );
  assert.equal(typeof relaunchDesktopHost, 'function');
  assert.equal(/Token\s+HUD/i.test(sidecarJson.description || ''), false);

  const sanitizedEnv = lifecycle.buildSanitizedDesktopRelaunchEnv({
    PATH: 'C:\\Windows\\System32',
    ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999',
    CHROME_DEVTOOLS_MCP_JS: '/app/mcp.js',
    AGY_CLAUDE_STYLE_PLUGIN_DATA: '/tmp/data',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--max-old-space-size=4096',
  });
  assert.equal(sanitizedEnv.PATH, 'C:\\Windows\\System32');
  assert.equal('ANTIGRAVITY_LS_ADDRESS' in sanitizedEnv, false);
  assert.equal('CHROME_DEVTOOLS_MCP_JS' in sanitizedEnv, false);
  assert.equal('AGY_CLAUDE_STYLE_PLUGIN_DATA' in sanitizedEnv, false);
  assert.equal('ELECTRON_RUN_AS_NODE' in sanitizedEnv, false);
  assert.equal('NODE_OPTIONS' in sanitizedEnv, false);

  const winExe = 'C:\\Users\\Demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe';
  const resolvedWin = lifecycle.resolveDesktopHostExecutable({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local' },
    existsFn: (p) => p === winExe,
  });
  assert.deepEqual(resolvedWin, {
    found: true,
    kind: 'desktop',
    executablePath: winExe,
    appBundlePath: '',
  });

  const macApp = '/Applications/Antigravity.app';
  const macBin = path.join(macApp, 'Contents', 'MacOS', 'Antigravity');
  const resolvedMac = lifecycle.resolveDesktopHostExecutable({
    platform: 'darwin',
    existsFn: (p) => p === macApp || p === macBin,
  });
  assert.deepEqual(resolvedMac, {
    found: true,
    kind: 'desktop',
    executablePath: macBin,
    appBundlePath: macApp,
  });

  const linuxBin = '/usr/bin/antigravity';
  const resolvedLinux = lifecycle.resolveDesktopHostExecutable({
    platform: 'linux',
    existsFn: (p) => p === linuxBin,
  });
  assert.deepEqual(resolvedLinux, {
    found: true,
    kind: 'desktop',
    executablePath: linuxBin,
    appBundlePath: '',
  });

  const innerPs = lifecycle.buildWindowsRelaunchInnerScript(winExe, ['C:\\temp\\DevToolsActivePort']);
  assert.ok(innerPs.includes('--remote-debugging-port=0'));
  assert.ok(innerPs.includes('DevToolsActivePort'));

  const blocked = await lifecycle.triggerDesktopHostRelaunch({
    env: { ANTIGRAVITY_LS_ADDRESS: 'test.invalid' },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 403);

  const missing = await lifecycle.triggerDesktopHostRelaunch({
    platform: 'linux',
    allowInTest: true,
    existsFn: () => false,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);

  const tmpWin = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-relaunch-'));
  try {
    let psScriptContent = '';
    const winRelaunch = await lifecycle.triggerDesktopHostRelaunch({
      platform: 'win32',
      allowInTest: true,
      tempDir: tmpWin,
      stalePortFiles: ['C:\\temp\\DevToolsActivePort'],
      env: { LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local', ANTIGRAVITY_CSRF_TOKEN: 'secret' },
      existsFn: (p) => p === winExe,
      execFileFn: async (file, args, opts) => {
        assert.equal(file, 'powershell.exe');
        assert.ok(args.includes('-Sta'));
        assert.equal('ANTIGRAVITY_CSRF_TOKEN' in opts.env, false);
        assert.ok(fs.existsSync(opts.env.AGY_RELAUNCH_PS1));
        psScriptContent = fs.readFileSync(opts.env.AGY_RELAUNCH_PS1, 'utf8');
        return '{"ok":true}';
      },
    });
    assert.equal(winRelaunch.ok, true);
    assert.equal(winRelaunch.relaunching, true);
    assert.equal(psScriptContent.charCodeAt(0), 0xfeff);
    assert.ok(psScriptContent.includes('--remote-debugging-port=0'));
  } finally {
    fs.rmSync(tmpWin, { recursive: true, force: true });
  }

  let macSpawn = null;
  const macRelaunch = await lifecycle.triggerDesktopHostRelaunch({
    platform: 'darwin',
    allowInTest: true,
    existsFn: (p) => p === macApp || p === macBin,
    spawnFn: async (file, args, opts) => {
      macSpawn = { file, args, opts };
      return { pid: 123 };
    },
  });
  assert.equal(macRelaunch.ok, true);
  assert.equal(macSpawn.file, '/bin/sh');
  assert.ok(macSpawn.args[1].includes('open -a "$AGY_RELAUNCH_APP" --args --remote-debugging-port=0'));

  let linuxSpawn = null;
  const linuxRelaunch = await lifecycle.triggerDesktopHostRelaunch({
    platform: 'linux',
    allowInTest: true,
    existsFn: (p) => p === linuxBin,
    spawnFn: async (file, args, opts) => {
      linuxSpawn = { file, args, opts };
      return { pid: 456 };
    },
  });
  assert.equal(linuxRelaunch.ok, true);
  assert.equal(linuxSpawn.file, '/bin/sh');
  assert.ok(linuxSpawn.args[1].includes('nohup "$AGY_RELAUNCH_EXE" --remote-debugging-port=0'));
});

test('cdp helpers resolve plugin data dir, sanitize removed keys, filter browser targets, and sidecar guards Host headers', async () => {
  const { isLocalHostRequest } = await import('../sidecars/studio/main.mjs');

  assert.equal(
    cdp.resolvePluginDataDir({ AGY_CLAUDE_STYLE_PLUGIN_DATA: 'C:\\demo\\plugin_data\\agy-claude-style' }),
    path.resolve('C:\\demo\\plugin_data\\agy-claude-style')
  );
  assert.equal(
    cdp.resolvePluginDataDir({
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: path.join('C:', 'data', 'sidecar_data', 'agy-claude-style', 'studio'),
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1234',
    }),
    path.resolve(path.join('C:', 'data', 'plugin_data', 'agy-claude-style'))
  );
  assert.equal(
    cdp.resolvePluginDataDir({
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: path.join('C:', 'data', 'sidecar_data', 'agy-claude-style', 'studio'),
      ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    }),
    null
  );

  const sanitized = cdp.sanitizeConfig({
    palette: 'claude',
    turnBadges: true,
    inlineStats: true,
    hudTopBar: true,
    sidebarCompact: true,
  });
  assert.equal(sanitized.palette, 'claude');
  assert.equal(sanitized.sidebarCompact, true);
  assert.equal('turnBadges' in sanitized, false);
  assert.equal('inlineStats' in sanitized, false);
  assert.equal('hudTopBar' in sanitized, false);

  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'Antigravity',
      url: 'https://127.0.0.1:9999/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1',
    }),
    true
  );
  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'Workbench',
      url: 'vscode-file://vscode-app/c:/app/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/2',
    }),
    true
  );
  assert.equal(
    cdp.isIdeExtensionChatTarget({
      type: 'iframe',
      title: 'Agent Chat',
      url: 'http://127.0.0.1:41362/c/11111111-1111-4111-8111-111111111111?extensionView=true',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/3',
    }),
    true
  );
  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'GitHub',
      url: 'https://github.com/google',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/4',
    }),
    false
  );
  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'DevTools',
      url: 'devtools://devtools/bundled/inspector.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/5',
    }),
    false
  );
  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'Usage Monitor',
      url: 'http://127.0.0.1:5100/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/6',
    }),
    false
  );
  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'AGY Claude Style Studio',
      url: 'http://127.0.0.1:5101/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/7',
    }),
    false
  );

  assert.equal(isLocalHostRequest(), true);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', origin: 'http://127.0.0.1:5100' } }), true);
  assert.equal(isLocalHostRequest({ headers: { host: 'localhost:5100', origin: 'vscode-webview://abc123' } }), true);
  assert.equal(isLocalHostRequest({ headers: { host: 'evil.com:5100' } }), false);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', origin: 'http://127.0.0.1:9999' } }), false);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', 'sec-fetch-site': 'cross-site' } }), false);
});

test.after(() => {
  try {
    fs.rmSync(IN_PROCESS_STATE_DIR, { recursive: true, force: true });
  } catch {}
});
