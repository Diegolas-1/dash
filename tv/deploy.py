#!/usr/bin/env python3
"""Package tv/homeapp as a signed .wgt and install it on the TV (Windows/macOS/Linux).

  python tv/deploy.py [--ip TV_IP] [--profile dash]

Needs: Tizen Studio CLI (tizen, sdb), a Samsung certificate profile tied to the TV's DUID,
TV in Developer Mode pointing at this computer's IP, tv/homeapp/service/auth.js.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import samsungtv as st  # noqa: E402

APP_ID = "DashHome01.home"
SRC = os.path.join(st.HERE, "homeapp")
STAGE = os.path.join(st.STATE_DIR, "build")
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


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ip", default=os.environ.get("SAMSUNG_TV_IP") or st.load_state().get("ip"))
    p.add_argument("--profile", default=os.environ.get("TIZEN_PROFILE", "dash"))
    a = p.parse_args()
    if not a.ip:
        raise SystemExit("No TV IP. Run: python tv/tv.py discover")
    if not os.path.exists(os.path.join(SRC, "service", "auth.js")):
        raise SystemExit("No upload password. Run: node tv/tools/set-password.js")

    tizen = find_tool("tizen", os.path.join("tools", "ide", "bin"))
    sdb = find_tool("sdb", "tools")
    serial = "%s:26101" % a.ip

    shutil.rmtree(STAGE, ignore_errors=True)
    shutil.copytree(SRC, STAGE, ignore=shutil.ignore_patterns(".DS_Store", "Thumbs.db"))

    run([tizen, "package", "-t", "wgt", "-s", a.profile, "--", STAGE])
    wgts = sorted(glob.glob(os.path.join(STAGE, "*.wgt")), key=os.path.getmtime)
    if not wgts:
        raise SystemExit("packaging produced no .wgt")
    wgt = os.path.basename(wgts[-1])

    run([sdb, "connect", a.ip])
    devices = subprocess.run([sdb, "devices"], capture_output=True, text=True).stdout
    if serial not in devices:
        raise SystemExit("TV not connected. Check Developer Mode host IP = this computer's IP, then restart the TV.")

    run([tizen, "install", "-n", wgt, "-s", serial, "--", STAGE])
    run([tizen, "run", "-p", APP_ID, "-s", serial])


if __name__ == "__main__":
    main()
