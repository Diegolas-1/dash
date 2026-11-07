#!/usr/bin/env python3
"""Samsung Tizen TV control CLI.  python3 tv/tv.py <command> --help"""
import argparse
import concurrent.futures
import ipaddress
import json
import os
import shutil
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import samsungtv as st  # noqa: E402

MACRO_DIR = os.path.join(st.HERE, "macros")
CHANGES_FILE = os.path.join(st.STATE_DIR, "changes.json")
PHOTO_DIR = os.path.join(st.STATE_DIR, "photos")
LATEST_FRAME = os.path.join(st.HERE, "camera", "frames", "latest.jpg")


# --------------------------------------------------------------------------- helpers

def jdump(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def macro_path(name):
    safe = "".join(c for c in name if c.isalnum() or c in "-_")
    if not safe:
        raise SystemExit("invalid macro name")
    return os.path.join(MACRO_DIR, safe + ".json")


def snapshot(label):
    if not os.path.exists(LATEST_FRAME):
        return None
    os.makedirs(PHOTO_DIR, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in label)[:60]
    dest = os.path.join(PHOTO_DIR, "%s-%s.jpg" % (time.strftime("%Y%m%d-%H%M%S"), safe))
    shutil.copyfile(LATEST_FRAME, dest)
    return os.path.relpath(dest, st.HERE)


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# --------------------------------------------------------------------------- discovery

def ssdp_search(timeout=3):
    msg = (
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n"
        "ST: urn:samsung.com:device:RemoteControlReceiver:1\r\n\r\n"
    ).encode()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    sock.settimeout(0.5)
    found = set()
    try:
        for _ in range(2):
            sock.sendto(msg, ("239.255.255.250", 1900))
        end = time.time() + timeout
        while time.time() < end:
            try:
                _, addr = sock.recvfrom(4096)
                found.add(addr[0])
            except socket.timeout:
                pass
    finally:
        sock.close()
    return sorted(found)


def probe(ip):
    try:
        info = st.device_info(ip, timeout=1.5)
        return ip, info if isinstance(info, dict) else None
    except Exception:
        return ip, None


def cmd_discover(a):
    candidates = [] if a.scan else ssdp_search()
    if not candidates:
        net = ipaddress.ip_network(local_ip() + "/24", strict=False)
        print("Scanning %s for port 8001 ..." % net)
        candidates = [str(h) for h in net.hosts()]
    tvs = []
    with concurrent.futures.ThreadPoolExecutor(64) as ex:
        for ip, info in ex.map(probe, candidates):
            if info and "device" in info:
                d = info["device"]
                tvs.append({"ip": ip, "name": d.get("name"), "model": d.get("modelName"), "os": d.get("OS"),
                            "duid": d.get("duid"), "tokenAuth": d.get("TokenAuthSupport"),
                            "developerMode": d.get("developerMode"), "developerIP": d.get("developerIP")})
    if not tvs:
        raise SystemExit("No Samsung TV found. Is the TV on and on the same Wi-Fi?")
    jdump(tvs)
    if len(tvs) == 1 or a.save:
        pick = tvs[0]
        state = st.load_state()
        if state.get("ip") != pick["ip"]:
            state = {"ip": pick["ip"]}
        state.update({"name": pick["name"], "model": pick["model"], "duid": pick["duid"]})
        st.save_state(state)
        print("Saved %s (%s) as the default TV." % (pick["ip"], pick["name"]))


# --------------------------------------------------------------------------- basic commands

def tv_from(a):
    return st.SamsungTV(ip=a.ip, port=a.port)


def cmd_info(a):
    tv = tv_from(a)
    jdump(st.device_info(tv.ip))


def cmd_pair(a):
    print("Connecting; accept the prompt on the TV if one appears ...")
    with tv_from(a) as tv:
        print("Paired. Token saved to tv/state/tv.json" if tv.token else "Connected (TV did not issue a token).")


def cmd_key(a):
    sent = []
    with tv_from(a) as tv:
        for k in a.keys:
            k = k.upper()
            if not k.startswith("KEY_"):
                k = "KEY_" + k
            print(k)
            tv.key(k)
            sent.append(k)
            time.sleep(a.delay)
    if a.record:
        path, macro = append_macro(a.record, sent)
        print("appended to %s (%d steps)" % (os.path.relpath(path, st.HERE), len(macro["steps"])))
    if a.snap:
        time.sleep(1.2)
        print(snapshot(a.snap) or "no camera frame available")


def cmd_keys(a):
    for group, ks in st.KEYS.items():
        print("%-7s %s" % (group, " ".join(ks)))


def cmd_apps(a):
    with tv_from(a) as tv:
        apps = tv.apps()
    if a.json:
        jdump(apps)
        return
    for app in sorted(apps, key=lambda x: (x.get("name") or "").lower()):
        print("%-22s type=%-2s %s" % (app.get("appId"), app.get("app_type"), app.get("name")))


def resolve_app(tv, query):
    apps = tv.apps()
    for app in apps:
        if app.get("appId") == query:
            return app
    matches = [x for x in apps if query.lower() in (x.get("name") or "").lower()]
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise SystemExit("Ambiguous: " + ", ".join("%s (%s)" % (m["name"], m["appId"]) for m in matches))
    return {"appId": query}


def cmd_launch(a):
    with tv_from(a) as tv:
        app = resolve_app(tv, a.app)
        print("Launching %s %s" % (app.get("appId"), app.get("name") or ""))
        tv.launch(app["appId"], meta=a.meta, app_type=app.get("app_type"))
        time.sleep(0.5)


def cmd_status(a):
    jdump(tv_from(a).app_status(a.app_id))


def cmd_close_app(a):
    jdump(tv_from(a).app_close(a.app_id))


def cmd_open_url(a):
    with tv_from(a) as tv:
        tv.open_url(a.url, browser_id=a.browser)
        time.sleep(0.5)


def cmd_snap(a):
    print(snapshot(a.label) or "no camera frame at tv/camera/frames/latest.jpg")


# --------------------------------------------------------------------------- macros

RECORD_KEYS = {
    "\x1b[A": "KEY_UP", "\x1b[B": "KEY_DOWN", "\x1b[C": "KEY_RIGHT", "\x1b[D": "KEY_LEFT",
    "\r": "KEY_ENTER", "\n": "KEY_ENTER", "\x7f": "KEY_RETURN", "b": "KEY_RETURN",
    "h": "KEY_HOME", "m": "KEY_MENU", "x": "KEY_EXIT", "s": "KEY_SOURCE", "t": "KEY_TOOLS",
    "+": "KEY_VOLUP", "-": "KEY_VOLDOWN", "p": "KEY_POWER",
}
RECORD_KEYS.update({str(i): "KEY_%d" % i for i in range(10)})


WIN_KEYS = {"H": "\x1b[A", "P": "\x1b[B", "M": "\x1b[C", "K": "\x1b[D"}


class RawKeys:
    """Read single key presses on Windows (msvcrt) or Unix (termios)."""

    def __enter__(self):
        if os.name == "nt":
            import msvcrt
            self.msvcrt = msvcrt
        else:
            import termios
            import tty
            self.termios = termios
            self.fd = sys.stdin.fileno()
            self.old = termios.tcgetattr(self.fd)
            tty.setraw(self.fd)
        return self

    def __exit__(self, *exc):
        if os.name != "nt":
            self.termios.tcsetattr(self.fd, self.termios.TCSADRAIN, self.old)

    def read(self):
        if os.name == "nt":
            ch = self.msvcrt.getwch()
            if ch in ("\x00", "\xe0"):
                return WIN_KEYS.get(self.msvcrt.getwch(), "")
            return "\x7f" if ch == "\x08" else ch
        ch = sys.stdin.read(1)
        if ch == "\x1b":
            ch += sys.stdin.read(2)
        return ch


def append_macro(name, keys, description=""):
    path = macro_path(name)
    macro = load_json(path, {"name": name, "description": description, "delay": 0.8, "steps": []})
    macro["steps"].extend(keys)
    if description:
        macro["description"] = description
    macro["recorded"] = time.strftime("%Y-%m-%d %H:%M:%S")
    save_json(path, macro)
    return path, macro


def cmd_record(a):
    steps = []
    print("Recording '%s'. Keys are sent to the TV live.\n"
          "  arrows=move  Enter=OK  Backspace/b=Back  h=Home  m=Menu  x=Exit  s=Source  t=Tools  0-9\n"
          "  w=insert 2s wait  u=drop last step (not sent)  q=save  Ctrl-C=abort" % a.name)
    with tv_from(a) as tv, RawKeys() as kb:
        while True:
            k = kb.read()
            if k == "\x03":
                raise SystemExit("\r\naborted, nothing saved")
            if k == "q":
                break
            if k == "w":
                steps.append({"wait": 2})
                sys.stdout.write("wait 2s\r\n")
            elif k == "u" and steps:
                sys.stdout.write("dropped %s\r\n" % json.dumps(steps.pop()))
            elif k in RECORD_KEYS:
                tv.key(RECORD_KEYS[k])
                steps.append(RECORD_KEYS[k])
                sys.stdout.write("%s\r\n" % RECORD_KEYS[k])
            sys.stdout.flush()
    if os.path.exists(macro_path(a.name)):
        os.remove(macro_path(a.name))
    path, macro = append_macro(a.name, steps, a.description or "")
    macro["delay"] = a.delay
    save_json(path, macro)
    print("Saved %s (%d steps)" % (os.path.relpath(path, st.HERE), len(steps)))


def cmd_save_macro(a):
    keys = [k.upper() if k.upper().startswith("KEY_") else "KEY_" + k.upper() for k in a.keys]
    if a.replace and os.path.exists(macro_path(a.name)):
        os.remove(macro_path(a.name))
    path, macro = append_macro(a.name, keys, a.description or "")
    print("%s: %d steps" % (os.path.relpath(path, st.HERE), len(macro["steps"])))


def cmd_play(a):
    macro = load_json(macro_path(a.name), None)
    if macro is None:
        raise SystemExit("no macro named %s" % a.name)
    print("Playing %s: %s" % (a.name, macro.get("description", "")))
    if a.dry_run:
        jdump(macro["steps"])
        return
    with tv_from(a) as tv:
        st.run_macro(tv, macro)


def cmd_macros(a):
    if not os.path.isdir(MACRO_DIR):
        return
    for f in sorted(os.listdir(MACRO_DIR)):
        if f.endswith(".json"):
            m = load_json(os.path.join(MACRO_DIR, f), {})
            print("%-32s %3d steps  %s" % (f[:-5], len(m.get("steps", [])), m.get("description", "")))


# --------------------------------------------------------------------------- settings log

def cmd_log_setting(a):
    log = load_json(CHANGES_FILE, {"tv": {}, "changes": []})
    if not log["tv"]:
        try:
            info = st.device_info(tv_from(a).ip).get("device", {})
            log["tv"] = {k: info.get(k) for k in ("name", "modelName", "OS", "firmwareVersion", "duid")}
        except (Exception, SystemExit):
            pass
    entry = {
        "id": a.id,
        "path": a.path,
        "original": a.original,
        "new": a.new,
        "undo_macro": a.undo,
        "irreversible": a.irreversible,
        "note": a.note,
        "logged": time.strftime("%Y-%m-%d %H:%M:%S"),
        "photo": snapshot(a.id),
        "restored": None,
    }
    if a.undo and not os.path.exists(macro_path(a.undo)):
        print("warning: undo macro '%s' does not exist yet" % a.undo)
    log["changes"] = [c for c in log["changes"] if c["id"] != a.id] + [entry]
    save_json(CHANGES_FILE, log)
    jdump(entry)


def cmd_changes(a):
    log = load_json(CHANGES_FILE, {"tv": {}, "changes": []})
    if a.json:
        jdump(log)
        return
    for c in log["changes"]:
        flag = "IRREVERSIBLE" if c.get("irreversible") else ("restored" if c.get("restored") else "active")
        print("%-28s %-12s %s: %s -> %s  [undo: %s]" % (
            c["id"], flag, c["path"], c["original"], c["new"], c.get("undo_macro") or "-"))


# --------------------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--ip", help="TV IP (default: tv/state/tv.json or $SAMSUNG_TV_IP)")
    p.add_argument("--port", type=int, default=8002)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("discover", help="find Samsung TVs on the LAN (SSDP, then /24 scan)")
    s.add_argument("--scan", action="store_true", help="skip SSDP, scan the /24 directly")
    s.add_argument("--save", action="store_true", help="save the first result even if several are found")
    s.set_defaults(fn=cmd_discover)

    sub.add_parser("info", help="device info from :8001/api/v2/").set_defaults(fn=cmd_info)
    sub.add_parser("pair", help="connect and store the auth token").set_defaults(fn=cmd_pair)
    sub.add_parser("keys", help="list common key codes").set_defaults(fn=cmd_keys)

    s = sub.add_parser("key", help="send key presses: key HOME DOWN DOWN ENTER")
    s.add_argument("keys", nargs="+")
    s.add_argument("--delay", type=float, default=0.6)
    s.add_argument("--snap", metavar="LABEL", help="save a camera photo afterwards")
    s.add_argument("--record", metavar="MACRO", help="also append these keys to a macro")
    s.set_defaults(fn=cmd_key)

    s = sub.add_parser("apps", help="list installed apps")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_apps)

    s = sub.add_parser("launch", help="launch app by id or name")
    s.add_argument("app")
    s.add_argument("--meta", help="deep-link metaTag")
    s.set_defaults(fn=cmd_launch)

    s = sub.add_parser("status", help="app status via REST")
    s.add_argument("app_id")
    s.set_defaults(fn=cmd_status)

    s = sub.add_parser("close-app", help="close app via REST")
    s.add_argument("app_id")
    s.set_defaults(fn=cmd_close_app)

    s = sub.add_parser("open-url", help="open a URL in the TV browser")
    s.add_argument("url")
    s.add_argument("--browser", default="org.tizen.browser")
    s.set_defaults(fn=cmd_open_url)

    s = sub.add_parser("snap", help="copy the latest camera frame into tv/state/photos")
    s.add_argument("label")
    s.set_defaults(fn=cmd_snap)

    s = sub.add_parser("record", help="record a key macro from the keyboard")
    s.add_argument("name")
    s.add_argument("--description", "-d")
    s.add_argument("--delay", type=float, default=0.8)
    s.set_defaults(fn=cmd_record)

    s = sub.add_parser("save-macro", help="write a macro without a keyboard: save-macro undo-x MENU DOWN ENTER")
    s.add_argument("name")
    s.add_argument("keys", nargs="+")
    s.add_argument("--description", "-d")
    s.add_argument("--replace", action="store_true", help="overwrite instead of append")
    s.set_defaults(fn=cmd_save_macro)

    s = sub.add_parser("play", help="play a key macro")
    s.add_argument("name")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_play)

    sub.add_parser("macros", help="list macros").set_defaults(fn=cmd_macros)

    s = sub.add_parser("log-setting", help="record a setting's original value BEFORE changing it")
    s.add_argument("--id", required=True)
    s.add_argument("--path", required=True, help="menu path, e.g. 'Settings > Support > Terms & Privacy'")
    s.add_argument("--original", required=True)
    s.add_argument("--new", required=True)
    s.add_argument("--undo", help="macro name that restores the original value")
    s.add_argument("--irreversible", action="store_true")
    s.add_argument("--note", default="")
    s.set_defaults(fn=cmd_log_setting)

    s = sub.add_parser("changes", help="show the settings change log")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_changes)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
