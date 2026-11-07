'use strict';
/*
 * Dash Server core: media library + dashboard for the TV-as-server setup.
 * Runs as the Tizen service (Node 16 on the TV) or locally: `node service.js`
 * (DASH_SERVER_DIR, DASH_USB_ROOTS, DASH_MEDIA_ROOTS for testing).
 *
 * Loopback callers (the TV app) are trusted; LAN callers need a session (+ X-Dash header for writes).
 *
 *   GET  /                                 phone UI
 *   POST /api/login | /api/logout, GET /api/session
 *   GET  /api/library[?rescan=1]           items grouped into movies / shows / music
 *   GET  /media/<id>                       Range-capable stream       GET /media/<id>/sub/<n>  subtitle text
 *   GET  /media/<id>/poster                sidecar poster image
 *   PUT  /api/progress/<id> {pos,dur}      resume positions           DELETE /api/progress/<id>
 *   GET  /api/player                       what the TV is playing     PUT /api/player (loopback: TV reports)
 *   POST /api/remote {cmd, id?, seconds?}  phone -> TV commands       GET /api/remote?after=<n> (loopback: TV polls)
 *   GET  /api/dashboard                    services, storage, system, speed results, logs
 *   POST /api/services/<id>/start          queues a launch command for the TV app
 *   POST /api/speedtest                    internet download/upload test (Cloudflare)
 *   GET  /speedtest/down?bytes=N           LAN throughput test payload
 *   POST /api/system-hints (loopback)      TV app sends model/firmware/uptime/cpu
 *   POST /api/storage-hints (loopback)     TV app sends mounted USB paths
 */
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var childProcess = require('child_process');

var PORT = Number(process.env.DASH_SERVER_PORT) || 8092;
var PKG_ID = 'DashSrv01';
var SESSION_TTL = 12 * 3600 * 1000;
var MAX_SESSIONS = 50;
var COOKIE = 'ssid';
var ID_RE = /^[0-9a-f]{16}$/;
var SCAN_INTERVAL = 10 * 60 * 1000;
var MAX_ITEMS = 5000;
var MAX_DEPTH = 6;
var VIDEO_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg', vob: 'video/mpeg' };
var AUDIO_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/ogg' };
var SUB_EXT = { srt: 'text/plain; charset=utf-8', vtt: 'text/vtt; charset=utf-8' };
var IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
var POSTER_NAMES = ['poster', 'folder', 'cover', 'thumb'];
var SKIP_DIRS = /^(\.|\$|system volume information|lost\+found|node_modules|torrents\/\.)/i;

var SERVICES = [
  { id: 'core', name: 'Dash Server', appId: PKG_ID + '.core', port: PORT, desc: 'Library, dashboard, phone remote' },
  { id: 'photos', name: 'Photos', appId: 'DashHome01.photos', port: 8090, desc: 'Home screen photo uploads' },
  { id: 'torrents', name: 'Torrents', appId: 'DashTorr01.engine', port: 8091, desc: 'Torrent engine and streaming' }
];

var auth = null;
try { auth = require('./auth.js'); } catch (e) { auth = null; }

// ---------------------------------------------------------------- ring log
var LOG_MAX = 300;
var logLines = [];
function logLine(level, args) {
  var text = Array.prototype.map.call(args, function (a) { return a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
  logLines.push({ t: Date.now(), l: level, m: text.slice(0, 500) });
  if (logLines.length > LOG_MAX) logLines.shift();
}
var _log = console.log, _err = console.error;
console.log = function () { logLine('info', arguments); _log.apply(console, arguments); };
console.error = function () { logLine('error', arguments); _err.apply(console, arguments); };

var server = null;
var dataDir, stateFile;
var db = { progress: {}, speed: [] };
var library = { at: 0, items: [], roots: [], scanning: false };
var sessions = new Map();
var failures = new Map();
var storageHints = [];
var systemHints = {};
var player = { state: 'idle', id: null, title: '', pos: 0, dur: 0, at: 0 };
var remoteQueue = [];      // {n, cmd, id, seconds, at}
var remoteSeq = 0;
var commandQueue = [];     // dashboard -> TV app
var commandSeq = 0;
var startedAt = Date.now();

// ---------------------------------------------------------------- persistence

function pickDataDir() {
  var candidates = [process.env.DASH_SERVER_DIR, '/opt/usr/home/owner/apps_rw/' + PKG_ID + '/data',
    path.join(os.homedir() || os.tmpdir(), 'dash-server'), path.join(os.tmpdir(), 'dash-server')];
  for (var i = 0; i < candidates.length; i++) if (candidates[i] && probeWritable(candidates[i], true)) return candidates[i];
  throw new Error('no writable data directory');
}

function probeWritable(dir, create) {
  try {
    if (create) fs.mkdirSync(dir, { recursive: true });
    var probe = path.join(dir, '.dash-probe-' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (e) { return false; }
}

var saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(db)); fs.renameSync(stateFile + '.tmp', stateFile); }
    catch (e) { console.error('save failed', e.message); }
  }, 300);
}

// ---------------------------------------------------------------- storage

function freeBytes(dir) {
  try { if (fs.statfsSync) { var s = fs.statfsSync(dir); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } } catch (e) { /* fall through */ }
  try {
    var out = childProcess.execFileSync('df', ['-kP', dir], { timeout: 2000, encoding: 'utf8' }).trim().split('\n');
    var cols = out[out.length - 1].split(/\s+/);
    return { free: parseInt(cols[3], 10) * 1024, total: parseInt(cols[1], 10) * 1024 };
  } catch (e) { return { free: null, total: null }; }
}

function usbRoots() {
  var roots = [];
  function add(p) { if (p && roots.indexOf(p) < 0 && fs.existsSync(p)) roots.push(p); }
  (process.env.DASH_USB_ROOTS || '').split(path.delimiter).forEach(add);
  storageHints.forEach(add);
  ['/opt/media'].forEach(function (base) {   // Samsung TVs mount USB drives here
    try {
      fs.readdirSync(base).forEach(function (n) {
        var p = path.join(base, n);
        try { if (fs.statSync(p).isDirectory()) add(p); } catch (e) { /* skip */ }
      });
    } catch (e) { /* no such base */ }
  });
  return roots;
}

function mediaRoots() {
  var roots = usbRoots().slice();
  (process.env.DASH_MEDIA_ROOTS || '').split(path.delimiter).forEach(function (p) { if (p && roots.indexOf(p) < 0 && fs.existsSync(p)) roots.push(p); });
  var torrentDl = path.join(path.dirname(dataDir), 'DashTorr01', 'data', 'downloads');   // sibling app data, if readable
  if (fs.existsSync(torrentDl)) roots.push(torrentDl);
  return roots;
}

function storageList() {
  var list = [];
  var internal = freeBytes(dataDir);
  list.push({ id: 'internal', label: 'TV storage', kind: 'internal', free: internal.free, total: internal.total, writable: true });
  usbRoots().forEach(function (root) {
    var f = freeBytes(root);
    list.push({ id: 'usb-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 8), label: path.basename(root), kind: 'usb',
      path: root, free: f.free, total: f.total, writable: probeWritable(root, false) });
  });
  return list;
}

// ---------------------------------------------------------------- library

function idFor(p) { return crypto.createHash('sha1').update(p).digest('hex').slice(0, 16); }

function cleanTitle(s) {
  return s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/\s*[-–]\s*$/, '').trim();
}

function parseName(base, dir) {
  var name = base.replace(/\.[^.]+$/, '');
  var out = { title: cleanTitle(name), year: null, show: null, season: null, episode: null, epTitle: null };
  var m = /^(.*?)[. _-]*[Ss](\d{1,2})[. _-]*[Ee](\d{1,3})(?:[. _-]*[Ee]\d{1,3})?[. _-]*(.*)$/.exec(name) ||
    /^(.*?)[. _-]+(\d{1,2})x(\d{2,3})[. _-]*(.*)$/.exec(name);
  if (m) {
    out.show = cleanTitle(m[1]) || cleanTitle(/season/i.test(path.basename(dir)) ? path.basename(path.dirname(dir)) : path.basename(dir));
    out.season = parseInt(m[2], 10);
    out.episode = parseInt(m[3], 10);
    out.epTitle = cleanTitle(m[4].replace(/\b(480p|720p|1080p|2160p|4k|x264|x265|h264|h265|hevc|web|bluray|dvdrip|hdtv|aac|ac3)\b.*$/i, ''));
    out.title = 'S' + pad2(out.season) + 'E' + pad2(out.episode) + (out.epTitle ? ' ' + out.epTitle : '');
    return out;
  }
  var sm = /season[ ._-]*(\d{1,2})/i.exec(path.basename(dir));
  if (sm) {
    out.show = cleanTitle(path.basename(path.dirname(dir)));
    out.season = parseInt(sm[1], 10);
    var em = /(?:^|\D)(\d{1,3})(?:\D|$)/.exec(name);
    out.episode = em ? parseInt(em[1], 10) : null;
    return out;
  }
  var ym = /^(.*?)[ ._(\[]*((?:19|20)\d{2})[ ._)\]]*(?:$|[ ._-]+(?:480p|720p|1080p|2160p|4k|x264|x265|h264|h265|hevc|web-?dl|web|bluray|dvdrip|hdtv|remux|proper|repack)\b.*)$/i.exec(name);
  if (ym && cleanTitle(ym[1])) { out.title = cleanTitle(ym[1]); out.year = parseInt(ym[2], 10); }
  else out.title = cleanTitle(name.replace(/\b(480p|720p|1080p|2160p|4k|x264|x265|h264|h265|hevc|web-?dl|bluray|dvdrip|hdtv)\b.*$/i, '')) || out.title;
  return out;
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function findSidecars(dir, stem, entries) {
  var subs = [], poster = null;
  var lowerStem = stem.toLowerCase();
  entries.forEach(function (e) {
    var ext = e.split('.').pop().toLowerCase();
    var ename = e.toLowerCase();
    if (SUB_EXT[ext] && ename.indexOf(lowerStem) === 0) subs.push({ name: e, lang: e.slice(stem.length + 1).replace(/\.(srt|vtt)$/i, '') || 'default', path: path.join(dir, e) });
    if (IMAGE_EXT[ext]) {
      var imgStem = ename.replace(/\.[^.]+$/, '');
      if (imgStem === lowerStem || imgStem === lowerStem + '-poster') poster = path.join(dir, e);
    }
  });
  return { subs: subs.slice(0, 8), poster: poster };
}

function folderPoster(dir, entries) {
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i], ext = e.split('.').pop().toLowerCase();
    if (IMAGE_EXT[ext] && POSTER_NAMES.indexOf(e.replace(/\.[^.]+$/, '').toLowerCase()) >= 0) return path.join(dir, e);
  }
  return null;
}

function scanLibrary() {
  if (library.scanning) return;
  library.scanning = true;
  var roots = mediaRoots(), items = [], posters = {};
  var t0 = Date.now();
  function walk(dir, depth, root) {
    if (depth > MAX_DEPTH || items.length >= MAX_ITEMS) return;
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    var fp = folderPoster(dir, entries);
    if (fp) posters[dir] = fp;
    entries.forEach(function (name) {
      if (items.length >= MAX_ITEMS || SKIP_DIRS.test(name)) return;
      var full = path.join(dir, name), st;
      try { st = fs.statSync(full); } catch (e) { return; }
      if (st.isDirectory()) return walk(full, depth + 1, root);
      var ext = name.split('.').pop().toLowerCase();
      var kind = VIDEO_EXT[ext] ? 'video' : AUDIO_EXT[ext] ? 'audio' : null;
      if (!kind || st.size < (kind === 'audio' ? 16 : 64) * 1024) return;
      var stem = name.replace(/\.[^.]+$/, '');
      var side = findSidecars(dir, stem, entries);
      var meta = parseName(name, dir);
      items.push({
        id: idFor(full), path: full, name: name, dir: dir, root: root, kind: kind, size: st.size, mtime: st.mtimeMs,
        mime: VIDEO_EXT[ext] || AUDIO_EXT[ext], title: meta.title, year: meta.year, show: meta.show, season: meta.season,
        episode: meta.episode, album: kind === 'audio' ? cleanTitle(path.basename(dir)) : null,
        subs: side.subs, poster: side.poster || posters[dir] || posters[path.dirname(dir)] || null
      });
    });
  }
  roots.forEach(function (r) { walk(r, 0, r); });
  library = { at: Date.now(), items: items, roots: roots, scanning: false, ms: Date.now() - t0 };
  console.log('library scan: ' + items.length + ' items in ' + roots.length + ' roots (' + library.ms + ' ms)');
}

function itemOf(id) {
  for (var i = 0; i < library.items.length; i++) if (library.items[i].id === id) return library.items[i];
  return null;
}

function publicItem(it) {
  var pr = db.progress[it.id];
  return {
    id: it.id, title: it.title, name: it.name, kind: it.kind, size: it.size, year: it.year, show: it.show, season: it.season,
    episode: it.episode, album: it.album, folder: path.basename(it.dir), source: path.basename(it.root), mime: it.mime,
    poster: it.poster ? '/media/' + it.id + '/poster' : null,
    subs: it.subs.map(function (s, i) { return { index: i, lang: s.lang, url: '/media/' + it.id + '/sub/' + i }; }),
    progress: pr ? { pos: pr.pos, dur: pr.dur, at: pr.at, done: pr.dur > 0 && pr.pos / pr.dur > 0.92 } : null
  };
}

function libraryBody() {
  var items = library.items.map(publicItem);
  var movies = [], shows = {}, music = {};
  items.forEach(function (it) {
    if (it.kind === 'audio') { (music[it.album || 'Music'] = music[it.album || 'Music'] || []).push(it); return; }
    if (it.show) {
      var sh = shows[it.show] = shows[it.show] || { title: it.show, poster: null, seasons: {}, count: 0 };
      sh.poster = sh.poster || it.poster;
      (sh.seasons[it.season || 0] = sh.seasons[it.season || 0] || []).push(it);
      sh.count++;
      return;
    }
    movies.push(it);
  });
  movies.sort(function (a, b) { return a.title.localeCompare(b.title); });
  var showList = Object.keys(shows).sort().map(function (k) {
    var sh = shows[k];
    sh.seasons = Object.keys(sh.seasons).sort(function (a, b) { return a - b; }).map(function (s) {
      return { season: Number(s), episodes: sh.seasons[s].sort(function (a, b) { return (a.episode || 0) - (b.episode || 0) || a.name.localeCompare(b.name); }) };
    });
    return sh;
  });
  var musicList = Object.keys(music).sort().map(function (k) {
    return { album: k, poster: music[k][0].poster, tracks: music[k].sort(function (a, b) { return a.name.localeCompare(b.name); }) };
  });
  var recent = items.filter(function (it) { return it.progress && !it.progress.done; })
    .sort(function (a, b) { return b.progress.at - a.progress.at; }).slice(0, 12);
  return { at: library.at, scanning: library.scanning, roots: library.roots.map(function (r) { return path.basename(r); }),
    counts: { items: items.length, movies: movies.length, shows: showList.length, albums: musicList.length },
    continueWatching: recent, movies: movies, shows: showList, music: musicList };
}

// ---------------------------------------------------------------- dashboard

function probeService(svc, cb) {
  if (svc.port === PORT) return cb({ up: true, latency: 0 });
  var t0 = Date.now(), done = false;
  var req = http.get({ host: '127.0.0.1', port: svc.port, path: '/api/session', timeout: 1500 }, function (res) {
    res.resume();
    if (!done) { done = true; cb({ up: res.statusCode < 500, latency: Date.now() - t0 }); }
  });
  req.on('timeout', function () { req.destroy(); });
  req.on('error', function () { if (!done) { done = true; cb({ up: false, latency: null }); } });
}

function fetchLog(svc, cb) {
  if (svc.port === PORT) return cb(logLines.slice(-80));
  var req = http.get({ host: '127.0.0.1', port: svc.port, path: '/api/log', timeout: 1500 }, function (res) {
    var body = '';
    res.on('data', function (c) { if (body.length < 200000) body += c; });
    res.on('end', function () { try { cb((JSON.parse(body).lines || []).slice(-80)); } catch (e) { cb([]); } });
  });
  req.on('timeout', function () { req.destroy(); });
  req.on('error', function () { cb([]); });
}

function dashboardBody(withLogs, cb) {
  var out = {
    ip: lanIp(), port: PORT, configured: !!auth,
    system: Object.assign({
      hostname: os.hostname(), arch: os.arch(), node: process.version, platform: os.platform(),
      uptime: os.uptime(), serviceUptime: Math.round((Date.now() - startedAt) / 1000),
      memTotal: os.totalmem(), memFree: os.freemem(), load: os.loadavg(), cpus: os.cpus().length
    }, systemHints),
    storage: storageList(), library: { items: library.items.length, at: library.at, roots: library.roots.length },
    speed: db.speed.slice(-20), player: player, pendingCommands: commandQueue.length, services: []
  };
  var pending = SERVICES.length;
  SERVICES.forEach(function (svc) {
    probeService(svc, function (health) {
      var row = { id: svc.id, name: svc.name, appId: svc.appId, port: svc.port, desc: svc.desc, up: health.up, latency: health.latency };
      function finish() { out.services.push(row); if (--pending === 0) { out.services.sort(function (a, b) { return a.port - b.port; }); cb(out); } }
      if (withLogs && health.up) fetchLog(svc, function (lines) { row.log = lines; finish(); });
      else finish();
    });
  });
}

var speedRunning = false;
function runSpeedTest(cb) {
  if (speedRunning) return cb(new Error('a test is already running'));
  speedRunning = true;
  var DOWN_BYTES = 25 * 1000 * 1000, UP_BYTES = 5 * 1000 * 1000;
  var result = { at: Date.now(), downMbps: null, upMbps: null, pingMs: null, error: null };
  function finish(err) {
    speedRunning = false;
    if (err) result.error = err.message;
    db.speed.push(result);
    if (db.speed.length > 50) db.speed.shift();
    save();
    cb(null, result);
  }
  var t0 = Date.now();
  var req = https.get('https://speed.cloudflare.com/__down?bytes=' + DOWN_BYTES, { timeout: 15000 }, function (res) {
    var first = null, got = 0;
    res.on('data', function (c) { if (first === null) { first = Date.now(); result.pingMs = first - t0; } got += c.length; });
    res.on('end', function () {
      var secs = (Date.now() - first) / 1000;
      result.downMbps = secs > 0 ? Math.round(got * 8 / secs / 1e6 * 10) / 10 : null;
      var payload = crypto.randomBytes(UP_BYTES), t1 = Date.now();
      var up = https.request({ host: 'speed.cloudflare.com', path: '/__up', method: 'POST', timeout: 20000,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': UP_BYTES } }, function (r2) {
        r2.resume();
        r2.on('end', function () {
          var s2 = (Date.now() - t1) / 1000;
          result.upMbps = s2 > 0 ? Math.round(UP_BYTES * 8 / s2 / 1e6 * 10) / 10 : null;
          finish();
        });
      });
      up.on('timeout', function () { up.destroy(new Error('upload timed out')); });
      up.on('error', function (e) { finish(e); });
      up.end(payload);
    });
    res.on('error', function (e) { finish(e); });
  });
  req.on('timeout', function () { req.destroy(new Error('download timed out')); });
  req.on('error', function (e) { finish(e); });
}

// ---------------------------------------------------------------- auth / http helpers

function verifyPassword(pw) {
  if (!auth || typeof pw !== 'string' || pw.length > 256) return false;
  var key = crypto.scryptSync(pw, Buffer.from(auth.salt, 'hex'), 32, { N: auth.N, r: auth.r, p: auth.p });
  var expect = Buffer.from(auth.hash, 'hex');
  return key.length === expect.length && crypto.timingSafeEqual(key, expect);
}
function parseCookies(header) {
  var out = {};
  (header || '').split(';').forEach(function (part) { var i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); });
  return out;
}
function sessionOf(req) {
  var sid = parseCookies(req.headers.cookie)[COOKIE];
  var exp = sid && sessions.get(sid);
  if (!exp) return null;
  if (exp < Date.now()) { sessions.delete(sid); return null; }
  return sid;
}
function isLoopback(req) { var a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function canRead(req) { return isLoopback(req) || !!sessionOf(req); }
function canWrite(req) { return isLoopback(req) || (!!sessionOf(req) && req.headers['x-dash'] === '1'); }
function lockedFor(ip) { var f = failures.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
function recordFailure(ip) {
  var f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) f.until = Date.now() + Math.min(3600, 30 * Math.pow(2, f.count - 5)) * 1000;
  failures.set(ip, f);
  if (failures.size > 1000) failures.clear();
}

var SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
function send(req, res, code, body, type, extra) {
  var headers = Object.assign({ 'Cache-Control': 'no-store' }, SEC_HEADERS, extra || {});
  if (isLoopback(req)) headers['Access-Control-Allow-Origin'] = '*';
  if (body !== undefined && body !== null) {
    if (!Buffer.isBuffer(body)) body = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    headers['Content-Type'] = type || 'application/json';
    headers['Content-Length'] = body.length;
  }
  res.writeHead(code, headers);
  res.end(body || undefined);
}
function readJson(req, limit, cb) {
  var chunks = [], size = 0, done = false;
  req.on('data', function (c) { if (done) return; size += c.length; if (size > limit) { done = true; cb(new Error('too large')); req.destroy(); return; } chunks.push(c); });
  req.on('end', function () { if (done) return; done = true; try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(e); } });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}
function query(url) {
  var out = {}, i = url.indexOf('?');
  if (i < 0) return out;
  url.slice(i + 1).split('&').forEach(function (kv) {
    var j = kv.indexOf('=');
    try { if (j > 0) out[decodeURIComponent(kv.slice(0, j))] = decodeURIComponent(kv.slice(j + 1)); else if (kv) out[decodeURIComponent(kv)] = ''; } catch (e) { /* malformed */ }
  });
  return out;
}
function lanIp() {
  var ifs = os.networkInterfaces();
  for (var name in ifs) for (var i = 0; i < ifs[name].length; i++) { var a = ifs[name][i]; if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address; }
  return null;
}
function parseRange(header, size) {
  if (!header) return null;
  var m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  var start, end;
  if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
  else { start = parseInt(m[1], 10); end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
  if (start > end || start >= size) return 'invalid';
  return { start: start, end: end };
}

// ---------------------------------------------------------------- handlers

function handleLogin(req, res) {
  var ip = req.socket.remoteAddress || '?';
  var wait = lockedFor(ip);
  if (wait) return send(req, res, 429, { error: 'too many attempts', retryAfter: wait }, null, { 'Retry-After': String(wait) });
  if (!auth) return send(req, res, 503, { error: 'password not configured' });
  readJson(req, 1024, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    if (!verifyPassword(body.password)) { recordFailure(ip); return send(req, res, 401, { error: 'wrong password' }); }
    failures.delete(ip);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    var sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, Date.now() + SESSION_TTL);
    send(req, res, 200, { ok: true }, null, { 'Set-Cookie': COOKIE + '=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + (SESSION_TTL / 1000) });
  });
}

function serveFile(req, res, file, mime, size) {
  var range = parseRange(req.headers.range, size);
  if (range === 'invalid') return send(req, res, 416, null, null, { 'Content-Range': 'bytes */' + size });
  var start = range ? range.start : 0, end = range ? range.end : size - 1;
  var headers = Object.assign({}, SEC_HEADERS, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
  if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  if (isLoopback(req)) headers['Access-Control-Allow-Origin'] = '*';
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  var stream = fs.createReadStream(file, { start: start, end: end });
  stream.on('error', function () { res.destroy(); });
  res.on('close', function () { stream.destroy(); });
  stream.pipe(res);
}

function handleMedia(req, res, id, rest) {
  var it = itemOf(id);
  if (!it) return send(req, res, 404, { error: 'not found' });
  if (rest[0] === 'poster') {
    if (!it.poster) return send(req, res, 404, { error: 'no poster' });
    try { var ps = fs.statSync(it.poster); } catch (e) { return send(req, res, 404, { error: 'no poster' }); }
    return serveFile(req, res, it.poster, IMAGE_EXT[it.poster.split('.').pop().toLowerCase()] || 'image/jpeg', ps.size);
  }
  if (rest[0] === 'sub') {
    var sub = it.subs[parseInt(rest[1], 10)];
    if (!sub) return send(req, res, 404, { error: 'no subtitle' });
    try {
      var text = fs.readFileSync(sub.path);
      if (text.length > 2 * 1024 * 1024) return send(req, res, 413, { error: 'subtitle too large' });
      return send(req, res, 200, text, SUB_EXT[sub.path.split('.').pop().toLowerCase()]);
    } catch (e) { return send(req, res, 404, { error: 'no subtitle' }); }
  }
  if (rest.length) return send(req, res, 404, { error: 'not found' });
  var st;
  try { st = fs.statSync(it.path); } catch (e) { return send(req, res, 404, { error: 'file missing (drive unplugged?)' }); }
  serveFile(req, res, it.path, it.mime, st.size);
}

function handleProgress(req, res, id) {
  if (req.method === 'DELETE') { delete db.progress[id]; save(); return send(req, res, 200, { ok: true }); }
  readJson(req, 512, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    var pos = Number(body.pos), dur = Number(body.dur);
    if (!(pos >= 0) || !(dur >= 0)) return send(req, res, 400, { error: 'bad values' });
    if (pos < 10) delete db.progress[id]; else db.progress[id] = { pos: Math.round(pos), dur: Math.round(dur), at: Date.now() };
    var keys = Object.keys(db.progress);
    if (keys.length > 2000) delete db.progress[keys[0]];
    save();
    send(req, res, 200, { ok: true });
  });
}

function handleRemote(req, res) {
  if (req.method === 'GET') {
    if (!isLoopback(req)) return send(req, res, 403, { error: 'forbidden' });
    var after = Number(query(req.url).after) || 0;
    var fresh = remoteQueue.filter(function (c) { return c.n > after && Date.now() - c.at < 30000; });
    return send(req, res, 200, { commands: fresh, seq: remoteSeq });
  }
  readJson(req, 512, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    var cmd = String(body.cmd || '');
    if (['play', 'pause', 'resume', 'toggle', 'stop', 'seek', 'next', 'prev'].indexOf(cmd) < 0) return send(req, res, 400, { error: 'unknown command' });
    var c = { n: ++remoteSeq, cmd: cmd, at: Date.now() };
    if (cmd === 'play') { if (!ID_RE.test(String(body.id)) || !itemOf(body.id)) return send(req, res, 400, { error: 'bad item' }); c.id = body.id; }
    if (cmd === 'seek') c.seconds = Math.max(-600, Math.min(600, Number(body.seconds) || 0));
    remoteQueue.push(c);
    if (remoteQueue.length > 20) remoteQueue.shift();
    send(req, res, 200, { ok: true, n: c.n, tvOnline: Date.now() - player.at < 15000 });
  });
}

function handlePlayer(req, res) {
  if (req.method === 'GET') return send(req, res, 200, Object.assign({ online: Date.now() - player.at < 15000 }, player));
  if (!isLoopback(req)) return send(req, res, 403, { error: 'forbidden' });
  readJson(req, 1024, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    player = { state: String(body.state || 'idle').slice(0, 16), id: ID_RE.test(String(body.id)) ? body.id : null,
      title: String(body.title || '').slice(0, 200), pos: Number(body.pos) || 0, dur: Number(body.dur) || 0, at: Date.now() };
    send(req, res, 200, { ok: true });
  });
}

function handleServiceStart(req, res, id) {
  var svc = null;
  SERVICES.forEach(function (s) { if (s.id === id) svc = s; });
  if (!svc) return send(req, res, 404, { error: 'unknown service' });
  commandQueue.push({ n: ++commandSeq, type: 'launchService', appId: svc.appId, at: Date.now() });
  if (commandQueue.length > 20) commandQueue.shift();
  send(req, res, 200, { ok: true, note: Date.now() - player.at < 15000 ? 'TV app will start it' : 'Open Dash Server on the TV to apply' });
}

function handleHints(req, res, kind) {
  if (!isLoopback(req)) return send(req, res, 403, { error: 'forbidden' });
  readJson(req, 8192, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    if (kind === 'storage') {
      if (!Array.isArray(body.paths)) return send(req, res, 400, { error: 'bad request' });
      var before = storageHints.join('|');
      storageHints = body.paths.filter(function (p) { return typeof p === 'string' && p.length < 512 && path.isAbsolute(p) && p.indexOf('..') < 0; }).slice(0, 8);
      if (storageHints.join('|') !== before) setTimeout(scanLibrary, 100);
    } else {
      var allowed = ['model', 'realModel', 'firmware', 'duid', 'tvUptime', 'cpuLoad', 'resolution', 'ipWifi', 'ssid', 'tizen', 'appVersion'];
      allowed.forEach(function (k) { if (body[k] !== undefined) systemHints[k] = typeof body[k] === 'number' ? body[k] : String(body[k]).slice(0, 120); });
      systemHints.at = Date.now();
    }
    send(req, res, 200, { ok: true });
  });
}

function handleSpeedPayload(req, res) {
  var bytes = Math.min(100 * 1000 * 1000, Math.max(1000, Number(query(req.url).bytes) || 10 * 1000 * 1000));
  var headers = Object.assign({}, SEC_HEADERS, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes, 'Cache-Control': 'no-store' });
  if (isLoopback(req)) headers['Access-Control-Allow-Origin'] = '*';
  res.writeHead(200, headers);
  var chunk = crypto.randomBytes(64 * 1024), left = bytes;
  (function pump() {
    while (left > 0) {
      var c = left >= chunk.length ? chunk : chunk.slice(0, left);
      left -= c.length;
      if (!res.write(c)) return res.once('drain', pump);
    }
    res.end();
  })();
}

function route(req, res) {
  var url = (req.url || '/').split('?')[0];
  var m = req.method;
  var parts = url.split('/');
  try {
    if (m === 'OPTIONS' && isLoopback(req)) {
      return send(req, res, 204, null, null, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, X-Dash' });
    }
    if (m === 'GET' && url === '/') {
      var nonce = crypto.randomBytes(16).toString('base64');
      return send(req, res, 200, PHONE_HTML.replace(/__NONCE__/g, nonce), 'text/html; charset=utf-8', {
        'Content-Security-Policy': "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce +
          "'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" });
    }
    if (m === 'POST' && url === '/api/login') return handleLogin(req, res);
    if (m === 'POST' && url === '/api/logout') {
      var sid = sessionOf(req);
      if (sid) sessions.delete(sid);
      return send(req, res, 200, { ok: true }, null, { 'Set-Cookie': COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (m === 'GET' && url === '/api/session') return send(req, res, 200, { loggedIn: !!sessionOf(req), configured: !!auth });
    if (m === 'GET' && url === '/api/log') { if (!isLoopback(req)) return send(req, res, 403, { error: 'forbidden' }); return send(req, res, 200, { lines: logLines }); }

    if (!canRead(req)) return send(req, res, 401, { error: 'login required' });

    if ((m === 'GET' || m === 'HEAD') && parts[1] === 'media' && ID_RE.test(parts[2] || '')) return handleMedia(req, res, parts[2], parts.slice(3));
    if (m === 'GET' && url === '/speedtest/down') return handleSpeedPayload(req, res);
    if (m === 'GET' && url === '/api/library') {
      var q = query(req.url);
      if (q.rescan === '1' || (!library.at && !library.scanning)) scanLibrary();
      return send(req, res, 200, libraryBody());
    }
    if (m === 'GET' && url === '/api/dashboard') return dashboardBody(query(req.url).logs === '1', function (body) { send(req, res, 200, body); });
    if (m === 'GET' && url === '/api/player') return handlePlayer(req, res);
    if (m === 'GET' && url === '/api/remote') return handleRemote(req, res);
    if (m === 'GET' && url === '/api/commands') {
      if (!isLoopback(req)) return send(req, res, 403, { error: 'forbidden' });
      var after = Number(query(req.url).after) || 0;
      return send(req, res, 200, { commands: commandQueue.filter(function (c) { return c.n > after && Date.now() - c.at < 120000; }), seq: commandSeq });
    }

    if (!canWrite(req)) return send(req, res, 403, { error: 'missing header' });
    if (m === 'PUT' && url === '/api/player') return handlePlayer(req, res);
    if (m === 'POST' && url === '/api/remote') return handleRemote(req, res);
    if (m === 'POST' && url === '/api/speedtest') return runSpeedTest(function (err, r) { if (err) return send(req, res, 409, { error: err.message }); send(req, res, 200, r); });
    if (m === 'POST' && url === '/api/system-hints') return handleHints(req, res, 'system');
    if (m === 'POST' && url === '/api/storage-hints') return handleHints(req, res, 'storage');
    if (m === 'POST' && url === '/api/library/rescan') { scanLibrary(); return send(req, res, 200, { ok: true, items: library.items.length }); }
    if ((m === 'PUT' || m === 'DELETE') && parts[2] === 'progress' && ID_RE.test(parts[3] || '')) return handleProgress(req, res, parts[3]);
    if (m === 'POST' && parts[2] === 'services' && parts[4] === 'start') return handleServiceStart(req, res, parts[3]);
    send(req, res, 404, { error: 'not found' });
  } catch (e) {
    console.error('route error', e.stack);
    send(req, res, 500, { error: 'server error' });
  }
}

// ---------------------------------------------------------------- lifecycle

function start() {
  if (server) return;
  dataDir = pickDataDir();
  stateFile = path.join(dataDir, 'state.json');
  try { var saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); db.progress = saved.progress || {}; db.speed = saved.speed || []; } catch (e) { /* first run */ }
  server = http.createServer(route);
  server.requestTimeout = 0;
  server.headersTimeout = 15000;
  server.on('error', function (e) { console.error('server error', e.message); server = null; });
  server.listen(PORT, '0.0.0.0', function () { console.log('Dash Server on :' + PORT + ' data=' + dataDir + (auth ? '' : ' (NO PASSWORD SET)')); });
  setTimeout(scanLibrary, 500);
  setInterval(scanLibrary, SCAN_INTERVAL).unref();
  setInterval(function () { var now = Date.now(); sessions.forEach(function (exp, sid) { if (exp < now) sessions.delete(sid); }); }, 60000).unref();
}
function stop() { if (server) { server.close(); server = null; } }

module.exports.onStart = start;
module.exports.onRequest = function () { start(); };
module.exports.onExit = stop;

// ---------------------------------------------------------------- phone UI

var PHONE_HTML = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1"><title>Dash Server</title><style nonce="__NONCE__">' +
':root{--bg:#0B0F14;--fg:#E6E6E6;--muted:#8A96A3;--card:#121821;--border:#1F2933;--accent:#1DB954;--bad:#F2545B}' +
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}' +
'main{max-width:720px;margin:0 auto}h1{font-size:20px;margin:8px 0 12px}h2{font-size:15px;margin:0 0 10px;color:var(--muted);font-weight:600}' +
'.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:14px}' +
'input[type=password],input[type=search]{width:100%;padding:12px;border-radius:10px;border:1px solid var(--border);background:#0E141B;color:var(--fg);font:inherit;font-size:16px}' +
'button{border:0;border-radius:10px;padding:10px 14px;font-weight:700;font-size:15px;background:var(--accent);color:#03230F;cursor:pointer}' +
'button.ghost{background:transparent;color:var(--fg);border:1px solid var(--border)}button.sm{padding:6px 10px;font-size:13px}button:disabled{opacity:.5}' +
'.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}.tabs{display:flex;gap:6px;margin-bottom:14px}' +
'.tabs button{flex:1;background:transparent;color:var(--muted);border:1px solid var(--border)}.tabs button.on{color:var(--accent);border-color:var(--accent)}' +
'#msg{min-height:20px;color:var(--muted);font-size:14px;margin-top:8px}#msg.bad{color:var(--bad)}' +
'.item{display:flex;gap:12px;align-items:center;border-top:1px solid var(--border);padding:10px 0}.item:first-child{border-top:0;padding-top:0}' +
'.item img,.item .ph{width:46px;height:66px;border-radius:6px;object-fit:cover;background:#0E141B;flex:0 0 auto}' +
'.item .ph{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:20px}' +
'.item .txt{flex:1;min-width:0}.name{font-weight:600;word-break:break-word}.meta{color:var(--muted);font-size:13px;margin-top:2px}' +
'.bar{height:5px;background:#0E141B;border-radius:3px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}' +
'.grp{font-weight:700;margin:14px 0 4px}.grp:first-child{margin-top:0}' +
'.now{background:#0E141B;border-radius:10px;padding:12px}.ctl{display:flex;gap:6px;margin-top:10px}.ctl button{flex:1;padding:12px 0}' +
'.svc{display:flex;justify-content:space-between;align-items:center;gap:10px;border-top:1px solid var(--border);padding:10px 0}.svc:first-child{border-top:0;padding-top:0}' +
'.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--bad);margin-right:8px;vertical-align:middle}.dot.up{background:var(--accent)}' +
'.kv{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:14px}.kv b{color:var(--muted);font-weight:500}' +
'pre{background:#0E141B;border-radius:10px;padding:10px;font-size:12px;line-height:1.4;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:8px 0 0}' +
'.err{color:var(--bad)}[hidden]{display:none!important}' +
'</style></head><body><main><h1>Dash Server</h1>' +
'<section id="login" class="card" hidden><form id="lf"><input id="pw" type="password" autocomplete="current-password" placeholder="Password" required>' +
'<div class="row"><button type="submit">Sign in</button></div></form></section>' +
'<p id="nocfg" class="card" hidden>No password is configured. Run tv/tools/set-password.js --app serverapp and redeploy.</p>' +
'<div id="app" hidden><div class="tabs"><button id="tabLib" class="on" type="button">Library</button><button id="tabDash" type="button">Dashboard</button></div>' +
'<section id="lib">' +
'<div class="card"><h2>On the TV</h2><div class="now" id="now">Nothing playing</div>' +
'<div class="ctl"><button id="rPrev" class="ghost" type="button">\u23EE</button><button id="rBack" class="ghost" type="button">\u221210s</button><button id="rToggle" type="button">\u23EF</button>' +
'<button id="rFwd" class="ghost" type="button">+10s</button><button id="rStop" class="ghost" type="button">\u23F9</button></div></div>' +
'<div class="card"><input id="q" type="search" placeholder="Search library"><div class="row"><button id="rescan" class="ghost sm" type="button">Rescan drives</button><span id="libInfo" class="meta"></span></div></div>' +
'<div class="card" id="list"></div></section>' +
'<section id="dash" hidden>' +
'<div class="card"><h2>System</h2><div class="kv" id="sys"></div></div>' +
'<div class="card"><h2>Services</h2><div id="svcs"></div><div class="row"><button id="refreshLogs" class="ghost sm" type="button">Show logs</button></div><pre id="logs" hidden></pre></div>' +
'<div class="card"><h2>Storage</h2><div id="stor"></div></div>' +
'<div class="card"><h2>Speed</h2><div id="speed" class="meta"></div><div class="row"><button id="inet" class="ghost sm" type="button">Internet test (TV)</button><button id="lan" class="ghost sm" type="button">LAN test (phone \u2194 TV)</button></div><div id="speedMsg" class="meta"></div></div>' +
'<div class="row"><button id="logout" class="ghost" type="button">Sign out</button></div></section>' +
'<div id="msg"></div></div></main><script nonce="__NONCE__">\n' +
'(function(){\n' +
'var $=function(id){return document.getElementById(id)};var lib=null,dash=null,tab="lib";\n' +
'function msg(t,bad){$("msg").textContent=t||"";$("msg").className=bad?"bad":""}\n' +
'function api(method,url,body){var h={"X-Dash":"1"};if(body!==undefined)h["Content-Type"]="application/json";' +
'return fetch(url,{method:method,body:body===undefined?undefined:JSON.stringify(body),headers:h,credentials:"same-origin"}).then(function(r){' +
'if(r.status===401){show("login");throw new Error("login")}return r.json().then(function(d){if(!r.ok)throw new Error(d.error||r.status);return d})})}\n' +
'function show(v){["login","app","nocfg"].forEach(function(x){$(x).hidden=x!==v})}\n' +
'function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}\n' +
'function fmtB(n){if(n==null)return"?";if(!n)return"0 B";var u=["B","KB","MB","GB","TB"],i=0;while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+" "+u[i]}\n' +
'function fmtT(s){s=Math.max(0,Math.round(s||0));var h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return(h?h+":"+(m<10?"0":""):"")+m+":"+(x<10?"0":"")+x}\n' +
'function fmtUp(s){s=Math.round(s||0);var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return(d?d+"d ":"")+h+"h "+m+"m"}\n' +
'function setTab(t){tab=t;$("lib").hidden=t!=="lib";$("dash").hidden=t!=="dash";$("tabLib").className=t==="lib"?"on":"";$("tabDash").className=t==="dash"?"on":"";if(t==="dash")loadDash(false)}\n' +
'$("tabLib").onclick=function(){setTab("lib")};$("tabDash").onclick=function(){setTab("dash")};\n' +
'function itemRow(it,sub){var w=el("div","item");if(it.poster){var im=el("img");im.src=it.poster;im.alt="";im.loading="lazy";w.appendChild(im)}else w.appendChild(el("div","ph",it.kind==="audio"?"\\u266A":"\\u25B6"));' +
'var t=el("div","txt");t.appendChild(el("div","name",it.title));t.appendChild(el("div","meta",sub||((it.year?it.year+" \\u00B7 ":"")+fmtB(it.size)+" \\u00B7 "+it.source)));' +
'if(it.progress){var b=el("div","bar"),i=el("i");i.style.width=(it.progress.dur?it.progress.pos/it.progress.dur*100:0)+"%";b.appendChild(i);t.appendChild(b)}w.appendChild(t);' +
'var p=el("button","sm","Play on TV");p.type="button";p.onclick=function(){api("POST","/api/remote",{cmd:"play",id:it.id}).then(function(r){msg(r.tvOnline?"Playing on the TV":"Open Dash Server on the TV first")},function(e){msg(e.message,true)})};w.appendChild(p);return w}\n' +
'function renderLib(){if(!lib)return;var L=$("list");L.textContent="";var q=$("q").value.trim().toLowerCase();' +
'$("libInfo").textContent=lib.counts.items+" items \\u00B7 "+(lib.roots.length?lib.roots.join(", "):"no drives found");' +
'function match(it){return!q||(it.title+" "+(it.show||"")+" "+(it.album||"")+" "+it.name).toLowerCase().indexOf(q)>=0}' +
'if(!q&&lib.continueWatching.length){L.appendChild(el("div","grp","Continue watching"));lib.continueWatching.forEach(function(it){L.appendChild(itemRow(it,(it.show?it.show+" \\u00B7 ":"")+fmtT(it.progress.pos)+" / "+fmtT(it.progress.dur)))})}' +
'var mv=lib.movies.filter(match);if(mv.length){L.appendChild(el("div","grp","Movies ("+mv.length+")"));mv.forEach(function(it){L.appendChild(itemRow(it))})}' +
'lib.shows.forEach(function(sh){var eps=[];sh.seasons.forEach(function(s){s.episodes.forEach(function(e){if(match(e)||(!q?false:sh.title.toLowerCase().indexOf(q)>=0))eps.push(e)})});if(!eps.length)return;' +
'L.appendChild(el("div","grp",sh.title+" ("+eps.length+")"));eps.forEach(function(e){L.appendChild(itemRow(e,"Season "+(e.season||"?")+" \\u00B7 "+fmtB(e.size)))})});' +
'lib.music.forEach(function(al){var tr=al.tracks.filter(function(t){return match(t)||(q&&al.album.toLowerCase().indexOf(q)>=0)});if(!tr.length)return;L.appendChild(el("div","grp","\\u266A "+al.album+" ("+tr.length+")"));tr.forEach(function(t){L.appendChild(itemRow(t,fmtB(t.size)))})});' +
'if(!L.childNodes.length)L.appendChild(el("div","meta",lib.counts.items?"No matches.":"No media found. Plug in a USB drive with video or music files, then Rescan."))}\n' +
'function loadLib(rescan){return api("GET","/api/library"+(rescan?"?rescan=1":"")).then(function(d){lib=d;renderLib()}).catch(function(){})}\n' +
'function loadNow(){return api("GET","/api/player").then(function(p){var n=$("now");n.textContent="";if(!p.online){n.textContent="TV app is not open";return}' +
'if(p.state==="idle"||!p.id){n.textContent="Nothing playing";return}n.appendChild(el("div","name",p.title));n.appendChild(el("div","meta",(p.state==="paused"?"Paused \\u00B7 ":"")+fmtT(p.pos)+" / "+fmtT(p.dur)));' +
'var b=el("div","bar"),i=el("i");i.style.width=(p.dur?p.pos/p.dur*100:0)+"%";b.appendChild(i);n.appendChild(b)}).catch(function(){})}\n' +
'function remote(cmd,extra){api("POST","/api/remote",Object.assign({cmd:cmd},extra||{})).then(function(r){if(!r.tvOnline)msg("Open Dash Server on the TV first")},function(e){msg(e.message,true)})}\n' +
'$("rToggle").onclick=function(){remote("toggle")};$("rStop").onclick=function(){remote("stop")};$("rBack").onclick=function(){remote("seek",{seconds:-10})};$("rFwd").onclick=function(){remote("seek",{seconds:10})};$("rPrev").onclick=function(){remote("prev")};\n' +
'$("q").oninput=renderLib;$("rescan").onclick=function(){msg("Rescanning...");api("POST","/api/library/rescan").then(function(){return loadLib(false)}).then(function(){msg("Rescan done")})};\n' +
'function renderDash(d){dash=d;var s=d.system,kv=$("sys");kv.textContent="";' +
'[["Model",s.realModel||s.model||"\\u2014"],["Firmware",s.firmware||"\\u2014"],["TV uptime",s.tvUptime?fmtUp(s.tvUptime):fmtUp(s.uptime)],["Service uptime",fmtUp(s.serviceUptime)],' +
'["CPU load",s.cpuLoad!=null?Math.round(s.cpuLoad*100)+"%":(s.load?s.load[0].toFixed(2):"\\u2014")],["Memory",fmtB(s.memTotal-s.memFree)+" / "+fmtB(s.memTotal)],["Node",s.node],["Wi-Fi IP",d.ip||"\\u2014"],["Library",d.library.items+" items"]]' +
'.forEach(function(p){kv.appendChild(el("b",null,p[0]));kv.appendChild(el("span",null,String(p[1])))});' +
'var sv=$("svcs");sv.textContent="";d.services.forEach(function(x){var r=el("div","svc");var l=el("div");var dot=el("span","dot"+(x.up?" up":""));l.appendChild(dot);l.appendChild(el("span","name",x.name));l.appendChild(el("div","meta",x.desc+" \\u00B7 :"+x.port+(x.up?" \\u00B7 "+x.latency+" ms":" \\u00B7 not running")));r.appendChild(l);' +
'if(!x.up){var b=el("button","sm","Start");b.type="button";b.onclick=function(){api("POST","/api/services/"+x.id+"/start").then(function(q){msg(q.note)},function(e){msg(e.message,true)})};r.appendChild(b)}sv.appendChild(r)});' +
'var st=$("stor");st.textContent="";d.storage.forEach(function(x){var r=el("div");r.appendChild(el("div","name",(x.kind==="usb"?"USB: ":"")+x.label+(x.writable?"":" (read-only)")));' +
'r.appendChild(el("div","meta",x.total?fmtB(x.total-x.free)+" used of "+fmtB(x.total):"size unknown"));var b=el("div","bar"),i=el("i");i.style.width=(x.total?(1-x.free/x.total)*100:0)+"%";b.appendChild(i);r.appendChild(b);r.style.marginBottom="10px";st.appendChild(r)});' +
'var sp=d.speed[d.speed.length-1];$("speed").textContent=sp?(sp.error?"Last test failed: "+sp.error:"Internet: \\u2193 "+sp.downMbps+" Mbps  \\u2191 "+sp.upMbps+" Mbps  \\u00B7 ping "+sp.pingMs+" ms \\u00B7 "+new Date(sp.at).toLocaleString()):"No test yet";' +
'if(d.services.some(function(x){return x.log})){var lines=[];d.services.forEach(function(x){(x.log||[]).forEach(function(l){lines.push([l.t,x.name,l.l,l.m])})});lines.sort(function(a,b){return a[0]-b[0]});' +
'$("logs").textContent=lines.slice(-120).map(function(l){return new Date(l[0]).toLocaleTimeString()+" ["+l[1]+"] "+(l[2]==="error"?"! ":"")+l[3]}).join("\\n")||"(no log lines)";$("logs").hidden=false}}\n' +
'function loadDash(logs){return api("GET","/api/dashboard"+(logs?"?logs=1":"")).then(renderDash).catch(function(){})}\n' +
'$("refreshLogs").onclick=function(){loadDash(true)};\n' +
'$("inet").onclick=function(){$("speedMsg").textContent="Testing from the TV (about 20 s)...";api("POST","/api/speedtest").then(function(){$("speedMsg").textContent="";loadDash(false)},function(e){$("speedMsg").textContent=e.message})};\n' +
'$("lan").onclick=function(){var N=20000000,t0=performance.now();$("speedMsg").textContent="Downloading 20 MB from the TV...";fetch("/speedtest/down?bytes="+N,{credentials:"same-origin"}).then(function(r){return r.arrayBuffer()}).then(function(b){var s=(performance.now()-t0)/1000;$("speedMsg").textContent="LAN: "+(b.byteLength*8/s/1e6).toFixed(1)+" Mbps phone \\u2190 TV"}).catch(function(e){$("speedMsg").textContent="LAN test failed: "+e.message})};\n' +
'$("lf").onsubmit=function(e){e.preventDefault();fetch("/api/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("pw").value})}).then(function(r){' +
'$("pw").value="";if(r.ok){show("app");boot()}else r.json().then(function(d){alert(d.retryAfter?"Too many attempts. Wait "+d.retryAfter+"s.":"Wrong password.")})})};\n' +
'$("logout").onclick=function(){api("POST","/api/logout").catch(function(){}).then(function(){show("login")})};\n' +
'function boot(){loadLib(false);loadNow()}\n' +
'fetch("/api/session",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(s){if(!s.configured)show("nocfg");else if(s.loggedIn){show("app");boot()}else show("login")});\n' +
'setInterval(function(){if($("app").hidden||document.hidden)return;if(tab==="lib")loadNow();else loadDash(false)},3000);\n' +
'})();\n</script></body></html>\n';

if (require.main === module) start();
