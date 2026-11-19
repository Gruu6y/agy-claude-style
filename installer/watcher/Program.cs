using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace AgyClaudeStyle.Watcher
{
    internal class AttachedEntry
    {
        public CdpSession Session;
        public string ScriptId;
        public string Title;
    }

    internal static class Program
    {
        private static readonly object LogLock = new object();
        private static string _baseDir;
        private static string _logFile;
        private static string _pidFile;
        private static bool _isWatch;

        [STAThread]
        private static int Main(string[] args)
        {
            string mode = "watch";
            string customDir = null;
            int? overridePort = null;
            string outFile = null;
            bool keepAlive = false;
            int? parentPid = null;
            int maxIdleFailures = 3;

            string envIdle = Environment.GetEnvironmentVariable("AG_WATCH_MAX_IDLE_FAILURES");
            if (!string.IsNullOrEmpty(envIdle))
            {
                int parsedEnvIdle;
                if (int.TryParse(envIdle.Trim(), out parsedEnvIdle) && parsedEnvIdle > 0)
                {
                    maxIdleFailures = parsedEnvIdle;
                }
            }

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--watch") mode = "watch";
                else if (a == "--once") mode = "once";
                else if (a == "--remove") mode = "remove";
                else if (a == "--keep-alive") keepAlive = true;
                else if (a == "--dir" && i + 1 < args.Length) customDir = args[++i];
                else if (a == "--cdp-port" && i + 1 < args.Length)
                {
                    int p;
                    if (int.TryParse(args[++i], out p) && p > 0) overridePort = p;
                }
                else if (a == "--parent-pid" && i + 1 < args.Length)
                {
                    int pp;
                    if (int.TryParse(args[++i], out pp) && pp > 0) parentPid = pp;
                }
                else if (a == "--max-idle-failures" && i + 1 < args.Length)
                {
                    int m;
                    if (int.TryParse(args[++i], out m) && m > 0) maxIdleFailures = m;
                }
                else if (a == "--out" && i + 1 < args.Length) outFile = args[++i];
            }

            _baseDir = Path.GetFullPath(string.IsNullOrEmpty(customDir) ? AppDomain.CurrentDomain.BaseDirectory : customDir).TrimEnd('\\', '/');
            _logFile = Path.Combine(_baseDir, "watch.log");
            _pidFile = Path.Combine(_baseDir, ".watch.pid");
            _isWatch = (mode == "watch");

            try
            {
                if (mode == "once")
                {
                    return RunOnceAsync(overridePort, outFile).GetAwaiter().GetResult();
                }
                if (mode == "remove")
                {
                    return RunRemoveAsync(overridePort, outFile).GetAwaiter().GetResult();
                }
                return RunWatchAsync(overridePort, keepAlive, parentPid, maxIdleFailures).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                Log("[!] Fatal error: " + ex.Message);
                WriteResult(outFile, false, ex.Message, null);
                return 1;
            }
        }

        private static void Log(string line)
        {
            if (!_isWatch) return;
            lock (LogLock)
            {
                try
                {
                    FileInfo fi = new FileInfo(_logFile);
                    if (fi.Exists && fi.Length > 1024 * 1024)
                    {
                        File.WriteAllText(_logFile, "", new UTF8Encoding(false));
                    }
                    string entry = string.Format("[{0}] {1}\n", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"), line);
                    byte[] bytes = new UTF8Encoding(false).GetBytes(entry);
                    using (FileStream fs = new FileStream(_logFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                    {
                        fs.Write(bytes, 0, bytes.Length);
                    }
                }
                catch { }
            }
        }

        private static void WriteResult(string outFile, bool ok, string message, List<string> pages)
        {
            if (string.IsNullOrEmpty(outFile)) return;
            try
            {
                Dictionary<string, object> res = new Dictionary<string, object>(StringComparer.Ordinal);
                res["ok"] = ok;
                res["message"] = message ?? "";
                if (pages != null) res["pages"] = pages;
                File.WriteAllText(outFile, MiniJson.Stringify(res, true), new UTF8Encoding(false));
            }
            catch { }
        }

        public static string GetDirHash(string dir)
        {
            return CdpHelper.ComputeHash(Path.GetFullPath(dir).TrimEnd('\\', '/').ToLowerInvariant());
        }

        private static int? ReadPidFile()
        {
            try
            {
                if (!File.Exists(_pidFile)) return null;
                int pid;
                if (int.TryParse(File.ReadAllText(_pidFile, Encoding.UTF8).Trim(), out pid) && pid > 0) return pid;
            }
            catch { }
            return null;
        }

        private static void ReleasePidFile(int selfPid)
        {
            try
            {
                int? current = ReadPidFile();
                if (current.HasValue && current.Value == selfPid)
                {
                    File.Delete(_pidFile);
                }
            }
            catch { }
        }

        private static async Task<int> RunOnceAsync(int? overridePort, string outFile)
        {
            PluginManifest manifest = PluginManifest.Load(_baseDir);
            int? port = CdpHelper.ReadPort(overridePort);
            if (!port.HasValue)
            {
                WriteResult(outFile, false, "未找到调试端口文件，Antigravity 可能未运行", null);
                return 1;
            }

            List<CdpPageInfo> pages = await CdpHelper.ListPagesAsync(port.Value).ConfigureAwait(false);
            if (pages.Count == 0)
            {
                WriteResult(outFile, false, "未找到 Antigravity 窗口页面", null);
                return 1;
            }

            string expr = CdpHelper.BuildInjectExpression(_baseDir, manifest);
            List<string> injectedTitles = new List<string>();
            for (int i = 0; i < pages.Count; i++)
            {
                CdpPageInfo page = pages[i];
                using (CdpSession session = await CdpSession.ConnectAsync(page.WebSocketDebuggerUrl, 4000).ConfigureAwait(false))
                {
                    await session.EvaluateAsync(expr, false).ConfigureAwait(false);
                    injectedTitles.Add(CdpHelper.ShortTitle(page));
                }
            }
            WriteResult(outFile, true, "injected " + injectedTitles.Count + " page(s)", injectedTitles);
            return 0;
        }

        private static async Task<int> RunRemoveAsync(int? overridePort, string outFile)
        {
            PluginManifest manifest = PluginManifest.Load(_baseDir);
            StopRunningWatcherInDir(_baseDir);

            int? port = CdpHelper.ReadPort(overridePort);
            List<string> cleaned = new List<string>();
            if (port.HasValue)
            {
                try
                {
                    List<CdpPageInfo> pages = await CdpHelper.ListPagesAsync(port.Value).ConfigureAwait(false);
                    for (int i = 0; i < pages.Count; i++)
                    {
                        CdpPageInfo page = pages[i];
                        try
                        {
                            using (CdpSession session = await CdpSession.ConnectAsync(page.WebSocketDebuggerUrl, 3000).ConfigureAwait(false))
                            {
                                await session.EvaluateAsync(manifest.RemoveExpression, false).ConfigureAwait(false);
                                cleaned.Add(CdpHelper.ShortTitle(page));
                            }
                        }
                        catch { }
                    }
                }
                catch { }
            }
            WriteResult(outFile, true, "removed from " + cleaned.Count + " page(s)", cleaned);
            return 0;
        }

        private static void StopRunningWatcherInDir(string dir)
        {
            string hash = GetDirHash(dir);
            try
            {
                using (EventWaitHandle stopEvt = EventWaitHandle.OpenExisting("Local\\AGYClaudeStyleStop_" + hash))
                {
                    stopEvt.Set();
                }
            }
            catch { }

            string pidFile = Path.Combine(dir, ".watch.pid");
            int? pid = null;
            try
            {
                if (File.Exists(pidFile))
                {
                    int p;
                    if (int.TryParse(File.ReadAllText(pidFile, Encoding.UTF8).Trim(), out p) && p > 0) pid = p;
                }
            }
            catch { }

            if (pid.HasValue && pid.Value != Process.GetCurrentProcess().Id)
            {
                try
                {
                    Process proc = Process.GetProcessById(pid.Value);
                    if (!proc.WaitForExit(1500))
                    {
                        proc.Kill();
                        proc.WaitForExit(1500);
                    }
                }
                catch { }
            }
            try { if (File.Exists(pidFile)) File.Delete(pidFile); } catch { }
        }

        private static bool IsProcessAlive(int pid)
        {
            try
            {
                using (Process p = Process.GetProcessById(pid))
                {
                    return !p.HasExited;
                }
            }
            catch
            {
                return false;
            }
        }

        private static async Task<int> RunWatchAsync(int? overridePort, bool keepAlive, int? parentPid, int maxIdleFailures)
        {
            string dirHash = GetDirHash(_baseDir);
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\AGYClaudeStyleWatcher_" + dirHash, out createdNew))
            {
                if (!createdNew)
                {
                    return 0;
                }

                int selfPid = Process.GetCurrentProcess().Id;
                File.WriteAllText(_pidFile, selfPid.ToString(), new UTF8Encoding(false));
                try { File.WriteAllText(_logFile, "", new UTF8Encoding(false)); } catch { }

                PluginManifest manifest = PluginManifest.Load(_baseDir);
                Log(string.Format("[*] AGY Claude Style (agy-claude-style) 守护模式启动 (PID {0}{1})，每 2 秒检查一次窗口", selfPid, keepAlive ? ", keep-alive" : ""));

                string currentExpr = CdpHelper.BuildInjectExpression(_baseDir, manifest);
                object exprLock = new object();
                ConcurrentDictionary<string, AttachedEntry> attached = new ConcurrentDictionary<string, AttachedEntry>(StringComparer.Ordinal);
                int hadAttached = 0;
                int consecutiveIdleFailures = 0;
                ManualResetEventSlim exitEvent = new ManualResetEventSlim(false);
                EventWaitHandle stopSignal = new EventWaitHandle(false, EventResetMode.ManualReset, "Local\\AGYClaudeStyleStop_" + dirHash);

                ThreadPool.RegisterWaitForSingleObject(stopSignal, (state, timedOut) =>
                {
                    exitEvent.Set();
                }, null, -1, true);

                AppDomain.CurrentDomain.ProcessExit += (s, e) =>
                {
                    exitEvent.Set();
                    ReleasePidFile(selfPid);
                };

                Func<AttachedEntry, string, Task<Dictionary<string, object>>> applyAsync = async (entry, exprToUse) =>
                {
                    if (!string.IsNullOrEmpty(entry.ScriptId))
                    {
                        try
                        {
                            Dictionary<string, object> rmParams = new Dictionary<string, object>(StringComparer.Ordinal);
                            rmParams["identifier"] = entry.ScriptId;
                            await entry.Session.SendAsync("Page.removeScriptToEvaluateOnNewDocument", rmParams, 5000).ConfigureAwait(false);
                        }
                        catch { }
                    }
                    Dictionary<string, object> addParams = new Dictionary<string, object>(StringComparer.Ordinal);
                    addParams["source"] = exprToUse;
                    Dictionary<string, object> addRes = await entry.Session.SendAsync("Page.addScriptToEvaluateOnNewDocument", addParams, 15000).ConfigureAwait(false);
                    object idVal;
                    if (addRes.TryGetValue("identifier", out idVal)) entry.ScriptId = idVal as string;
                    object evalVal = await entry.Session.EvaluateAsync(exprToUse, false).ConfigureAwait(false);
                    return evalVal as Dictionary<string, object>;
                };

                Func<CdpPageInfo, Task> attachAsync = async (page) =>
                {
                    if (!attached.TryAdd(page.Id, null)) return;
                    CdpSession session = null;
                    try
                    {
                        session = await CdpSession.ConnectAsync(page.WebSocketDebuggerUrl, 4000).ConfigureAwait(false);
                        AttachedEntry entry = new AttachedEntry();
                        entry.Session = session;
                        entry.ScriptId = null;
                        entry.Title = CdpHelper.ShortTitle(page);
                        attached[page.Id] = entry;
                        Interlocked.Exchange(ref hadAttached, 1);

                        session.OnClose = () =>
                        {
                            AttachedEntry ignored;
                            attached.TryRemove(page.Id, out ignored);
                            Log("[-] 窗口已关闭: " + entry.Title);
                        };

                        await session.SendAsync("Page.enable", null, 5000).ConfigureAwait(false);
                        session.On("Runtime.bindingCalled", (p) =>
                        {
                            object bNameObj;
                            object payloadObj;
                            if (!p.TryGetValue("name", out bNameObj) || !string.Equals(bNameObj as string, manifest.SettingBinding, StringComparison.Ordinal)) return;
                            if (!p.TryGetValue("payload", out payloadObj) || !(payloadObj is string)) return;
                            try
                            {
                                Dictionary<string, object> kv = MiniJson.ParseObject((string)payloadObj);
                                object kObj;
                                object vObj;
                                if (kv.TryGetValue("key", out kObj) && kObj is string && kv.TryGetValue("value", out vObj))
                                {
                                    string key = (string)kObj;
                                    if (CdpHelper.UpdateConfigSetting(_baseDir, manifest, key, vObj))
                                    {
                                        Log("[⚙] 设置已保存: " + key + " = " + MiniJson.Stringify(vObj, false));
                                    }
                                }
                            }
                            catch { }
                        });

                        await session.SendAsync("Runtime.enable", null, 5000).ConfigureAwait(false);
                        Dictionary<string, object> bindParams = new Dictionary<string, object>(StringComparer.Ordinal);
                        bindParams["name"] = manifest.SettingBinding;
                        await session.SendAsync("Runtime.addBinding", bindParams, 5000).ConfigureAwait(false);

                        string exprSnapshot;
                        lock (exprLock) { exprSnapshot = currentExpr; }
                        Dictionary<string, object> res = await applyAsync(entry, exprSnapshot).ConfigureAwait(false);
                        string status = (res != null && res.ContainsKey("status")) ? Convert.ToString(res["status"]) : "ok";
                        Log(string.Format("[✓] 已注入 agy-claude-style: {0} ({1})", entry.Title, status));
                    }
                    catch (Exception ex)
                    {
                        AttachedEntry removed;
                        if (attached.TryRemove(page.Id, out removed) && removed != null && removed.Session != null)
                        {
                            try { removed.Session.Close(); } catch { }
                        }
                        if (session != null)
                        {
                            try { session.Close(); } catch { }
                        }
                        Log(string.Format("[!] 注入失败，稍后重试: {0} — {1}", CdpHelper.ShortTitle(page), ex.Message));
                    }
                };

                Timer reloadTimer = null;
                string pendingFilename = null;
                object timerLock = new object();

                FileSystemWatcher fsw = null;
                try
                {
                    fsw = new FileSystemWatcher(_baseDir);
                    fsw.IncludeSubdirectories = false;
                    fsw.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.CreationTime;
                    FileSystemEventHandler onFsChange = (sender, e) =>
                    {
                        string name = e.Name;
                        if (string.IsNullOrEmpty(name) || name.StartsWith(".", StringComparison.Ordinal)) return;
                        if (!name.EndsWith(".css", StringComparison.OrdinalIgnoreCase) &&
                            !name.EndsWith(".js", StringComparison.OrdinalIgnoreCase) &&
                            !name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                        {
                            return;
                        }
                        lock (timerLock)
                        {
                            pendingFilename = name;
                            if (reloadTimer == null)
                            {
                                reloadTimer = new Timer(async (_) =>
                                {
                                    string changedName;
                                    lock (timerLock) { changedName = pendingFilename; }
                                    try
                                    {
                                        manifest = PluginManifest.Load(_baseDir);
                                        string nextExpr = CdpHelper.BuildInjectExpression(_baseDir, manifest);
                                        lock (exprLock) { currentExpr = nextExpr; }

                                        int n = 0;
                                        foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                                        {
                                            AttachedEntry entry = kv.Value;
                                            if (entry == null) continue;
                                            try
                                            {
                                                await applyAsync(entry, nextExpr).ConfigureAwait(false);
                                                n++;
                                            }
                                            catch { }
                                        }
                                        Log(string.Format("[↻] {0} 已变更，已热更新 {1} 个窗口", changedName, n));
                                    }
                                    catch (Exception ex)
                                    {
                                        Log("[!] 读取文件失败: " + ex.Message);
                                    }
                                }, null, 180, Timeout.Infinite);
                            }
                            else
                            {
                                reloadTimer.Change(180, Timeout.Infinite);
                            }
                        }
                    };
                    fsw.Changed += onFsChange;
                    fsw.Created += onFsChange;
                    fsw.Renamed += (s, e) => onFsChange(s, e);
                    fsw.EnableRaisingEvents = true;
                }
                catch { }

                int? lastPort = null;
                try
                {
                    while (!exitEvent.IsSet)
                    {
                        if (parentPid.HasValue && !IsProcessAlive(parentPid.Value))
                        {
                            Log("[*] 宿主父进程已退出，守护进程自动停止");
                            break;
                        }

                        int waitMs = 2000;
                        try
                        {
                            int? port = CdpHelper.ReadPort(overridePort);
                            List<CdpPageInfo> pages = null;
                            if (port.HasValue)
                            {
                                try
                                {
                                    pages = await CdpHelper.ListPagesAsync(port.Value).ConfigureAwait(false);
                                }
                                catch
                                {
                                    pages = null;
                                }
                            }

                            if (pages != null)
                            {
                                if (!lastPort.HasValue || lastPort.Value != port.Value)
                                {
                                    // Close stale sessions if Antigravity restarted on a new port
                                    foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                                    {
                                        AttachedEntry oldEntry;
                                        if (attached.TryRemove(kv.Key, out oldEntry) && oldEntry != null && oldEntry.Session != null)
                                        {
                                            try { oldEntry.Session.Close(); } catch { }
                                        }
                                    }
                                    Log("[+] 连接到调试端口 " + port.Value);
                                    lastPort = port.Value;
                                }

                                List<Task> tasks = new List<Task>();
                                for (int i = 0; i < pages.Count; i++)
                                {
                                    if (!attached.ContainsKey(pages[i].Id))
                                    {
                                        tasks.Add(attachAsync(pages[i]));
                                    }
                                }
                                if (tasks.Count > 0)
                                {
                                    await Task.WhenAll(tasks).ConfigureAwait(false);
                                }
                            }
                            else if (!attached.IsEmpty)
                            {
                                foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                                {
                                    AttachedEntry oldEntry;
                                    if (attached.TryRemove(kv.Key, out oldEntry) && oldEntry != null && oldEntry.Session != null)
                                    {
                                        try { oldEntry.Session.Close(); } catch { }
                                    }
                                }
                            }

                            bool hostReachable = (pages != null && (pages.Count > 0 || !attached.IsEmpty));
                            if (hostReachable)
                            {
                                consecutiveIdleFailures = 0;
                                if (!attached.IsEmpty) Interlocked.Exchange(ref hadAttached, 1);
                            }
                            else if (Volatile.Read(ref hadAttached) == 1 && attached.IsEmpty)
                            {
                                consecutiveIdleFailures++;
                                if (!keepAlive && consecutiveIdleFailures >= maxIdleFailures)
                                {
                                    Log("[✓] 检测到 Antigravity 已关闭，守护进程自动退出");
                                    break;
                                }
                                if (keepAlive && consecutiveIdleFailures >= maxIdleFailures)
                                {
                                    lastPort = null;
                                    waitMs = 10000;
                                }
                            }
                        }
                        catch { }

                        exitEvent.Wait(waitMs);
                    }
                }
                finally
                {
                    if (fsw != null) { try { fsw.Dispose(); } catch { } }
                    if (reloadTimer != null) { try { reloadTimer.Dispose(); } catch { } }
                    foreach (KeyValuePair<string, AttachedEntry> kv in attached)
                    {
                        if (kv.Value != null && kv.Value.Session != null)
                        {
                            try { kv.Value.Session.Close(); } catch { }
                        }
                    }
                    try { stopSignal.Dispose(); } catch { }
                    try { exitEvent.Dispose(); } catch { }
                    ReleasePidFile(selfPid);
                }
            }
            return 0;
        }
    }
}
