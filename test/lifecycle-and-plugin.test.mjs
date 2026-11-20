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
const mcpHost = require(path.join(ROOT_DIR, 'plugin', 'mcp-host.js'));

function createMockCdpServer() {
  const receivedCalls = [];
  const sockets = new Set();
  let lastInjectedExpr = null;
  let lastRemovedExpr = null;
  let injectCount = 0;
  let removeCount = 0;

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
        removeCount += 1;
        result = { result: { type: 'object', value: { removed: 3 } } };
      } else {
        lastInjectedExpr = expr;
        injectCount += 1;
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
    getInjectCount: () => injectCount,
    getRemoveCount: () => removeCount,
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

function createMockLsServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function spawnMcpHost({
  workDir,
  cdpPort,
  lsAddress = '',
  antigravityConfigPath = '',
  standbyPollMs = 120,
  settleDelayMs = 0,
  configPath = path.join(workDir, 'config.json'),
}) {
  const env = {
    ...process.env,
    AG_CDP_PORT: String(cdpPort),
    ANTIGRAVITY_LS_ADDRESS: lsAddress,
    AGY_CLAUDE_STYLE_STATE_DIR: workDir,
    AGY_CLAUDE_STYLE_CONFIG: configPath,
    AGY_CLAUDE_STYLE_SKIP_LAUNCHER_PROVISION: '1',
    AGY_CLAUDE_STYLE_STANDBY_POLL_MS: String(standbyPollMs),
    AGY_CLAUDE_STYLE_SHUTDOWN_SETTLE_MS: String(settleDelayMs),
  };
  delete env.AGY_CLAUDE_STYLE_PLUGIN_DATA;
  if (antigravityConfigPath) {
    env.AGY_CLAUDE_STYLE_ANTIGRAVITY_CONFIG = antigravityConfigPath;
  } else {
    delete env.AGY_CLAUDE_STYLE_ANTIGRAVITY_CONFIG;
  }

  const child = spawn(process.execPath, [path.join(ROOT_DIR, 'plugin', 'mcp-host.js')], {
    cwd: ROOT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const responses = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      responses.push(JSON.parse(line));
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
  });

  return {
    child,
    pid: child.pid,
    responses,
    getStderr: () => stderrBuf,
    sendRpc(obj) {
      child.stdin.write(JSON.stringify(obj) + '\n');
    },
    async rpc(method, params = {}) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return await waitFor(() => responses.find((r) => r.id === id));
    },
    async handshake() {
      const initResp = await this.rpc('initialize', {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'test', version: '1.0' },
      });
      const toolsResp = await this.rpc('tools/list');
      return { initResp, toolsResp };
    },
    endStdin() {
      child.stdin.end();
    },
    kill(signal) {
      try {
        if (child.exitCode === null) child.kill(signal);
      } catch {}
    },
  };
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

test('Unit: watcher lock preserves mcp-plugin, replaces cli, cleans stale locks, and prevents split-brain', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-lock-unit-'));
  const pidFile = path.join(workDir, '.watch.pid');
  const lockFile = path.join(workDir, '.watch.lock.json');
  const sleepers = [];

  try {
    const sleeperA = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    sleepers.push(sleeperA);

    fs.writeFileSync(pidFile, String(sleeperA.pid), 'utf8');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: sleeperA.pid, mode: 'mcp-plugin', startedAt: new Date().toISOString() }),
      'utf8'
    );

    const preservedRes = await lifecycle.acquireWatcherLock({
      pidFile,
      lockFile,
      mode: 'mcp-plugin',
      replaceExisting: true,
      preserveModes: ['mcp-plugin'],
    });
    assert.equal(preservedRes.acquired, false);
    assert.equal(preservedRes.existingPid, sleeperA.pid);
    assert.equal(preservedRes.existingMode, 'mcp-plugin');
    assert.equal(preservedRes.preserved, true);
    assert.equal(lifecycle.isPidAlive(sleeperA.pid), true);

    const cliSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    sleepers.push(cliSleeper);
    fs.writeFileSync(pidFile, String(cliSleeper.pid), 'utf8');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: cliSleeper.pid, mode: 'cli', startedAt: new Date().toISOString() }),
      'utf8'
    );

    const replacedRes = await lifecycle.acquireWatcherLock({
      pidFile,
      lockFile,
      mode: 'mcp-plugin',
      replaceExisting: true,
      preserveModes: ['mcp-plugin'],
    });
    assert.equal(replacedRes.acquired, true);
    assert.equal(replacedRes.pid, process.pid);
    assert.equal(lifecycle.readWatcherPid(pidFile, lockFile), process.pid);
    await waitFor(() => !lifecycle.isPidAlive(cliSleeper.pid), 3000, 50);
    replacedRes.release();
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(fs.existsSync(lockFile), false);

    // Dead stale lock files are cleaned automatically before acquiring
    const deadPid = 9999999;
    fs.writeFileSync(pidFile, String(deadPid), 'utf8');
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: deadPid, mode: 'mcp-plugin', startedAt: '2020-01-01T00:00:00.000Z' }),
      'utf8'
    );
    const staleClaim = await lifecycle.acquireWatcherLock({
      pidFile,
      lockFile,
      mode: 'mcp-plugin',
      replaceExisting: true,
      preserveModes: ['mcp-plugin'],
    });
    assert.equal(staleClaim.acquired, true);
    staleClaim.release();

    // Concurrent acquireWatcherLock contention across OS processes allows strictly 1 winner
    const contenderScript = `
      const lifecycle = require(${JSON.stringify(path.join(ROOT_DIR, 'lifecycle.js'))});
      (async () => {
        const res = await lifecycle.acquireWatcherLock({
          pidFile: process.argv[1],
          lockFile: process.argv[2],
          mode: 'mcp-plugin',
          replaceExisting: true,
          preserveModes: ['mcp-plugin'],
        });
        process.stdout.write(JSON.stringify({ pid: process.pid, acquired: Boolean(res.acquired) }) + '\\n');
        setTimeout(() => {
          if (res.release) res.release();
          process.exit(0);
        }, res.acquired ? 450 : 200);
      })();
    `;
    const runContender = () =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ['-e', contenderScript, pidFile, lockFile], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        sleepers.push(proc);
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => (out += d.toString()));
        proc.stderr.on('data', (d) => (err += d.toString()));
        proc.on('exit', (code) => {
          try {
            const parsed = JSON.parse(out.trim());
            resolve({ code, ...parsed });
          } catch (e) {
            reject(new Error(`Contender failed (${code}): ${err || out || e.message}`));
          }
        });
      });

    const raceResults = await Promise.all([runContender(), runContender(), runContender()]);
    assert.equal(raceResults.filter((r) => r.acquired).length, 1);
  } finally {
    for (const s of sleepers) {
      try { if (s && s.exitCode === null) s.kill('SIGKILL'); } catch {}
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('Unit: host peer registry, plugin enabled-state reader, and empty healthz guard behave safely', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-host-reg-'));
  const sleepers = [];

  try {
    const selfLease = lifecycle.registerMcpHost({
      stateDir: workDir,
      pid: process.pid,
      lsAddress: '127.0.0.1:4242',
    });
    assert.equal(fs.existsSync(selfLease.filePath), true);

    const peerSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    sleepers.push(peerSleeper);
    const peerLease = lifecycle.registerMcpHost({
      stateDir: workDir,
      pid: peerSleeper.pid,
      lsAddress: '127.0.0.1:5353',
    });
    const deadLeasePath = path.join(lifecycle.getMcpHostsDir(workDir), '9999999.json');
    fs.writeFileSync(deadLeasePath, JSON.stringify({ pid: 9999999 }), 'utf8');

    const aliveWithoutSelf = lifecycle.listAliveMcpHosts({
      stateDir: workDir,
      excludePid: process.pid,
      pruneStale: true,
    });
    assert.equal(aliveWithoutSelf.length, 1);
    assert.equal(aliveWithoutSelf[0].pid, peerSleeper.pid);
    assert.equal(fs.existsSync(deadLeasePath), false);

    selfLease.unregister();
    assert.equal(fs.existsSync(selfLease.filePath), false);
    peerLease.unregister();

    const missingCfg = path.join(workDir, 'missing.json');
    assert.equal(lifecycle.readAntigravityPluginEnabledState({ configPath: missingCfg }), 'unknown');

    const badCfg = path.join(workDir, 'bad.json');
    fs.writeFileSync(badCfg, '{broken json', 'utf8');
    assert.equal(lifecycle.readAntigravityPluginEnabledState({ configPath: badCfg }), 'unknown');

    const emptyPluginsCfg = path.join(workDir, 'empty.json');
    fs.writeFileSync(emptyPluginsCfg, JSON.stringify({ plugins: {} }), 'utf8');
    assert.equal(lifecycle.readAntigravityPluginEnabledState({ configPath: emptyPluginsCfg }), 'unknown');

    const dirMatchCfg = path.join(workDir, 'dir-match.json');
    fs.writeFileSync(
      dirMatchCfg,
      JSON.stringify({
        plugins: {
          'agy-claude-style': { enabled: true },
          'custom-dir-name': { enabled: false },
        },
      }),
      'utf8'
    );
    assert.equal(
      lifecycle.readAntigravityPluginEnabledState({
        pluginName: 'agy-claude-style',
        pluginRoot: path.join(workDir, 'custom-dir-name'),
        configPath: dirMatchCfg,
      }),
      'disabled'
    );
    assert.equal(
      lifecycle.readAntigravityPluginEnabledState({
        pluginName: 'agy-claude-style',
        pluginRoot: path.join(workDir, 'other-dir'),
        configPath: dirMatchCfg,
      }),
      'enabled'
    );

    assert.equal(await mcpHost.isHostStillAlive('stdin-end', null), false);
    assert.equal(await mcpHost.isHostStillAlive('stdin-close', ''), false);
  } finally {
    for (const s of sleepers) {
      try { if (s && s.exitCode === null) s.kill('SIGKILL'); } catch {}
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('E2E A: Desktop leader + TUI standby coexist and TUI exit preserves Desktop watcher and UI', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-e2e-a-'));
  const mockCdp = createMockCdpServer();
  const desktopLs = createMockLsServer();
  const tuiLs = createMockLsServer();
  let hostDesktop = null;
  let hostTui = null;

  try {
    const cdpPort = await mockCdp.start();
    const desktopLsPort = await desktopLs.start();
    const tuiLsPort = await tuiLs.start();
    const pidFile = path.join(workDir, '.watch.pid');

    hostDesktop = spawnMcpHost({
      workDir,
      cdpPort,
      lsAddress: `127.0.0.1:${desktopLsPort}`,
    });
    const hsA = await hostDesktop.handshake();
    assert.equal(hsA.initResp.result.serverInfo.name, 'agy-claude-style-host');
    assert.deepEqual(hsA.toolsResp.result.tools, []);
    await waitFor(() => mockCdp.getInjectCount() >= 1);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(hostDesktop.pid));

    hostTui = spawnMcpHost({
      workDir,
      cdpPort,
      lsAddress: `127.0.0.1:${tuiLsPort}`,
    });
    const hsB = await hostTui.handshake();
    assert.equal(hsB.initResp.result.serverInfo.name, 'agy-claude-style-host');
    assert.deepEqual(hsB.toolsResp.result.tools, []);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(lifecycle.isPidAlive(hostDesktop.pid), true);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(hostDesktop.pid));
    assert.equal(mockCdp.getActiveSocketCount(), 1);

    // TUI exits while TUI LS is still momentarily reachable
    hostTui.endStdin();
    const tuiCode = await waitForExit(hostTui.child, 6000);
    assert.equal(tuiCode, 0);
    assert.equal(mockCdp.getRemoveCount(), 0);
    assert.equal(lifecycle.isPidAlive(hostDesktop.pid), true);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(hostDesktop.pid));
    assert.equal(mockCdp.getActiveSocketCount(), 1);
  } finally {
    hostTui?.kill('SIGKILL');
    hostDesktop?.kill('SIGKILL');
    await Promise.allSettled([
      hostTui ? waitForExit(hostTui.child, 2000).catch(() => {}) : Promise.resolve(),
      hostDesktop ? waitForExit(hostDesktop.child, 2000).catch(() => {}) : Promise.resolve(),
    ]);
    await mockCdp.close().catch(() => {});
    await desktopLs.close().catch(() => {});
    await tuiLs.close().catch(() => {});
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('E2E B: TUI leader exits cleanly and Desktop standby promotes seamlessly with setting binding intact', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-e2e-b-'));
  const mockCdp = createMockCdpServer();
  const tuiLs = createMockLsServer();
  const desktopLs = createMockLsServer();
  let hostTui = null;
  let hostDesktop = null;

  try {
    const cdpPort = await mockCdp.start();
    const tuiLsPort = await tuiLs.start();
    const desktopLsPort = await desktopLs.start();
    const pidFile = path.join(workDir, '.watch.pid');

    hostTui = spawnMcpHost({
      workDir,
      cdpPort,
      lsAddress: `127.0.0.1:${tuiLsPort}`,
    });
    await hostTui.handshake();
    await waitFor(() => mockCdp.getInjectCount() >= 1);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(hostTui.pid));

    hostDesktop = spawnMcpHost({
      workDir,
      cdpPort,
      lsAddress: `127.0.0.1:${desktopLsPort}`,
      standbyPollMs: 120,
    });
    await hostDesktop.handshake();
    await waitFor(() =>
      lifecycle.listAliveMcpHosts({ stateDir: workDir, excludePid: 0, pruneStale: false }).length === 2
    );

    const injectsBeforeHandover = mockCdp.getInjectCount();
    hostTui.endStdin();
    const tuiCode = await waitForExit(hostTui.child, 6000);
    assert.equal(tuiCode, 0);
    assert.equal(mockCdp.getRemoveCount(), 0);

    await waitFor(
      () =>
        fs.existsSync(pidFile) &&
        fs.readFileSync(pidFile, 'utf8').trim() === String(hostDesktop.pid) &&
        mockCdp.getActiveSocketCount() === 1 &&
        mockCdp.getInjectCount() > injectsBeforeHandover,
      6000,
      50
    );

    mockCdp.emitBindingCalled(cdp.SETTING_BINDING, { key: 'palette', value: 'claude' });
    const cfgPath = path.join(workDir, 'config.json');
    await waitFor(
      () => fs.existsSync(cfgPath) && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).palette === 'claude',
      4000,
      50
    );
  } finally {
    hostTui?.kill('SIGKILL');
    hostDesktop?.kill('SIGKILL');
    await Promise.allSettled([
      hostTui ? waitForExit(hostTui.child, 2000).catch(() => {}) : Promise.resolve(),
      hostDesktop ? waitForExit(hostDesktop.child, 2000).catch(() => {}) : Promise.resolve(),
    ]);
    await mockCdp.close().catch(() => {});
    await tuiLs.close().catch(() => {});
    await desktopLs.close().catch(() => {});
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('E2E C: Leader SIGKILL crash triggers stale lock/lease cleanup and standby automatic promotion', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-e2e-c-'));
  const mockCdp = createMockCdpServer();
  let hostA = null;
  let hostB = null;

  try {
    const cdpPort = await mockCdp.start();
    const pidFile = path.join(workDir, '.watch.pid');

    hostA = spawnMcpHost({ workDir, cdpPort, standbyPollMs: 120 });
    await hostA.handshake();
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(hostA.pid));

    hostB = spawnMcpHost({ workDir, cdpPort, standbyPollMs: 120 });
    await hostB.handshake();
    const leaseA = path.join(lifecycle.getMcpHostsDir(workDir), `${hostA.pid}.json`);
    await waitFor(() => fs.existsSync(leaseA));

    const injectsBeforeCrash = mockCdp.getInjectCount();
    hostA.kill('SIGKILL');
    await waitForExit(hostA.child, 4000);

    await waitFor(
      () =>
        fs.existsSync(pidFile) &&
        fs.readFileSync(pidFile, 'utf8').trim() === String(hostB.pid) &&
        !fs.existsSync(leaseA) &&
        mockCdp.getInjectCount() > injectsBeforeCrash,
      6000,
      60
    );
    assert.equal(mockCdp.getActiveSocketCount(), 1);
  } finally {
    hostA?.kill('SIGKILL');
    hostB?.kill('SIGKILL');
    await Promise.allSettled([
      hostA ? waitForExit(hostA.child, 2000).catch(() => {}) : Promise.resolve(),
      hostB ? waitForExit(hostB.child, 2000).catch(() => {}) : Promise.resolve(),
    ]);
    await mockCdp.close().catch(() => {});
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('E2E D: Simultaneous cold-start race produces single CDP leader and two live MCP hosts', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-e2e-d-'));
  const mockCdp = createMockCdpServer();
  let hostA = null;
  let hostB = null;

  try {
    const cdpPort = await mockCdp.start();
    const pidFile = path.join(workDir, '.watch.pid');

    hostA = spawnMcpHost({ workDir, cdpPort, standbyPollMs: 150 });
    hostB = spawnMcpHost({ workDir, cdpPort, standbyPollMs: 150 });

    const [hsA, hsB] = await Promise.all([hostA.handshake(), hostB.handshake()]);
    assert.deepEqual(hsA.toolsResp.result.tools, []);
    assert.deepEqual(hsB.toolsResp.result.tools, []);

    await waitFor(() => mockCdp.getInjectCount() >= 1 && fs.existsSync(pidFile));
    await new Promise((r) => setTimeout(r, 250));

    const leaderPid = fs.readFileSync(pidFile, 'utf8').trim();
    assert.ok(leaderPid === String(hostA.pid) || leaderPid === String(hostB.pid));
    assert.equal(lifecycle.isPidAlive(hostA.pid), true);
    assert.equal(lifecycle.isPidAlive(hostB.pid), true);
    assert.equal(mockCdp.getActiveSocketCount(), 1);
  } finally {
    hostA?.kill('SIGKILL');
    hostB?.kill('SIGKILL');
    await Promise.allSettled([
      hostA ? waitForExit(hostA.child, 2000).catch(() => {}) : Promise.resolve(),
      hostB ? waitForExit(hostB.child, 2000).catch(() => {}) : Promise.resolve(),
    ]);
    await mockCdp.close().catch(() => {});
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('E2E E: Single-host exit without plugin disable preserves UI (empty LS and enabled config)', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-e2e-e-'));
  const mockCdp = createMockCdpServer();
  const lsServer = createMockLsServer();
  let host1 = null;
  let host2 = null;

  try {
    const cdpPort = await mockCdp.start();
    const lsPort = await lsServer.start();

    // Subcase 1: Single host with empty ANTIGRAVITY_LS_ADDRESS (e.g. TUI)
    host1 = spawnMcpHost({ workDir, cdpPort, lsAddress: '' });
    await host1.handshake();
    await waitFor(() => mockCdp.getInjectCount() >= 1);
    host1.endStdin();
    const code1 = await waitForExit(host1.child, 6000);
    assert.equal(code1, 0);
    assert.equal(mockCdp.getRemoveCount(), 0);

    // Subcase 2: Single host with reachable LS + explicit plugins["agy-claude-style"].enabled: true
    const antigravityCfg = path.join(workDir, 'antigravity-config.json');
    fs.writeFileSync(
      antigravityCfg,
      JSON.stringify({ plugins: { 'agy-claude-style': { enabled: true } } }, null, 2),
      'utf8'
    );
    host2 = spawnMcpHost({
      workDir,
      cdpPort,
      lsAddress: `127.0.0.1:${lsPort}`,
      antigravityConfigPath: antigravityCfg,
    });
    await host2.handshake();
    await waitFor(() => mockCdp.getInjectCount() >= 2);
    host2.endStdin();
    const code2 = await waitForExit(host2.child, 6000);
    assert.equal(code2, 0);
    assert.equal(mockCdp.getRemoveCount(), 0);
  } finally {
    host1?.kill('SIGKILL');
    host2?.kill('SIGKILL');
    await Promise.allSettled([
      host1 ? waitForExit(host1.child, 2000).catch(() => {}) : Promise.resolve(),
      host2 ? waitForExit(host2.child, 2000).catch(() => {}) : Promise.resolve(),
    ]);
    await mockCdp.close().catch(() => {});
    await lsServer.close().catch(() => {});
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('E2E F: Plugin disable removes live UI despite concurrent TUI standby, and re-enable resumes cleanly', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-e2e-f-'));
  const mockCdp = createMockCdpServer();
  const lsA = createMockLsServer();
  const lsB = createMockLsServer();
  let hostA = null;
  let hostB = null;

  try {
    const cdpPort = await mockCdp.start();
    const lsAPort = await lsA.start();
    const lsBPort = await lsB.start();
    const pidFile = path.join(workDir, '.watch.pid');
    const antigravityCfg = path.join(workDir, 'antigravity-config.json');
    const writeEnabled = (enabled) => {
      fs.writeFileSync(
        antigravityCfg,
        JSON.stringify({ plugins: { 'agy-claude-style': { enabled } } }, null, 2),
        'utf8'
      );
    };

    writeEnabled(true);

    hostA = spawnMcpHost({
      workDir,
      cdpPort,
      lsAddress: `127.0.0.1:${lsAPort}`,
      antigravityConfigPath: antigravityCfg,
      standbyPollMs: 100,
    });
    await hostA.handshake();
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(hostA.pid));

    hostB = spawnMcpHost({
      workDir,
      cdpPort,
      lsAddress: `127.0.0.1:${lsBPort}`,
      antigravityConfigPath: antigravityCfg,
      standbyPollMs: 100,
    });
    await hostB.handshake();

    // Disable plugin in config and close leader host A (simulating Settings toggle off)
    writeEnabled(false);
    hostA.endStdin();
    const codeA = await waitForExit(hostA.child, 6000);
    assert.equal(codeA, 0);
    assert.ok(mockCdp.getRemoveCount() >= 1);

    const injectCountWhileDisabled = mockCdp.getInjectCount();
    await new Promise((r) => setTimeout(r, 400));
    const pingB = await hostB.rpc('ping');
    assert.deepEqual(pingB.result, {});
    assert.equal(fs.existsSync(pidFile), false);
    assert.equal(mockCdp.getInjectCount(), injectCountWhileDisabled);

    // Re-enable plugin: standby host B promotes and re-injects automatically
    writeEnabled(true);
    await waitFor(
      () =>
        fs.existsSync(pidFile) &&
        fs.readFileSync(pidFile, 'utf8').trim() === String(hostB.pid) &&
        mockCdp.getInjectCount() > injectCountWhileDisabled,
      6000,
      60
    );
  } finally {
    hostA?.kill('SIGKILL');
    hostB?.kill('SIGKILL');
    await Promise.allSettled([
      hostA ? waitForExit(hostA.child, 2000).catch(() => {}) : Promise.resolve(),
      hostB ? waitForExit(hostB.child, 2000).catch(() => {}) : Promise.resolve(),
    ]);
    await mockCdp.close().catch(() => {});
    await lsA.close().catch(() => {});
    await lsB.close().catch(() => {});
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});

test('E2E G: Native mcp-host.js still replaces legacy CLI watcher seamlessly', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-e2e-g-'));
  const mockCdp = createMockCdpServer();
  let cliChild = null;
  let mcpChild = null;

  try {
    const cdpPort = await mockCdp.start();
    const pidFile = path.join(workDir, '.watch.pid');
    const cliEnv = {
      ...process.env,
      AG_CDP_PORT: String(cdpPort),
      AGY_CLAUDE_STYLE_STATE_DIR: workDir,
      AGY_CLAUDE_STYLE_CONFIG: path.join(workDir, 'config.json'),
      ANTIGRAVITY_LS_ADDRESS: '',
    };
    delete cliEnv.AGY_CLAUDE_STYLE_PLUGIN_DATA;

    cliChild = spawn(process.execPath, [path.join(ROOT_DIR, 'inject.js'), '--watch'], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cliEnv,
    });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(cliChild.pid));

    mcpChild = spawnMcpHost({ workDir, cdpPort });
    await mcpChild.handshake();

    await waitForExit(cliChild, 6000);
    await waitFor(
      () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(mcpChild.pid),
      6000,
      50
    );
  } finally {
    try { if (cliChild && cliChild.exitCode === null) cliChild.kill('SIGKILL'); } catch {}
    mcpChild?.kill('SIGKILL');
    await Promise.allSettled([
      cliChild ? waitForExit(cliChild, 2000).catch(() => {}) : Promise.resolve(),
      mcpChild ? waitForExit(mcpChild.child, 2000).catch(() => {}) : Promise.resolve(),
    ]);
    await mockCdp.close().catch(() => {});
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
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
  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'Plugin Sidecar',
      url: 'plugin://abc123.host/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/8',
    }),
    false
  );
  assert.equal(
    cdp.isAntigravityPageTarget({
      type: 'page',
      title: 'Favicon',
      url: 'agy-favicon://tok123/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/9',
    }),
    false
  );

  assert.equal(isLocalHostRequest(), true);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', origin: 'http://127.0.0.1:5100' } }), true);
  assert.equal(isLocalHostRequest({ headers: { host: 'localhost:5100', origin: 'vscode-webview://abc123' } }), true);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', origin: 'plugin://abc123.host' } }), true);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', origin: 'plugin://evil/path' } }), false);
  assert.equal(isLocalHostRequest({ headers: { host: 'evil.com:5100' } }), false);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', origin: 'http://127.0.0.1:9999' } }), false);
  assert.equal(isLocalHostRequest({ headers: { host: '127.0.0.1:5100', 'sec-fetch-site': 'cross-site' } }), false);
});

test.after(() => {
  try {
    fs.rmSync(IN_PROCESS_STATE_DIR, { recursive: true, force: true });
  } catch {}
});
