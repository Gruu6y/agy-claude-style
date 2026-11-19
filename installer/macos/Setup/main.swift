import Cocoa
import Foundation
#if canImport(Darwin)
import Darwin
#endif

final class InstallerOptions {
    var uninstall = false
    var silent = false
    var popup = false
    var statusOnly = false
    var noAutostart = false
    var noKillLegacy = false
    var installDir: String?
    var cdpPort: Int?
    var outFile: String?
}

struct AntigravityDetectResult {
    var appPath: String?
    var version: String?
    var isRunning = false
}

final class OperationResult {
    var ok = false
    var mode = "install"
    var headline = ""
    var detail = ""
    var installDir = ""
    var antigravityApp: String?
    var antigravityVersion: String?
    var cdpPort: Int?
    var injectedPages: [String] = []
    var preservedExistingConfig = false
    var configSummary = ""
}

enum InstallerCore {
    static let launchAgentLabel = "io.github.0dnancy.agy-claude-style"
    static let launchAgentFileName = "io.github.0dnancy.agy-claude-style.plist"
    static let watcherExeName = "agy-claude-style-watcher"
    static let selfInstalledExeName = "agy-claude-style-installer"

    static func getDefaultInstallDir() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return (home as NSString).appendingPathComponent("Library/Application Support/agy-claude-style")
    }

    static func getLaunchAgentPlistPath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ((home as NSString).appendingPathComponent("Library/LaunchAgents") as NSString)
            .appendingPathComponent(launchAgentFileName)
    }

    static func resolvePayloadDir() -> String? {
        let fm = FileManager.default
        if let resPath = Bundle.main.resourcePath {
            let p = (resPath as NSString).appendingPathComponent("payload")
            if fm.fileExists(atPath: (p as NSString).appendingPathComponent("manifest.json")) {
                return p
            }
        }
        let execPath = resolvedSelfExecutablePath()
        let execDir = (execPath as NSString).deletingLastPathComponent
        let contentsDir = (execDir as NSString).deletingLastPathComponent
        let relPayload = ((contentsDir as NSString).appendingPathComponent("Resources") as NSString)
            .appendingPathComponent("payload")
        if fm.fileExists(atPath: (relPayload as NSString).appendingPathComponent("manifest.json")) {
            return relPayload
        }
        return nil
    }

    static func resolveWatcherBinarySource() -> String? {
        let fm = FileManager.default
        if let execPath = Bundle.main.executablePath {
            let dir = (execPath as NSString).deletingLastPathComponent
            let candidate = (dir as NSString).appendingPathComponent(watcherExeName)
            if fm.fileExists(atPath: candidate) { return candidate }
        }
        let selfPath = resolvedSelfExecutablePath()
        let selfDir = (selfPath as NSString).deletingLastPathComponent
        let sibling = (selfDir as NSString).appendingPathComponent(watcherExeName)
        if fm.fileExists(atPath: sibling) { return sibling }
        return nil
    }

    static func resolvedSelfExecutablePath() -> String {
        if let p = Bundle.main.executablePath, !p.isEmpty {
            return URL(fileURLWithPath: p).standardizedFileURL.path
        }
        let arg0 = CommandLine.arguments.first ?? ""
        return URL(fileURLWithPath: arg0).standardizedFileURL.path
    }

    @discardableResult
    static func runProcessSync(executable: String, arguments: [String]) -> (code: Int32, stdout: String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: executable)
        proc.arguments = arguments
        let outPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = FileHandle.nullDevice
        proc.standardInput = FileHandle.nullDevice
        do {
            try proc.run()
            let data = outPipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            let str = String(data: data, encoding: .utf8) ?? ""
            return (proc.terminationStatus, str)
        } catch {
            return (-1, "")
        }
    }

    static func detectAntigravityDesktop() -> AntigravityDetectResult {
        var res = AntigravityDetectResult()
        let running = NSWorkspace.shared.runningApplications
        for app in running {
            let bundleName = app.bundleURL?.lastPathComponent.lowercased() ?? ""
            let locName = app.localizedName?.lowercased() ?? ""
            let exeName = app.executableURL?.lastPathComponent.lowercased() ?? ""
            if bundleName == "antigravity.app" || locName == "antigravity" || exeName == "antigravity" {
                res.isRunning = true
                if let url = app.bundleURL {
                    res.appPath = url.path
                    break
                }
            }
        }

        let fm = FileManager.default
        if res.appPath == nil {
            let home = fm.homeDirectoryForCurrentUser.path
            let candidates = [
                "/Applications/Antigravity.app",
                (home as NSString).appendingPathComponent("Applications/Antigravity.app"),
            ]
            for path in candidates {
                if fm.fileExists(atPath: path) {
                    res.appPath = path
                    break
                }
            }
        }

        if let appPath = res.appPath {
            let plistPath = ((appPath as NSString).appendingPathComponent("Contents") as NSString)
                .appendingPathComponent("Info.plist")
            if let dict = NSDictionary(contentsOfFile: plistPath) {
                if let shortVer = dict["CFBundleShortVersionString"] as? String, !shortVer.isEmpty {
                    res.version = shortVer
                } else if let ver = dict["CFBundleVersion"] as? String, !ver.isEmpty {
                    res.version = ver
                }
            }
        }
        return res
    }

    static func unloadLaunchAgent() {
        let plistPath = getLaunchAgentPlistPath()
        let uid = getuid()
        _ = runProcessSync(executable: "/bin/launchctl", arguments: ["bootout", "gui/\(uid)/\(launchAgentLabel)"])
        if FileManager.default.fileExists(atPath: plistPath) {
            _ = runProcessSync(executable: "/bin/launchctl", arguments: ["unload", "-w", plistPath])
        }
    }

    private static func terminatePid(_ pid: Int32) -> Bool {
        guard pid > 0, pid != getpid() else { return false }
        guard kill(pid, 0) == 0 else { return false }
        _ = kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(2.0)
        while Date() < deadline {
            if kill(pid, 0) != 0 { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if kill(pid, 0) == 0 {
            _ = kill(pid, SIGKILL)
            Thread.sleep(forTimeInterval: 0.1)
        }
        return true
    }

    static func stopWatcherInDir(_ dir: String, noAutostart: Bool, log: ((String) -> Void)?) {
        let fm = FileManager.default
        if !noAutostart {
            unloadLaunchAgent()
        }
        guard fm.fileExists(atPath: dir) else { return }

        let pidFile = (dir as NSString).appendingPathComponent(".watch.pid")
        if let pidStr = try? String(contentsOfFile: pidFile, encoding: .utf8),
           let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)),
           pid > 0 {
            if terminatePid(pid) {
                log?("已停止运行中的守护进程 (PID \(pid))")
            }
            try? fm.removeItem(atPath: pidFile)
        }

        let normalizedDir = URL(fileURLWithPath: dir).standardizedFileURL.path
        let ps = runProcessSync(executable: "/bin/ps", arguments: ["-ax", "-o", "pid=,command="])
        for rawLine in ps.stdout.components(separatedBy: CharacterSet.newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            let parts = line.split(maxSplits: 1, omittingEmptySubsequences: true, whereSeparator: { $0.isWhitespace })
            guard parts.count == 2, let pid = Int32(parts[0]) else { continue }
            let cmd = String(parts[1])
            if cmd.contains(watcherExeName) && cmd.contains(normalizedDir) {
                _ = terminatePid(pid)
            }
        }
    }

    static func stopLegacyNodeWatchers(log: ((String) -> Void)?) {
        let ps = runProcessSync(executable: "/bin/ps", arguments: ["-ax", "-o", "pid=,command="])
        for rawLine in ps.stdout.components(separatedBy: CharacterSet.newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            let parts = line.split(maxSplits: 1, omittingEmptySubsequences: true, whereSeparator: { $0.isWhitespace })
            guard parts.count == 2, let pid = Int32(parts[0]) else { continue }
            let cmd = String(parts[1]).lowercased()
            if cmd.contains("node") &&
                cmd.contains("agy-claude-style") &&
                cmd.contains("inject.js") &&
                cmd.contains("--watch") {
                if terminatePid(pid) {
                    log?("已替换旧版 Node 守护进程 (PID \(pid))")
                }
            }
        }
    }

    private static func xmlEscape(_ s: String) -> String {
        return s
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    static func registerLaunchAgent(installDir: String, cdpPort: Int?) throws {
        let plistPath = getLaunchAgentPlistPath()
        let launchAgentsDir = (plistPath as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: launchAgentsDir, withIntermediateDirectories: true, attributes: nil)

        let watcherExe = (installDir as NSString).appendingPathComponent(watcherExeName)
        var args = [watcherExe, "--watch", "--keep-alive", "--dir", installDir]
        if let port = cdpPort, port > 0 {
            args.append("--cdp-port")
            args.append(String(port))
        }
        let argsXml = args.map { "    <string>\(xmlEscape($0))</string>" }.joined(separator: "\n")
        let outLog = (installDir as NSString).appendingPathComponent("launchd.out.log")
        let errLog = (installDir as NSString).appendingPathComponent("launchd.err.log")

        let plistContent = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(xmlEscape(launchAgentLabel))</string>
          <key>ProgramArguments</key>
          <array>
        \(argsXml)
          </array>
          <key>WorkingDirectory</key>
          <string>\(xmlEscape(installDir))</string>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <false/>
          <key>StandardOutPath</key>
          <string>\(xmlEscape(outLog))</string>
          <key>StandardErrorPath</key>
          <string>\(xmlEscape(errLog))</string>
        </dict>
        </plist>
        """
        try plistContent.write(toFile: plistPath, atomically: true, encoding: .utf8)

        let uid = getuid()
        _ = runProcessSync(executable: "/bin/launchctl", arguments: ["bootout", "gui/\(uid)/\(launchAgentLabel)"])
        let bootRes = runProcessSync(executable: "/bin/launchctl", arguments: ["bootstrap", "gui/\(uid)", plistPath])
        if bootRes.code != 0 {
            _ = runProcessSync(executable: "/bin/launchctl", arguments: ["load", "-w", plistPath])
        }
    }

    private static func spawnWatcherDirectly(installDir: String, cdpPort: Int?) throws {
        let watcherExe = (installDir as NSString).appendingPathComponent(watcherExeName)
        var args = ["--watch", "--dir", installDir]
        if let port = cdpPort, port > 0 {
            args.append("--cdp-port")
            args.append(String(port))
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: watcherExe)
        proc.arguments = args
        proc.currentDirectoryURL = URL(fileURLWithPath: installDir)
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try proc.run()
    }

    static func runInstall(opts: InstallerOptions, progress: ((Int, String) -> Void)?) throws -> OperationResult {
        let result = OperationResult()
        result.mode = "install"
        let rawDir = (opts.installDir?.isEmpty == false) ? opts.installDir! : getDefaultInstallDir()
        let installDir = URL(fileURLWithPath: rawDir).standardizedFileURL.path
        result.installDir = installDir

        let report: (Int, String) -> Void = { pct, msg in
            progress?(pct, msg)
        }

        report(10, "正在检测本机 Antigravity Desktop 环境...")
        let ag = detectAntigravityDesktop()
        result.antigravityApp = ag.appPath
        result.antigravityVersion = ag.version
        if let appPath = ag.appPath {
            let verPart = (ag.version?.isEmpty == false) ? " (\(ag.version!))" : ""
            report(18, "已发现 Antigravity Desktop\(verPart): \(appPath)")
        } else {
            report(18, "未在默认目录检测到 Antigravity.app，仍将安装并启用 CDP 自动监听")
        }

        report(28, "正在停止旧版守护进程（如存在）...")
        stopWatcherInDir(installDir, noAutostart: opts.noAutostart) { msg in
            report(32, msg)
        }
        if !opts.noKillLegacy {
            stopLegacyNodeWatchers { msg in
                report(35, msg)
            }
        }

        report(45, "正在部署独立运行环境与插件资源至: \(installDir)")
        let fm = FileManager.default
        try fm.createDirectory(atPath: installDir, withIntermediateDirectories: true, attributes: nil)

        guard let payloadDir = resolvePayloadDir() else {
            throw CdpError("安装包内置资源 payload 缺失")
        }
        guard let watcherSrc = resolveWatcherBinarySource() else {
            throw CdpError("安装包内置守护程序 \(watcherExeName) 缺失")
        }

        var preservedConfig = false
        let payloadEntries = try fm.contentsOfDirectory(atPath: payloadDir)
        for name in payloadEntries {
            if name.hasPrefix(".") { continue }
            let src = (payloadDir as NSString).appendingPathComponent(name)
            let dest = (installDir as NSString).appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: src, isDirectory: &isDir), !isDir.boolValue else { continue }

            if name.caseInsensitiveCompare("config.json") == .orderedSame && fm.fileExists(atPath: dest) {
                preservedConfig = true
                continue
            }
            if fm.fileExists(atPath: dest) {
                try fm.removeItem(atPath: dest)
            }
            try fm.copyItem(atPath: src, toPath: dest)
        }

        let watcherDest = (installDir as NSString).appendingPathComponent(watcherExeName)
        if fm.fileExists(atPath: watcherDest) {
            try fm.removeItem(atPath: watcherDest)
        }
        try fm.copyItem(atPath: watcherSrc, toPath: watcherDest)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: watcherDest)

        let selfSrc = resolvedSelfExecutablePath()
        let selfDest = (installDir as NSString).appendingPathComponent(selfInstalledExeName)
        if !selfSrc.isEmpty && fm.fileExists(atPath: selfSrc) && selfSrc != selfDest {
            if fm.fileExists(atPath: selfDest) {
                try? fm.removeItem(atPath: selfDest)
            }
            try? fm.copyItem(atPath: selfSrc, toPath: selfDest)
            try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: selfDest)
        }

        result.preservedExistingConfig = preservedConfig
        report(62, preservedConfig ? "已保留本机现有 config.json 用户配置" : "已写入内置默认配置 config.json")

        let manifest = try PluginManifest.load(baseDir: installDir)
        let activeCfg = CdpHelper.readConfig(baseDir: installDir, manifest: manifest)
        let lang = activeCfg["language"]?.stringValue ?? "zh-CN"
        let palette = activeCfg["palette"]?.stringValue ?? "obsidian"
        let ringMode = activeCfg["ringMode"]?.stringValue ?? "context"
        let effortStyle = activeCfg["effortSliderStyle"]?.stringValue ?? "claude"
        result.configSummary = "语言=\(lang) | 配色=\(palette) | 圆环=\(ringMode) | 思考滑块=\(effortStyle)"

        if !opts.noAutostart {
            report(72, "正在配置 macOS LaunchAgent 登录自启...")
            try registerLaunchAgent(installDir: installDir, cdpPort: opts.cdpPort)
            Thread.sleep(forTimeInterval: 0.25)
            let pidFile = (installDir as NSString).appendingPathComponent(".watch.pid")
            if !fm.fileExists(atPath: pidFile) {
                report(82, "正在启动后台静默守护进程...")
                try spawnWatcherDirectly(installDir: installDir, cdpPort: opts.cdpPort)
            }
        } else {
            report(72, "已按参数跳过 LaunchAgent 登录自启注册")
            report(82, "正在启动后台静默守护进程...")
            try spawnWatcherDirectly(installDir: installDir, cdpPort: opts.cdpPort)
        }

        report(90, "正在检查 Antigravity Desktop 实时注入状态...")
        let port = CdpHelper.readPort(overridePort: opts.cdpPort)
        var cdpReachable = false
        let watchLogPath = (installDir as NSString).appendingPathComponent("watch.log")

        if let port = port {
            for attempt in 0..<15 {
                if let pages = try? CdpHelper.listPages(port: port) {
                    cdpReachable = true
                    let logContent = (try? String(contentsOfFile: watchLogPath, encoding: .utf8)) ?? ""
                    let watcherInjected = logContent.contains("[✓] 已注入 agy-claude-style:")
                    if !pages.isEmpty && watcherInjected {
                        var allReady = true
                        var titles: [String] = []
                        for page in pages {
                            titles.append(CdpHelper.shortTitle(page))
                            do {
                                let session = try CdpSession.connect(wsUrl: page.webSocketDebuggerUrl, timeoutMs: 2000)
                                defer { session.close() }
                                let okVal = try session.evaluate("Boolean(window.__agClaudeStyle)", awaitPromise: false)
                                if okVal.boolValue != true {
                                    allReady = false
                                }
                            } catch {
                                allReady = false
                            }
                        }
                        if allReady {
                            result.injectedPages = titles
                            break
                        }
                    }
                } else {
                    if !ag.isRunning && opts.cdpPort == nil && attempt >= 1 {
                        break
                    }
                }
                Thread.sleep(forTimeInterval: 0.35)
            }
        }
        result.cdpPort = cdpReachable ? port : nil

        result.ok = true
        if !result.injectedPages.isEmpty {
            result.headline = "修补成功！已实时注入 \(result.injectedPages.count) 个 Antigravity 窗口"
            result.detail = "后台无损守护已运行并已配置登录自启。后续打开新窗口或更新 Antigravity 后也会自动注入。"
            for title in result.injectedPages {
                report(98, "已注入窗口: \(title)")
            }
        } else if cdpReachable, let port = port {
            result.headline = "已安装并启动守护！等待 Antigravity 窗口就绪"
            result.detail = "已配置登录自启并启动后台守护。检测到调试端口 \(port)，窗口就绪后将自动完成注入。"
        } else {
            result.headline = "安装成功！后台自动修补已就绪"
            result.detail = "当前未检测到运行中的 Antigravity Desktop；守护进程已在后台待命，打开 Antigravity Desktop 后会自动立即生效。"
        }
        report(100, result.headline)
        return result
    }

    static func runUninstall(opts: InstallerOptions, progress: ((Int, String) -> Void)?) -> OperationResult {
        let result = OperationResult()
        result.mode = "uninstall"
        let rawDir = (opts.installDir?.isEmpty == false) ? opts.installDir! : getDefaultInstallDir()
        let installDir = URL(fileURLWithPath: rawDir).standardizedFileURL.path
        result.installDir = installDir

        let report: (Int, String) -> Void = { pct, msg in
            progress?(pct, msg)
        }

        report(15, "正在停止后台守护进程...")
        stopWatcherInDir(installDir, noAutostart: opts.noAutostart) { msg in
            report(25, msg)
        }

        report(40, "正在通过 CDP 清理运行中的 Antigravity Desktop 界面...")
        let port = CdpHelper.readPort(overridePort: opts.cdpPort)
        result.cdpPort = port

        var removeExpr: String?
        if let m = try? PluginManifest.load(baseDir: installDir), !m.removeExpression.isEmpty {
            removeExpr = m.removeExpression
        } else if let payloadDir = resolvePayloadDir(),
                  let m = try? PluginManifest.load(baseDir: payloadDir),
                  !m.removeExpression.isEmpty {
            removeExpr = m.removeExpression
        }

        if let port = port, let expr = removeExpr, !expr.isEmpty,
           let pages = try? CdpHelper.listPages(port: port) {
            for page in pages {
                if let session = try? CdpSession.connect(wsUrl: page.webSocketDebuggerUrl, timeoutMs: 3000) {
                    defer { session.close() }
                    if (try? session.evaluate(expr, awaitPromise: false)) != nil {
                        let title = CdpHelper.shortTitle(page)
                        result.injectedPages.append(title)
                        report(55, "已恢复原生界面: \(title)")
                    }
                }
            }
        }

        if !opts.noAutostart {
            report(70, "正在移除 LaunchAgent 登录自启项...")
            unloadLaunchAgent()
            let plistPath = getLaunchAgentPlistPath()
            if FileManager.default.fileExists(atPath: plistPath) {
                try? FileManager.default.removeItem(atPath: plistPath)
            }
        }

        report(85, "正在清理安装目录: \(installDir)")
        if FileManager.default.fileExists(atPath: installDir) {
            try? FileManager.default.removeItem(atPath: installDir)
        }

        result.ok = true
        result.headline = "已卸载并恢复 Antigravity Desktop 原生界面"
        result.detail = !result.injectedPages.isEmpty
            ? "已停止守护、移除自启，并立即还原了 \(result.injectedPages.count) 个打开的窗口。"
            : "已停止守护、移除登录自启并清理安装目录。"
        report(100, result.headline)
        return result
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { return true }
}

final class InstallerAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let opts: InstallerOptions
    private var window: NSWindow!
    private var statusHeadline: NSTextField!
    private var statusDetail: NSTextField!
    private var metaLabel: NSTextField!
    private var progressBar: NSProgressIndicator!
    private var logView: NSTextView!
    private var uninstallBtn: NSButton!
    private var openDirBtn: NSButton!
    private var launchAgBtn: NSButton!
    private var closeBtn: NSButton!

    private var activeInstallDir: String
    private var antigravityApp: String?
    private var busy = false

    init(opts: InstallerOptions) {
        self.opts = opts
        let rawDir = (opts.installDir?.isEmpty == false) ? opts.installDir! : InstallerCore.getDefaultInstallDir()
        self.activeInstallDir = URL(fileURLWithPath: rawDir).standardizedFileURL.path
        super.init()
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "退出 AGY Claude Style", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(NSMenuItem(title: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editMenuItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    private static func srgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1.0) -> NSColor {
        return NSColor(srgbRed: r / 255.0, green: g / 255.0, blue: b / 255.0, alpha: a)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainMenu()

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 588, height: 464),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        win.title = "AGY Claude Style 安装与修补工具"
        win.appearance = NSAppearance(named: .aqua)
        win.backgroundColor = Self.srgb(248, 246, 243)
        win.isReleasedWhenClosed = false
        win.delegate = self

        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 588, height: 464))
        win.contentView = root

        // Header
        let header = FlippedView(frame: NSRect(x: 0, y: 0, width: 588, height: 80))
        header.wantsLayer = true
        header.layer?.backgroundColor = Self.srgb(26, 25, 24).cgColor
        root.addSubview(header)

        let iconView = NSImageView(frame: NSRect(x: 20, y: 18, width: 44, height: 44))
        iconView.image = NSApp.applicationIconImage
        iconView.imageScaling = .scaleProportionallyUpOrDown
        header.addSubview(iconView)

        let titleLabel = NSTextField(labelWithString: "AGY Claude Style · 自动修补安装器")
        titleLabel.frame = NSRect(x: 76, y: 15, width: 492, height: 24)
        titleLabel.textColor = Self.srgb(250, 248, 245)
        titleLabel.font = NSFont.systemFont(ofSize: 17, weight: .bold)
        header.addSubview(titleLabel)

        let subtitleLabel = NSTextField(labelWithString: "Antigravity Desktop 无损实时界面增强、思考滑块与 Token HUD")
        subtitleLabel.frame = NSRect(x: 76, y: 45, width: 492, height: 18)
        subtitleLabel.textColor = Self.srgb(217, 119, 87)
        subtitleLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        header.addSubview(subtitleLabel)

        // Status card
        let card = FlippedView(frame: NSRect(x: 20, y: 96, width: 548, height: 118))
        card.wantsLayer = true
        card.layer?.backgroundColor = NSColor.white.cgColor
        card.layer?.borderColor = Self.srgb(222, 217, 209).cgColor
        card.layer?.borderWidth = 1.0
        card.layer?.cornerRadius = 6.0
        root.addSubview(card)

        statusHeadline = NSTextField(labelWithString: opts.uninstall ? "准备卸载并恢复原版界面..." : "正在自动修补本机 Antigravity Desktop...")
        statusHeadline.frame = NSRect(x: 14, y: 12, width: 520, height: 24)
        statusHeadline.textColor = Self.srgb(28, 25, 23)
        statusHeadline.font = NSFont.systemFont(ofSize: 14, weight: .bold)
        statusHeadline.lineBreakMode = .byTruncatingTail
        card.addSubview(statusHeadline)

        statusDetail = NSTextField(wrappingLabelWithString: "正在检测环境并配置独立守护进程，请稍候...")
        statusDetail.frame = NSRect(x: 14, y: 40, width: 520, height: 40)
        statusDetail.textColor = Self.srgb(87, 83, 78)
        statusDetail.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        statusDetail.maximumNumberOfLines = 2
        card.addSubview(statusDetail)

        metaLabel = NSTextField(labelWithString: "安装路径: \(activeInstallDir)")
        metaLabel.frame = NSRect(x: 14, y: 88, width: 520, height: 18)
        metaLabel.textColor = Self.srgb(120, 113, 108)
        metaLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        metaLabel.lineBreakMode = .byTruncatingMiddle
        card.addSubview(metaLabel)

        // Progress bar
        progressBar = NSProgressIndicator(frame: NSRect(x: 20, y: 224, width: 548, height: 14))
        progressBar.isIndeterminate = false
        progressBar.minValue = 0
        progressBar.maxValue = 100
        progressBar.doubleValue = 5
        root.addSubview(progressBar)

        // Log area
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 248, width: 548, height: 148))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let tv = NSTextView(frame: NSRect(x: 0, y: 0, width: 530, height: 144))
        tv.isEditable = false
        tv.isSelectable = true
        tv.backgroundColor = Self.srgb(252, 251, 249)
        tv.textColor = Self.srgb(41, 37, 36)
        tv.font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = true
        scroll.documentView = tv
        root.addSubview(scroll)
        self.logView = tv

        // Buttons
        uninstallBtn = NSButton(title: "卸载并恢复原版", target: self, action: #selector(handleUninstallClick))
        uninstallBtn.frame = NSRect(x: 20, y: 412, width: 136, height: 32)
        uninstallBtn.bezelStyle = .rounded
        uninstallBtn.isEnabled = false
        root.addSubview(uninstallBtn)

        openDirBtn = NSButton(title: "打开配置目录", target: self, action: #selector(handleOpenDirClick))
        openDirBtn.frame = NSRect(x: 162, y: 412, width: 118, height: 32)
        openDirBtn.bezelStyle = .rounded
        openDirBtn.isEnabled = false
        root.addSubview(openDirBtn)

        launchAgBtn = NSButton(title: "启动 Antigravity", target: self, action: #selector(handleLaunchAgClick))
        launchAgBtn.frame = NSRect(x: 286, y: 412, width: 134, height: 32)
        launchAgBtn.bezelStyle = .rounded
        launchAgBtn.isHidden = true
        launchAgBtn.isEnabled = false
        root.addSubview(launchAgBtn)

        closeBtn = NSButton(title: "完成并关闭", target: self, action: #selector(handleCloseClick))
        closeBtn.frame = NSRect(x: 456, y: 412, width: 112, height: 32)
        closeBtn.bezelStyle = .rounded
        closeBtn.keyEquivalent = "\r"
        closeBtn.isEnabled = false
        root.addSubview(closeBtn)

        win.center()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = win

        startInitialAction()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        return !busy
    }

    private func appendLog(_ msg: String) {
        let df = DateFormatter()
        df.dateFormat = "HH:mm:ss"
        let line = "[\(df.string(from: Date()))] \(msg)\n"
        DispatchQueue.main.async {
            let attr = NSAttributedString(
                string: line,
                attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
                    .foregroundColor: Self.srgb(41, 37, 36),
                ]
            )
            self.logView.textStorage?.append(attr)
            self.logView.scrollToEndOfDocument(nil)
        }
    }

    private func updateProgress(_ pct: Int, _ msg: String) {
        let clamped = Double(max(0, min(100, pct)))
        DispatchQueue.main.async {
            self.progressBar.doubleValue = clamped
        }
        appendLog(msg)
    }

    private func setButtonsEnabled(_ enabled: Bool) {
        uninstallBtn.isEnabled = enabled
        openDirBtn.isEnabled = enabled
        launchAgBtn.isEnabled = enabled
        closeBtn.isEnabled = enabled
    }

    private func startInitialAction() {
        if opts.uninstall {
            let alert = NSAlert()
            alert.messageText = "卸载确认"
            alert.informativeText = "确认要卸载 AGY Claude Style 并恢复 Antigravity Desktop 原生界面吗？"
            alert.alertStyle = .informational
            alert.addButton(withTitle: "确认卸载")
            alert.addButton(withTitle: "取消")
            if alert.runModal() == .alertFirstButtonReturn {
                executeUninstall()
            } else {
                window.close()
            }
        } else {
            executeInstall()
        }
    }

    private func executeInstall() {
        busy = true
        setButtonsEnabled(false)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let res = try InstallerCore.runInstall(opts: self.opts) { pct, msg in
                    self.updateProgress(pct, msg)
                }
                DispatchQueue.main.async {
                    self.activeInstallDir = res.installDir
                    self.antigravityApp = res.antigravityApp
                    self.statusHeadline.stringValue = res.headline
                    self.statusHeadline.textColor = Self.srgb(21, 128, 61)
                    self.statusDetail.stringValue = res.detail
                    self.metaLabel.stringValue = "配置: \(res.configSummary)"
                    self.openDirBtn.isEnabled = FileManager.default.fileExists(atPath: self.activeInstallDir)
                    self.uninstallBtn.isEnabled = true
                    let showLaunch = (self.antigravityApp != nil && res.injectedPages.isEmpty)
                    self.launchAgBtn.isHidden = !showLaunch
                    self.launchAgBtn.isEnabled = showLaunch
                    self.busy = false
                    self.closeBtn.isEnabled = true
                }
            } catch {
                self.appendLog("[✗] 错误: \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self.statusHeadline.stringValue = "修补失败"
                    self.statusHeadline.textColor = Self.srgb(185, 28, 28)
                    self.statusDetail.stringValue = error.localizedDescription
                    self.busy = false
                    self.closeBtn.isEnabled = true
                }
            }
        }
    }

    @objc private func handleUninstallClick() {
        let alert = NSAlert()
        alert.messageText = "卸载并恢复原版"
        alert.informativeText = "确认卸载 AGY Claude Style、停止后台守护并立即恢复 Antigravity 原生界面？"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "确认卸载")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            executeUninstall()
        }
    }

    private func executeUninstall() {
        busy = true
        setButtonsEnabled(false)
        DispatchQueue.global(qos: .userInitiated).async {
            let res = InstallerCore.runUninstall(opts: self.opts) { pct, msg in
                self.updateProgress(pct, msg)
            }
            DispatchQueue.main.async {
                self.statusHeadline.stringValue = res.headline
                self.statusHeadline.textColor = Self.srgb(3, 105, 161)
                self.statusDetail.stringValue = res.detail
                self.metaLabel.stringValue = "已清理目录: \(res.installDir)"
                self.openDirBtn.isEnabled = false
                self.uninstallBtn.isEnabled = false
                self.launchAgBtn.isHidden = true
                self.busy = false
                self.closeBtn.isEnabled = true
            }
        }
    }

    @objc private func handleOpenDirClick() {
        if FileManager.default.fileExists(atPath: activeInstallDir) {
            NSWorkspace.shared.open(URL(fileURLWithPath: activeInstallDir))
        }
    }

    @objc private func handleLaunchAgClick() {
        if let appPath = antigravityApp, FileManager.default.fileExists(atPath: appPath) {
            let url = URL(fileURLWithPath: appPath)
            let cfg = NSWorkspace.OpenConfiguration()
            NSWorkspace.shared.openApplication(at: url, configuration: cfg, completionHandler: nil)
        }
    }

    @objc private func handleCloseClick() {
        window.close()
    }
}

func parseInstallerArgs(_ args: [String]) -> InstallerOptions {
    let opts = InstallerOptions()
    var i = 1
    while i < args.count {
        let a = args[i]
        if a.hasPrefix("-psn_") {
            i += 1
            continue
        }
        if a == "--uninstall" { opts.uninstall = true }
        else if a == "--silent" || a == "/S" || a == "-s" { opts.silent = true }
        else if a == "--popup" { opts.popup = true }
        else if a == "--status" { opts.statusOnly = true }
        else if a == "--no-autostart" { opts.noAutostart = true }
        else if a == "--no-kill-legacy" { opts.noKillLegacy = true }
        else if a == "--install-dir" && i + 1 < args.count { i += 1; opts.installDir = args[i] }
        else if a == "--cdp-port" && i + 1 < args.count {
            i += 1
            if let p = Int(args[i]), p > 0 { opts.cdpPort = p }
        }
        else if a == "--out" && i + 1 < args.count { i += 1; opts.outFile = args[i] }
        i += 1
    }
    return opts
}

func writeOperationOutFile(_ outFile: String?, res: OperationResult) {
    guard let outFile = outFile, !outFile.isEmpty else { return }
    let d: [String: JsonValue] = [
        "ok": .bool(res.ok),
        "mode": .string(res.mode),
        "headline": .string(res.headline),
        "detail": .string(res.detail),
        "installDir": .string(res.installDir),
        "antigravityApp": res.antigravityApp.map { .string($0) } ?? .null,
        "antigravityVersion": res.antigravityVersion.map { .string($0) } ?? .null,
        "cdpPort": res.cdpPort.map { .int(Int64($0)) } ?? .null,
        "injectedPages": .array(res.injectedPages.map { .string($0) }),
        "preservedExistingConfig": .bool(res.preservedExistingConfig),
    ]
    let text = MiniJson.stringify(.object(d), pretty: true) + "\n"
    try? text.write(toFile: outFile, atomically: true, encoding: .utf8)
}

func runInstallerMain() -> Int32 {
    let opts = parseInstallerArgs(CommandLine.arguments)

    if opts.statusOnly {
        let rawDir = (opts.installDir?.isEmpty == false) ? opts.installDir! : InstallerCore.getDefaultInstallDir()
        let dir = URL(fileURLWithPath: rawDir).standardizedFileURL.path
        let ag = InstallerCore.detectAntigravityDesktop()
        let port = CdpHelper.readPort(overridePort: opts.cdpPort)
        let watcherPath = (dir as NSString).appendingPathComponent(InstallerCore.watcherExeName)
        let fm = FileManager.default
        let st: [String: JsonValue] = [
            "installed": .bool(fm.fileExists(atPath: dir) && fm.fileExists(atPath: watcherPath)),
            "installDir": .string(dir),
            "launchAgent": .bool(fm.fileExists(atPath: InstallerCore.getLaunchAgentPlistPath())),
            "antigravityApp": ag.appPath.map { .string($0) } ?? .null,
            "antigravityVersion": ag.version.map { .string($0) } ?? .null,
            "antigravityRunning": .bool(ag.isRunning),
            "cdpPort": port.map { .int(Int64($0)) } ?? .null,
        ]
        let json = MiniJson.stringify(.object(st), pretty: true) + "\n"
        if let outFile = opts.outFile, !outFile.isEmpty {
            try? json.write(toFile: outFile, atomically: true, encoding: .utf8)
        } else {
            print(json, terminator: "")
        }
        return 0
    }

    if opts.silent {
        do {
            let res = opts.uninstall
                ? InstallerCore.runUninstall(opts: opts, progress: nil)
                : try InstallerCore.runInstall(opts: opts, progress: nil)
            writeOperationOutFile(opts.outFile, res: res)
            if opts.popup {
                let app = NSApplication.shared
                app.setActivationPolicy(.accessory)
                let alert = NSAlert()
                alert.messageText = res.headline
                alert.informativeText = res.detail
                alert.runModal()
            }
            return res.ok ? 0 : 1
        } catch {
            if let outFile = opts.outFile, !outFile.isEmpty {
                let errObj: [String: JsonValue] = [
                    "ok": .bool(false),
                    "error": .string(error.localizedDescription),
                ]
                let text = MiniJson.stringify(.object(errObj), pretty: true) + "\n"
                try? text.write(toFile: outFile, atomically: true, encoding: .utf8)
            }
            if opts.popup {
                let app = NSApplication.shared
                app.setActivationPolicy(.accessory)
                let alert = NSAlert()
                alert.alertStyle = .critical
                alert.messageText = "AGY Claude Style 操作失败"
                alert.informativeText = error.localizedDescription
                alert.runModal()
            }
            return 1
        }
    }

    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let delegate = InstallerAppDelegate(opts: opts)
    app.delegate = delegate
    app.run()
    return 0
}

exit(runInstallerMain())
