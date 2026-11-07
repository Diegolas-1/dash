# CLAUDE.md

`Index` is a standalone iOS Shortcut launcher page. Everything else lives in `tv/`: tooling to customize a Samsung Tizen TV (privacy settings, ad reduction, custom home-screen app). Run Claude Code **on a Mac on the same Wi-Fi as the TV**; a cloud session cannot reach the TV.

## Layout
- `tv/tv.py` – CLI: `discover`, `info`, `pair`, `key`, `apps`, `launch`, `open-url`, `snap`, `record`, `play`, `macros`, `log-setting`, `changes`
- `tv/samsungtv.py` – stdlib client: REST `:8001/api/v2/`, WebSocket remote `wss://:8002`
- `tv/restore.py` – replays undo macros for logged changes, newest first
- `tv/camera/server.py` + `index.html` – iPhone streams TV-screen photos to `tv/camera/frames/latest.jpg`
- `tv/macros/*.json` – recorded key sequences (forward + undo)
- `tv/state/` (gitignored) – `tv.json` (IP, token), `changes.json` (settings log), `photos/`, `build/`
- `tv/homeapp/` – Tizen web app (home screen) + `service/service.js` (Node 16 photo upload service, port 8090)
- `tv/tools/set-password.js` – writes `tv/homeapp/service/auth.js` (gitignored)
- `tv/deploy.sh` – package, `sdb connect`, install, run

## Rules
1. **Look before acting.** After every key press or macro step, Read `tv/camera/frames/latest.jpg` and confirm the screen matches what you expect. If it doesn't (wrong page, popup, a movie opened), press `KEY_RETURN` and re-orient before continuing. Never chain blind key sequences longer than ~5 keys while exploring.
2. **Log before change.** Before changing any setting: photograph it (`tv.py snap <id>`) and run `tv.py log-setting --id ... --path ... --original ... --new ... --undo <macro>`. Record the undo macro (`tv.py record undo-<id>`) or write it as JSON, and test it once.
3. **Irreversible = ask first.** Resetting the PSID/advertising ID, factory reset, Samsung account changes, firmware updates: stop and get explicit user approval. Log them with `--irreversible`.
4. **Never** sign in/out of the Samsung account, accept new terms, or enable any data-sharing option on the user's behalf.
5. Research claims (menu paths, API behavior, DNS hosts to block) go through the `tv-researcher` agent and are verified by `fact-checker` before acting on them. Menu paths differ by model year; trust the camera over research.
6. Run the `security-reviewer` agent on `tv/homeapp/service/` before every deploy that changes it.
7. Developer Mode must be turned **off** at the end of a session; then restart the TV and confirm the home app still launches.

## Workflow
1. **Recon:** `python3 tv/tv.py discover` → `info`. Confirm `OS: Tizen` (no ADB/root on Tizen; don't try). Note model, firmware, `developerMode`.
2. **Pair:** `python3 tv/tv.py pair` (user accepts the prompt on the TV). Smoke test: `tv.py key HOME`.
3. **Camera:** user runs `python3 tv/camera/server.py`, opens the printed URL on an iPhone, props it facing the TV. Verify `latest.jpg` updates.
4. **Inventory:** walk Settings menus, photograph and list every privacy/ad-related setting with its current value before touching anything.
5. **Privacy changes** (each one logged per Rule 2), typically under Settings > General > Terms & Privacy / Support > Terms & Policies:
   Viewing Information Services off, Interest-Based Advertisement off, Voice recognition services off, Samsung Promotion / Home-screen promotion off, Autoplay sound/video on Home off, remove unwanted Home row tiles.
   DNS: Settings > General > Network > Network Status > IP Settings > DNS manual (user picks the filter, e.g. Control D). Afterwards open every dock app to confirm they still load.
6. **Restore test:** `python3 tv/restore.py --dry-run`, then run 2–3 real undos with `--only` and re-apply.
7. **Developer Mode** (user does it): Apps → Settings/123 → type `12345` → Developer mode On → enter this Mac's IP → restart TV. Re-check with `tv.py info` (`developerMode: "1"`).
8. **Tizen SDK + certificate:** Tizen Studio CLI (`tizen`, `sdb`); Samsung author + distributor certificate tied to the TV's DUID (`tv.py info` → `duid`), saved as security profile `dash`. Certificates expire after 1 year.
9. **Prove the risky part first:** deploy a throwaway app with just the service to confirm the Node background service starts and serves `:8090` on this TV.
10. **Home app:** edit `tv/homeapp/js/config.js` (location, apps from `tv.py apps`, YouTube shortcuts, dim schedule, prayer times). `node tv/tools/set-password.js`, security review, `tv/deploy.sh <tv-ip>`.
11. **Finish:** set Settings > General > Smart Features > Autorun Last App as needed so the home app comes back after power-on; Developer Mode off; restart TV; confirm via camera.

## Testing without a TV
- `DASH_PHOTO_DIR=/tmp/p node tv/homeapp/service/service.js` then open `http://localhost:8090`
- Open `tv/homeapp/index.html` in a browser at 1920×1080 (Tizen APIs are stubbed out when absent)
