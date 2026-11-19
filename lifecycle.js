// Shared lifecycle, safe logging, and orphan-prevention helpers for AGY Claude Style.
// Zero external dependencies (Node >= 22).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BROKEN_PIPE_CODES = new Set([
  'EPIPE',
  'EOF',
  'EBADF',
  'ERR_STREAM_DESTROYED',
  'ERR_IPC_CHANNEL_CLOSED',
]);

function isBrokenPipeError(err) {
  if (!err) return false;
  if (err.code && BROKEN_PIPE_CODES.has(err.code)) return true;
  const msg = String(err.message || err || '').toLowerCase();
  return (
    msg.includes('epipe') ||
    msg.includes('stream was destroyed') ||
    msg.includes('write after end') ||
    msg.includes('write eof')
  );
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function createSafeLogger({ logFile = null, enableConsole = true, maxLogBytes = 1024 * 1024, onBrokenPipe } = {}) {
  let stdioBroken = false;
  let brokenNotified = false;
  let inErrorHandler = false;

  const notifyBroken = (err) => {
    stdioBroken = true;
    if (!brokenNotified) {
      brokenNotified = true;
      if (typeof onBrokenPipe === 'function') {
        try {
          onBrokenPipe(err);
        } catch {}
      }
    }
  };

  const attachStreamErrorGuard = (stream) => {
    if (!stream || typeof stream.on !== 'function') return () => {};
    const onErr = (err) => {
      if (isBrokenPipeError(err)) {
        notifyBroken(err);
      }
    };
    stream.on('error', onErr);
    return () => {
      try {
        stream.off('error', onErr);
      } catch {}
    };
  };

  const detachStdout = attachStreamErrorGuard(process.stdout);
  const detachStderr = attachStreamErrorGuard(process.stderr);

  const writeToLogFile = (line) => {
    if (!logFile) return;
    try {
      try {
        const st = fs.statSync(logFile);
        if (st.size > maxLogBytes) {
          fs.writeFileSync(logFile, '', 'utf8');
        }
      } catch {}
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {}
  };

  const log = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (enableConsole && !stdioBroken) {
      try {
        const out = process.stdout;
        if (!out || out.destroyed || out.writableEnded || out.writable === false) {
          notifyBroken(new Error('stdout destroyed'));
        } else {
          console.log(line);
        }
      } catch (err) {
        if (isBrokenPipeError(err)) {
          notifyBroken(err);
        }
      }
    }
    writeToLogFile(line);
  };

  const resetLogFile = () => {
    if (!logFile) return;
    try {
      fs.writeFileSync(logFile, '', 'utf8');
    } catch {}
  };

  const installProcessErrorGuards = ({ onFatalPipe } = {}) => {
    const handleAsyncError = (kind, err) => {
      if (isBrokenPipeError(err)) {
        notifyBroken(err);
        if (typeof onFatalPipe === 'function') {
          try {
            onFatalPipe(err);
          } catch {}
        }
        return;
      }
      if (inErrorHandler) return;
      inErrorHandler = true;
      try {
        const detail = err && err.stack ? err.stack : String(err);
        writeToLogFile(`[!] ${kind}: ${detail}`);
      } finally {
        inErrorHandler = false;
      }
    };

    const onUncaught = (err) => handleAsyncError('未捕获异常', err);
    const onUnhandled = (err) => handleAsyncError('未处理 Promise 拒绝', err);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    return () => {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    };
  };

  const dispose = () => {
    detachStdout();
    detachStderr();
  };

  return {
    log,
    resetLogFile,
    installProcessErrorGuards,
    isStdioBroken: () => stdioBroken,
    dispose,
  };
}

function createIdleHostTracker({ maxIdleFailures = 3, keepAlive = false } = {}) {
  const threshold = Math.max(1, Number(maxIdleFailures) || 3);
  let hadAttachedWindow = false;
  let consecutiveFailures = 0;

  return {
    markAttached() {
      hadAttachedWindow = true;
      consecutiveFailures = 0;
    },
    recordTick({ reachable, pageCount = 0, attachedCount = 0 }) {
      if (reachable && (pageCount > 0 || attachedCount > 0)) {
        consecutiveFailures = 0;
        if (attachedCount > 0) hadAttachedWindow = true;
        return;
      }
      if (hadAttachedWindow && attachedCount === 0) {
        consecutiveFailures += 1;
      }
    },
    shouldExit() {
      return !keepAlive && hadAttachedWindow && consecutiveFailures >= threshold;
    },
    shouldBackoff() {
      return Boolean(keepAlive) && hadAttachedWindow && consecutiveFailures >= threshold;
    },
    getState() {
      return { hadAttachedWindow, consecutiveFailures, threshold, keepAlive: Boolean(keepAlive) };
    },
  };
}

function normalizeLsHealthzUrl(lsAddress) {
  const raw = String(lsAddress || '').trim();
  if (!raw || raw === 'test.invalid') return null;
  const base = /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw.replace(/\/+$/, '')}`;
  return `${base}/healthz`;
}

function startHostWatchdog({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS,
  parentPid = 0,
  watchStdin = false,
  checkIntervalMs = 3500,
  maxLsFailures = 2,
  onShutdown,
} = {}) {
  const healthzUrl = normalizeLsHealthzUrl(lsAddress);
  const ppid = Number.isInteger(parentPid) && parentPid > 0 ? parentPid : 0;
  let stopped = false;
  let triggered = false;
  let lsFailures = 0;
  let polling = false;
  let intervalTimer = null;

  const cleanups = [];

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn();
      } catch {}
    }
  };

  const trigger = (reason) => {
    if (stopped || triggered) return;
    triggered = true;
    stop();
    if (typeof onShutdown === 'function') {
      Promise.resolve().then(() => onShutdown(reason)).catch(() => {});
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    const handler = () => trigger(`signal:${sig}`);
    try {
      process.on(sig, handler);
      cleanups.push(() => process.off(sig, handler));
    } catch {}
  }

  if (watchStdin && process.stdin) {
    const onEnd = () => trigger('stdin-end');
    const onClose = () => trigger('stdin-close');
    const onErr = (err) => {
      if (isBrokenPipeError(err)) trigger('stdin-error');
    };
    process.stdin.on('end', onEnd);
    process.stdin.on('close', onClose);
    process.stdin.on('error', onErr);
    cleanups.push(() => {
      try {
        process.stdin.off('end', onEnd);
        process.stdin.off('close', onClose);
        process.stdin.off('error', onErr);
      } catch {}
    });
  }

  const checkHost = async () => {
    if (stopped || triggered) return;
    if (ppid > 0 && !isPidAlive(ppid)) {
      trigger('parent-dead');
      return;
    }
    if (!healthzUrl || polling) return;
    polling = true;
    try {
      await fetch(healthzUrl, { signal: AbortSignal.timeout(1500) });
      lsFailures = 0;
    } catch {
      lsFailures += 1;
      if (lsFailures >= Math.max(1, maxLsFailures)) {
        trigger('ls-dead');
      }
    } finally {
      polling = false;
    }
  };

  if (ppid > 0 || healthzUrl) {
    intervalTimer = setInterval(() => {
      void checkHost();
    }, Math.max(100, checkIntervalMs));
    if (typeof intervalTimer.unref === 'function') {
      intervalTimer.unref();
    }
  }

  return {
    stop,
    isTriggered: () => triggered,
    checkNow: checkHost,
  };
}

function readWatcherPid(pidFile, lockFile) {
  try {
    const raw = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  } catch {}
  if (lockFile) {
    try {
      const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const pid = parseInt(data && data.pid, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
  }
  return null;
}

async function waitForPidExit(pid, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return !isPidAlive(pid);
}

async function acquireWatcherLock({ pidFile, lockFile, mode = 'watch', replaceExisting = false } = {}) {
  const existingPid = readWatcherPid(pidFile, lockFile);
  if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
    if (!replaceExisting) {
      return { acquired: false, existingPid };
    }
    try {
      process.kill(existingPid);
    } catch {}
    await waitForPidExit(existingPid, 1200);
  }

  fs.writeFileSync(pidFile, String(process.pid), 'utf8');
  if (lockFile) {
    try {
      fs.writeFileSync(
        lockFile,
        JSON.stringify(
          {
            pid: process.pid,
            mode,
            dir: path.dirname(pidFile),
            startedAt: new Date().toISOString(),
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
    } catch {}
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const curPid = fs.readFileSync(pidFile, 'utf8').trim();
      if (curPid === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {}
    if (lockFile) {
      try {
        const meta = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (meta && Number(meta.pid) === process.pid) {
          fs.unlinkSync(lockFile);
        }
      } catch {}
    }
  };

  process.on('exit', release);
  return {
    acquired: true,
    pid: process.pid,
    release: () => {
      process.off('exit', release);
      release();
    },
  };
}

function stripJsonc(rawText) {
  let out = '';
  let i = 0;
  const text = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Remove trailing commas before } or ] outside strings
  return out.replace(/,\s*([}\]])/g, '$1');
}

function ensureIdeRemoteDebuggingArgv(env = process.env, homeDir = os.homedir()) {
  const portableRoot = String(env.VSCODE_PORTABLE || '').trim();
  const ideDir = portableRoot || path.join(homeDir, '.antigravity-ide');
  if (!fs.existsSync(ideDir)) {
    return { changed: false, skipped: 'ide-dir-missing' };
  }
  const argvPath = path.join(ideDir, 'argv.json');
  if (!fs.existsSync(argvPath)) {
    const fresh =
      '{\n\t// Automatically configured by agy-claude-style for Antigravity IDE CDP support.\n\t"remote-debugging-port": "0"\n}\n';
    try {
      fs.writeFileSync(argvPath, fresh, 'utf8');
      return { changed: true, created: true, path: argvPath };
    } catch (err) {
      return { changed: false, error: err.message };
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(argvPath, 'utf8');
  } catch (err) {
    return { changed: false, error: err.message };
  }
  if (!raw.trim()) {
    const fresh =
      '{\n\t// Automatically configured by agy-claude-style for Antigravity IDE CDP support.\n\t"remote-debugging-port": "0"\n}\n';
    fs.writeFileSync(argvPath, fresh, 'utf8');
    return { changed: true, created: true, path: argvPath };
  }

  const cleaned = stripJsonc(raw);
  if (!cleaned) {
    return { changed: false, skipped: 'invalid-jsonc' };
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { changed: false, skipped: 'invalid-jsonc' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { changed: false, skipped: 'not-object' };
  }
  if (
    typeof parsed['remote-debugging-port'] === 'string' &&
    parsed['remote-debugging-port'].trim().length > 0
  ) {
    return { changed: false, alreadyConfigured: true, path: argvPath };
  }

  // If present as non-string or empty string, replace in-place cleanly or insert before closing brace
  let nextText;
  const keyPropRe = /("remote-debugging-port"\s*:\s*)(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false|null)/;
  if (Object.prototype.hasOwnProperty.call(parsed, 'remote-debugging-port') && keyPropRe.test(raw)) {
    nextText = raw.replace(keyPropRe, '$1"0"');
  } else {
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace < 0) return { changed: false, skipped: 'missing-brace' };
    const before = raw.slice(0, lastBrace).replace(/\s+$/, '');
    const needsComma = !before.endsWith('{') && !before.endsWith(',');
    const sep = needsComma ? ',\n\t' : '\n\t';
    nextText = `${before}${sep}"remote-debugging-port": "0"\n${raw.slice(lastBrace)}`;
  }

  try {
    fs.writeFileSync(argvPath, nextText, 'utf8');
    return { changed: true, path: argvPath };
  } catch (err) {
    return { changed: false, error: err.message };
  }
}

const REMOTE_DEBUG_LAUNCH_FLAG = '--remote-debugging-port=0';
const REMOTE_DEBUG_ANY_RE = /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i;
const REMOTE_DEBUG_MANAGED_ZERO_RE = /(?:^|\s+)--remote-debugging-port=(?:"0"|'0'|0)(?=\s|$)/gi;

function ensureRemoteDebugFlagInArgs(rawArgs, { enabled = true } = {}) {
  const current = String(rawArgs ?? '').trim();
  if (enabled) {
    if (REMOTE_DEBUG_ANY_RE.test(current)) {
      return {
        changed: false,
        configured: true,
        alreadyConfigured: true,
        args: current,
      };
    }
    const nextArgs = current
      ? `${current} ${REMOTE_DEBUG_LAUNCH_FLAG}`
      : REMOTE_DEBUG_LAUNCH_FLAG;
    return {
      changed: true,
      configured: true,
      args: nextArgs,
    };
  }

  REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
  if (!REMOTE_DEBUG_MANAGED_ZERO_RE.test(current)) {
    REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
    return {
      changed: false,
      configured: REMOTE_DEBUG_ANY_RE.test(current),
      removed: false,
      args: current,
    };
  }
  REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
  const stripped = current
    .replace(REMOTE_DEBUG_MANAGED_ZERO_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return {
    changed: stripped !== current,
    configured: REMOTE_DEBUG_ANY_RE.test(stripped),
    removed: stripped !== current,
    args: stripped,
  };
}

function patchWindowsRunRegistryCommand(rawValue, { enabled = true } = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const m = raw.match(/^\s*(?:"([^"]+)"|([^\s"]+))([\s\S]*)$/);
  if (!m) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const exePath = String(m[1] || m[2] || '').trim();
  const exeLeaf = exePath.split(/[\\/]/).pop() || '';
  if (exeLeaf.toLowerCase() !== 'antigravity.exe') {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const quotedExe = m[1] ? `"${exePath}"` : /\s/.test(exePath) ? `"${exePath}"` : exePath;
  const patchedArgs = ensureRemoteDebugFlagInArgs(m[3] || '', { enabled });
  const nextValue = patchedArgs.args ? `${quotedExe} ${patchedArgs.args}` : quotedExe;
  return {
    matched: true,
    changed: nextValue !== raw,
    configured: patchedArgs.configured,
    value: nextValue,
  };
}

function patchLinuxDesktopEntryText(rawText, { enabled = true } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { matched: false, changed: false, configured: false, text: String(rawText || '') };
  }
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawText.split(/\r?\n/);
  let matched = false;
  let changed = false;
  let configured = false;

  const nextLines = lines.map((line) => {
    const execMatch = line.match(/^(\s*Exec\s*=\s*)(.+)$/);
    if (!execMatch) return line;
    const prefix = execMatch[1];
    const cmdBody = execMatch[2].trim();
    const binMatch = cmdBody.match(/^(?:"([^"]+)"|'([^']+)'|([^\s"']+))([\s\S]*)$/);
    if (!binMatch) return line;
    const rawBin = String(binMatch[1] || binMatch[2] || binMatch[3] || '');
    const leaf = (rawBin.split('/').pop() || '').toLowerCase();
    if (leaf !== 'antigravity') {
      return line;
    }
    matched = true;
    const binToken = binMatch[1]
      ? `"${binMatch[1]}"`
      : binMatch[2]
        ? `'${binMatch[2]}'`
        : binMatch[3];
    const rest = String(binMatch[4] || '').trim();

    if (enabled) {
      if (REMOTE_DEBUG_ANY_RE.test(rest)) {
        configured = true;
        return line;
      }
      configured = true;
      changed = true;
      const fieldCodeMatch = rest.match(/^(.*?)\s*(%[fFuUdDnNickvm](?:\s+%[fFuUdDnNickvm])*)\s*$/);
      if (fieldCodeMatch) {
        const beforeCodes = fieldCodeMatch[1].trim();
        const codes = fieldCodeMatch[2].trim();
        const mid = beforeCodes
          ? `${beforeCodes} ${REMOTE_DEBUG_LAUNCH_FLAG}`
          : REMOTE_DEBUG_LAUNCH_FLAG;
        return `${prefix}${binToken} ${mid} ${codes}`;
      }
      return rest
        ? `${prefix}${binToken} ${rest} ${REMOTE_DEBUG_LAUNCH_FLAG}`
        : `${prefix}${binToken} ${REMOTE_DEBUG_LAUNCH_FLAG}`;
    }

    const stripped = ensureRemoteDebugFlagInArgs(rest, { enabled: false });
    configured = configured || stripped.configured;
    if (!stripped.changed) return line;
    changed = true;
    return stripped.args ? `${prefix}${binToken} ${stripped.args}` : `${prefix}${binToken}`;
  });

  return {
    matched,
    changed,
    configured,
    text: changed ? nextLines.join(eol) : rawText,
  };
}

const WIN_SHORTCUT_PROVISION_PS = `
$ErrorActionPreference = 'Stop'
$enableFlag = $env:AGY_CS_LAUNCH_ENABLED -eq '1'
$updated = New-Object System.Collections.Generic.List[string]
$configured = New-Object System.Collections.Generic.List[string]
$ws = New-Object -ComObject WScript.Shell
$userProgramsDir = [Environment]::GetFolderPath('Programs')

$scanSpecs = @(
  @{ Dir = [Environment]::GetFolderPath('Desktop'); Recurse = $false; IsCommon = $false },
  @{ Dir = $userProgramsDir; Recurse = $true; IsCommon = $false },
  @{ Dir = [Environment]::GetFolderPath('StartMenu'); Recurse = $false; IsCommon = $false },
  @{ Dir = [Environment]::GetFolderPath('Startup'); Recurse = $false; IsCommon = $false },
  @{ Dir = (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'); Recurse = $false; IsCommon = $false },
  @{ Dir = [Environment]::GetFolderPath('CommonDesktopDirectory'); Recurse = $false; IsCommon = $true },
  @{ Dir = [Environment]::GetFolderPath('CommonPrograms'); Recurse = $true; IsCommon = $true }
)

$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($spec in $scanSpecs) {
  $dir = [string]$spec.Dir
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  $items = @()
  try {
    if ($spec.Recurse) {
      $items = @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue)
    } else {
      $items = @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -ErrorAction SilentlyContinue)
    }
  } catch { continue }

  foreach ($item in $items) {
    $lnkPath = [string]$item.FullName
    if (-not $seen.Add($lnkPath)) { continue }
    try {
      $sc = $ws.CreateShortcut($lnkPath)
      $target = [string]$sc.TargetPath
      if ([System.IO.Path]::GetFileName($target) -ine 'Antigravity.exe') { continue }
      $curArgs = [string]$sc.Arguments
      if ($enableFlag) {
        if ($curArgs -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
          $configured.Add($lnkPath)
          continue
        }
        $nextArgs = ($curArgs.Trim() + ' --remote-debugging-port=0').Trim()
        try {
          $sc.Arguments = $nextArgs
          $sc.Save()
          $updated.Add($lnkPath)
          $configured.Add($lnkPath)
        } catch {
          if ($spec.IsCommon -and $userProgramsDir -and (Test-Path -LiteralPath $userProgramsDir)) {
            $fallbackLnk = Join-Path $userProgramsDir ([System.IO.Path]::GetFileName($lnkPath))
            if (-not (Test-Path -LiteralPath $fallbackLnk)) {
              try {
                $uSc = $ws.CreateShortcut($fallbackLnk)
                $uSc.TargetPath = $target
                $uSc.Arguments = $nextArgs
                if ($sc.WorkingDirectory) { $uSc.WorkingDirectory = $sc.WorkingDirectory }
                if ($sc.IconLocation) { $uSc.IconLocation = $sc.IconLocation }
                if ($sc.Description) { $uSc.Description = $sc.Description }
                $uSc.Save()
                $updated.Add($fallbackLnk)
                $configured.Add($fallbackLnk)
              } catch {}
            }
          }
        }
      } else {
        $stripped = ([regex]::Replace($curArgs, '(?:^|\\s+)--remote-debugging-port=(?:"0"|''0''|0)(?=\\s|$)', ' ')).Trim()
        if ($stripped -ne $curArgs.Trim()) {
          try {
            $sc.Arguments = $stripped
            $sc.Save()
            $updated.Add($lnkPath)
          } catch {}
        }
        if ($stripped -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
          $configured.Add($lnkPath)
        }
      }
    } catch {}
  }
}

$runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
if (Test-Path -LiteralPath $runKey) {
  try {
    $regItem = Get-Item -LiteralPath $runKey -ErrorAction SilentlyContinue
    if ($regItem) {
      foreach ($valName in $regItem.GetValueNames()) {
        $rawCmd = [string]$regItem.GetValue($valName, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if (-not $rawCmd) { continue }
        if ($rawCmd -notmatch '^\\s*(?:"([^"]+)"|([^\\s"]+))(.*)$') { continue }
        $exeCandidate = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        $restPart = [string]$Matches[3]
        if ([System.IO.Path]::GetFileName($exeCandidate) -ine 'Antigravity.exe') { continue }
        $quotedExe = if ($Matches[1] -or $exeCandidate -match '\\s') { '"' + $exeCandidate + '"' } else { $exeCandidate }
        if ($enableFlag) {
          if ($restPart -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
            $configured.Add("HKCU:Run:$valName")
            continue
          }
          $nextRest = ($restPart.Trim() + ' --remote-debugging-port=0').Trim()
          $nextVal = "$quotedExe $nextRest"
          Set-ItemProperty -LiteralPath $runKey -Name $valName -Value $nextVal -ErrorAction SilentlyContinue
          $updated.Add("HKCU:Run:$valName")
          $configured.Add("HKCU:Run:$valName")
        } else {
          $strippedRest = ([regex]::Replace($restPart, '(?:^|\\s+)--remote-debugging-port=(?:"0"|''0''|0)(?=\\s|$)', ' ')).Trim()
          $nextVal = if ($strippedRest) { "$quotedExe $strippedRest" } else { $quotedExe }
          if ($nextVal -ne $rawCmd.Trim()) {
            Set-ItemProperty -LiteralPath $runKey -Name $valName -Value $nextVal -ErrorAction SilentlyContinue
            $updated.Add("HKCU:Run:$valName")
          }
          if ($strippedRest -match '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {
            $configured.Add("HKCU:Run:$valName")
          }
        }
      }
    }
  } catch {}
}

[pscustomobject]@{
  ok = $true
  updatedPaths = @($updated)
  configuredPaths = @($configured)
} | ConvertTo-Json -Compress
`.trim();

function toStringList(val) {
  if (Array.isArray(val)) return val.map(String).filter(Boolean);
  if (typeof val === 'string' && val.trim()) return [val.trim()];
  return [];
}

async function ensureDesktopRemoteDebuggingLaunchers({
  enabled = true,
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  execFileFn = null,
  fsOps = null,
  allowInTest = false,
} = {}) {
  if (
    !allowInTest &&
    (String(env?.AGY_CLAUDE_STYLE_SKIP_LAUNCHER_PROVISION || '') === '1' ||
      String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid')
  ) {
    return {
      checked: false,
      updated: false,
      alreadyConfigured: false,
      configured: false,
      updatedPaths: [],
      configuredPaths: [],
      reason: 'skipped',
    };
  }

  const ops = {
    existsFn: fsOps?.existsFn || fs.existsSync,
    readFn: fsOps?.readFn || fs.readFileSync,
    writeFn: fsOps?.writeFn || fs.writeFileSync,
    mkdirFn: fsOps?.mkdirFn || fs.mkdirSync,
  };

  if (platform === 'win32') {
    try {
      const runner =
        execFileFn ||
        ((file, args, opts) =>
          new Promise((resolve, reject) => {
            execFile(file, args, opts, (err, stdout) => {
              if (err) {
                reject(err);
                return;
              }
              resolve(String(stdout || ''));
            });
          }));
      const out = await runner(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SHORTCUT_PROVISION_PS],
        {
          windowsHide: true,
          timeout: 9000,
          maxBuffer: 1024 * 1024,
          env: {
            ...env,
            AGY_CS_LAUNCH_ENABLED: enabled ? '1' : '0',
          },
        }
      );
      const trimmed = String(out || '').trim();
      const jsonLine =
        trimmed
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.trim().startsWith('{')) || '';
      const parsed = jsonLine ? JSON.parse(jsonLine) : null;
      const updatedPaths = toStringList(parsed?.updatedPaths);
      const configuredPaths = toStringList(parsed?.configuredPaths);
      return {
        checked: true,
        updated: updatedPaths.length > 0,
        alreadyConfigured: updatedPaths.length === 0 && configuredPaths.length > 0,
        configured: configuredPaths.length > 0,
        updatedPaths,
        configuredPaths,
      };
    } catch (err) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: false,
        configured: false,
        updatedPaths: [],
        configuredPaths: [],
        reason: 'win_shortcut_error',
        error: err && err.message ? err.message : String(err),
      };
    }
  }

  if (platform === 'linux') {
    const dataHome = env?.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
    const configHome = env?.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    const userDesktopFile = path.join(dataHome, 'applications', 'antigravity.desktop');
    const systemDesktopFiles = [
      '/usr/share/applications/antigravity.desktop',
      '/usr/local/share/applications/antigravity.desktop',
    ];
    const autostartDesktopFile = path.join(configHome, 'autostart', 'antigravity.desktop');

    const updatedPaths = [];
    const configuredPaths = [];

    try {
      const existedUser = Boolean(ops.existsFn(userDesktopFile));
      let baseUserText = '';
      if (existedUser) {
        baseUserText = String(ops.readFn(userDesktopFile, 'utf8') || '');
      } else if (enabled) {
        for (const sysFile of systemDesktopFiles) {
          if (ops.existsFn(sysFile)) {
            baseUserText = String(ops.readFn(sysFile, 'utf8') || '');
            if (baseUserText) break;
          }
        }
      }

      if (baseUserText) {
        const patchedUser = patchLinuxDesktopEntryText(baseUserText, { enabled });
        if (patchedUser.matched) {
          if (patchedUser.changed || (enabled && !existedUser && patchedUser.configured)) {
            ops.mkdirFn(path.dirname(userDesktopFile), { recursive: true });
            ops.writeFn(userDesktopFile, patchedUser.text, 'utf8');
            updatedPaths.push(userDesktopFile);
          }
          if (patchedUser.configured) {
            configuredPaths.push(userDesktopFile);
          }
        }
      }

      if (ops.existsFn(autostartDesktopFile)) {
        const autoText = String(ops.readFn(autostartDesktopFile, 'utf8') || '');
        const patchedAuto = patchLinuxDesktopEntryText(autoText, { enabled });
        if (patchedAuto.matched) {
          if (patchedAuto.changed) {
            ops.writeFn(autostartDesktopFile, patchedAuto.text, 'utf8');
            updatedPaths.push(autostartDesktopFile);
          }
          if (patchedAuto.configured) {
            configuredPaths.push(autostartDesktopFile);
          }
        }
      }

      return {
        checked: true,
        updated: updatedPaths.length > 0,
        alreadyConfigured: updatedPaths.length === 0 && configuredPaths.length > 0,
        configured: configuredPaths.length > 0,
        updatedPaths,
        configuredPaths,
      };
    } catch (err) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: false,
        configured: false,
        updatedPaths: [],
        configuredPaths: [],
        reason: 'linux_desktop_error',
        error: err && err.message ? err.message : String(err),
      };
    }
  }

  return {
    checked: true,
    updated: false,
    alreadyConfigured: false,
    configured: false,
    updatedPaths: [],
    configuredPaths: [],
    reason: 'unsupported_platform',
  };
}

function exitProcessCleanly(code = 0, settleMs = 50) {
  process.exitCode = code;
  try {
    if (process.stdin && typeof process.stdin.pause === 'function') {
      process.stdin.pause();
    }
  } catch {}
  const timer = setTimeout(() => {
    process.exit(code);
  }, Math.max(10, settleMs));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

module.exports = {
  BROKEN_PIPE_CODES,
  isBrokenPipeError,
  isPidAlive,
  createSafeLogger,
  createIdleHostTracker,
  normalizeLsHealthzUrl,
  startHostWatchdog,
  readWatcherPid,
  waitForPidExit,
  acquireWatcherLock,
  ensureIdeRemoteDebuggingArgv,
  REMOTE_DEBUG_LAUNCH_FLAG,
  ensureRemoteDebugFlagInArgs,
  patchWindowsRunRegistryCommand,
  patchLinuxDesktopEntryText,
  ensureDesktopRemoteDebuggingLaunchers,
  exitProcessCleanly,
};
