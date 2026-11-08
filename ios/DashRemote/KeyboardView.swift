import SwiftUI

/// Types into the TV's focused text field (search boxes, passwords, Wi-Fi keys…).
struct KeyboardView: View {
    @EnvironmentObject var app: AppState
    @State private var text = ""
    @State private var history: [String] = []
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                StatusBar()
                VStack(alignment: .leading, spacing: 14) {
                    Text("Select a text field on the TV first, then type here. Return sends the text.")
                        .font(.footnote).foregroundStyle(.secondary)
                    HStack {
                        TextField("Type for the TV", text: $text)
                            .textFieldStyle(.roundedBorder)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focused)
                            .submitLabel(.send)
                            .onSubmit(send)
                        Button(action: send) { Image(systemName: "paperplane.fill").font(.title3) }
                            .buttonStyle(.borderedProminent).disabled(text.isEmpty)
                    }
                    HStack(spacing: 10) {
                        Key(text: "ENTER", key: "KEY_ENTER", wide: true)
                        Key("delete.left", key: "KEY_RETURN", wide: true)
                        Key(text: "SPACE", key: "KEY_SPACE", wide: true)
                    }
                    if !history.isEmpty {
                        Text("Recent").font(.caption.weight(.bold)).foregroundStyle(.secondary).padding(.top, 8)
                        ScrollView {
                            VStack(spacing: 6) {
                                ForEach(history, id: \.self) { item in
                                    Button { text = item; send() } label: {
                                        HStack { Text(item).lineLimit(1); Spacer(); Image(systemName: "arrow.up.left") }
                                            .padding(10).frame(maxWidth: .infinity)
                                            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                    }
                    Spacer()
                }
                .padding(16)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Keyboard")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { focused = true }
        }
    }

    private func send() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        app.sendText(value)
        history.removeAll { $0 == value }
        history.insert(value, at: 0)
        if history.count > 8 { history.removeLast() }
        text = ""
    }
}
