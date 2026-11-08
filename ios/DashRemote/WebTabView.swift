import SwiftUI
import WebKit

/// Hosts the pages the TV serves (library, torrents, lights, dashboard). Updating those updates this tab.
struct WebTabView: View {
    @EnvironmentObject var app: AppState
    @State private var page = 8092
    @State private var reloadToken = 0

    private struct Page: Identifiable { let title: String; let port: Int; var id: Int { port } }
    private let pages = [Page(title: "Dash Server", port: 8092), Page(title: "Torrents", port: 8091), Page(title: "Photos", port: 8090)]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Page", selection: $page) {
                    ForEach(pages) { p in Text(p.title).tag(p.port) }
                }
                .pickerStyle(.segmented).padding(12)
                if let url = app.pageURL(port: page) {
                    WebView(url: url, reloadToken: reloadToken)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "tv").font(.largeTitle).foregroundStyle(.secondary)
                        Text("Choose your TV in Settings").foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Dash")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) { Button { reloadToken += 1 } label: { Image(systemName: "arrow.clockwise") } }
            }
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = UIColor(Theme.bg)
        view.scrollView.backgroundColor = UIColor(Theme.bg)
        view.load(URLRequest(url: url))
        context.coordinator.lastURL = url
        context.coordinator.lastToken = reloadToken
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        if context.coordinator.lastURL != url {
            context.coordinator.lastURL = url
            view.load(URLRequest(url: url))
        } else if context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            view.reload()
        }
    }

    final class Coordinator {
        var lastURL: URL?
        var lastToken = 0
    }
}
