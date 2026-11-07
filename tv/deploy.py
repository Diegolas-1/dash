#!/usr/bin/env python3
"""Package a TV app as a signed .wgt and install it on the TV (Windows/macOS/Linux/ChromeOS).

  python tv/deploy.py [--app homeapp|torrentapp] [--ip TV_IP] [--profile dash]

Needs: Tizen Studio CLI (tizen, sdb), a Samsung certificate profile tied to the TV's DUID,
TV in Developer Mode pointing at this computer's IP, tv/<app>/service/auth.js.
Apps with a package.json (torrentapp) are built with npm first.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import samsungtv as st  # noqa: E402

APPS = ("homeapp", "torrentapp")
BUILD_ONLY = ("node_modules", "build", "package.json", "package-lock.json", ".DS_Store", "Thumbs.db")
TIZEN_HOMES = [os.environ.get("TIZEN_STUDIO", ""), os.path.expanduser("~/tizen-studio"), r"C:\tizen-studio"]


def find_tool(name, subdir):
    exe = shutil.which(name)
    if exe:
        return exe
    for home in TIZEN_HOMES:
        for ext in ("", ".bat", ".exe"):
            cand = os.path.join(home, subdir, name + ext)
            if home and os.path.exists(cand):
                return cand
    raise SystemExit("%s not found. Install Tizen Studio CLI or set TIZEN_STUDIO to its folder." % name)


def run(cmd, **kw):
    print("> " + " ".join(cmd))
    return subprocess.run(cmd, check=True, **kw)


def app_id(src):
    root = ET.parse(os.path.join(src, "config.xml")).getroot()
    node = root.find("{http://tizen.org/ns/widgets}application")
    return node.get("id")


def build(src):
    if not os.path.exists(os.path.join(src, "package.json")):
        return
    npm = shutil.which("npm")
    if not npm:
        raise SystemExit("npm not found (needed to build %s)" % src)
    if not os.path.isdir(os.path.join(src, "node_modules")):
        run([npm, "ci" if os.path.exists(os.path.join(src, "package-lock.json")) else "install",
             "--omit=optional", "--no-audit", "--no-fund"], cwd=src)
    run([npm, "run", "build"], cwd=src)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--app", choices=APPS, default="homeapp")
    p.add_argument("--ip", default=os.environ.get("SAMSUNG_TV_IP") or st.load_state().get("ip"))
    p.add_argument("--profile", default=os.environ.get("TIZEN_PROFILE", "dash"))
    a = p.parse_args()
    src = os.path.join(st.HERE, a.app)
    stage = os.path.join(st.STATE_DIR, "build", a.app)
    if not a.ip:
        raise SystemExit("No TV IP. Run: python tv/tv.py discover")
    if not os.path.exists(os.path.join(src, "service", "auth.js")):
        raise SystemExit("No password for %s. Run: DASH_PASSWORD=... node tv/tools/set-password.js --app %s" % (a.app, a.app))

    tizen = find_tool("tizen", os.path.join("tools", "ide", "bin"))
    sdb = find_tool("sdb", "tools")
    serial = "%s:26101" % a.ip

    build(src)
    shutil.rmtree(stage, ignore_errors=True)
    shutil.copytree(src, stage, ignore=shutil.ignore_patterns(*BUILD_ONLY))

    run([tizen, "package", "-t", "wgt", "-s", a.profile, "--", stage])
    wgts = sorted(glob.glob(os.path.join(stage, "*.wgt")), key=os.path.getmtime)
    if not wgts:
        raise SystemExit("packaging produced no .wgt")
    wgt = os.path.basename(wgts[-1])

    run([sdb, "connect", a.ip])
    devices = subprocess.run([sdb, "devices"], capture_output=True, text=True).stdout
    if serial not in devices:
        raise SystemExit("TV not connected. Check Developer Mode host IP = this computer's IP, then restart the TV.")

    run([tizen, "install", "-n", wgt, "-s", serial, "--", stage])
    run([tizen, "run", "-p", app_id(src), "-s", serial])


if __name__ == "__main__":
    main()
