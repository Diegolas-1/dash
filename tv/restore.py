#!/usr/bin/env python3
"""Undo logged TV setting changes by replaying their undo macros (newest first).

  python3 tv/restore.py                 interactive, every active change
  python3 tv/restore.py --only ID ...   just these changes
  python3 tv/restore.py --dry-run       show what would run
  python3 tv/restore.py --yes           no per-step confirmation
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import samsungtv as st  # noqa: E402
from tv import CHANGES_FILE, load_json, macro_path, save_json, snapshot  # noqa: E402


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ip")
    p.add_argument("--only", nargs="+", metavar="ID")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--include-restored", action="store_true", help="re-run changes already marked restored")
    a = p.parse_args()

    log = load_json(CHANGES_FILE, None)
    if not log or not log.get("changes"):
        raise SystemExit("Nothing logged in %s" % CHANGES_FILE)

    todo = [c for c in reversed(log["changes"])
            if (a.include_restored or not c.get("restored")) and (not a.only or c["id"] in a.only)]
    if a.only:
        missing = set(a.only) - {c["id"] for c in todo}
        if missing:
            print("not found / already restored: %s" % ", ".join(sorted(missing)))
    if not todo:
        print("Nothing to restore.")
        return

    plan = []
    for c in todo:
        if c.get("irreversible"):
            print("SKIP %-28s irreversible (%s)" % (c["id"], c["path"]))
            continue
        if not c.get("undo_macro"):
            print("SKIP %-28s no undo macro; restore manually: %s -> %s" % (c["id"], c["path"], c["original"]))
            continue
        path = macro_path(c["undo_macro"])
        if not os.path.exists(path):
            print("SKIP %-28s macro '%s' missing" % (c["id"], c["undo_macro"]))
            continue
        plan.append((c, load_json(path, {})))

    for c, m in plan:
        print("PLAN %-28s %s: %s -> %s via %s (%d steps)" % (
            c["id"], c["path"], c["new"], c["original"], c["undo_macro"], len(m.get("steps", []))))
    if a.dry_run or not plan:
        return

    tv = st.SamsungTV(ip=a.ip)
    tv.connect()
    try:
        for c, m in plan:
            if not a.yes:
                ans = input("\nRestore %s (%s -> %s)? [y/N/q] " % (c["id"], c["new"], c["original"])).strip().lower()
                if ans == "q":
                    break
                if ans != "y":
                    continue
            print("Restoring %s" % c["id"])
            tv.key("KEY_HOME")
            time.sleep(1.5)
            st.run_macro(tv, m)
            time.sleep(1.5)
            c["restored"] = time.strftime("%Y-%m-%d %H:%M:%S")
            c["restore_photo"] = snapshot("restored-" + c["id"])
            save_json(CHANGES_FILE, log)
            tv.key("KEY_HOME")
            time.sleep(1.5)
    finally:
        tv.close()
    print("\nVerify on screen (or tv/camera/frames/latest.jpg). Log: %s" % os.path.relpath(CHANGES_FILE))
    print(json.dumps([{"id": c["id"], "restored": c.get("restored")} for c, _ in plan], indent=2))


if __name__ == "__main__":
    main()
