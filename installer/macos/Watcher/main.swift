import Foundation
#if canImport(Darwin)
import Darwin
#endif

final class AttachedEntry {
    let session: CdpSession
    var scriptId: String?
    let title: String

    init(session: CdpSession, scriptId: String? = nil, title: String) {
        self.session = session
        self.scriptId = scriptId
        self.title = title
    }
}

final class WatcherApp {
    private let baseDir: String
    private let logFile: String
    private let pidFile: String
    private let lockFile: String
    private let isWatch: Bool
    private let logLock = NSLock()

    init(baseDir: String, isWatch: Bool) {
        self.baseDir = baseDir
        self.logFile = (baseDir as NSString).appendingPathComponent("watch.log")
        self.pidFile = (baseDir as NSString).appendingPathComponent(".watch.pid")
        self.lockFile = (baseDir as NSString).appendingPathComponent(".watch.lock")
        self.isWatch = isWatch
    }

    func log(_ line: String) {
        guard isWatch else { return }
        logLock.lock()
        defer { logLock.unlock() }
        let fm = FileManager.default
        if let attrs = try? fm.attributesOfItem(atPath: logFile),
           let size = attrs[.size] as? NSNumber,
           size.int64Value > 1024 * 1024 {
            try? "".write(toFile: logFile, atomically: false, encoding: .utf8)
        }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let entry = "[\(fmt.string(from: Date()))] \(line)\n"
        guard let data = entry.data(using: .utf8) else { return }
        if !fm.fileExists(atPath: logFile) {
            fm.createFile(atPath: logFile, contents: data, attributes: nil)
            return
        }
        if let handle = FileHandle(forWritingAtPath: logFile) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        }
    }

    static func writeResult(outFile: String?, ok: Bool, message: String, pages: [String]?) {
        guard let outFile = outFile, !outFile.isEmpty else { return }
        var obj: [String: JsonValue] = [
            "ok": .bool(ok),
            "message": .string(message)
        ]
        if let pages = pages {
            obj["pages"] = .array(pages.map { .string($0) })
        }
        let text = MiniJson.stringify(.object(obj), pretty: true) + "\n"
        try? text.write(toFile: outFile, atomically: true, encoding: .utf8)
    }

    private func readPidFile() -> Int32? {
        guard let text = try? String(contentsOfFile: pidFile, encoding: .utf8) else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let pid = Int32(trimmed), pid > 0 { return pid }
        return nil
    }

    private func releasePidFile(selfPid: Int32) {
        if let current = readPidFile(), current == selfPid {
            try? FileManager.default.removeItem(atPath: pidFile)
        }
    }

    func runOnce(overridePort: Int?, outFile: String?) -> Int32 {
        do {
            let manifest = try PluginManifest.load(baseDir: baseDir)
            guard let port = CdpHelper.readPort(overridePort: overridePort) else {
                Self.writeResult(outFile: outFile, ok: false, message: "未找到调试端口文件，Antigravity 可能未运行", pages: nil)
                return 1
            }
            let pages = try CdpHelper.listPages(port: port)
            if pages.isEmpty {
                Self.writeResult(outFile: outFile, ok: false, message: "未找到 Antigravity 窗口页面", pages: nil)
                return 1
            }
            let expr = try CdpHelper.buildInjectExpression(baseDir: baseDir, manifest: manifest)
            var injectedTitles: [String] = []
            for page in pages {
                let session = try CdpSession.connect(wsUrl: page.webSocketDebuggerUrl, timeoutMs: 4000)
                defer { session.close() }
                _ = try session.evaluate(expr, awaitPromise: false)
                injectedTitles.append(CdpHelper.shortTitle(page))
            }
            Self.writeResult(outFile: outFile, ok: true, message: "injected \(injectedTitles.count) page(s)", pages: injectedTitles)
            return 0
        } catch {
            Self.writeResult(outFile: outFile, ok: false, message: error.localizedDescription, pages: nil)
            return 1
        }
    }

    func runRemove(overridePort: Int?, outFile: String?) -> Int32 {
        let manifest = try? PluginManifest.load(baseDir: baseDir)
        stopRunningWatcherInDir()
        var cleaned: [String] = []
        if let port = CdpHelper.readPort(overridePort: overridePort),
           let removeExpr = manifest?.removeExpression,
           !removeExpr.isEmpty,
           let pages = try? CdpHelper.listPages(port: port) {
            for page in pages {
                if let session = try? CdpSession.connect(wsUrl: page.webSocketDebuggerUrl, timeoutMs: 3000) {
                    defer { session.close() }
                    if (try? session.evaluate(removeExpr, awaitPromise: false)) != nil {
                        cleaned.append(CdpHelper.shortTitle(page))
                    }
                }
            }
        }
        Self.writeResult(outFile: outFile, ok: true, message: "removed from \(cleaned.count) page(s)", pages: cleaned)
        return 0
    }

    private func stopRunningWatcherInDir() {
        let selfPid = getpid()
        if let pid = readPidFile(), pid != selfPid {
            if kill(pid, 0) == 0 {
                _ = kill(pid, SIGTERM)
                let deadline = Date().addingTimeInterval(2.0)
                while Date() < deadline {
                    if kill(pid, 0) != 0 { break }
                    Thread.sleep(forTimeInterval: 0.05)
                }
                if kill(pid, 0) == 0 {
                    _ = kill(pid, SIGKILL)
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
        }
        try? FileManager.default.removeItem(atPath: pidFile)
    }

    private func computeDirStamp() -> [String: String] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: baseDir) else { return [:] }
        var stamp: [String: String] = [:]
        for name in names {
            if name.hasPrefix(".") { continue }
            let lower = name.lowercased()
            if !lower.hasSuffix(".css") && !lower.hasSuffix(".js") && !lower.hasSuffix(".json") {
                continue
            }
            let full = (baseDir as NSString).appendingPathComponent(name)
            if let attrs = try? fm.attributesOfItem(atPath: full) {
                let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
                let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
                stamp[name] = "\(mtime):\(size)"
            }
        }
        return stamp
    }

    private func firstChangedFile(oldStamp: [String: String], newStamp: [String: String]) -> String? {
        for (k, v) in newStamp {
            if oldStamp[k] != v { return k }
        }
        for k in oldStamp.keys where newStamp[k] == nil {
            return k
        }
        return nil
    }

    private static func isProcessAlive(_ pid: Int32) -> Bool {
        if pid <= 0 { return false }
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    func runWatch(overridePort: Int?, keepAlive: Bool = false, parentPid: Int32? = nil, maxIdleFailures: Int = 3) -> Int32 {
        try? FileManager.default.createDirectory(atPath: baseDir, withIntermediateDirectories: true, attributes: nil)
        let lockFd = open(lockFile, O_CREAT | O_RDWR, 0o644)
        if lockFd < 0 {
            return 1
        }
        if flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
            close(lockFd)
            return 0
        }

        signal(SIGPIPE, SIG_IGN)
        let selfPid = getpid()
        try? String(selfPid).write(toFile: pidFile, atomically: true, encoding: .utf8)
        try? "".write(toFile: logFile, atomically: false, encoding: .utf8)

        var manifest: PluginManifest
        var currentExpr: String
        do {
            manifest = try PluginManifest.load(baseDir: baseDir)
            currentExpr = try CdpHelper.buildInjectExpression(baseDir: baseDir, manifest: manifest)
        } catch {
            log("[!] 初始化加载失败: \(error.localizedDescription)")
            releasePidFile(selfPid: selfPid)
            flock(lockFd, LOCK_UN)
            close(lockFd)
            return 1
        }

        log("[*] AGY Claude Style (agy-claude-style) 守护模式启动 (PID \(selfPid)\(keepAlive ? ", keep-alive" : ""))，每 2 秒检查一次窗口")

        let stateLock = NSLock()
        var attached: [String: AttachedEntry] = [:]
        var attaching: Set<String> = []
        var hadAttachedWindow = false
        var consecutiveIdleFailures = 0
        var lastDirStamp = computeDirStamp()

        let exitSem = DispatchSemaphore(value: 0)
        var shouldExit = false
        let exitLock = NSLock()
        let requestExit = {
            exitLock.lock()
            let already = shouldExit
            shouldExit = true
            exitLock.unlock()
            if !already {
                exitSem.signal()
            }
        }
        let isExiting: () -> Bool = {
            exitLock.lock()
            let v = shouldExit
            exitLock.unlock()
            return v
        }

        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let sigQueue = DispatchQueue(label: "io.github.0dnancy.agy-claude-style.signals")
        let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
        termSource.setEventHandler(handler: requestExit)
        termSource.resume()
        let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: sigQueue)
        intSource.setEventHandler(handler: requestExit)
        intSource.resume()

        let applyToEntry: (AttachedEntry, String) throws -> JsonValue = { entry, exprToUse in
            if let oldId = entry.scriptId, !oldId.isEmpty {
                _ = try? entry.session.send(
                    "Page.removeScriptToEvaluateOnNewDocument",
                    params: ["identifier": .string(oldId)],
                    timeoutMs: 5000
                )
            }
            let addRes = try entry.session.send(
                "Page.addScriptToEvaluateOnNewDocument",
                params: ["source": .string(exprToUse)],
                timeoutMs: 15000
            )
            if let newId = addRes["identifier"]?.stringValue {
                entry.scriptId = newId
            }
            return try entry.session.evaluate(exprToUse, awaitPromise: false)
        }

        let attachPage: (CdpPageInfo) -> Void = { page in
            stateLock.lock()
            if attached[page.id] != nil || attaching.contains(page.id) {
                stateLock.unlock()
                return
            }
            attaching.insert(page.id)
            stateLock.unlock()

            var session: CdpSession?
            do {
                let s = try CdpSession.connect(wsUrl: page.webSocketDebuggerUrl, timeoutMs: 4000)
                session = s
                let title = CdpHelper.shortTitle(page)
                let entry = AttachedEntry(session: s, scriptId: nil, title: title)

                s.onClose = {
                    stateLock.lock()
                    let removed = attached.removeValue(forKey: page.id)
                    stateLock.unlock()
                    if let removed = removed {
                        self.log("[-] 窗口已关闭: \(removed.title)")
                    }
                }

                _ = try s.send("Page.enable", params: nil, timeoutMs: 5000)
                s.on("Runtime.bindingCalled") { params in
                    guard let name = params["name"]?.stringValue,
                          let payloadStr = params["payload"]?.stringValue else { return }
                    stateLock.lock()
                    let manifestSnap = manifest
                    stateLock.unlock()
                    guard name == manifestSnap.settingBinding else { return }
                    if let kv = try? MiniJson.parseObject(payloadStr),
                       let key = kv["key"]?.stringValue,
                       let value = kv["value"] {
                        if CdpHelper.updateConfigSetting(baseDir: self.baseDir, manifest: manifestSnap, key: key, value: value) {
                            self.log("[⚙] 设置已保存: \(key) = \(MiniJson.stringify(value, pretty: false))")
                        }
                    }
                }

                _ = try s.send("Runtime.enable", params: nil, timeoutMs: 5000)
                stateLock.lock()
                let bindingName = manifest.settingBinding
                let exprSnap = currentExpr
                stateLock.unlock()

                _ = try s.send("Runtime.addBinding", params: ["name": .string(bindingName)], timeoutMs: 5000)

                stateLock.lock()
                attached[page.id] = entry
                attaching.remove(page.id)
                hadAttachedWindow = true
                stateLock.unlock()

                let evalVal = try applyToEntry(entry, exprSnap)
                let status = evalVal.objectValue?["status"]?.stringValue ?? "ok"
                self.log("[✓] 已注入 agy-claude-style: \(title) (\(status))")
            } catch {
                stateLock.lock()
                attaching.remove(page.id)
                let removed = attached.removeValue(forKey: page.id)
                stateLock.unlock()
                removed?.session.close()
                session?.close()
                self.log("[!] 注入失败，稍后重试: \(CdpHelper.shortTitle(page)) — \(error.localizedDescription)")
            }
        }

        let reloadQueue = DispatchQueue(label: "io.github.0dnancy.agy-claude-style.reload")
        var pendingReloadWork: DispatchWorkItem?
        var pendingChangedHint: String?

        let performReload: (String?) -> Void = { hintName in
            pendingReloadWork?.cancel()
            pendingReloadWork = nil
            pendingChangedHint = nil

            let currentStamp = self.computeDirStamp()
            stateLock.lock()
            let detectedChange = self.firstChangedFile(oldStamp: lastDirStamp, newStamp: currentStamp)
            if detectedChange == nil {
                stateLock.unlock()
                return
            }
            lastDirStamp = currentStamp
            stateLock.unlock()

            let changedName = detectedChange ?? hintName ?? "config.json"
            do {
                let nextManifest = try PluginManifest.load(baseDir: self.baseDir)
                let nextExpr = try CdpHelper.buildInjectExpression(baseDir: self.baseDir, manifest: nextManifest)
                stateLock.lock()
                manifest = nextManifest
                currentExpr = nextExpr
                let entries = Array(attached.values)
                stateLock.unlock()

                var n = 0
                for entry in entries {
                    if (try? applyToEntry(entry, nextExpr)) != nil {
                        n += 1
                    }
                }
                self.log("[↻] \(changedName) 已变更，已热更新 \(n) 个窗口")
            } catch {
                self.log("[!] 读取文件失败: \(error.localizedDescription)")
            }
        }

        let scheduleReload: (String?) -> Void = { hintName in
            reloadQueue.async {
                if let hint = hintName { pendingChangedHint = hint }
                pendingReloadWork?.cancel()
                let work = DispatchWorkItem {
                    let hint = pendingChangedHint
                    pendingChangedHint = nil
                    performReload(hint)
                }
                pendingReloadWork = work
                reloadQueue.asyncAfter(deadline: .now() + .milliseconds(180), execute: work)
            }
        }

        var dirSource: DispatchSourceFileSystemObject?
        let dirFd = open(baseDir, O_EVTONLY)
        if dirFd >= 0 {
            let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: dirFd, eventMask: [.write, .rename, .extend, .delete], queue: reloadQueue)
            src.setEventHandler {
                let currentStamp = self.computeDirStamp()
                stateLock.lock()
                let changed = self.firstChangedFile(oldStamp: lastDirStamp, newStamp: currentStamp)
                stateLock.unlock()
                if let changed = changed {
                    scheduleReload(changed)
                }
            }
            src.setCancelHandler {
                close(dirFd)
            }
            src.resume()
            dirSource = src
        }

        var lastPort: Int?
        while !isExiting() {
            if let ppid = parentPid, !Self.isProcessAlive(ppid) {
                log("[*] 宿主父进程已退出，守护进程自动停止")
                break
            }

            // Poll fallback for in-place edits that don't fire directory vnode write events
            reloadQueue.sync {
                performReload(nil)
            }

            var waitSeconds = 2
            let port = CdpHelper.readPort(overridePort: overridePort)
            let pages = port.flatMap { try? CdpHelper.listPages(port: $0) }

            if let port = port, let pages = pages {
                if lastPort != port {
                    stateLock.lock()
                    let oldEntries = Array(attached.values)
                    attached.removeAll()
                    stateLock.unlock()
                    for oldEntry in oldEntries {
                        oldEntry.session.close()
                    }
                    log("[+] 连接到调试端口 \(port)")
                    lastPort = port
                }

                let group = DispatchGroup()
                for page in pages {
                    stateLock.lock()
                    let needsAttach = (attached[page.id] == nil && !attaching.contains(page.id))
                    stateLock.unlock()
                    if needsAttach {
                        group.enter()
                        DispatchQueue.global(qos: .utility).async {
                            attachPage(page)
                            group.leave()
                        }
                    }
                }
                _ = group.wait(timeout: .now() + .seconds(10))
            } else {
                stateLock.lock()
                let oldEntries = Array(attached.values)
                attached.removeAll()
                stateLock.unlock()
                for oldEntry in oldEntries {
                    oldEntry.session.close()
                }
            }

            stateLock.lock()
            let attachedEmpty = attached.isEmpty
            if !attachedEmpty {
                hadAttachedWindow = true
            }
            let hadAttached = hadAttachedWindow
            stateLock.unlock()

            let hostReachable = (pages != nil && (!pages!.isEmpty || !attachedEmpty))
            if hostReachable {
                consecutiveIdleFailures = 0
            } else if hadAttached && attachedEmpty {
                consecutiveIdleFailures += 1
                if !keepAlive && consecutiveIdleFailures >= maxIdleFailures {
                    log("[✓] 检测到 Antigravity 已关闭，守护进程自动退出")
                    break
                }
                if keepAlive && consecutiveIdleFailures >= maxIdleFailures {
                    lastPort = nil
                    waitSeconds = 10
                }
            }

            _ = exitSem.wait(timeout: .now() + .seconds(waitSeconds))
        }

        dirSource?.cancel()
        termSource.cancel()
        intSource.cancel()

        stateLock.lock()
        let finalEntries = Array(attached.values)
        attached.removeAll()
        stateLock.unlock()
        for entry in finalEntries {
            entry.session.close()
        }

        releasePidFile(selfPid: selfPid)
        flock(lockFd, LOCK_UN)
        close(lockFd)
        return 0
    }
}

func runWatcherMain() -> Int32 {
    var mode = "watch"
    var customDir: String?
    var overridePort: Int?
    var outFile: String?
    var keepAlive = false
    var parentPid: Int32?
    var maxIdleFailures = 3

    if let envIdle = ProcessInfo.processInfo.environment["AG_WATCH_MAX_IDLE_FAILURES"],
       let parsed = Int(envIdle.trimmingCharacters(in: .whitespacesAndNewlines)),
       parsed > 0 {
        maxIdleFailures = parsed
    }

    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        let a = args[i]
        if a == "--watch" { mode = "watch" }
        else if a == "--once" { mode = "once" }
        else if a == "--remove" { mode = "remove" }
        else if a == "--keep-alive" { keepAlive = true }
        else if a == "--dir" && i + 1 < args.count { i += 1; customDir = args[i] }
        else if a == "--cdp-port" && i + 1 < args.count {
            i += 1
            if let p = Int(args[i]), p > 0 { overridePort = p }
        }
        else if a == "--parent-pid" && i + 1 < args.count {
            i += 1
            if let pp = Int32(args[i]), pp > 0 { parentPid = pp }
        }
        else if a == "--max-idle-failures" && i + 1 < args.count {
            i += 1
            if let m = Int(args[i]), m > 0 { maxIdleFailures = m }
        }
        else if a == "--out" && i + 1 < args.count { i += 1; outFile = args[i] }
        i += 1
    }

    let rawBase = (customDir?.isEmpty == false)
        ? customDir!
        : ((args[0] as NSString).deletingLastPathComponent)
    let baseDir = URL(fileURLWithPath: rawBase.isEmpty ? "." : rawBase).standardizedFileURL.path
    let app = WatcherApp(baseDir: baseDir, isWatch: mode == "watch")

    if mode == "once" {
        return app.runOnce(overridePort: overridePort, outFile: outFile)
    }
    if mode == "remove" {
        return app.runRemove(overridePort: overridePort, outFile: outFile)
    }
    return app.runWatch(overridePort: overridePort, keepAlive: keepAlive, parentPid: parentPid, maxIdleFailures: maxIdleFailures)
}

exit(runWatcherMain())
