import Foundation

/// Connection state of the Samsung remote-control WebSocket.
enum ConnectionStatus: Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)

    var label: String {
        switch self {
        case .disconnected: return "Not connected"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .failed(let why): return why
        }
    }
    var isConnected: Bool { if case .connected = self { return true }; return false }
}

/// Talks to the TV's own remote API: wss://<ip>:8002/api/v2/channels/samsung.remote.control
/// The TV presents a self-signed certificate, so the session delegate accepts the server trust for it.
final class SamsungRemote: NSObject, URLSessionWebSocketDelegate {
    var onStatus: ((ConnectionStatus) -> Void)?
    var onToken: ((String) -> Void)?

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private(set) var isOpen = false
    private var pingTimer: Timer?

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 12
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    func connect(ip: String, token: String?, name: String = "DashRemote") {
        disconnect()
        let encodedName = Data(name.utf8).base64EncodedString()
        var urlString = "wss://\(ip):8002/api/v2/channels/samsung.remote.control?name=\(encodedName)"
        if let token, !token.isEmpty { urlString += "&token=\(token)" }
        guard let url = URL(string: urlString) else {
            onStatus?(.failed("Bad TV address"))
            return
        }
        onStatus?(.connecting)
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
        DispatchQueue.main.async { [weak self] in
            self?.pingTimer?.invalidate()
            self?.pingTimer = Timer.scheduledTimer(withTimeInterval: 25, repeats: true) { [weak self] _ in
                self?.task?.sendPing { _ in }
            }
        }
    }

    func disconnect() {
        pingTimer?.invalidate()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isOpen = false
    }

    // MARK: - Commands

    private func send(_ object: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { [weak self] error in
            if let error { self?.onStatus?(.failed(error.localizedDescription)) }
        }
    }

    /// `KEY_HOME`, `KEY_VOLUP`, … `cmd` is Click, Press or Release.
    func sendKey(_ key: String, cmd: String = "Click") {
        send(["method": "ms.remote.control",
              "params": ["Cmd": cmd, "DataOfCmd": key, "Option": "false", "TypeOfRemote": "SendRemoteKey"]])
    }

    /// Types into whatever text field the TV currently shows.
    func sendText(_ text: String) {
        let encoded = Data(text.utf8).base64EncodedString()
        send(["method": "ms.remote.control",
              "params": ["Cmd": encoded, "DataOfCmd": "base64", "TypeOfRemote": "SendInputString"]])
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.send(["method": "ms.remote.control", "params": ["TypeOfRemote": "SendInputEnd"]])
        }
    }

    func launchApp(_ appId: String, meta: String? = nil, native: Bool = false) {
        var payload: [String: Any] = ["appId": appId, "action_type": native ? "NATIVE_LAUNCH" : "DEEP_LINK"]
        if let meta { payload["metaTag"] = meta }
        send(["method": "ms.channel.emit", "params": ["event": "ed.apps.launch", "to": "host", "data": payload]])
    }

    // MARK: - Receive loop

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.isOpen = false
                self.onStatus?(.failed(error.localizedDescription))
            case .success(let message):
                if case .string(let text) = message { self.handle(text) }
                self.receive()
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let event = object["event"] as? String ?? ""
        switch event {
        case "ms.channel.connect":
            isOpen = true
            if let payload = object["data"] as? [String: Any], let token = payload["token"] as? String, !token.isEmpty {
                onToken?(token)
            }
            onStatus?(.connected)
        case "ms.channel.unauthorized":
            isOpen = false
            onStatus?(.failed("The TV denied access. Allow “DashRemote” on the TV, then try again."))
        case "ms.channel.timeOut":
            isOpen = false
            onStatus?(.failed("The TV did not answer the pairing prompt in time."))
        default:
            break
        }
    }

    // MARK: - URLSessionDelegate

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // The TV uses a self-signed certificate on the LAN; trust it for this connection.
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        isOpen = false
        onStatus?(.disconnected)
    }
}
