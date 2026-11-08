import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var app: AppState
    @State private var ipDraft = ""

    var body: some View {
        NavigationStack {
            List {
                Section("TV") {
                    HStack {
                        TextField("TV IP address", text: $ipDraft)
                            .keyboardType(.decimalPad)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Use") { useDraft() }.disabled(ipDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    Button {
                        Task { await app.scan() }
                    } label: {
                        HStack {
                            Label(app.scanning ? "Scanning… \(app.scanProgress)/254" : "Scan the Wi-Fi for Samsung TVs", systemImage: "antenna.radiowaves.left.and.right")
                            if app.scanning { Spacer(); ProgressView() }
                        }
                    }.disabled(app.scanning)
                    ForEach(app.found) { tv in
                        Button { app.select(tv) } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(tv.name).font(.body.weight(.semibold))
                                    Text("\(tv.ip) · \(tv.model)").font(.footnote).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if tv.ip == app.tvIP { Image(systemName: "checkmark").foregroundStyle(Theme.good) }
                            }
                        }
                    }
                }
                if app.hasTV {
                    Section("Connection") {
                        LabeledContent("Status", value: app.status.label)
                        LabeledContent("Name", value: app.tvName.isEmpty ? "—" : app.tvName)
                        if let info = app.info { LabeledContent("Model", value: info.model) }
                        LabeledContent("MAC", value: app.tvMAC.isEmpty ? "—" : app.tvMAC)
                        LabeledContent("Pairing token", value: app.token.isEmpty ? "none" : "saved")
                        Button("Connect / pair again") { app.connect() }
                        Button("Wake the TV") { app.wake() }
                        Button("Forget pairing", role: .destructive) { app.forgetPairing() }
                    }
                }
                Section("Phone") {
                    Toggle("Haptic clicks", isOn: $app.hapticsOn)
                    LabeledContent("This phone", value: Discovery.localIPv4() ?? "no Wi-Fi")
                }
                Section("About") {
                    Text("Dash Remote talks to the TV's own remote-control API, so it works before any Dash app is installed. The Dash tab shows pages served by the TV itself, so they update without reinstalling this app.")
                        .font(.footnote).foregroundStyle(.secondary)
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { ipDraft = app.tvIP }
        }
    }

    private func useDraft() {
        let ip = ipDraft.trimmingCharacters(in: .whitespaces)
        guard !ip.isEmpty else { return }
        if ip != app.tvIP { app.token = "" }
        app.tvIP = ip
        app.connect()
    }
}
