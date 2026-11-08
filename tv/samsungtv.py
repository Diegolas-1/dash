"""Samsung Tizen TV remote client (Python standard library only).

REST  : http://<ip>:8001/api/v2/            device info, app launch/status
WS    : wss://<ip>:8002/api/v2/channels/samsung.remote.control   key presses, app list
"""
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(HERE, "state")
TV_FILE = os.path.join(STATE_DIR, "tv.json")
CLIENT_NAME = "DashRemote"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

KEYS = {
    "nav": ["KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_RIGHT", "KEY_ENTER", "KEY_RETURN", "KEY_EXIT", "KEY_HOME"],
    "menu": ["KEY_MENU", "KEY_TOOLS", "KEY_INFO", "KEY_GUIDE", "KEY_SOURCE"],
    "power": ["KEY_POWER", "KEY_POWEROFF"],
    "volume": ["KEY_VOLUP", "KEY_VOLDOWN", "KEY_MUTE"],
    "media": ["KEY_PLAY", "KEY_PAUSE", "KEY_STOP", "KEY_FF", "KEY_REWIND"],
    "color": ["KEY_RED", "KEY_GREEN", "KEY_YELLOW", "KEY_BLUE"],
    "digits": ["KEY_%d" % i for i in range(10)],
    # BN59-01315A extras
    "channel": ["KEY_CHUP", "KEY_CHDOWN", "KEY_PRECH", "KEY_CH_LIST"],
    "info": ["KEY_INFO", "KEY_GUIDE", "KEY_CAPTION", "KEY_TOOLS", "KEY_MENU"],
    "transport": ["KEY_REC", "KEY_PLAY_BACK"],
}


# --------------------------------------------------------------------------- state

def load_state():
    try:
        with open(TV_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = TV_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, TV_FILE)
    try:
        os.chmod(TV_FILE, 0o600)
    except OSError:
        pass


# --------------------------------------------------------------------------- REST

def rest(ip, path="", method="GET", timeout=4):
    url = "http://%s:8001/api/v2/%s" % (ip, path)
    req = urllib.request.Request(url, method=method, data=b"" if method in ("POST", "PUT") else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    try:
        return json.loads(body.decode("utf-8") or "null")
    except ValueError:
        return body.decode("utf-8", "replace")


def device_info(ip, timeout=4):
    return rest(ip, "", timeout=timeout)


# --------------------------------------------------------------------------- WebSocket

class WebSocketError(Exception):
    pass


class WebSocket:
    """Minimal RFC 6455 client: text frames, ping/pong, close, fragmentation."""

    def __init__(self, host, port, path, use_tls=True, timeout=10):
        raw = socket.create_connection((host, port), timeout=timeout)
        if use_tls:
            # The TV presents a self-signed certificate; it is a LAN device.
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            raw = ctx.wrap_socket(raw, server_hostname=host)
        self.sock = raw
        self._buf = b""
        self._handshake(host, port, path)

    def _handshake(self, host, port, path):
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)
        )
        self.sock.sendall(req.encode())
        while b"\r\n\r\n" not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketError("connection closed during handshake")
            self._buf += chunk
        head, self._buf = self._buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0] + " ":
            raise WebSocketError("handshake rejected: %s" % lines[0])
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        expect = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != expect:
            raise WebSocketError("bad Sec-WebSocket-Accept")

    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise WebSocketError("connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode, payload):
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send(self, obj):
        data = obj if isinstance(obj, str) else json.dumps(obj)
        self._send_frame(0x1, data.encode("utf-8"))

    def recv(self, timeout=None):
        """Return the next text message (str) or None on timeout."""
        self.sock.settimeout(timeout)
        message = b""
        try:
            while True:
                b1, b2 = self._read(2)
                fin, opcode = b1 & 0x80, b1 & 0x0F
                n = b2 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._read(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._read(8))[0]
                mask = self._read(4) if b2 & 0x80 else None
                payload = self._read(n)
                if mask:
                    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                if opcode == 0x9:
                    self._send_frame(0xA, payload)
                    continue
                if opcode == 0xA:
                    continue
                if opcode == 0x8:
                    raise WebSocketError("closed by TV")
                message += payload
                if fin:
                    return message.decode("utf-8", "replace")
        except socket.timeout:
            return None

    def close(self):
        try:
            self._send_frame(0x8, struct.pack(">H", 1000))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------- TV client

class SamsungTV:
    def __init__(self, ip=None, port=8002, name=CLIENT_NAME):
        state = load_state()
        self.ip = ip or os.environ.get("SAMSUNG_TV_IP") or state.get("ip")
        if not self.ip:
            raise SystemExit("No TV IP. Run: python3 tv/tv.py discover  (or pass --ip)")
        self.port = port
        self.name = name
        self.token = state.get("token") if state.get("ip") == self.ip else None
        self.ws = None

    def connect(self, pair_timeout=30):
        name64 = base64.b64encode(self.name.encode()).decode()
        path = "/api/v2/channels/samsung.remote.control?name=%s" % name64
        if self.token:
            path += "&token=%s" % self.token
        self.ws = WebSocket(self.ip, self.port, path, use_tls=(self.port == 8002))
        deadline = time.time() + pair_timeout
        while time.time() < deadline:
            msg = self.ws.recv(timeout=max(0.1, deadline - time.time()))
            if msg is None:
                break
            evt = json.loads(msg)
            if evt.get("event") == "ms.channel.connect":
                token = (evt.get("data") or {}).get("token") or self.token
                state = load_state()
                if state.get("ip") != self.ip or state.get("token") != token:
                    if state.get("ip") != self.ip:
                        state = {}
                    self.token = token
                    state.update({"ip": self.ip, "token": token})
                    save_state(state)
                return self
            if evt.get("event") == "ms.channel.unauthorized":
                raise SystemExit("TV denied access. Allow 'DashRemote' on the TV prompt "
                                 "(Settings > General > External Device Manager > Device Connection Manager).")
        raise SystemExit("Timed out waiting for the TV to accept the connection.")

    def close(self):
        if self.ws:
            self.ws.close()
            self.ws = None

    def __enter__(self):
        return self.connect()

    def __exit__(self, *exc):
        self.close()

    # -- keys
    def key(self, key, cmd="Click"):
        self.ws.send({
            "method": "ms.remote.control",
            "params": {"Cmd": cmd, "DataOfCmd": key, "Option": "false", "TypeOfRemote": "SendRemoteKey"},
        })

    def keys(self, seq, delay=0.6):
        for k in seq:
            self.key(k)
            time.sleep(delay)

    def hold(self, key, seconds=1.0):
        self.key(key, "Press")
        time.sleep(seconds)
        self.key(key, "Release")

    # -- apps
    def _emit(self, event, data=None):
        params = {"event": event, "to": "host"}
        if data is not None:
            params["data"] = data
        self.ws.send({"method": "ms.channel.emit", "params": params})

    def _wait_event(self, event, timeout=8):
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = self.ws.recv(timeout=max(0.1, deadline - time.time()))
            if msg is None:
                break
            evt = json.loads(msg)
            if evt.get("event") == event:
                return evt
        return None

    def apps(self):
        self._emit("ed.installedApp.get")
        evt = self._wait_event("ed.installedApp.get")
        if not evt:
            return []
        data = evt.get("data") or {}
        return data.get("data", []) if isinstance(data, dict) else []

    def launch(self, app_id, meta=None, app_type=None):
        action = "NATIVE_LAUNCH" if app_type == 4 else "DEEP_LINK"
        data = {"appId": app_id, "action_type": action}
        if meta:
            data["metaTag"] = meta
        self._emit("ed.apps.launch", data)

    def open_url(self, url, browser_id="org.tizen.browser"):
        self._emit("ed.apps.launch", {"appId": browser_id, "action_type": "NATIVE_LAUNCH", "metaTag": url})

    # -- REST helpers that need no socket
    def app_status(self, app_id):
        return rest(self.ip, "applications/%s" % app_id)

    def app_close(self, app_id):
        return rest(self.ip, "applications/%s" % app_id, method="DELETE")


def run_macro(tv, macro, default_delay=0.6, echo=print):
    """Macro steps: "KEY_X" | {"key": "KEY_X", "times": n} | {"wait": s} | {"hold": "KEY_X", "seconds": s}."""
    for step in macro.get("steps", []):
        if isinstance(step, str):
            echo("  key  %s" % step)
            tv.key(step)
            time.sleep(macro.get("delay", default_delay))
        elif "wait" in step:
            echo("  wait %ss" % step["wait"])
            time.sleep(float(step["wait"]))
        elif "hold" in step:
            echo("  hold %s %ss" % (step["hold"], step.get("seconds", 1)))
            tv.hold(step["hold"], float(step.get("seconds", 1)))
        elif "key" in step:
            for _ in range(int(step.get("times", 1))):
                echo("  key  %s" % step["key"])
                tv.key(step["key"])
                time.sleep(float(step.get("delay", macro.get("delay", default_delay))))
