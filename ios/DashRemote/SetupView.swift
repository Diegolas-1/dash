import SwiftUI

/// Walks through the TV takeover. Steps that need the TV remote or the laptop say so.
struct SetupView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        NavigationStack {
            List {
                Section {
                    StatusBar().listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
                Section("1 · Find and pair") {
                    row(done: app.hasTV, title: "TV found", detail: app.hasTV ? "\(app.tvName) · \(app.tvIP)" : "Settings → Scan, or type the TV's IP")
                    row(done: app.status.isConnected, title: "Paired", detail: app.status.isConnected ? "This phone is allowed on the TV" : "Press Connect, then Allow on the TV when it asks")
                    if let info = app.info {
                        row(done: info.os.lowercased().contains("tizen"), title: "Tizen TV", detail: "\(info.model) · \(info.os)")
                    }
                }
                Section("2 · Privacy (TV remote)") {
                    Text("Settings → General → Terms & Privacy (older models: Support → Terms & Policies). Turn off: Viewing Information Services, Interest-Based Advertisement, Voice recognition services. Settings → General → Smart Features: Autoplay Sound/Video off. Home: remove promo rows.")
                        .font(.footnote)
                    Text("DNS: Settings → General → Network → Network Status → IP Settings → DNS → Manual. Enter your filter's address, then open every app once to confirm they still load.")
                        .font(.footnote)
                    Text("Resetting the PSID (advertising ID) cannot be undone.").font(.footnote).foregroundStyle(Theme.bad)
                }
                Section("3 · Developer mode (TV remote)") {
                    row(done: app.info?.developerMode == true, title: "Developer mode on",
                        detail: "Apps → Settings → type 1 2 3 4 5 → On → enter the laptop's IP → restart TV")
                }
                Section("4 · Install the apps (laptop)") {
                    Text("The Tizen apps are installed from the Chromebook or laptop with `python tv/deploy.py --app …`. Order: Dash Server, Torrents, then the Home screen.")
                        .font(.footnote)
                    ForEach(app.services) { s in
                        row(done: s.up, title: s.name, detail: s.up ? "Running on port \(s.port)" : "Not reachable on port \(s.port)")
                    }
                    Button { Task { await app.refreshInfo() } } label: { Label("Check again", systemImage: "arrow.clockwise") }
                }
                Section("5 · Finish (TV remote)") {
                    Text("Turn Developer mode back off, restart the TV, and confirm the home screen comes back. Open Dash Server → Settings on the TV pages to set the Govee key and the ambient theme.")
                        .font(.footnote)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Setup")
            .navigationBarTitleDisplayMode(.inline)
            .task { await app.refreshInfo() }
        }
    }

    private func row(done: Bool, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle").foregroundStyle(done ? Theme.good : .secondary).font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}
