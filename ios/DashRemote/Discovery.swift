import Foundation
import Network

/// What the TV reports at http://<ip>:8001/api/v2/
struct TVInfo: Identifiable, Equatable {
    var id: String { ip }
    let ip: String
    let name: String
    let model: String
    let mac: String
    let os: String
    let developerMode: Bool
}

struct ServiceStatus: Identifiable, Equatable {
    var id: Int { port }
    let name: String
    let port: Int
    let up: Bool
}

enum Discovery {
    /// IPv4 address of the Wi-Fi interface (en0), or any non-loopback interface.
    static func localIPv4() -> String? {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return nil }
        defer { freeifaddrs(list) }
        var fallback: String?
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard let sa = ptr.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: host)
                let name = String(cString: ptr.pointee.ifa_name)
                if name == "en0" { return ip }
                if fallback == nil { fallback = ip }
            }
        }
        return fallback
    }

    static func deviceInfo(ip: String, timeout: TimeInterval = 1.5) async -> TVInfo? {
        guard let url = URL(string: "http://\(ip):8001/api/v2/") else { return nil }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: cfg)
        guard let result = try? await session.data(from: url),
              let root = try? JSONSerialization.jsonObject(with: result.0) as? [String: Any],
              let device = root["device"] as? [String: Any] else { return nil }
        return TVInfo(ip: ip,
                      name: (device["name"] as? String) ?? "Samsung TV",
                      model: (device["modelName"] as? String) ?? "",
                      mac: (device["wifiMac"] as? String) ?? "",
                      os: (device["OS"] as? String) ?? "",
                      developerMode: (device["developerMode"] as? String) == "1")
    }

    /// Probes every host on the phone's /24 for the Samsung REST port.
    static func scan(progress: @escaping (Int) -> Void) async -> [TVInfo] {
        guard let mine = localIPv4() else { return [] }
        let parts = mine.split(separator: ".")
        guard parts.count == 4 else { return [] }
        let prefix = parts[0...2].joined(separator: ".")
        var found: [TVInfo] = []
        var done = 0
        await withTaskGroup(of: TVInfo?.self) { group in
            var next = 1
            while next <= 32 {
                let ip = "\(prefix).\(next)"
                next += 1
                group.addTask { await deviceInfo(ip: ip, timeout: 1.2) }
            }
            for await result in group {
                done += 1
                progress(done)
                if let tv = result { found.append(tv) }
                if next <= 254 {
                    let ip = "\(prefix).\(next)"
                    next += 1
                    group.addTask { await deviceInfo(ip: ip, timeout: 1.2) }
                }
            }
        }
        return found.sorted { $0.ip < $1.ip }
    }

    static func probeServices(ip: String) async -> [ServiceStatus] {
        let targets = [("Photos", 8090), ("Torrents", 8091), ("Dash Server", 8092)]
        var out: [ServiceStatus] = []
        for (name, port) in targets {
            var up = false
            if let url = URL(string: "http://\(ip):\(port)/api/session") {
                let cfg = URLSessionConfiguration.ephemeral
                cfg.timeoutIntervalForRequest = 2
                cfg.timeoutIntervalForResource = 2
                if let result = try? await URLSession(configuration: cfg).data(from: url),
                   let http = result.1 as? HTTPURLResponse { up = http.statusCode < 500 }
            }
            out.append(ServiceStatus(name: name, port: port, up: up))
        }
        return out
    }

    /// Wake-on-LAN magic packet. Sent to the TV's last address and to the subnet broadcast (best effort).
    static func wake(mac: String, ip: String) {
        let bytes = mac.split(whereSeparator: { $0 == ":" || $0 == "-" }).compactMap { UInt8($0, radix: 16) }
        guard bytes.count == 6 else { return }
        var packet = Data(repeating: 0xFF, count: 6)
        for _ in 0..<16 { packet.append(contentsOf: bytes) }
        var targets = [ip]
        let parts = ip.split(separator: ".")
        if parts.count == 4 { targets.append(parts[0...2].joined(separator: ".") + ".255") }
        for host in targets {
            let connection = NWConnection(host: NWEndpoint.Host(host), port: 9, using: .udp)
            connection.stateUpdateHandler = { state in
                if case .ready = state {
                    connection.send(content: packet, completion: .contentProcessed { _ in connection.cancel() })
                } else if case .failed = state {
                    connection.cancel()
                }
            }
            connection.start(queue: .global())
        }
    }
}
