// Zero-tool MCP Stdio lifecycle host for the native AGY Claude Style plugin.
// - Exposes 0 tools (`tools/list -> []`) so it consumes 0 context tokens.
// - Launches and supervises the CDP watcher inside the Antigravity plugin lifecycle.
// - Detects both plugin disable (stdin close while LS is still alive -> live restore UI)
//   and host shutdown (LS /healthz unreachable or parent exit -> immediate clean exit with zero orphans).
const fs = require('fs');
const path = require('path');
const {
  isBrokenPipeError,
  normalizeLsHealthzUrl,
  startHostWatchdog,
  ensureIdeRemoteDebuggingArgv,
  ensureDesktopRemoteDebuggingLaunchers,
  exitProcessCleanly,
} = require('../lifecycle');
const { updateConfigSetting } = require('../inject');
const { startWatchController } = require('../watcher-core');

const PLUGIN_MANIFEST_PATH = path.resolve(__dirname, '..', 'plugin.json');

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

function readPluginVersion() {
  try {
    if (fs.existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {}
  return '1.0.0';
}

function handleMcpJsonRpcMessage(msg, serverVersion = '1.0.0') {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) return null;

  const id = msg.id;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'agy-claude-style-host',
          version: serverVersion,
        },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [] } };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }

  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

async function isHostStillAlive(reason, healthzUrl) {
  if (reason === 'ls-dead' || reason === 'parent-dead') return false;
  if (!healthzUrl) {
    return reason === 'stdin-end' || reason === 'stdin-close';
  }
  try {
    await fetch(healthzUrl, { signal: AbortSignal.timeout(450) });
    return true;
  } catch {
    return false;
  }
}

function startMcpPluginHost() {
  const serverVersion = readPluginVersion();
  const healthzUrl = normalizeLsHealthzUrl(process.env.ANTIGRAVITY_LS_ADDRESS);
  let shuttingDown = false;
  let framingMode = 'line';
  let rawBuffer = Buffer.alloc(0);

  try {
    ensureIdeRemoteDebuggingArgv();
  } catch {}
  void ensureDesktopRemoteDebuggingLaunchers({ enabled: true }).catch(() => {});

  let controller = null;
  const controllerPromise = startWatchController({
    mode: 'mcp-plugin',
    keepAlive: true,
    watchHostExit: false,
    watchStdin: false,
    replaceExisting: true,
    enableConsole: false,
    lsAddress: '',
    updateConfigSetting,
  })
    .then((ctrl) => {
      controller = ctrl;
      return ctrl;
    })
    .catch(() => null);

  let watchdog = null;

  async function shutdownHost(reason = 'shutdown') {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watchdog) {
      watchdog.stop();
      watchdog = null;
    }

    const forceTimer = setTimeout(() => {
      process.exit(0);
    }, 1800);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    try {
      const hostAlive = await isHostStillAlive(reason, healthzUrl);
      const ctrl = controller || (await Promise.race([
        controllerPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 400)),
      ]));
      if (ctrl) {
        await ctrl.stop({ removeFromPages: hostAlive, exitCode: 0, reason });
      }
    } catch {
      // Ignore shutdown errors
    } finally {
      clearTimeout(forceTimer);
      exitProcessCleanly(0, 50);
    }
  }

  const onPipeError = (err) => {
    if (isBrokenPipeError(err)) {
      void shutdownHost('broken-pipe');
    }
  };
  process.stdout?.on('error', onPipeError);
  process.stderr?.on('error', onPipeError);

  watchdog = startHostWatchdog({
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
    watchStdin: true,
    checkIntervalMs: 3000,
    maxLsFailures: 2,
    onShutdown: (reason) => {
      void shutdownHost(reason);
    },
  });

  function writeJsonRpcResponse(payload, mode) {
    if (shuttingDown) return;
    try {
      const serialized = JSON.stringify(payload);
      if (mode === 'lsp') {
        const byteLen = Buffer.byteLength(serialized, 'utf8');
        process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
      } else {
        process.stdout.write(`${serialized}\n`);
      }
    } catch (err) {
      onPipeError(err);
    }
  }

  function dispatchParsedPayload(parsed, mode) {
    if (Array.isArray(parsed)) {
      const batchOut = parsed
        .map((item) => handleMcpJsonRpcMessage(item, serverVersion))
        .filter(Boolean);
      if (batchOut.length > 0) {
        writeJsonRpcResponse(batchOut, mode);
      }
      return;
    }
    const response = handleMcpJsonRpcMessage(parsed, serverVersion);
    if (response) {
      writeJsonRpcResponse(response, mode);
    }
  }

  function drainInputBuffer() {
    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');
      if (/^Content-Length:/i.test(preview.trimStart())) {
        framingMode = 'lsp';
        const sepIdx = rawBuffer.indexOf('\r\n\r\n');
        const lfSepIdx = sepIdx < 0 ? rawBuffer.indexOf('\n\n') : -1;
        const headerEnd = sepIdx >= 0 ? sepIdx : lfSepIdx;
        const sepLen = sepIdx >= 0 ? 4 : 2;
        if (headerEnd < 0) return;

        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rawBuffer = rawBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(lenMatch[1]);
        const totalFrameLen = headerEnd + sepLen + contentLen;
        if (rawBuffer.length < totalFrameLen) return;

        const bodyStr = rawBuffer.subarray(headerEnd + sepLen, totalFrameLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalFrameLen);
        try {
          dispatchParsedPayload(JSON.parse(bodyStr), 'lsp');
        } catch {}
        continue;
      }

      const nlIdx = rawBuffer.indexOf(0x0a);
      if (nlIdx < 0) return;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        dispatchParsedPayload(JSON.parse(lineStr), framingMode);
      } catch {}
    }
  }

  process.stdin.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    rawBuffer = rawBuffer.length === 0 ? buf : Buffer.concat([rawBuffer, buf]);
    drainInputBuffer();
  });
  process.stdin.resume();
}

if (require.main === module) {
  startMcpPluginHost();
}

module.exports = {
  readPluginVersion,
  handleMcpJsonRpcMessage,
  startMcpPluginHost,
};
