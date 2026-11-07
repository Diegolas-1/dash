#!/usr/bin/env python3
"""Stream photos of the TV screen to tv/camera/frames/latest.jpg (+ rolling history).

  Laptop webcam:  python tv/camera/server.py --webcam
                  Opens http://localhost:8443/... in the laptop browser; aim the webcam at the TV.
  Phone camera:   python tv/camera/server.py
                  Open the printed https URL on the phone (same Wi-Fi), accept the certificate
                  warning, allow the camera, prop the phone up facing the TV.
"""
import argparse
import http.server
import os
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "frames")
HISTORY = os.path.join(FRAMES, "history")
CERTS = os.path.join(HERE, "certs")
MAX_FRAME = 6 * 1024 * 1024


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def find_openssl():
    exe = shutil.which("openssl")
    if exe:
        return exe
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", "")):
        cand = os.path.join(base, "Git", "usr", "bin", "openssl.exe")
        if base and os.path.exists(cand):
            return cand
    raise SystemExit("openssl not found. Install Git for Windows (includes openssl) or use --webcam.")


def ensure_cert(ip):
    os.makedirs(CERTS, exist_ok=True)
    crt, key = os.path.join(CERTS, "cert.pem"), os.path.join(CERTS, "key.pem")
    stamp = os.path.join(CERTS, "ip.txt")
    if all(os.path.exists(p) for p in (crt, key, stamp)):
        with open(stamp) as f:
            if f.read() == ip:
                return crt, key
    base = [find_openssl(), "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
            "-days", "365", "-subj", "/CN=tv-camera"]
    try:
        subprocess.run(base + ["-addext", "subjectAltName=IP:%s" % ip], check=True, capture_output=True)
    except subprocess.CalledProcessError:
        subprocess.run(base, check=True, capture_output=True)
    with open(stamp, "w") as f:
        f.write(ip)
    os.chmod(key, 0o600)
    return crt, key


def make_handler(token, keep, interval):
    page = open(os.path.join(HERE, "index.html"), "rb").read().replace(b"__INTERVAL__", str(interval).encode())
    state = {"count": 0, "last": 0.0}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, body=b"", ctype="text/plain"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authed(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return secrets.compare_digest(q.get("k", [""])[0], token)

        def do_GET(self):
            route = urllib.parse.urlparse(self.path).path
            if not self._authed():
                return self._send(403, b"forbidden")
            if route == "/":
                return self._send(200, page, "text/html; charset=utf-8")
            if route == "/latest.jpg":
                try:
                    return self._send(200, open(os.path.join(FRAMES, "latest.jpg"), "rb").read(), "image/jpeg")
                except OSError:
                    return self._send(404, b"no frame yet")
            self._send(404, b"not found")

        def do_POST(self):
            if urllib.parse.urlparse(self.path).path != "/frame" or not self._authed():
                return self._send(403, b"forbidden")
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_FRAME:
                return self._send(413, b"bad size")
            data = self.rfile.read(n)
            if not data.startswith(b"\xff\xd8"):
                return self._send(415, b"jpeg only")
            tmp = os.path.join(FRAMES, ".latest.tmp")
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, os.path.join(FRAMES, "latest.jpg"))
            ts = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % (int(time.time() * 1000) % 1000)
            with open(os.path.join(HISTORY, ts + ".jpg"), "wb") as f:
                f.write(data)
            old = sorted(os.listdir(HISTORY))[:-keep]
            for name in old:
                try:
                    os.remove(os.path.join(HISTORY, name))
                except OSError:
                    pass
            state["count"] += 1
            if time.time() - state["last"] > 10:
                state["last"] = time.time()
                sys.stdout.write("\rframes received: %d " % state["count"])
                sys.stdout.flush()
            self._send(204)

    return H


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8443)
    p.add_argument("--interval", type=int, default=1000, help="ms between frames")
    p.add_argument("--keep", type=int, default=300, help="history frames to keep")
    p.add_argument("--webcam", action="store_true", help="use this computer's webcam (plain HTTP on localhost)")
    a = p.parse_args()

    os.makedirs(HISTORY, exist_ok=True)
    token = secrets.token_urlsafe(12)
    handler = make_handler(token, a.keep, a.interval)
    if a.webcam:
        # Browsers allow camera access on http://localhost without a certificate.
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler)
        url = "http://localhost:%d/?k=%s" % (a.port, token)
        print("Webcam page:   %s" % url)
        webbrowser.open(url)
    else:
        ip = lan_ip()
        crt, key = ensure_cert(ip)
        srv = http.server.ThreadingHTTPServer(("0.0.0.0", a.port), handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        print("Open on the phone:  https://%s:%d/?k=%s" % (ip, a.port, token))
    print("Latest frame:  %s" % os.path.join(FRAMES, "latest.jpg"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
