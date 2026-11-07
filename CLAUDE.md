# CLAUDE.md

`Index` is a standalone iOS Shortcut launcher page. Everything else lives in `tv/`: tooling to customize a Samsung Tizen TV (privacy settings, ad reduction, custom home-screen app).

## Where this runs
- Claude Code must run on a **laptop on the same Wi-Fi as the TV** (Windows, macOS or Linux). A cloud session cannot reach the TV.
- The user may be driving this session **from their phone** (Remote Control). Assume they cannot type on the laptop: never start interactive commands (`tv.py record`, password prompts); use the non-interactive forms below. Ask them to act only on the TV/remote or phone, and say exactly which button or menu.
- Commands are written `python`; on macOS/Linux use `python3`. Windows: if `python` opens the Store, use `py`.
- **Chromebook:** runs in the ChromeOS Linux container, which is behind NAT on `100.115.92.x`. SSDP and the default scan can't see the home LAN: use `discover --subnet <wifi subnet>` or `--ip <TV IP>`. Developer Mode host IP = the Chromebook's Wi-Fi IP from ChromeOS Settings, not `ip addr` in Linux. The webcam page opens in ChromeOS Chrome via `localhost` forwarding. Tizen Studio (steps 8–10) needs an Intel/AMD Chromebook; on ARM, stop after step 7. Keep the lid open; ChromeOS sleeps the Linux container otherwise.
- Camera: default is the **laptop webcam** aimed at the TV (`python tv/camera/server.py --webcam`, keep that browser window visible, not minimized). Phone camera mode (`server.py` without `--webcam`) only if the user has a spare phone, since their phone is the controller.

## Layout
- `tv/tv.py` – CLI: `discover`, `info`, `pair`, `key [--record MACRO] [--snap LABEL]`, `apps`, `launch`, `open-url`, `snap`, `save-macro`, `play`, `macros`, `log-setting`, `changes`, `record` (interactive, keyboard only)
- `tv/samsungtv.py` – stdlib client: REST `:8001/api/v2/`, WebSocket remote `wss://:8002`
- `tv/restore.py` – replays undo macros for logged changes, newest first (`--yes` for non-interactive)
- `tv/camera/server.py` + `index.html` – streams TV-screen photos to `tv/camera/frames/latest.jpg`
- `tv/macros/*.json` – key sequences (forward + undo)
- `tv/state/` (gitignored) – `tv.json` (IP, token), `changes.json` (settings log), `photos/`, `build/`
- `tv/homeapp/` – Tizen web app (home screen) + `service/service.js` (Node 16 photo upload service, port 8090)
- `tv/tools/set-password.js` – writes `tv/homeapp/service/auth.js` (gitignored); use `DASH_PASSWORD=...` env, never the prompt
- `tv/deploy.py` – package, `sdb connect`, install, run

## Rules
1. **Look before acting.** After every key press or macro step, Read `tv/camera/frames/latest.jpg` and confirm the screen matches what you expect. If it doesn't (wrong page, popup, a movie opened), press `KEY_RETURN` and re-orient before continuing. Never chain blind key sequences longer than ~5 keys while exploring.
2. **Log before change.** Before changing any setting: `tv.py snap <id>`, then `tv.py log-setting --id ... --path ... --original ... --new ... --undo undo-<id>`. Build the undo macro with `tv.py save-macro undo-<id> HOME ... --replace` (or by navigating with `tv.py key ... --record undo-<id>`), and test it once.
3. **Irreversible = ask first.** Resetting the PSID/advertising ID, factory reset, Samsung account changes, firmware updates: stop and get explicit user approval. Log them with `--irreversible`.
4. **Never** sign in/out of the Samsung account, accept new terms, or enable any data-sharing option on the user's behalf.
5. Research claims (menu paths, API behavior, DNS hosts to block) go through the `tv-researcher` agent and are verified by `fact-checker` before acting on them. Menu paths differ by model year; trust the camera over research.
6. Run the `security-reviewer` agent on `tv/homeapp/service/` before every deploy that changes it.
7. Developer Mode must be turned **off** at the end of a session; then restart the TV and confirm the home app still launches.
8. Never ask the user to paste passwords into chat. For the upload password, have them set it on the laptop or generate one and tell them to save it.

## Workflow
0. **Setup check:** `python --version` (3.8+), `node --version` (only needed for the home app). Windows: if `discover` finds nothing, Windows Firewall may be blocking Python on the Private network; ask the user to allow it, and confirm the Wi-Fi network profile is Private.
1. **Recon:** `python tv/tv.py discover` (Chromebook: `--subnet`) → `info`. Confirm `OS: Tizen` (no ADB/root on Tizen; don't try). Note model, firmware, `developerMode`.
2. **Pair:** `python tv/tv.py pair` (user presses Allow on the TV). Smoke test: `tv.py key HOME`.
3. **Camera:** start `python tv/camera/server.py --webcam` in the background (it opens the page; user clicks Start and allows the camera, then aims the laptop at the TV). Verify `latest.jpg` updates and the TV is legible.
4. **Inventory:** walk Settings menus, photograph and list every privacy/ad-related setting with its current value before touching anything.
5. **Privacy changes** (each one logged per Rule 2), typically under Settings > General > Terms & Privacy / Support > Terms & Policies:
   Viewing Information Services off, Interest-Based Advertisement off, Voice recognition services off, Samsung Promotion / Home-screen promotion off, Autoplay sound/video on Home off, remove unwanted Home row tiles.
   DNS: Settings > General > Network > Network Status > IP Settings > DNS manual (user picks the filter, e.g. Control D). Afterwards open every dock app to confirm they still load.
6. **Restore test:** `python tv/restore.py --dry-run`, then run 2–3 real undos with `--only ID --yes` and re-apply.
7. **Developer Mode** (user does it with the remote): Apps → Settings/123 → type `12345` → Developer mode On → enter the laptop's IP → restart TV. Re-check with `tv.py info` (`developerMode: "1"`).
8. **Tizen SDK + certificate:** Tizen Studio CLI (`tizen`, `sdb`); Samsung author + distributor certificate tied to the TV's DUID (`tv.py info` → `duid`), saved as security profile `dash`. Certificates expire after 1 year. Creating the Samsung certificate requires the user to sign in to their Samsung account in a browser window on the laptop.
9. **Prove the risky part first:** deploy a throwaway app with just the service to confirm the Node background service starts and serves `:8090` on this TV.
10. **Home app:** edit `tv/homeapp/js/config.js` (location, apps from `tv.py apps`, YouTube shortcuts, dim schedule, prayer times). Set password with `DASH_PASSWORD`, run the security review, then `python tv/deploy.py`.
11. **Finish:** set Settings > General > Smart Features > Autorun Last App as needed so the home app comes back after power-on; Developer Mode off; restart TV; confirm via camera.

## Testing without a TV
- `DASH_PHOTO_DIR=<tmp dir> node tv/homeapp/service/service.js` then open `http://localhost:8090`
- Open `tv/homeapp/index.html` in a browser at 1920×1080 (Tizen APIs are stubbed out when absent)
