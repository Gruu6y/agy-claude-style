using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AgyClaudeStyle.Installer
{
    internal class InstallerOptions
    {
        public bool Uninstall;
        public bool Silent;
        public bool Popup;
        public bool StatusOnly;
        public bool NoAutostart;
        public bool NoKillLegacy;
        public string InstallDir;
        public int? CdpPort;
        public string OutFile;
    }

    internal class AntigravityDetectResult
    {
        public string ExePath;
        public string Version;
        public bool IsRunning;
    }

    internal class OperationResult
    {
        public bool Ok;
        public string Mode;
        public string Headline;
        public string Detail;
        public string InstallDir;
        public string AntigravityExe;
        public string AntigravityVersion;
        public int? CdpPort;
        public List<string> InjectedPages = new List<string>();
        public bool PreservedExistingConfig;
        public bool SelfDeleteScheduled;
        public string ConfigSummary;
    }

    internal static class InstallerCore
    {
        private const string UninstallRegSubKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AGYClaudeStyle";
        private const string StartupLnkName = "AGY-Claude-Style.lnk";
        private const string WatcherExeName = "agy-claude-style-watcher.exe";
        private const string SelfInstalledExeName = "agy-claude-style-installer.exe";

        public static string GetDefaultInstallDir()
        {
            string localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(localAppData))
            {
                localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            }
            return Path.Combine(localAppData, "agy-claude-style");
        }

        public static string GetDirHash(string dir)
        {
            return CdpHelper.ComputeHash(Path.GetFullPath(dir).TrimEnd('\\', '/').ToLowerInvariant());
        }

        public static string GetStartupShortcutPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), StartupLnkName);
        }

        public static AntigravityDetectResult DetectAntigravityDesktop()
        {
            AntigravityDetectResult res = new AntigravityDetectResult();
            try
            {
                Process[] procs = Process.GetProcessesByName("Antigravity");
                if (procs != null && procs.Length > 0)
                {
                    res.IsRunning = true;
                    for (int i = 0; i < procs.Length; i++)
                    {
                        try
                        {
                            string p = procs[i].MainModule.FileName;
                            if (!string.IsNullOrEmpty(p) && File.Exists(p))
                            {
                                res.ExePath = p;
                                break;
                            }
                        }
                        catch { }
                        finally
                        {
                            try { procs[i].Dispose(); } catch { }
                        }
                    }
                }
            }
            catch { }

            if (string.IsNullOrEmpty(res.ExePath))
            {
                List<string> candidates = new List<string>();
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
                if (!string.IsNullOrEmpty(localAppData))
                    candidates.Add(Path.Combine(localAppData, "Programs", "antigravity", "Antigravity.exe"));
                if (!string.IsNullOrEmpty(progFiles))
                    candidates.Add(Path.Combine(progFiles, "Antigravity", "Antigravity.exe"));
                if (!string.IsNullOrEmpty(progFilesX86))
                    candidates.Add(Path.Combine(progFilesX86, "Antigravity", "Antigravity.exe"));

                for (int i = 0; i < candidates.Count; i++)
                {
                    if (File.Exists(candidates[i]))
                    {
                        res.ExePath = candidates[i];
                        break;
                    }
                }
            }

            if (string.IsNullOrEmpty(res.ExePath))
            {
                res.ExePath = FindAntigravityFromUninstallRegistry();
            }

            if (!string.IsNullOrEmpty(res.ExePath))
            {
                try
                {
                    FileVersionInfo fvi = FileVersionInfo.GetVersionInfo(res.ExePath);
                    res.Version = !string.IsNullOrEmpty(fvi.FileVersion) ? fvi.FileVersion : fvi.ProductVersion;
                }
                catch { }
                if (string.IsNullOrEmpty(res.Version))
                {
                    string dir = Path.GetDirectoryName(res.ExePath);
                    string versionFile = Path.Combine(dir, "version");
                    if (File.Exists(versionFile))
                    {
                        try { res.Version = File.ReadAllText(versionFile, Encoding.UTF8).Trim(); } catch { }
                    }
                }
            }

            return res;
        }

        private static string FindAntigravityFromUninstallRegistry()
        {
            RegistryKey[] roots = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };
            string[] subPaths = new string[]
            {
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            };
            for (int r = 0; r < roots.Length; r++)
            {
                for (int sp = 0; sp < subPaths.Length; sp++)
                {
                    try
                    {
                        using (RegistryKey parent = roots[r].OpenSubKey(subPaths[sp]))
                        {
                            if (parent == null) continue;
                            string[] names = parent.GetSubKeyNames();
                            for (int i = 0; i < names.Length; i++)
                            {
                                try
                                {
                                    using (RegistryKey item = parent.OpenSubKey(names[i]))
                                    {
                                        if (item == null) continue;
                                        string disp = item.GetValue("DisplayName") as string;
                                        if (string.IsNullOrEmpty(disp)) continue;
                                        if (!disp.StartsWith("Antigravity", StringComparison.OrdinalIgnoreCase)) continue;
                                        if (disp.IndexOf("IDE", StringComparison.OrdinalIgnoreCase) >= 0) continue;

                                        string loc = item.GetValue("InstallLocation") as string;
                                        string exe = TryProbeAntigravityDir(loc);
                                        if (exe != null) return exe;

                                        string uninst = item.GetValue("UninstallString") as string;
                                        exe = TryProbeAntigravityFromCmd(uninst);
                                        if (exe != null) return exe;

                                        string icon = item.GetValue("DisplayIcon") as string;
                                        exe = TryProbeAntigravityFromCmd(icon);
                                        if (exe != null) return exe;
                                    }
                                }
                                catch { }
                            }
                        }
                    }
                    catch { }
                }
            }
            return null;
        }

        private static string TryProbeAntigravityDir(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return null;
            string cleaned = dir.Trim().Trim('"');
            if (string.IsNullOrEmpty(cleaned)) return null;
            string exe = Path.Combine(cleaned, "Antigravity.exe");
            return File.Exists(exe) ? exe : null;
        }

        private static string TryProbeAntigravityFromCmd(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return null;
            string s = cmd.Trim();
            string pathPart = null;
            if (s.StartsWith("\"", StringComparison.Ordinal))
            {
                int end = s.IndexOf('"', 1);
                if (end > 1) pathPart = s.Substring(1, end - 1);
            }
            else
            {
                int exeIdx = s.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                if (exeIdx > 0) pathPart = s.Substring(0, exeIdx + 4);
            }
            if (string.IsNullOrEmpty(pathPart)) return null;
            int comma = pathPart.IndexOf(',');
            if (comma > 0) pathPart = pathPart.Substring(0, comma);
            try
            {
                return TryProbeAntigravityDir(Path.GetDirectoryName(pathPart));
            }
            catch
            {
                return null;
            }
        }

        public static void StopWatcherInDir(string dir, Action<string> log)
        {
            if (!Directory.Exists(dir)) return;
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
            if (File.Exists(pidFile))
            {
                try
                {
                    int pid;
                    if (int.TryParse(File.ReadAllText(pidFile, Encoding.UTF8).Trim(), out pid) && pid > 0)
                    {
                        try
                        {
                            Process p = Process.GetProcessById(pid);
                            if (!p.WaitForExit(2000))
                            {
                                p.Kill();
                                p.WaitForExit(2000);
                            }
                            if (log != null) log("已停止运行中的守护进程 (PID " + pid + ")");
                        }
                        catch { }
                    }
                }
                catch { }
                try { File.Delete(pidFile); } catch { }
            }

            string normalizedDir = Path.GetFullPath(dir).TrimEnd('\\', '/').ToLowerInvariant();
            try
            {
                Process[] procs = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(WatcherExeName));
                for (int i = 0; i < procs.Length; i++)
                {
                    try
                    {
                        string path = procs[i].MainModule.FileName;
                        if (!string.IsNullOrEmpty(path) &&
                            Path.GetFullPath(path).ToLowerInvariant().StartsWith(normalizedDir + "\\", StringComparison.Ordinal))
                        {
                            if (!procs[i].WaitForExit(1500))
                            {
                                procs[i].Kill();
                                procs[i].WaitForExit(1500);
                            }
                        }
                    }
                    catch { }
                    finally
                    {
                        try { procs[i].Dispose(); } catch { }
                    }
                }
            }
            catch { }
        }

        public static void StopLegacyNodeWatchers(Action<string> log)
        {
            try
            {
                string lnkPath = GetStartupShortcutPath();
                if (File.Exists(lnkPath))
                {
                    string workDir = ReadShortcutWorkingDir(lnkPath);
                    if (!string.IsNullOrEmpty(workDir) && Directory.Exists(workDir))
                    {
                        string legacyPidFile = Path.Combine(workDir, ".watch.pid");
                        if (File.Exists(legacyPidFile))
                        {
                            int pid;
                            if (int.TryParse(File.ReadAllText(legacyPidFile, Encoding.UTF8).Trim(), out pid) && pid > 0)
                            {
                                try
                                {
                                    Process p = Process.GetProcessById(pid);
                                    if (string.Equals(p.ProcessName, "node", StringComparison.OrdinalIgnoreCase))
                                    {
                                        p.Kill();
                                        p.WaitForExit(1500);
                                        if (log != null) log("已停止旧版脚本守护进程 (PID " + pid + ")");
                                    }
                                }
                                catch { }
                            }
                            try { File.Delete(legacyPidFile); } catch { }
                        }
                    }
                }
            }
            catch { }

            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
                {
                    foreach (ManagementObject obj in searcher.Get())
                    {
                        try
                        {
                            string cmd = obj["CommandLine"] as string;
                            if (string.IsNullOrEmpty(cmd)) continue;
                            if (cmd.IndexOf("agy-claude-style", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                cmd.IndexOf("inject.js", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                cmd.IndexOf("--watch", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                int pid = Convert.ToInt32(obj["ProcessId"]);
                                try
                                {
                                    Process p = Process.GetProcessById(pid);
                                    p.Kill();
                                    p.WaitForExit(1500);
                                    if (log != null) log("已替换旧版 Node 守护进程 (PID " + pid + ")");
                                }
                                catch { }
                            }
                        }
                        finally
                        {
                            obj.Dispose();
                        }
                    }
                }
            }
            catch { }
        }

        private static string ReadShortcutWorkingDir(string lnkPath)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                object shell = Activator.CreateInstance(shellType);
                object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                return lnk.GetType().InvokeMember("WorkingDirectory", BindingFlags.GetProperty, null, lnk, null) as string;
            }
            catch
            {
                return null;
            }
        }

        public static void CreateStartupShortcut(string installDir)
        {
            string lnkPath = GetStartupShortcutPath();
            string targetExe = Path.Combine(installDir, WatcherExeName);
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type lnkType = lnk.GetType();
            lnkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { targetExe });
            lnkType.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { "--watch --keep-alive" });
            lnkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { installDir.TrimEnd('\\', '/') });
            lnkType.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "AGY Claude Style (agy-claude-style) watcher" });
            lnkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }

        public static void RegisterUninstallEntry(string installDir, string version)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallRegSubKey))
            {
                if (key == null) return;
                string exePath = Path.Combine(installDir, SelfInstalledExeName);
                key.SetValue("DisplayName", "AGY Claude Style (Antigravity 界面增强补丁)", RegistryValueKind.String);
                key.SetValue("DisplayVersion", version ?? "1.0.0", RegistryValueKind.String);
                key.SetValue("Publisher", "AGY Claude Style", RegistryValueKind.String);
                key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
                key.SetValue("DisplayIcon", exePath + ",0", RegistryValueKind.String);
                key.SetValue("UninstallString", "\"" + exePath + "\" --uninstall", RegistryValueKind.String);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        public static OperationResult RunInstall(InstallerOptions opts, Action<int, string> progress)
        {
            OperationResult result = new OperationResult();
            result.Mode = "install";
            string installDir = Path.GetFullPath(string.IsNullOrEmpty(opts.InstallDir) ? GetDefaultInstallDir() : opts.InstallDir).TrimEnd('\\', '/');
            result.InstallDir = installDir;

            Action<int, string> report = (pct, msg) =>
            {
                if (progress != null) progress(pct, msg);
            };

            report(10, "正在检测本机 Antigravity Desktop 环境...");
            AntigravityDetectResult ag = DetectAntigravityDesktop();
            result.AntigravityExe = ag.ExePath;
            result.AntigravityVersion = ag.Version;
            if (!string.IsNullOrEmpty(ag.ExePath))
            {
                report(18, "已发现 Antigravity Desktop" + (string.IsNullOrEmpty(ag.Version) ? "" : " (" + ag.Version + ")") + ": " + ag.ExePath);
            }
            else
            {
                report(18, "未在默认目录检测到 Antigravity.exe，仍将安装并启用 CDP 自动监听");
            }

            report(28, "正在停止旧版守护进程（如存在）...");
            StopWatcherInDir(installDir, (m) => report(32, m));
            if (!opts.NoKillLegacy)
            {
                StopLegacyNodeWatchers((m) => report(35, m));
            }

            report(45, "正在部署独立运行环境与插件资源至: " + installDir);
            Directory.CreateDirectory(installDir);

            bool preservedConfig = false;
            using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("AGY_PAYLOAD.zip"))
            {
                if (resStream == null) throw new InvalidOperationException("安装包内嵌资源 AGY_PAYLOAD.zip 缺失");
                using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        if (string.IsNullOrEmpty(entry.Name)) continue;
                        string destPath = Path.Combine(installDir, entry.FullName.Replace('/', '\\'));
                        string parent = Path.GetDirectoryName(destPath);
                        if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);

                        if (string.Equals(entry.Name, "config.json", StringComparison.OrdinalIgnoreCase) && File.Exists(destPath))
                        {
                            preservedConfig = true;
                            continue;
                        }
                        using (Stream inStream = entry.Open())
                        using (FileStream outStream = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            inStream.CopyTo(outStream);
                        }
                    }
                }
            }
            result.PreservedExistingConfig = preservedConfig;
            report(62, preservedConfig ? "已保留本机现有 config.json 用户配置" : "已写入内置默认配置 config.json");

            try
            {
                string selfSrc = Assembly.GetExecutingAssembly().Location;
                string selfDest = Path.Combine(installDir, SelfInstalledExeName);
                if (!string.IsNullOrEmpty(selfSrc) && File.Exists(selfSrc) &&
                    !string.Equals(Path.GetFullPath(selfSrc), Path.GetFullPath(selfDest), StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(selfSrc, selfDest, true);
                }
            }
            catch { }

            PluginManifest manifest = PluginManifest.Load(installDir);
            Dictionary<string, object> activeCfg = CdpHelper.ReadConfig(installDir, manifest);
            result.ConfigSummary = string.Format(
                "语言={0} | 配色={1} | 圆环={2} | 思考滑块={3}",
                activeCfg.ContainsKey("language") ? activeCfg["language"] : "zh-CN",
                activeCfg.ContainsKey("palette") ? activeCfg["palette"] : "claude",
                activeCfg.ContainsKey("ringMode") ? activeCfg["ringMode"] : "quota",
                activeCfg.ContainsKey("effortSliderStyle") ? activeCfg["effortSliderStyle"] : "claude"
            );

            if (!opts.NoAutostart)
            {
                report(72, "正在配置 Windows 开机自动修补与卸载入口...");
                CreateStartupShortcut(installDir);
                RegisterUninstallEntry(installDir, manifest.Version);
            }
            else
            {
                report(72, "已按参数跳过开机自启注册");
            }

            report(82, "正在启动后台静默守护进程...");
            string watcherExe = Path.Combine(installDir, WatcherExeName);
            string watcherArgs = "--watch --dir \"" + installDir + "\"";
            if (opts.CdpPort.HasValue && opts.CdpPort.Value > 0)
            {
                watcherArgs += " --cdp-port " + opts.CdpPort.Value;
            }
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = watcherExe;
            psi.Arguments = watcherArgs;
            psi.WorkingDirectory = installDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);

            report(90, "正在检查 Antigravity Desktop 实时注入状态...");
            int? port = CdpHelper.ReadPort(opts.CdpPort);
            bool cdpReachable = false;
            string watchLogPath = Path.Combine(installDir, "watch.log");
            if (port.HasValue)
            {
                List<CdpPageInfo> pages = null;
                for (int attempt = 0; attempt < 15; attempt++)
                {
                    try
                    {
                        pages = CdpHelper.ListPagesAsync(port.Value).GetAwaiter().GetResult();
                        cdpReachable = true;
                        string logContent = "";
                        if (File.Exists(watchLogPath))
                        {
                            using (FileStream fs = new FileStream(watchLogPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                            using (StreamReader sr = new StreamReader(fs, Encoding.UTF8))
                            {
                                logContent = sr.ReadToEnd();
                            }
                        }
                        bool watcherInjected = logContent.IndexOf("[✓] 已注入 agy-claude-style:", StringComparison.Ordinal) >= 0;
                        if (pages != null && pages.Count > 0 && watcherInjected)
                        {
                            bool allReady = true;
                            List<string> titles = new List<string>();
                            for (int p = 0; p < pages.Count; p++)
                            {
                                titles.Add(CdpHelper.ShortTitle(pages[p]));
                                using (CdpSession s = CdpSession.ConnectAsync(pages[p].WebSocketDebuggerUrl, 2000).GetAwaiter().GetResult())
                                {
                                    object okVal = s.EvaluateAsync("Boolean(window.__agClaudeStyle)", false).GetAwaiter().GetResult();
                                    if (!(okVal is bool) || !((bool)okVal))
                                    {
                                        allReady = false;
                                    }
                                }
                            }
                            if (allReady)
                            {
                                result.InjectedPages = titles;
                                break;
                            }
                        }
                    }
                    catch
                    {
                        pages = null;
                        if (!ag.IsRunning && !opts.CdpPort.HasValue && attempt >= 1)
                        {
                            break;
                        }
                    }
                    Thread.Sleep(350);
                }
            }
            result.CdpPort = cdpReachable ? port : null;

            result.Ok = true;
            if (result.InjectedPages.Count > 0)
            {
                result.Headline = string.Format("修补成功！已实时注入 {0} 个 Antigravity 窗口", result.InjectedPages.Count);
                result.Detail = "后台无损守护已运行并已配置开机自启。后续打开新窗口或更新 Antigravity 后也会自动注入。";
                for (int i = 0; i < result.InjectedPages.Count; i++)
                {
                    report(98, "已注入窗口: " + result.InjectedPages[i]);
                }
            }
            else if (cdpReachable && port.HasValue)
            {
                result.Headline = "已安装并启动守护！等待 Antigravity 窗口就绪";
                result.Detail = "已配置开机自启并启动后台守护。检测到调试端口 " + port.Value + "，窗口就绪后将自动完成注入。";
            }
            else
            {
                result.Headline = "安装成功！后台自动修补已就绪";
                result.Detail = "当前未检测到运行中的 Antigravity Desktop；守护进程已在后台待命，打开 Antigravity Desktop 后会自动立即生效。";
            }
            report(100, result.Headline);
            return result;
        }

        public static OperationResult RunUninstall(InstallerOptions opts, Action<int, string> progress)
        {
            OperationResult result = new OperationResult();
            result.Mode = "uninstall";
            string installDir = Path.GetFullPath(string.IsNullOrEmpty(opts.InstallDir) ? GetDefaultInstallDir() : opts.InstallDir).TrimEnd('\\', '/');
            result.InstallDir = installDir;

            Action<int, string> report = (pct, msg) =>
            {
                if (progress != null) progress(pct, msg);
            };

            report(15, "正在停止后台守护进程...");
            StopWatcherInDir(installDir, (m) => report(25, m));

            report(40, "正在通过 CDP 清理运行中的 Antigravity Desktop 界面...");
            int? port = CdpHelper.ReadPort(opts.CdpPort);
            result.CdpPort = port;
            string removeExpr = null;
            if (File.Exists(Path.Combine(installDir, "manifest.json")))
            {
                try { removeExpr = PluginManifest.Load(installDir).RemoveExpression; } catch { }
            }
            if (string.IsNullOrEmpty(removeExpr))
            {
                try
                {
                    using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("AGY_PAYLOAD.zip"))
                    using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                    {
                        ZipArchiveEntry entry = archive.GetEntry("manifest.json");
                        if (entry != null)
                        {
                            using (StreamReader sr = new StreamReader(entry.Open(), Encoding.UTF8))
                            {
                                Dictionary<string, object> raw = MiniJson.ParseObject(sr.ReadToEnd());
                                if (raw.ContainsKey("removeExpression")) removeExpr = raw["removeExpression"] as string;
                            }
                        }
                    }
                }
                catch { }
            }

            if (port.HasValue && !string.IsNullOrEmpty(removeExpr))
            {
                try
                {
                    List<CdpPageInfo> pages = CdpHelper.ListPagesAsync(port.Value).GetAwaiter().GetResult();
                    for (int i = 0; i < pages.Count; i++)
                    {
                        try
                        {
                            using (CdpSession s = CdpSession.ConnectAsync(pages[i].WebSocketDebuggerUrl, 3000).GetAwaiter().GetResult())
                            {
                                s.EvaluateAsync(removeExpr, false).GetAwaiter().GetResult();
                                string title = CdpHelper.ShortTitle(pages[i]);
                                result.InjectedPages.Add(title);
                                report(55, "已恢复原生界面: " + title);
                            }
                        }
                        catch { }
                    }
                }
                catch { }
            }

            if (!opts.NoAutostart)
            {
                report(70, "正在移除开机自启与卸载注册表项...");
                try
                {
                    string lnk = GetStartupShortcutPath();
                    if (File.Exists(lnk)) File.Delete(lnk);
                }
                catch { }
                try
                {
                    Registry.CurrentUser.DeleteSubKeyTree(UninstallRegSubKey, false);
                }
                catch { }
            }

            report(85, "正在清理安装目录: " + installDir);
            string selfExe = Assembly.GetExecutingAssembly().Location;
            bool runningInsideInstallDir = !string.IsNullOrEmpty(selfExe) &&
                Path.GetFullPath(selfExe).ToLowerInvariant().StartsWith(installDir.ToLowerInvariant() + "\\", StringComparison.Ordinal);

            if (Directory.Exists(installDir))
            {
                if (!runningInsideInstallDir)
                {
                    try { Directory.Delete(installDir, true); } catch { }
                }
                else
                {
                    string[] files = Directory.GetFiles(installDir, "*", SearchOption.AllDirectories);
                    for (int i = 0; i < files.Length; i++)
                    {
                        if (string.Equals(Path.GetFullPath(files[i]), Path.GetFullPath(selfExe), StringComparison.OrdinalIgnoreCase)) continue;
                        try { File.Delete(files[i]); } catch { }
                    }
                    result.SelfDeleteScheduled = true;
                }
            }

            result.Ok = true;
            result.Headline = "已卸载并恢复 Antigravity Desktop 原生界面";
            result.Detail = result.InjectedPages.Count > 0
                ? string.Format("已停止守护、移除自启，并立即还原了 {0} 个打开的窗口。", result.InjectedPages.Count)
                : "已停止守护、移除开机自启并清理安装文件。";
            report(100, result.Headline);
            return result;
        }

        public static void ScheduleSelfDeleteIfNeeded(string installDir)
        {
            string selfExe = Assembly.GetExecutingAssembly().Location;
            if (string.IsNullOrEmpty(selfExe)) return;
            string cmd = string.Format(
                "/c for /L %i in (1,1,10) do (ping -n 2 127.0.0.1 >nul & del /f /q \"{0}\" >nul 2>&1 & rmdir /s /q \"{1}\" >nul 2>&1 & if not exist \"{1}\" exit /b 0)",
                selfExe,
                installDir
            );
            ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmd);
            psi.WorkingDirectory = Path.GetTempPath();
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            try { Process.Start(psi); } catch { }
        }
    }

    internal class InstallerForm : Form
    {
        private readonly InstallerOptions _opts;
        private readonly Label _titleLabel;
        private readonly Label _subtitleLabel;
        private readonly Label _statusHeadline;
        private readonly Label _statusDetail;
        private readonly Label _metaLabel;
        private readonly ProgressBar _progressBar;
        private readonly TextBox _logBox;
        private readonly Button _uninstallBtn;
        private readonly Button _openDirBtn;
        private readonly Button _launchAgBtn;
        private readonly Button _closeBtn;

        private string _activeInstallDir;
        private string _antigravityExe;
        private bool _selfDeleteOnClose;
        private bool _busy;

        public InstallerForm(InstallerOptions opts)
        {
            _opts = opts;
            _activeInstallDir = string.IsNullOrEmpty(opts.InstallDir) ? InstallerCore.GetDefaultInstallDir() : opts.InstallDir;

            Text = "AGY Claude Style 安装与修补工具";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            AutoScaleMode = AutoScaleMode.Font;
            Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            ClientSize = new Size(588, 464);
            BackColor = Color.FromArgb(248, 246, 243);
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }

            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 80;
            header.BackColor = Color.FromArgb(26, 25, 24);
            header.Padding = new Padding(20, 14, 20, 12);

            _titleLabel = new Label();
            _titleLabel.Text = "AGY Claude Style · 自动修补安装器";
            _titleLabel.ForeColor = Color.FromArgb(250, 248, 245);
            _titleLabel.Font = new Font("Microsoft YaHei UI", 13.5f, FontStyle.Bold);
            _titleLabel.AutoSize = true;
            _titleLabel.Location = new Point(20, 14);

            _subtitleLabel = new Label();
            _subtitleLabel.Text = "Antigravity Desktop 无损实时界面增强、思考滑块与 Token HUD";
            _subtitleLabel.ForeColor = Color.FromArgb(217, 119, 87);
            _subtitleLabel.Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular);
            _subtitleLabel.AutoSize = true;
            _subtitleLabel.Location = new Point(21, 46);

            header.Controls.Add(_titleLabel);
            header.Controls.Add(_subtitleLabel);
            Controls.Add(header);

            Panel card = new Panel();
            card.Location = new Point(20, 96);
            card.Size = new Size(548, 118);
            card.BackColor = Color.White;
            card.BorderStyle = BorderStyle.FixedSingle;

            _statusHeadline = new Label();
            _statusHeadline.Text = opts.Uninstall ? "准备卸载并恢复原版界面..." : "正在自动修补本机 Antigravity Desktop...";
            _statusHeadline.ForeColor = Color.FromArgb(28, 25, 23);
            _statusHeadline.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
            _statusHeadline.Location = new Point(14, 12);
            _statusHeadline.Size = new Size(520, 26);

            _statusDetail = new Label();
            _statusDetail.Text = "正在检测环境并配置独立守护进程，请稍候...";
            _statusDetail.ForeColor = Color.FromArgb(87, 83, 78);
            _statusDetail.Location = new Point(14, 42);
            _statusDetail.Size = new Size(520, 40);

            _metaLabel = new Label();
            _metaLabel.Text = "安装路径: " + _activeInstallDir;
            _metaLabel.ForeColor = Color.FromArgb(120, 113, 108);
            _metaLabel.Font = new Font("Microsoft YaHei UI", 8.2f, FontStyle.Regular);
            _metaLabel.Location = new Point(14, 88);
            _metaLabel.Size = new Size(520, 20);

            card.Controls.Add(_statusHeadline);
            card.Controls.Add(_statusDetail);
            card.Controls.Add(_metaLabel);
            Controls.Add(card);

            _progressBar = new ProgressBar();
            _progressBar.Location = new Point(20, 224);
            _progressBar.Size = new Size(548, 14);
            _progressBar.Minimum = 0;
            _progressBar.Maximum = 100;
            _progressBar.Value = 5;
            Controls.Add(_progressBar);

            _logBox = new TextBox();
            _logBox.Location = new Point(20, 248);
            _logBox.Size = new Size(548, 148);
            _logBox.Multiline = true;
            _logBox.ReadOnly = true;
            _logBox.ScrollBars = ScrollBars.Vertical;
            _logBox.BackColor = Color.FromArgb(252, 251, 249);
            _logBox.ForeColor = Color.FromArgb(41, 37, 36);
            _logBox.Font = new Font("Consolas", 8.8f, FontStyle.Regular);
            Controls.Add(_logBox);

            _uninstallBtn = new Button();
            _uninstallBtn.Text = "卸载并恢复原版";
            _uninstallBtn.Location = new Point(20, 412);
            _uninstallBtn.Size = new Size(134, 34);
            _uninstallBtn.Enabled = false;
            _uninstallBtn.FlatStyle = FlatStyle.System;
            _uninstallBtn.Click += async (s, e) => await HandleUninstallClickAsync();

            _openDirBtn = new Button();
            _openDirBtn.Text = "打开配置目录";
            _openDirBtn.Location = new Point(162, 412);
            _openDirBtn.Size = new Size(116, 34);
            _openDirBtn.Enabled = false;
            _openDirBtn.FlatStyle = FlatStyle.System;
            _openDirBtn.Click += (s, e) =>
            {
                try
                {
                    if (Directory.Exists(_activeInstallDir)) Process.Start("explorer.exe", _activeInstallDir);
                }
                catch { }
            };

            _launchAgBtn = new Button();
            _launchAgBtn.Text = "启动 Antigravity";
            _launchAgBtn.Location = new Point(286, 412);
            _launchAgBtn.Size = new Size(134, 34);
            _launchAgBtn.Visible = false;
            _launchAgBtn.FlatStyle = FlatStyle.System;
            _launchAgBtn.Click += (s, e) =>
            {
                try
                {
                    if (!string.IsNullOrEmpty(_antigravityExe) && File.Exists(_antigravityExe))
                    {
                        Process.Start(_antigravityExe);
                    }
                }
                catch { }
            };

            _closeBtn = new Button();
            _closeBtn.Text = "完成并关闭";
            _closeBtn.Location = new Point(456, 412);
            _closeBtn.Size = new Size(112, 34);
            _closeBtn.Enabled = false;
            _closeBtn.FlatStyle = FlatStyle.System;
            _closeBtn.Click += (s, e) => Close();

            Controls.Add(_uninstallBtn);
            Controls.Add(_openDirBtn);
            Controls.Add(_launchAgBtn);
            Controls.Add(_closeBtn);

            Shown += async (s, e) => await StartInitialActionAsync();
            FormClosing += (s, e) =>
            {
                if (_busy)
                {
                    e.Cancel = true;
                    return;
                }
                if (_selfDeleteOnClose)
                {
                    InstallerCore.ScheduleSelfDeleteIfNeeded(_activeInstallDir);
                }
            };
        }

        private void AppendLog(string msg)
        {
            if (IsDisposed || Disposing) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action<string>(AppendLog), msg); } catch { }
                return;
            }
            _logBox.AppendText(string.Format("[{0}] {1}\r\n", DateTime.Now.ToString("HH:mm:ss"), msg));
        }

        private void UpdateProgress(int pct, string msg)
        {
            if (IsDisposed || Disposing) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action<int, string>(UpdateProgress), pct, msg); } catch { }
                return;
            }
            _progressBar.Value = Math.Max(0, Math.Min(100, pct));
            AppendLog(msg);
        }

        private async Task StartInitialActionAsync()
        {
            if (_opts.Uninstall)
            {
                DialogResult dr = MessageBox.Show(
                    this,
                    "确认要卸载 AGY Claude Style 并恢复 Antigravity Desktop 原生界面吗？",
                    "卸载确认",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );
                if (dr != DialogResult.Yes)
                {
                    Close();
                    return;
                }
                await ExecuteUninstallAsync();
            }
            else
            {
                await ExecuteInstallAsync();
            }
        }

        private async Task ExecuteInstallAsync()
        {
            _busy = true;
            SetButtonsEnabled(false);
            try
            {
                OperationResult res = await Task.Run(() => InstallerCore.RunInstall(_opts, UpdateProgress));
                _activeInstallDir = res.InstallDir;
                _antigravityExe = res.AntigravityExe;
                _statusHeadline.Text = res.Headline;
                _statusHeadline.ForeColor = Color.FromArgb(21, 128, 61);
                _statusDetail.Text = res.Detail;
                _metaLabel.Text = "配置: " + res.ConfigSummary;
                _openDirBtn.Enabled = Directory.Exists(_activeInstallDir);
                _uninstallBtn.Enabled = true;
                _launchAgBtn.Visible = (!string.IsNullOrEmpty(_antigravityExe) && res.InjectedPages.Count == 0);
                _launchAgBtn.Enabled = _launchAgBtn.Visible;
            }
            catch (Exception ex)
            {
                _statusHeadline.Text = "修补失败";
                _statusHeadline.ForeColor = Color.FromArgb(185, 28, 28);
                _statusDetail.Text = ex.Message;
                AppendLog("[✗] 错误: " + ex);
            }
            finally
            {
                _busy = false;
                _closeBtn.Enabled = true;
            }
        }

        private async Task HandleUninstallClickAsync()
        {
            DialogResult dr = MessageBox.Show(
                this,
                "确认卸载 AGY Claude Style、停止后台守护并立即恢复 Antigravity 原生界面？",
                "卸载并恢复原版",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (dr != DialogResult.Yes) return;
            await ExecuteUninstallAsync();
        }

        private async Task ExecuteUninstallAsync()
        {
            _busy = true;
            SetButtonsEnabled(false);
            try
            {
                OperationResult res = await Task.Run(() => InstallerCore.RunUninstall(_opts, UpdateProgress));
                _selfDeleteOnClose = res.SelfDeleteScheduled;
                _statusHeadline.Text = res.Headline;
                _statusHeadline.ForeColor = Color.FromArgb(3, 105, 161);
                _statusDetail.Text = res.Detail;
                _metaLabel.Text = "已清理目录: " + res.InstallDir;
                _openDirBtn.Enabled = false;
                _uninstallBtn.Enabled = false;
                _launchAgBtn.Visible = false;
            }
            catch (Exception ex)
            {
                _statusHeadline.Text = "卸载失败";
                _statusHeadline.ForeColor = Color.FromArgb(185, 28, 28);
                _statusDetail.Text = ex.Message;
                AppendLog("[✗] 错误: " + ex);
            }
            finally
            {
                _busy = false;
                _closeBtn.Enabled = true;
            }
        }

        private void SetButtonsEnabled(bool enabled)
        {
            _uninstallBtn.Enabled = enabled;
            _openDirBtn.Enabled = enabled;
            _launchAgBtn.Enabled = enabled;
            _closeBtn.Enabled = enabled;
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }

            InstallerOptions opts = ParseArgs(args);

            if (opts.StatusOnly)
            {
                string dir = Path.GetFullPath(string.IsNullOrEmpty(opts.InstallDir) ? InstallerCore.GetDefaultInstallDir() : opts.InstallDir).TrimEnd('\\', '/');
                AntigravityDetectResult ag = InstallerCore.DetectAntigravityDesktop();
                int? port = CdpHelper.ReadPort(opts.CdpPort);
                Dictionary<string, object> st = new Dictionary<string, object>(StringComparer.Ordinal);
                st["installed"] = Directory.Exists(dir) && File.Exists(Path.Combine(dir, "agy-claude-style-watcher.exe"));
                st["installDir"] = dir;
                st["startupShortcut"] = File.Exists(InstallerCore.GetStartupShortcutPath());
                st["antigravityExe"] = ag.ExePath;
                st["antigravityVersion"] = ag.Version;
                st["antigravityRunning"] = ag.IsRunning;
                st["cdpPort"] = port.HasValue ? (object)port.Value : null;
                string json = MiniJson.Stringify(st, true);
                if (!string.IsNullOrEmpty(opts.OutFile)) File.WriteAllText(opts.OutFile, json, new UTF8Encoding(false));
                else Console.WriteLine(json);
                return 0;
            }

            if (opts.Silent)
            {
                try
                {
                    OperationResult res = opts.Uninstall
                        ? InstallerCore.RunUninstall(opts, null)
                        : InstallerCore.RunInstall(opts, null);
                    WriteOutFile(opts.OutFile, res);
                    if (opts.Popup)
                    {
                        MessageBox.Show(res.Detail, res.Headline, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }
                    if (res.SelfDeleteScheduled)
                    {
                        InstallerCore.ScheduleSelfDeleteIfNeeded(res.InstallDir);
                    }
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    if (!string.IsNullOrEmpty(opts.OutFile))
                    {
                        Dictionary<string, object> err = new Dictionary<string, object>(StringComparer.Ordinal);
                        err["ok"] = false;
                        err["error"] = ex.Message;
                        File.WriteAllText(opts.OutFile, MiniJson.Stringify(err, true), new UTF8Encoding(false));
                    }
                    if (opts.Popup)
                    {
                        MessageBox.Show(ex.Message, "AGY Claude Style 操作失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm(opts));
            return 0;
        }

        private static InstallerOptions ParseArgs(string[] args)
        {
            InstallerOptions opts = new InstallerOptions();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == "--uninstall") opts.Uninstall = true;
                else if (a == "--silent" || a == "/S" || a == "-s") opts.Silent = true;
                else if (a == "--popup") opts.Popup = true;
                else if (a == "--status") opts.StatusOnly = true;
                else if (a == "--no-autostart") opts.NoAutostart = true;
                else if (a == "--no-kill-legacy") opts.NoKillLegacy = true;
                else if (a == "--install-dir" && i + 1 < args.Length) opts.InstallDir = args[++i];
                else if (a == "--cdp-port" && i + 1 < args.Length)
                {
                    int p;
                    if (int.TryParse(args[++i], out p) && p > 0) opts.CdpPort = p;
                }
                else if (a == "--out" && i + 1 < args.Length) opts.OutFile = args[++i];
            }
            return opts;
        }

        private static void WriteOutFile(string outFile, OperationResult res)
        {
            if (string.IsNullOrEmpty(outFile)) return;
            Dictionary<string, object> d = new Dictionary<string, object>(StringComparer.Ordinal);
            d["ok"] = res.Ok;
            d["mode"] = res.Mode;
            d["headline"] = res.Headline;
            d["detail"] = res.Detail;
            d["installDir"] = res.InstallDir;
            d["antigravityExe"] = res.AntigravityExe;
            d["antigravityVersion"] = res.AntigravityVersion;
            d["cdpPort"] = res.CdpPort.HasValue ? (object)res.CdpPort.Value : null;
            d["injectedPages"] = res.InjectedPages;
            d["preservedExistingConfig"] = res.PreservedExistingConfig;
            d["selfDeleteScheduled"] = res.SelfDeleteScheduled;
            File.WriteAllText(outFile, MiniJson.Stringify(d, true), new UTF8Encoding(false));
        }
    }
}
