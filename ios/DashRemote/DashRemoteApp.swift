import SwiftUI
import UIKit

@main
struct DashRemoteApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}

enum Theme {
    static let bg = Color(red: 0.043, green: 0.067, blue: 0.078)        // #0B1114
    static let card = Color(red: 0.07, green: 0.1, blue: 0.12)
    static let line = Color.white.opacity(0.1)
    static let accent = Color(red: 0.878, green: 0.643, blue: 0.345)    // #E0A458
    static let good = Color(red: 0.424, green: 0.765, blue: 0.69)       // #6CC3B0
    static let bad = Color(red: 0.878, green: 0.376, blue: 0.376)
}

/// Shared state: TV address, pairing token, connection status, discovered services.
@MainActor
final class AppState: ObservableObject {
    @Published var tvIP: String { didSet { defaults.set(tvIP, forKey: "tvIP") } }
    @Published var tvName: String { didSet { defaults.set(tvName, forKey: "tvName") } }
    @Published var tvMAC: String { didSet { defaults.set(tvMAC, forKey: "tvMAC") } }
    @Published var token: String { didSet { defaults.set(token, forKey: "token") } }
    @Published var hapticsOn: Bool { didSet { defaults.set(hapticsOn, forKey: "haptics") } }
    @Published var status: ConnectionStatus = .disconnected
    @Published var info: TVInfo?
    @Published var services: [ServiceStatus] = []
    @Published var scanning = false
    @Published var scanProgress = 0
    @Published var found: [TVInfo] = []
    @Published var notice: String?

    let remote = SamsungRemote()
    private let defaults = UserDefaults.standard
    private let impact = UIImpactFeedbackGenerator(style: .light)
    private let heavy = UIImpactFeedbackGenerator(style: .medium)

    init() {
        tvIP = defaults.string(forKey: "tvIP") ?? ""
        tvName = defaults.string(forKey: "tvName") ?? ""
        tvMAC = defaults.string(forKey: "tvMAC") ?? ""
        token = defaults.string(forKey: "token") ?? ""
        hapticsOn = defaults.object(forKey: "haptics") as? Bool ?? true
        remote.onStatus = { [weak self] s in Task { @MainActor in self?.status = s } }
        remote.onToken = { [weak self] t in Task { @MainActor in self?.token = t } }
        if CommandLine.arguments.contains("-demo") {
            // Sample state for screenshots in the simulator (no TV on that network).
            demo = true
            tvIP = "192.168.1.40"; tvName = "Living Room TV"; tvMAC = "AA:BB:CC:DD:EE:FF"; token = "demo"
            status = .connected
            info = TVInfo(ip: tvIP, name: tvName, model: "QN65Q70CAFXZA", mac: tvMAC, os: "Tizen", developerMode: true)
            services = [ServiceStatus(name: "Photos", port: 8090, up: true), ServiceStatus(name: "Torrents", port: 8091, up: true), ServiceStatus(name: "Dash Server", port: 8092, up: true)]
            return
        }
        if !tvIP.isEmpty { connect() }
    }

    /// True when launched with -demo (screenshots); network calls are skipped.
    private(set) var demo = false
    var initialTab: String { if let i = CommandLine.arguments.firstIndex(of: "-tab"), i + 1 < CommandLine.arguments.count { return CommandLine.arguments[i + 1] }; return "remote" }

    var hasTV: Bool { !tvIP.isEmpty }

    func connect() {
        if demo { status = .connected; return }
        guard hasTV else { status = .failed("Choose your TV in Settings first."); return }
        remote.connect(ip: tvIP, token: token.isEmpty ? nil : token)
        Task { await refreshInfo() }
    }

    func disconnect() { remote.disconnect(); status = .disconnected }

    func forgetPairing() { token = ""; disconnect() }

    func sendKey(_ key: String) {
        if hapticsOn { impact.impactOccurred() }
        if demo { return }
        if !remote.isOpen { connect() }
        remote.sendKey(key)
    }

    func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        if hapticsOn { heavy.impactOccurred() }
        if !remote.isOpen { connect() }
        remote.sendText(text)
    }

    func launchApp(_ appId: String) {
        if hapticsOn { heavy.impactOccurred() }
        if !remote.isOpen { connect() }
        remote.launchApp(appId)
    }

    func wake() {
        guard !tvMAC.isEmpty else { notice = "No MAC address yet. Connect once while the TV is on."; return }
        Discovery.wake(mac: tvMAC, ip: tvIP)
        notice = "Wake packet sent"
    }

    func refreshInfo() async {
        guard hasTV, !demo else { return }
        if let tv = await Discovery.deviceInfo(ip: tvIP, timeout: 2.5) {
            info = tv
            tvName = tv.name
            if !tv.mac.isEmpty { tvMAC = tv.mac }
        }
        services = await Discovery.probeServices(ip: tvIP)
    }

    func scan() async {
        scanning = true
        scanProgress = 0
        found = await Discovery.scan { [weak self] n in Task { @MainActor in self?.scanProgress = n } }
        scanning = false
        if found.count == 1 { select(found[0]) }
    }

    func select(_ tv: TVInfo) {
        if tv.ip != tvIP { token = "" }
        tvIP = tv.ip
        tvName = tv.name
        tvMAC = tv.mac
        info = tv
        connect()
    }

    /// Base URL of a TV-hosted web page (Dash Server :8092, Torrents :8091, Photos :8090).
    func pageURL(port: Int, path: String = "/") -> URL? { URL(string: "http://\(tvIP):\(port)\(path)") }
}

struct RootView: View {
    @EnvironmentObject var app: AppState
    @State private var tab = "remote"

    var body: some View {
        TabView(selection: $tab) {
            RemoteView().tabItem { Label("Remote", systemImage: "av.remote") }.tag("remote")
            KeyboardView().tabItem { Label("Keyboard", systemImage: "keyboard") }.tag("keyboard")
            WebTabView().tabItem { Label("Dash", systemImage: "rectangle.on.rectangle") }.tag("dash")
            SetupView().tabItem { Label("Setup", systemImage: "checklist") }.tag("setup")
            SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag("settings")
        }
        .onAppear { tab = app.initialTab }
        .background(Theme.bg.ignoresSafeArea())
        .alert(item: Binding(get: { app.notice.map { NoticeItem(text: $0) } }, set: { _ in app.notice = nil })) { item in
            Alert(title: Text(item.text))
        }
    }
}

private struct NoticeItem: Identifiable { let id = UUID(); let text: String }

/// Small status line used at the top of several tabs.
struct StatusBar: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(app.status.isConnected ? Theme.good : (app.status == .connecting ? Theme.accent : Theme.bad)).frame(width: 9, height: 9)
            Text(app.hasTV ? (app.tvName.isEmpty ? app.tvIP : app.tvName) : "No TV selected").font(.subheadline.weight(.semibold))
            Text(app.status.label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            if !app.status.isConnected && app.hasTV {
                Button("Connect") { app.connect() }.font(.caption.weight(.semibold)).buttonStyle(.bordered)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Theme.card)
    }
}
