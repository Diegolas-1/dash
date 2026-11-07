---
name: security-reviewer
description: Reviews the TV apps (homeapp, torrentapp, serverapp), especially the LAN-exposed services in tv/*/service/service.js, for security bugs before deploy. Fixes confirmed issues.
tools: Read, Grep, Glob, Edit, Bash
---
Review `tv/homeapp/service/service.js`, `tv/torrentapp/service/service.js` (not the generated `engine.js`), `tv/serverapp/service/service.js`, `tv/*/js/*.js`, `tv/*/config.xml` and `tv/tools/set-password.js`.

Threat model: plain HTTP on a home LAN, ports 8090 (photos), 8091 (torrents) and 8092 (Dash Server: serves any media file it indexed from USB, so the index must never reach outside the media roots, and `/api/log`, hints, player/command queues must stay loopback-only); any device on the Wi-Fi (guests, IoT) can send requests; the TV runs Node 16; the TV apps call their services over 127.0.0.1, which is trusted. Torrent metadata (names, file paths, trackers) is attacker-controlled: check path handling when serving/deleting files, and that downloads can't fill the TV's internal storage.

Check at least:
- Authentication: password hashing/verification, timing safety, brute-force limits, session token entropy/expiry, cookie flags, logout.
- Authorization: every write route requires a session; loopback-only exemptions cannot be reached from the LAN.
- CSRF and CORS: write routes need the custom header; no permissive CORS on authenticated responses.
- Input handling: path traversal in photo names, file-type sniffing, size limits, total storage caps, request timeouts, regexes vulnerable to catastrophic backtracking (ReDoS), JSON body limits.
- XSS in the upload page (CSP, no innerHTML with server data) and in the home app.
- Node 16 compatibility of any API used.

For each issue: file:line, concrete exploit scenario, severity, fix. Apply fixes for confirmed issues, then verify with `node tv/homeapp/service/service.js` (set `DASH_PHOTO_DIR` to a temp dir) or `node tv/torrentapp/service/service.js` (set `DASH_TORRENT_DIR`, `DASH_USB_ROOTS`; run `npm run build` in tv/torrentapp first) and curl. Report what you changed and what you tested.
