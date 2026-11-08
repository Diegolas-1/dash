import SwiftUI

/// The BN59-01315A layout, button for button, plus the Dash apps.
struct RemoteView: View {
    @EnvironmentObject var app: AppState
    @State private var showNumbers = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                StatusBar()
                ScrollView {
                    VStack(spacing: 18) {
                        topRow
                        if showNumbers { numberPad }
                        rockers
                        appRow
                        dpad
                        navRow
                        colorRow
                        mediaRow
                    }
                    .padding(16)
                }
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Remote")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { withAnimation { showNumbers.toggle() } } label: { Image(systemName: showNumbers ? "number.square.fill" : "number.square") }
                }
            }
        }
    }

    private var topRow: some View {
        HStack {
            Key("power", key: "KEY_POWER", tint: Theme.bad, wide: true)
            Spacer()
            Key(text: "SOURCE", key: "KEY_SOURCE", wide: true)
        }
    }

    private var numberPad: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
            ForEach(1...9, id: \.self) { n in Key(text: "\(n)", key: "KEY_\(n)") }
            Key(text: "–", key: "KEY_MINUS")
            Key(text: "0", key: "KEY_0")
            Key(text: "PRE-CH", key: "KEY_PRECH", small: true)
        }
    }

    private var rockers: some View {
        HStack(alignment: .top, spacing: 14) {
            Rocker(title: "VOL", up: "KEY_VOLUP", down: "KEY_VOLDOWN")
            VStack(spacing: 10) {
                Key("speaker.slash", key: "KEY_MUTE")
                Key(text: "CH LIST", key: "KEY_CH_LIST", small: true)
            }
            Rocker(title: "CH", up: "KEY_CHUP", down: "KEY_CHDOWN")
        }
    }

    private var appRow: some View {
        HStack(spacing: 10) {
            AppKey(title: "Home", appId: "DashHome01.home", symbol: "house")
            AppKey(title: "Server", appId: "DashSrv01.server", symbol: "server.rack")
            AppKey(title: "Torrents", appId: "DashTorr01.torrent", symbol: "arrow.down.circle")
            Key(text: "GUIDE", key: "KEY_GUIDE", small: true)
        }
    }

    private var dpad: some View {
        ZStack {
            Circle().fill(Theme.card).frame(width: 240, height: 240).overlay(Circle().stroke(Theme.line, lineWidth: 1))
            VStack {
                Arrow("chevron.up", key: "KEY_UP")
                Spacer()
                Arrow("chevron.down", key: "KEY_DOWN")
            }.frame(height: 232)
            HStack {
                Arrow("chevron.left", key: "KEY_LEFT")
                Spacer()
                Arrow("chevron.right", key: "KEY_RIGHT")
            }.frame(width: 232)
            Button { app.sendKey("KEY_ENTER") } label: {
                Text("OK").font(.title3.weight(.bold)).frame(width: 84, height: 84)
                    .background(Circle().fill(Theme.accent)).foregroundStyle(.black)
            }
        }
    }

    private var navRow: some View {
        HStack(spacing: 10) {
            Key(text: "RETURN", key: "KEY_RETURN", wide: true)
            Key("house", key: "KEY_HOME", wide: true)
            Key(text: "EXIT", key: "KEY_EXIT", wide: true)
        }
    }

    private var colorRow: some View {
        HStack(spacing: 10) {
            Key(text: "A", key: "KEY_RED", tint: Color(red: 0.86, green: 0.25, blue: 0.22))
            Key(text: "B", key: "KEY_GREEN", tint: Color(red: 0.2, green: 0.6, blue: 0.4))
            Key(text: "C", key: "KEY_YELLOW", tint: Color(red: 0.9, green: 0.68, blue: 0.2))
            Key(text: "D", key: "KEY_BLUE", tint: Color(red: 0.25, green: 0.45, blue: 0.85))
            Key(text: "INFO", key: "KEY_INFO", small: true)
            Key(text: "CC", key: "KEY_CAPTION", small: true)
        }
    }

    private var mediaRow: some View {
        HStack(spacing: 10) {
            Key("backward.end", key: "KEY_REWIND")
            Key("play", key: "KEY_PLAY")
            Key("pause", key: "KEY_PAUSE")
            Key("stop", key: "KEY_STOP")
            Key("forward.end", key: "KEY_FF")
        }
    }
}

/// One remote button. Either an SF Symbol or a text label.
struct Key: View {
    @EnvironmentObject var app: AppState
    let symbol: String?
    let text: String?
    let key: String
    var tint: Color = Theme.card
    var wide = false
    var small = false

    init(_ symbol: String, key: String, tint: Color = Theme.card, wide: Bool = false) {
        self.symbol = symbol; self.text = nil; self.key = key; self.tint = tint; self.wide = wide
    }
    init(text: String, key: String, tint: Color = Theme.card, wide: Bool = false, small: Bool = false) {
        self.symbol = nil; self.text = text; self.key = key; self.tint = tint; self.wide = wide; self.small = small
    }

    var body: some View {
        Button { app.sendKey(key) } label: {
            Group {
                if let symbol { Image(systemName: symbol).font(.title3.weight(.semibold)) }
                else { Text(text ?? "").font(small ? .caption.weight(.bold) : .headline) }
            }
            .frame(maxWidth: .infinity, minHeight: wide ? 48 : 52)
            .background(RoundedRectangle(cornerRadius: 14).fill(tint))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 1))
            .foregroundStyle(Color.white)
        }
        .buttonStyle(.plain)
    }
}

struct Arrow: View {
    @EnvironmentObject var app: AppState
    let symbol: String
    let key: String
    init(_ symbol: String, key: String) { self.symbol = symbol; self.key = key }
    var body: some View {
        Button { app.sendKey(key) } label: {
            Image(systemName: symbol).font(.title2.weight(.bold)).frame(width: 64, height: 64).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(.white)
    }
}

struct Rocker: View {
    @EnvironmentObject var app: AppState
    let title: String
    let up: String
    let down: String
    var body: some View {
        VStack(spacing: 0) {
            Button { app.sendKey(up) } label: { Image(systemName: "plus").frame(maxWidth: .infinity, minHeight: 48) }
            Text(title).font(.caption2.weight(.bold)).foregroundStyle(.secondary).padding(.vertical, 4)
            Button { app.sendKey(down) } label: { Image(systemName: "minus").frame(maxWidth: .infinity, minHeight: 48) }
        }
        .buttonStyle(.plain).foregroundStyle(.white)
        .background(RoundedRectangle(cornerRadius: 16).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line, lineWidth: 1))
        .frame(maxWidth: .infinity)
    }
}

struct AppKey: View {
    @EnvironmentObject var app: AppState
    let title: String
    let appId: String
    let symbol: String
    var body: some View {
        Button { app.launchApp(appId) } label: {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.body.weight(.semibold))
                Text(title).font(.caption2.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.accent.opacity(0.5), lineWidth: 1))
            .foregroundStyle(Theme.accent)
        }.buttonStyle(.plain)
    }
}
