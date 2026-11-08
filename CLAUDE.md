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
- `tv/torrentapp/` – Tizen torrent app (`DashTorr01.torrent`): TV UI with AVPlay player + `service/service.js` engine (port 8091: API, streaming, phone page). `service/engine.js` is WebTorrent 2.8.5 bundled by `npm run build` (gitignored; `uint8-util` pinned to 2.2.5, WebRTC stubbed, no uTP). Data: stream cache + TV-storage downloads in the app data dir; USB downloads in `<drive>/Torrents/`. Pauses TV-storage torrents below 1.5 GB free.
- `tv/serverapp/` – "Dash Server" (`DashSrv01.server`): the TV-as-server app. TV UI: Home (hardware/services/storage cards, continue watching, quick actions), Library (USB media: movies/shows/music from filenames, sidecar posters and .srt/.vtt), Player (AVPlay, resume, subtitles, next episode), Dashboard (service health, storage, speed test, logs). `service/service.js` core on port 8092: library index, range streaming, resume positions, phone page with remote control, dashboard data; it probes :8090/:8091 and reads their loopback-only `/api/log`. Services can be started (not stopped) from the dashboard via the TV app. No external metadata lookups.
- `tv/serverapp/ambient/` – the always-on **ambient screen** (`index.html`, `ambient.css`, `ambient.js`, `config.js`): serif clock, 24-hour temperature curve (Open-Meteo), glass column (now playing / continue watching, rotating panel: calendar ICS, prayer times, downloads, internet speed, up next; lights switch bay), status line. Three themes, `theme` in `config.js` or `?theme=`: **ink** (`theme-ink.css`, quiet editorial serif over photos/aurora), **poster** (`theme-poster.css`, Bauhaus color blocks on paper, stepped temperature, photo in its own block) and **parks** (`theme-parks.css`, WPA travel poster: full-bleed flat-art national park scenes from `art/parks/` with a caption band; colors adapt to each artwork via `--art-accent/--art-dark/--art-light`, set by the JS from `art/parks/manifest.js`; dusk scenes preferred at night). The JS is theme-agnostic; a new theme is a new `theme-<name>.css` plus its name in the allowlist in `index.html`. An art pack is a folder `art/<pack>/` of 1920×1080 JPEGs plus a `manifest.js` (`window.ART_PACKS.<pack> = [{file, park, state, dominant, dark, light, accent}]`, loaded by a script tag because XHR to JSON fails from `file://`); palettes are extracted at build time with PIL (quantize to 8, pick darkest / lightest / most saturated). The parks pack came from the user's Drive folder "Flat Art Wallpaper / National Parks" (71 images). Backdrop (ink): photos from :8090 or a drifting aurora. Modes from `config.js`: day / night (ember palette, fewer panels) / sleep (black + small clock). Pixel-shift every 90 s. Dash Server opens it after `idleMinutes`, Yellow key, or the Ambient quick action; any key returns. Standalone (`?standalone`, for Fire TV/browser): keys do nothing. `?demo=1` shows preview data, `?t=HH:MM` fakes the time. Self-contained: copy the folder to any platform with a browser.
- **Nav bar** (parks theme): a strip docked between the left frame rule, the sidebar and the band; items come from `ambient/config.js` → `nav` (`label`, `icon` = `n-*` symbol in `index.html`, `action`: `app:<tizen id>` launches an app, `view:home|library|dashboard` opens Dash Server at that view via URL hash, `theme` cycles themes, `mode` cycles the day/night override, `lights` jumps to the bay, `rescan`, `art`, `speed`). Remote regions: the nav bar and the lights bay; Up/Down hop between them, Left/Right move, OK activates, Return clears the highlight (then leaves). Hidden in ink/poster.
- **Lights** (ambient panel, replaces "The House"): the core service exposes `GET /api/lights` and `PUT /api/lights/<id> {on, brightness, color}` with providers `mock` (default; six sample lights, state in `state.json`) and `govee` (official API v1: device list cached 10 min, state polled every 60 s, commands queued ≥350 ms apart). Provider/key live in `tv/serverapp/service/lights.js` (gitignored) via `GOVEE_API_KEY=... node tv/tools/set-lights.js` (`--mock` to revert); never paste the key in chat. Presentation in `ambient/config.js` → `lights`: per-device icon (18-icon library `l-*` in `index.html`), groups (name → members), order, step. Tiles are rocker switches whose well fills from the bottom to the brightness % in the light's color. Remote: Left/Right focus (ring appears on first press, fades after 9 s), OK = toggle, hold OK ≈0.5 s = brightness mode, Up/Down = ±step, Back = done → disarm → leave. Group tiles aggregate members (on if any on, mean brightness) and fan commands out with a 400 ms debounce.
- `tv/tools/set-password.js` – writes `tv/<app>/service/auth.js` (gitignored); `DASH_PASSWORD=... node tv/tools/set-password.js --app homeapp|torrentapp|serverapp`, never the prompt
- `tv/deploy.py` – `--app homeapp|torrentapp|serverapp`: build (npm), package, `sdb connect`, install, run

## iPhone companion (`ios/`)
SwiftUI app "Dash Remote" (iOS 16+, no dependencies): finds the TV (LAN scan of :8001), pairs and sends keys/text over Samsung's remote WebSocket (`:8002`, self-signed cert trusted in the session delegate), launches apps, Wake-on-LAN, a Setup checklist, and a WKWebView tab for the TV-hosted pages (:8090/:8091/:8092), which is how most new features reach the phone without re-sideloading. Built by `.github/workflows/ios.yml` on a macOS runner with XcodeGen (`ios/project.yml`; the `.xcodeproj` is generated, not committed) into an **unsigned** `DashRemote-unsigned.ipa` artifact (push to `ios/**`, or tag `ios-v*` for a Release). The user signs and sideloads it themselves. Nothing here can be compiled locally: after changing Swift, push and read the Actions log (`mcp__github__get_job_logs`), fix, repeat.

## Remote (Samsung BN59-01315A layout)
Shared map `tv/common/remote.js` (copied into each app as `js/remote.js` / `ambient/remote.js` by `tv/tools/sync-common.js`, which `deploy.py` runs). Buttons the TV keeps: Power, Source, Vol, Mute, Home, Settings, Netflix / Prime Video / Hulu (TV launches them). Deliverable and registered: 0-9, -, PRE-CH, CH ±, CH LIST, Guide, Info, CC/VD, Exit, A/B/C/D, transport keys. When guiding the user, name buttons as printed on this remote (A=red, B=green, C=yellow, D=blue; OK = the centre button; "Return" not "Back").
| Button | Home screen | Dash Server | Player (Dash Server) | Torrents | Ambient |
|---|---|---|---|---|---|
| 1-9 | launch dock app N | 1 Home · 2 Library · 3 Dashboard | – | – | 1 Ink · 2 Poster · 3 Parks (saved) |
| 0 | screensaver | ambient screen | – | – | theme back to config |
| CH ± / PRE-CH | next photo | page (3 items) | next / previous episode | page (5 items) | next scene / photo |
| CH LIST | – | Library → Everything | – | – | – |
| Guide | open Dash Server | Library | – | open Dash Server | show calendar panel |
| Info | photos only (toggle overlay) | details toast | show OSD | details toast | art only (toggle) |
| CC/VD | – | – | subtitles on/off | – | – |
| A red | dim toggle | – | – | – | mode: auto → night → day |
| B green | next photo | – | subtitles | – | next scene |
| C yellow | screensaver | ambient | – | – | – |
| D blue | reload photos | rescan / logs | – | – | reload data |
| ▶ ⏸ ■ ◀◀ ▶▶ \|◀◀ ▶▶\| | – | – | play/pause, stop, ±60 s, next/prev | same | sent to the Dash Server player via `/api/remote` |
| Return | hide app | back / hide | stop | back / hide | lights: leave adjust → disarm → Dash Server |
| Exit | hide app | hide app | stop | stop / hide | Dash Server |
| Arrows + OK | dock | spatial focus | seek ±10 s / pause | list | lights bay (hold OK = brightness) |
`tv.py key` accepts the same names as `KEY_*` (`KEY_INFO`, `KEY_GUIDE`, `KEY_CH_LIST`, `KEY_PRECH`, `KEY_CHUP`, `KEY_CAPTION`, `KEY_RED` …); the recorder has single-letter shortcuts for them.

## Rules
1. **Look before acting.** After every key press or macro step, Read `tv/camera/frames/latest.jpg` and confirm the screen matches what you expect. If it doesn't (wrong page, popup, a movie opened), press `KEY_RETURN` and re-orient before continuing. Never chain blind key sequences longer than ~5 keys while exploring.
2. **Log before change.** Before changing any setting: `tv.py snap <id>`, then `tv.py log-setting --id ... --path ... --original ... --new ... --undo undo-<id>`. Build the undo macro with `tv.py save-macro undo-<id> HOME ... --replace` (or by navigating with `tv.py key ... --record undo-<id>`), and test it once.
3. **Irreversible = ask first.** Resetting the PSID/advertising ID, factory reset, Samsung account changes, firmware updates: stop and get explicit user approval. Log them with `--irreversible`.
4. **Never** sign in/out of the Samsung account, accept new terms, or enable any data-sharing option on the user's behalf.
5. Research claims (menu paths, API behavior, DNS hosts to block) go through the `tv-researcher` agent and are verified by `fact-checker` before acting on them. Menu paths differ by model year; trust the camera over research.
6. Run the `security-reviewer` agent on `tv/*/service/service.js` before every deploy that changes them.
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
11. **Torrent app:** `DASH_PASSWORD=... node tv/tools/set-password.js --app torrentapp`, security review, `python tv/deploy.py --app torrentapp`. Then verify on the TV, in order: engine starts (TV app header shows no "Engine error", phone page loads at `http://<tv-ip>:8091`); a small legal test torrent (e.g. a Linux ISO or Blender open movie) finds peers; playback of MP4 and MKV via AVPlay including seeking; plug in a USB drive, confirm the header lists it as writable, download to it, then check the files under Source → USB on the TV. If the USB shows "read-only", the sandbox blocks writes there: report it, don't work around it.
12. **Dash Server:** first edit `tv/serverapp/ambient/config.js` (location, units, night/sleep windows, greeting, optional calendar URL). `DASH_PASSWORD=... node tv/tools/set-password.js --app serverapp`, security review, `python tv/deploy.py --app serverapp`. Verify on the TV: the ambient screen (Yellow) shows weather, photos backdrop and the fonts (Google Fonts need internet; the serif falls back to Georgia offline), and returns on any key; Home cards show the real model/firmware (productinfo privilege) and the USB drive; Library lists files from the USB drive (if empty, check the storage hints: Blue to rescan); play an MP4 and an MKV with a sidecar .srt, confirm resume after Back; phone page at `http://<tv-ip>:8092` shows now-playing and pause/seek work; Dashboard shows Photos/Torrents UP with logs; internet speed test completes. Install order: Dash Server before the home screen update so the Dash Server tile and `backgroundServices` entry resolve.
13. **Finish:** set Settings > General > Smart Features > Autorun Last App as needed so the home app comes back after power-on; Developer Mode off; restart TV; confirm via camera.

## Testing without a TV
- `DASH_PHOTO_DIR=<tmp dir> node tv/homeapp/service/service.js` then open `http://localhost:8090`
- `cd tv/torrentapp && npm ci --omit=optional && npm run build`, then `DASH_TORRENT_DIR=<tmp> DASH_USB_ROOTS=<tmp usb dir> node service/service.js`; open `index.html` (TV UI) and `http://localhost:8091` (phone page)
- `DASH_SERVER_DIR=<tmp> DASH_USB_ROOTS=<dir with video files> node tv/serverapp/service/service.js`; open `tv/serverapp/index.html` (TV UI, HTML5 video fallback) and `http://localhost:8092` (phone page)
- Open `tv/homeapp/index.html` in a browser at 1920×1080 (Tizen APIs are stubbed out when absent)
- Ambient screen without any service: open `tv/serverapp/ambient/index.html?demo=1&standalone` (add `&t=22:40` for night, `&t=02:15` for sleep, `&theme=poster` or `&theme=parks` for the other themes)
