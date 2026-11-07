'use strict';
/*
 * Dash Torrents engine: WebTorrent + HTTP API + phone web UI. Runs as the Tizen service
 * (Node 16 on the TV) or locally: `node service.js` (set DASH_TORRENT_DIR / DASH_USB_ROOTS).
 *
 * Loopback callers (the TV app) are trusted; LAN callers need a session (+ X-Dash header for writes).
 *
 *   GET    /                               phone UI
 *   POST   /api/login | /api/logout        GET /api/session
 *   GET    /api/state                      torrents, storages, settings, play request
 *   POST   /api/torrents                   {magnet, mode: stream|download, storage}
 *   PUT    /api/torrents?mode=&storage=    raw .torrent body
 *   POST   /api/torrents/<hash>/pause | /resume | /play {file} | /download {storage}
 *   DELETE /api/torrents/<hash>?data=1
 *   PUT    /api/settings                   {seedAfterDone, downloadLimitKBps, uploadLimitKBps}
 *   POST   /api/storage-hints              {paths: [...]}   (loopback only, from tizen.filesystem)
 *   GET    /stream/<hash>/<fileIndex>      Range-capable file stream
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var childProcess = require('child_process');

var PORT = Number(process.env.DASH_TORRENT_PORT) || 8091;
var PKG_ID = 'DashTorr01';
var MAX_TORRENTS = 30;
var MAX_TORRENT_FILE = 4 * 1024 * 1024;
var SESSION_TTL = 12 * 3600 * 1000;
var MAX_SESSIONS = 50;
var COOKIE = 'tsid';
var MIN_INTERNAL_FREE = (Number(process.env.DASH_MIN_FREE_MB) || 1536) * 1024 * 1024;   // TV flash is small; never fill it
var HASH_RE = /^[0-9a-f]{40}$/;
var TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce'
];
var MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav',
  srt: 'text/plain; charset=utf-8', vtt: 'text/vtt'
};
var PLAYABLE = /\.(mp4|m4v|mkv|webm|avi|mov|ts|m2ts|wmv|mpg|mpeg|mp3|m4a|aac|flac|ogg|wav)$/i;

var WebTorrent = null, engineError = null;
try { WebTorrent = require('./engine.js').default; } catch (e) { engineError = e.message; }
var auth = null;
try { auth = require('./auth.js'); } catch (e) { auth = null; }

var server = null, client = null;
var dataDir, cacheDir, internalDir, torrentDir, stateFile;
var db = { settings: { seedAfterDone: false, downloadLimitKBps: 0, uploadLimitKBps: 0 }, torrents: [] };
var live = new Map();          // infoHash -> WebTorrent torrent
var streaming = new Map();     // infoHash -> open stream responses
var lastError = new Map();     // infoHash -> message
var sessions = new Map();
var failures = new Map();
var storageHints = [];
var playRequest = null;

// ---------------------------------------------------------------- persistence

function pickDataDir() {
  var candidates = [
    process.env.DASH_TORRENT_DIR,
    '/opt/usr/home/owner/apps_rw/' + PKG_ID + '/data',
    path.join(os.homedir() || os.tmpdir(), 'dash-torrents'),
    path.join(os.tmpdir(), 'dash-torrents')
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && probeWritable(candidates[i], true)) return candidates[i];
  }
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
    try {
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify(db, null, 1));
      fs.renameSync(stateFile + '.tmp', stateFile);
    } catch (e) { console.error('[torrent] save failed', e.message); }
  }, 300);
}

function entryOf(hash) {
  for (var i = 0; i < db.torrents.length; i++) if (db.torrents[i].infoHash === hash) return db.torrents[i];
  return null;
}

// ---------------------------------------------------------------- storage

function freeBytes(dir) {
  try {
    if (fs.statfsSync) { var s = fs.statfsSync(dir); return s.bavail * s.bsize; }
  } catch (e) { /* fall through */ }
  try {
    var out = childProcess.execFileSync('df', ['-kP', dir], { timeout: 2000, encoding: 'utf8' }).trim().split('\n');
    var cols = out[out.length - 1].split(/\s+/);
    var kb = parseInt(cols[3], 10);
    return isNaN(kb) ? null : kb * 1024;
  } catch (e) { return null; }
}

function usbRoots() {
  var roots = [];
  function add(p) { if (p && roots.indexOf(p) < 0) roots.push(p); }
  (process.env.DASH_USB_ROOTS || '').split(path.delimiter).forEach(add);
  storageHints.forEach(add);
  ['/opt/media'].forEach(function (base) {   // Samsung TVs mount USB drives here (e.g. /opt/media/USBDriveA1)
    try {
      fs.readdirSync(base).forEach(function (n) {
        var p = path.join(base, n);
        try { if (fs.statSync(p).isDirectory()) add(p); } catch (e) { /* skip */ }
      });
    } catch (e) { /* no such base */ }
  });
  return roots;
}

var storageCache = { at: 0, list: [] };
function storages(force) {
  if (!force && Date.now() - storageCache.at < 10000) return storageCache.list;
  var list = [{ id: 'internal', label: 'TV storage', kind: 'internal', path: internalDir, writable: true, free: freeBytes(internalDir) }];
  usbRoots().forEach(function (root) {
    var target = path.join(root, 'Torrents');
    var writable = probeWritable(root, false);
    list.push({
      id: 'usb-' + crypto.createHash('sha1').update(root).digest('hex').slice(0, 8),
      label: path.basename(root), kind: 'usb', root: root, path: target, writable: writable,
      free: writable ? freeBytes(root) : null
    });
  });
  storageCache = { at: Date.now(), list: list };
  return list;
}

function storageFor(id) {
  var list = storages(true);
  if (!id || id === 'auto') {
    for (var i = 0; i < list.length; i++) if (list[i].kind === 'usb' && list[i].writable) return list[i];
    return list[0];
  }
  for (var j = 0; j < list.length; j++) if (list[j].id === id) return list[j].writable ? list[j] : null;
  return null;
}

// ---------------------------------------------------------------- engine

function engineOpts() {
  var s = db.settings;
  return {
    maxConns: 40, utp: false, natUpnp: false, natPmp: false, dht: true, lsd: true, tracker: true,
    downloadLimit: s.downloadLimitKBps > 0 ? s.downloadLimitKBps * 1024 : -1,
    uploadLimit: s.uploadLimitKBps > 0 ? s.uploadLimitKBps * 1024 : -1
  };
}

function torrentFilePath(hash) { return path.join(torrentDir, hash + '.torrent'); }

function sourceFor(entry) {
  try { return fs.readFileSync(torrentFilePath(entry.infoHash)); } catch (e) { return entry.magnet; }
}

function attach(entry, source) {
  return wire(entry, client.add(source, { path: entry.root, announce: TRACKERS, deselect: entry.mode === 'stream' }));
}

function wire(entry, t) {
  live.set(entry.infoHash, t);
  lastError.delete(entry.infoHash);
  t.on('error', function (err) {
    lastError.set(entry.infoHash, err.message || String(err));
    live.delete(entry.infoHash);
  });
  t.on('warning', function () { /* tracker noise */ });
  function onMetadata() {
    entry.name = t.name;
    entry.length = t.length;
    entry.files = t.files.map(function (f) { return { name: f.name, path: f.path, length: f.length }; });
    try { fs.writeFileSync(torrentFilePath(entry.infoHash), Buffer.from(t.torrentFile)); } catch (e) { /* ignore */ }
    save();
  }
  if (t.info) onMetadata(); else t.once('metadata', onMetadata);
  t.on('done', function () {
    if (t.progress < 1) return;           // stream torrents report done for their (empty) selection
    entry.complete = true;
    save();
    retireIfIdle(entry);
  });
  return t;
}

// Stop a finished torrent unless seeding is wanted or something is still streaming from it.
function retireIfIdle(entry) {
  if (entry.complete && !db.settings.seedAfterDone && !streaming.get(entry.infoHash)) detach(entry.infoHash, false);
}

function detach(hash, destroyStore) {
  var t = live.get(hash);
  live.delete(hash);
  if (!t) return Promise.resolve();
  return new Promise(function (resolve) {
    try { client.remove(t, { destroyStore: !!destroyStore }, function () { resolve(); }); } catch (e) { resolve(); }
  });
}

function parseHashFromMagnet(magnet) {
  var i = magnet.indexOf('xt=urn:btih:');
  if (i < 0) return null;
  var h = magnet.slice(i + 12, i + 12 + 40).toLowerCase();
  return HASH_RE.test(h) ? h : null;   // base32 magnets are resolved after add
}

function addTorrent(source, mode, storageId) {
  if (!client) throw new Error('engine unavailable: ' + engineError);
  if (db.torrents.length >= MAX_TORRENTS) throw new Error('too many torrents (max ' + MAX_TORRENTS + ')');
  if (mode !== 'stream' && mode !== 'download') throw new Error('mode must be stream or download');
  var store = mode === 'stream' ? { id: 'cache', path: cacheDir } : storageFor(storageId);
  if (!store) throw new Error('storage not available or not writable');
  fs.mkdirSync(store.path, { recursive: true });

  var entry = {
    infoHash: null, name: null, magnet: typeof source === 'string' ? source : null,
    mode: mode, storage: store.id, root: store.path, addedAt: Date.now(),
    paused: false, complete: false, files: [], length: 0
  };
  return new Promise(function (resolve, reject) {
    var t = client.add(source, { path: store.path, announce: TRACKERS, deselect: mode === 'stream' });
    var settled = false;
    var timer = setTimeout(function () { fail(new Error('could not read this torrent')); }, 30000);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.remove(t, { destroyStore: false }); } catch (e) { /* already gone */ }
      reject(err);
    }
    t.once('error', function (err) { fail(new Error(/duplicate/i.test(err.message) ? 'already added' : err.message)); });
    t.once('infoHash', function () {
      if (settled) return;
      if (entryOf(t.infoHash)) return fail(new Error('already added'));
      settled = true;
      clearTimeout(timer);
      entry.infoHash = t.infoHash;
      if (!entry.magnet) entry.magnet = 'magnet:?xt=urn:btih:' + t.infoHash;
      db.torrents.push(entry);
      save();
      wire(entry, t);
      resolve(entry);
    });
  });
}

function resume(entry) {
  if (live.has(entry.infoHash)) return;
  entry.paused = false;
  save();
  attach(entry, sourceFor(entry));
}

function removeDataFromDisk(entry) {
  var root = path.resolve(entry.root);
  var dirs = {};
  (entry.files || []).forEach(function (f) {
    var p = path.resolve(root, f.path);
    if (p.indexOf(root + path.sep) !== 0) return;
    try { fs.unlinkSync(p); } catch (e) { /* missing */ }
    for (var d = path.dirname(p); d.indexOf(root + path.sep) === 0; d = path.dirname(d)) dirs[d] = true;
  });
  Object.keys(dirs).sort(function (a, b) { return b.length - a.length; }).forEach(function (d) {
    try { fs.rmdirSync(d); } catch (e) { /* not empty */ }
  });
}

function removeTorrent(entry, deleteData) {
  var wipe = deleteData || entry.mode === 'stream';
  return detach(entry.infoHash, wipe).then(function () {
    if (wipe) removeDataFromDisk(entry);
    try { fs.unlinkSync(torrentFilePath(entry.infoHash)); } catch (e) { /* none */ }
    db.torrents = db.torrents.filter(function (x) { return x !== entry; });
    if (playRequest && playRequest.infoHash === entry.infoHash) playRequest = null;
    save();
  });
}

function view(entry) {
  var t = live.get(entry.infoHash);
  var v = {
    infoHash: entry.infoHash, name: entry.name || (t && t.name) || entry.infoHash, mode: entry.mode,
    storage: entry.storage, addedAt: entry.addedAt, paused: entry.paused, complete: entry.complete,
    active: !!t, error: lastError.get(entry.infoHash) || null, length: entry.length || 0,
    progress: entry.complete ? 1 : 0, downloadSpeed: 0, uploadSpeed: 0, peers: 0, timeRemaining: null, ready: false
  };
  if (t) {
    v.ready = !!t.ready;
    v.progress = t.length ? t.progress : 0;
    v.downloadSpeed = Math.round(t.downloadSpeed);
    v.uploadSpeed = Math.round(t.uploadSpeed);
    v.peers = t.numPeers;
    v.timeRemaining = isFinite(t.timeRemaining) ? Math.round(t.timeRemaining / 1000) : null;
  }
  v.files = (entry.files || []).map(function (f, i) {
    var lf = t && t.files && t.files[i];
    return {
      index: i, name: f.name, path: f.path, length: f.length,
      progress: lf ? lf.progress : (entry.complete ? 1 : 0), playable: PLAYABLE.test(f.name)
    };
  });
  return v;
}

// ---------------------------------------------------------------- auth

function verifyPassword(pw) {
  if (!auth || typeof pw !== 'string' || pw.length > 256) return false;
  var key = crypto.scryptSync(pw, Buffer.from(auth.salt, 'hex'), 32, { N: auth.N, r: auth.r, p: auth.p });
  var expect = Buffer.from(auth.hash, 'hex');
  return key.length === expect.length && crypto.timingSafeEqual(key, expect);
}

function parseCookies(header) {
  var out = {};
  (header || '').split(';').forEach(function (part) {
    var i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function sessionOf(req) {
  var sid = parseCookies(req.headers.cookie)[COOKIE];
  var exp = sid && sessions.get(sid);
  if (!exp) return null;
  if (exp < Date.now()) { sessions.delete(sid); return null; }
  return sid;
}

function isLoopback(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function canRead(req) { return isLoopback(req) || !!sessionOf(req); }
function canWrite(req) { return isLoopback(req) || (!!sessionOf(req) && req.headers['x-dash'] === '1'); }

function lockedFor(ip) {
  var f = failures.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

function recordFailure(ip) {
  var f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) f.until = Date.now() + Math.min(3600, 30 * Math.pow(2, f.count - 5)) * 1000;
  failures.set(ip, f);
  if (failures.size > 1000) failures.clear();
}

// ---------------------------------------------------------------- http helpers

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

function readBody(req, limit, cb) {
  var chunks = [], size = 0, done = false;
  req.on('data', function (c) {
    if (done) return;
    size += c.length;
    if (size > limit) { done = true; cb(new Error('too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () { if (!done) { done = true; cb(null, Buffer.concat(chunks)); } });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}

function readJson(req, limit, cb) {
  readBody(req, limit, function (err, buf) {
    if (err) return cb(err);
    try { cb(null, JSON.parse(buf.toString('utf8') || '{}')); } catch (e) { cb(e); }
  });
}

function query(url) {
  var out = {}, i = url.indexOf('?');
  if (i < 0) return out;
  url.slice(i + 1).split('&').forEach(function (kv) {
    var j = kv.indexOf('=');
    try {
      if (j > 0) out[decodeURIComponent(kv.slice(0, j))] = decodeURIComponent(kv.slice(j + 1));
      else if (kv) out[decodeURIComponent(kv)] = '';
    } catch (e) { /* malformed escape */ }
  });
  return out;
}

function lanIp() {
  var ifs = os.networkInterfaces();
  for (var name in ifs) {
    for (var i = 0; i < ifs[name].length; i++) {
      var a = ifs[name][i];
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
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
    send(req, res, 200, { ok: true }, null, {
      'Set-Cookie': COOKIE + '=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + (SESSION_TTL / 1000)
    });
  });
}

function stateBody() {
  return {
    ip: lanIp(), port: PORT, configured: !!auth, engine: client ? 'ok' : engineError,
    settings: db.settings, playRequest: playRequest,
    storages: storages().map(function (s) {
      return { id: s.id, label: s.label, kind: s.kind, writable: s.writable, free: s.free };
    }),
    torrents: db.torrents.filter(function (e) { return e.infoHash; }).map(view)
  };
}

function respondAdd(req, res, promise) {
  promise.then(function (entry) { send(req, res, 201, view(entry)); })
    .catch(function (e) { send(req, res, 400, { error: e.message }); });
}

function handleAddMagnet(req, res) {
  readJson(req, 8192, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    var magnet = String(body.magnet || '').trim();
    if (/^[0-9a-fA-F]{40}$/.test(magnet)) magnet = 'magnet:?xt=urn:btih:' + magnet.toLowerCase();
    if (magnet.indexOf('magnet:?') !== 0 || magnet.length > 4096) return send(req, res, 400, { error: 'not a magnet link' });
    var known = parseHashFromMagnet(magnet);
    if (known && entryOf(known)) return send(req, res, 409, { error: 'already added' });
    respondAdd(req, res, addTorrent(magnet, body.mode, body.storage));
  });
}

function handleAddFile(req, res) {
  var q = query(req.url);
  readBody(req, MAX_TORRENT_FILE, function (err, buf) {
    if (err) return send(req, res, 413, { error: 'max 4 MB' });
    if (buf[0] !== 0x64) return send(req, res, 415, { error: 'not a .torrent file' });   // bencoded dict starts with 'd'
    respondAdd(req, res, addTorrent(buf, q.mode, q.storage));
  });
}

function handleTorrentAction(req, res, hash, action) {
  var entry = entryOf(hash);
  if (!entry) return send(req, res, 404, { error: 'not found' });
  if (action === 'pause') {
    entry.paused = true;
    save();
    return detach(hash, false).then(function () { send(req, res, 200, view(entry)); });
  }
  if (action === 'resume') {
    try { resume(entry); } catch (e) { return send(req, res, 500, { error: e.message }); }
    return send(req, res, 200, view(entry));
  }
  readJson(req, 1024, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    if (action === 'play') {
      var idx = Number(body.file);
      if (!entry.files[idx]) return send(req, res, 400, { error: 'bad file' });
      playRequest = { id: crypto.randomBytes(6).toString('hex'), infoHash: hash, file: idx, at: Date.now() };
      return send(req, res, 200, { ok: true, playRequest: playRequest });
    }
    if (action === 'download') {
      if (entry.mode === 'download') return send(req, res, 400, { error: 'already downloading' });
      var store = storageFor(body.storage);
      if (!store) return send(req, res, 400, { error: 'storage not available or not writable' });
      var source = sourceFor(entry);
      return removeTorrent(entry, true).then(function () {
        respondAdd(req, res, addTorrent(source, 'download', store.id));
      });
    }
    send(req, res, 404, { error: 'unknown action' });
  });
}

function handleSettings(req, res) {
  readJson(req, 1024, function (err, body) {
    if (err) return send(req, res, 400, { error: 'bad request' });
    var s = db.settings;
    if (typeof body.seedAfterDone === 'boolean') s.seedAfterDone = body.seedAfterDone;
    ['downloadLimitKBps', 'uploadLimitKBps'].forEach(function (k) {
      if (body[k] !== undefined) {
        var n = Math.floor(Number(body[k]));
        if (n >= 0 && n <= 1000000) s[k] = n;
      }
    });
    if (client) {
      client.throttleDownload(s.downloadLimitKBps > 0 ? s.downloadLimitKBps * 1024 : -1);
      client.throttleUpload(s.uploadLimitKBps > 0 ? s.uploadLimitKBps * 1024 : -1);
    }
    save();
    send(req, res, 200, s);
  });
}

function handleHints(req, res) {
  if (!isLoopback(req)) return send(req, res, 403, { error: 'forbidden' });
  readJson(req, 8192, function (err, body) {
    if (err || !Array.isArray(body.paths)) return send(req, res, 400, { error: 'bad request' });
    storageHints = body.paths.filter(function (p) {
      return typeof p === 'string' && p.length < 512 && path.isAbsolute(p) && p.indexOf('..') < 0;
    }).slice(0, 8);
    storageCache.at = 0;
    send(req, res, 200, { storages: stateBody().storages });
  });
}

function handleStream(req, res, hash, idx) {
  var entry = entryOf(hash);
  var meta = entry && entry.files[idx];
  if (!meta) return send(req, res, 404, { error: 'not found' });
  if (entry.paused || (!live.has(hash) && !entry.complete)) {
    try { resume(entry); } catch (e) { return send(req, res, 500, { error: e.message }); }
  }
  var t = live.get(hash);
  var file = t && t.files && t.files[idx];
  var diskPath = path.resolve(entry.root, meta.path);
  if (!file && !(entry.complete && diskPath.indexOf(path.resolve(entry.root) + path.sep) === 0 && fs.existsSync(diskPath))) {
    return send(req, res, 503, { error: 'not ready yet, retry' }, null, { 'Retry-After': '2' });
  }
  var size = meta.length;
  var range = parseRange(req.headers.range, size);
  if (range === 'invalid') return send(req, res, 416, null, null, { 'Content-Range': 'bytes */' + size });
  var start = range ? range.start : 0, end = range ? range.end : size - 1;
  var headers = Object.assign({}, SEC_HEADERS, {
    'Content-Type': MIME[(meta.name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store'
  });
  if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  if (isLoopback(req)) headers['Access-Control-Allow-Origin'] = '*';
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  streaming.set(hash, (streaming.get(hash) || 0) + 1);
  res.on('close', function () {
    var n = (streaming.get(hash) || 1) - 1;
    if (n > 0) streaming.set(hash, n); else streaming.delete(hash);
    if (!n) retireIfIdle(entry);
  });
  var stream = file ? file.createReadStream({ start: start, end: end }) : fs.createReadStream(diskPath, { start: start, end: end });
  stream.on('error', function (e) {
    console.error('[torrent] stream error', hash.slice(0, 8), idx, start + '-' + end, e && e.message);
    res.destroy();
  });
  res.on('close', function () { if (stream.destroy) stream.destroy(); });
  stream.pipe(res);
}

function route(req, res) {
  var url = (req.url || '/').split('?')[0];
  var m = req.method;
  var parts = url.split('/');   // ['', 'api', 'torrents', hash, action]
  try {
    if (m === 'OPTIONS' && isLoopback(req)) {
      return send(req, res, 204, null, null, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, X-Dash'
      });
    }
    if (m === 'GET' && url === '/') {
      var nonce = crypto.randomBytes(16).toString('base64');
      return send(req, res, 200, PHONE_HTML.replace(/__NONCE__/g, nonce), 'text/html; charset=utf-8', {
        'Content-Security-Policy': "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce +
          "'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
      });
    }
    if (m === 'POST' && url === '/api/login') return handleLogin(req, res);
    if (m === 'POST' && url === '/api/logout') {
      var sid = sessionOf(req);
      if (sid) sessions.delete(sid);
      return send(req, res, 200, { ok: true }, null, { 'Set-Cookie': COOKIE + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (m === 'GET' && url === '/api/session') return send(req, res, 200, { loggedIn: !!sessionOf(req), configured: !!auth });

    if ((m === 'GET' || m === 'HEAD') && parts[1] === 'stream' && parts.length >= 4) {
      if (!canRead(req)) return send(req, res, 401, { error: 'login required' });
      if (!HASH_RE.test(parts[2])) return send(req, res, 400, { error: 'bad hash' });
      return handleStream(req, res, parts[2], parseInt(parts[3], 10));
    }
    if (m === 'GET' && url === '/api/state') {
      if (!canRead(req)) return send(req, res, 401, { error: 'login required' });
      return send(req, res, 200, stateBody());
    }
    if (m !== 'GET' && parts[1] === 'api') {
      if (!canWrite(req)) return send(req, res, sessionOf(req) ? 403 : 401, { error: sessionOf(req) ? 'missing header' : 'login required' });
      if (m === 'POST' && url === '/api/torrents') return handleAddMagnet(req, res);
      if (m === 'PUT' && url === '/api/torrents') return handleAddFile(req, res);
      if (m === 'PUT' && url === '/api/settings') return handleSettings(req, res);
      if (m === 'POST' && url === '/api/storage-hints') return handleHints(req, res);
      if (parts[2] === 'torrents' && HASH_RE.test(parts[3] || '')) {
        if (m === 'DELETE' && parts.length === 4) {
          var entry = entryOf(parts[3]);
          if (!entry) return send(req, res, 404, { error: 'not found' });
          return removeTorrent(entry, query(req.url).data === '1').then(function () { send(req, res, 200, { ok: true }); });
        }
        if (m === 'POST' && parts.length === 5) return handleTorrentAction(req, res, parts[3], parts[4]);
      }
    }
    send(req, res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[torrent] error', e.stack);
    send(req, res, 500, { error: 'server error' });
  }
}

// ---------------------------------------------------------------- lifecycle

function start() {
  if (server) return;
  dataDir = pickDataDir();
  cacheDir = path.join(dataDir, 'stream-cache');
  internalDir = path.join(dataDir, 'downloads');
  torrentDir = path.join(dataDir, 'torrents');
  stateFile = path.join(dataDir, 'state.json');
  [cacheDir, internalDir, torrentDir].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
  try {
    var saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    db.settings = Object.assign(db.settings, saved.settings || {});
    db.torrents = (saved.torrents || []).filter(function (e) { return e.infoHash && HASH_RE.test(e.infoHash); });
  } catch (e) { /* first run */ }

  if (WebTorrent) {
    client = new WebTorrent(engineOpts());
    client.on('error', function (e) { console.error('[torrent] engine error', e.message); });
    db.torrents.forEach(function (entry) {
      if (entry.paused || (entry.complete && !db.settings.seedAfterDone)) return;
      try { attach(entry, sourceFor(entry)); } catch (e) { lastError.set(entry.infoHash, e.message); }
    });
  } else {
    console.error('[torrent] engine failed to load:', engineError);
  }

  server = http.createServer(route);
  server.requestTimeout = 0;            // streams are long-lived
  server.headersTimeout = 15000;
  server.on('error', function (e) { console.error('[torrent] server error', e.message); server = null; });
  server.listen(PORT, '0.0.0.0', function () {
    console.log('[torrent] on :' + PORT + ' data=' + dataDir + (auth ? '' : ' (NO PASSWORD SET)'));
  });
  setInterval(function () {
    var now = Date.now();
    sessions.forEach(function (exp, sid) { if (exp < now) sessions.delete(sid); });
    if (playRequest && now - playRequest.at > 60000) playRequest = null;
  }, 30000).unref();
  setInterval(guardInternalSpace, 15000).unref();
}

// Pause torrents writing to TV storage before the TV runs out of space. USB drives are left alone.
function guardInternalSpace() {
  if (!client || !live.size) return;
  var free = freeBytes(dataDir);
  if (free === null || free >= MIN_INTERNAL_FREE) return;
  db.torrents.forEach(function (entry) {
    if (!live.has(entry.infoHash) || path.resolve(entry.root).indexOf(path.resolve(dataDir)) !== 0) return;
    if (streaming.get(entry.infoHash)) return;   // don't cut off what is playing right now
    entry.paused = true;
    detach(entry.infoHash, false).then(function () {
      lastError.set(entry.infoHash, 'Paused: TV storage almost full. Remove something or use a USB drive.');
    });
  });
  save();
}

function stop() {
  if (server) { server.close(); server = null; }
  if (client) { client.destroy(); client = null; live.clear(); }
}

module.exports.onStart = start;
module.exports.onRequest = function () { start(); };
module.exports.onExit = stop;

// ---------------------------------------------------------------- phone UI

var PHONE_HTML = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1"><title>TV Torrents</title><style nonce="__NONCE__">' +
':root{--bg:#0B0F14;--fg:#E6E6E6;--muted:#8A96A3;--card:#121821;--border:#1F2933;--accent:#1DB954;--bad:#F2545B}' +
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}' +
'main{max-width:720px;margin:0 auto}h1{font-size:20px;margin:8px 0 16px}h2{font-size:15px;margin:0 0 10px;color:var(--muted);font-weight:600}' +
'.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px}' +
'input[type=password],input[type=number],textarea,select{width:100%;padding:12px;border-radius:10px;border:1px solid var(--border);background:#0E141B;color:var(--fg);font:inherit;font-size:16px}' +
'textarea{min-height:84px;resize:vertical;font-size:14px}' +
'button,label.btn{display:inline-block;border:0;border-radius:10px;padding:11px 15px;font-weight:700;font-size:15px;background:var(--accent);color:#03230F;cursor:pointer}' +
'button.ghost{background:transparent;color:var(--fg);border:1px solid var(--border)}button.bad{background:transparent;color:var(--bad);border:1px solid var(--border)}' +
'button:disabled{opacity:.5}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}' +
'.seg{display:flex;border:1px solid var(--border);border-radius:10px;overflow:hidden}.seg label{flex:1;text-align:center;padding:10px;cursor:pointer}' +
'.seg input{display:none}.seg input:checked+span{color:var(--accent);font-weight:700}' +
'#msg{min-height:20px;color:var(--muted);font-size:14px;margin-top:8px}#msg.bad{color:var(--bad)}' +
'.t{border-top:1px solid var(--border);padding:12px 0}.t:first-child{border-top:0;padding-top:0}' +
'.name{font-weight:600;word-break:break-word}.meta{color:var(--muted);font-size:13px;margin-top:2px}' +
'.bar{height:6px;background:#0E141B;border-radius:3px;margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}' +
'.files{margin-top:8px;font-size:14px}.files div{display:flex;justify-content:space-between;gap:8px;padding:4px 0}' +
'.files span{word-break:break-word}.files button{padding:5px 10px;font-size:13px}' +
'.check{display:flex;gap:10px;align-items:center}.check input{width:20px;height:20px;margin:0}.err{color:var(--bad);font-size:13px}[hidden]{display:none!important}input[type=file]{display:none}' +
'</style></head><body><main><h1>TV Torrents</h1>' +
'<section id="login" class="card" hidden><form id="lf"><input id="pw" type="password" autocomplete="current-password" placeholder="Password" required>' +
'<div class="row"><button type="submit">Sign in</button></div></form></section>' +
'<p id="nocfg" class="card" hidden>No password is configured. Run tv/tools/set-password.js --app torrentapp and redeploy.</p>' +
'<div id="app" hidden>' +
'<section class="card"><h2>Add</h2><textarea id="magnet" placeholder="Paste a magnet link or info hash"></textarea>' +
'<div class="row seg" id="modeSeg"><label><input type="radio" name="mode" value="stream" checked><span>Stream on TV</span></label>' +
'<label><input type="radio" name="mode" value="download"><span>Download</span></label></div>' +
'<div class="row" id="storeRow" hidden><select id="storage"></select></div>' +
'<div class="row"><button id="addMag" type="button">Add magnet</button><label class="btn" for="tfile">Add .torrent file</label>' +
'<input id="tfile" type="file" accept=".torrent,application/x-bittorrent"></div><div id="msg"></div></section>' +
'<section class="card"><h2>Torrents</h2><div id="list"></div></section>' +
'<section class="card"><h2>Settings</h2><label class="check"><input id="seed" type="checkbox"><span>Keep seeding after a download finishes</span></label>' +
'<div class="row"><label>Download limit KB/s (0 = none)<input id="dl" type="number" min="0"></label></div>' +
'<div class="row"><label>Upload limit KB/s (0 = none)<input id="ul" type="number" min="0"></label></div>' +
'<div class="row"><button id="saveSet" type="button" class="ghost">Save settings</button><button id="logout" class="ghost" type="button">Sign out</button></div></section>' +
'</div></main><script nonce="__NONCE__">\n' +
'(function(){\n' +
'var $=function(id){return document.getElementById(id)};var last=null,expanded={};\n' +
'function msg(t,bad){$("msg").textContent=t;$("msg").className=bad?"bad":""}\n' +
'function api(method,url,body,type){var h={"X-Dash":"1"};if(type)h["Content-Type"]=type;' +
'return fetch(url,{method:method,body:body,headers:h,credentials:"same-origin"}).then(function(r){' +
'if(r.status===401){show("login");throw new Error("login")}return r.json().then(function(d){if(!r.ok)throw new Error(d.error||r.status);return d})})}\n' +
'function show(v){["login","app","nocfg"].forEach(function(x){$(x).hidden=x!==v})}\n' +
'function fmtB(n){if(!n)return"0 B";var u=["B","KB","MB","GB","TB"],i=0;while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+" "+u[i]}\n' +
'function fmtT(s){if(s==null)return"";if(s<60)return s+"s";if(s<3600)return Math.round(s/60)+"m";return Math.floor(s/3600)+"h "+Math.round(s%3600/60)+"m"}\n' +
'function mode(){return document.querySelector("input[name=mode]:checked").value}\n' +
'function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}\n' +
'function btn(text,cls,fn){var b=el("button",cls,text);b.type="button";b.onclick=function(){b.disabled=true;Promise.resolve(fn()).catch(function(e){msg(e.message,true)}).then(function(){b.disabled=false;refresh()})};return b}\n' +
'function storageOptions(sel,list){sel.textContent="";list.forEach(function(s){if(!s.writable)return;var o=el("option",null,(s.kind==="usb"?"USB: ":"")+s.label+(s.free!=null?" ("+fmtB(s.free)+" free)":""));o.value=s.id;sel.appendChild(o)})}\n' +
'function render(d){last=d;var sel=$("storage"),prev=sel.value;storageOptions(sel,d.storages);if(prev)sel.value=prev;' +
'if(!sel.value){var u=d.storages.filter(function(s){return s.kind==="usb"&&s.writable})[0];if(u)sel.value=u.id}' +
'if(document.activeElement!==$("dl")&&document.activeElement!==$("ul")){$("seed").checked=d.settings.seedAfterDone;$("dl").value=d.settings.downloadLimitKBps;$("ul").value=d.settings.uploadLimitKBps}' +
'var L=$("list");L.textContent="";if(!d.torrents.length)L.appendChild(el("div","meta","Nothing yet."));\n' +
'd.torrents.slice().reverse().forEach(function(t){var w=el("div","t");w.appendChild(el("div","name",t.name));' +
'var st=t.complete?"Complete":t.paused?"Paused":t.mode==="stream"?"Streaming":"Downloading";' +
'var where=t.mode==="stream"?"TV cache":(d.storages.filter(function(s){return s.id===t.storage})[0]||{label:t.storage}).label;' +
'w.appendChild(el("div","meta",st+" \\u00B7 "+where+" \\u00B7 "+Math.floor(t.progress*100)+"% of "+fmtB(t.length)+(t.active?" \\u00B7 \\u2193"+fmtB(t.downloadSpeed)+"/s \\u2191"+fmtB(t.uploadSpeed)+"/s \\u00B7 "+t.peers+(t.peers===1?" peer":" peers")+(t.timeRemaining&&t.mode==="download"&&!t.complete?" \\u00B7 "+fmtT(t.timeRemaining)+" left":""):"")));' +
'if(t.error)w.appendChild(el("div","err",t.error));var bar=el("div","bar"),i=el("i");i.style.width=(t.progress*100)+"%";bar.appendChild(i);w.appendChild(bar);' +
'var r=el("div","row");r.appendChild(btn(expanded[t.infoHash]?"Hide files":"Files ("+t.files.length+")","ghost",function(){expanded[t.infoHash]=!expanded[t.infoHash]}));' +
'if(t.paused)r.appendChild(btn("Resume","ghost",function(){return api("POST","/api/torrents/"+t.infoHash+"/resume")}));else if(!t.complete)r.appendChild(btn("Pause","ghost",function(){return api("POST","/api/torrents/"+t.infoHash+"/pause")}));' +
'if(t.mode==="stream")r.appendChild(btn("Download instead","ghost",function(){return api("POST","/api/torrents/"+t.infoHash+"/download",JSON.stringify({storage:$("storage").value||"auto"}),"application/json")}));' +
'r.appendChild(btn("Remove","bad",function(){if(!confirm("Remove "+t.name+"?"))return;var del=t.mode==="download"&&confirm("Also delete the downloaded files?");' +
'return api("DELETE","/api/torrents/"+t.infoHash+(del?"?data=1":""))}));w.appendChild(r);' +
'if(expanded[t.infoHash]){var f=el("div","files");t.files.forEach(function(x){var row=el("div");row.appendChild(el("span",null,x.name+" \\u00B7 "+fmtB(x.length)+" \\u00B7 "+Math.floor(x.progress*100)+"%"));' +
'if(x.playable)row.appendChild(btn("Play on TV",null,function(){return api("POST","/api/torrents/"+t.infoHash+"/play",JSON.stringify({file:x.index}),"application/json").then(function(){msg("Sent to TV. Open Torrents on the TV if it is not already open.")})}));' +
'f.appendChild(row)});w.appendChild(f)}L.appendChild(w)})}\n' +
'function refresh(){return fetch("/api/state",{credentials:"same-origin"}).then(function(r){if(r.status===401){show("login");return}return r.json().then(render)}).catch(function(){})}\n' +
'Array.prototype.forEach.call(document.querySelectorAll("input[name=mode]"),function(r){r.onchange=function(){$("storeRow").hidden=mode()!=="download"}});\n' +
'function added(d){msg("Added "+(d.name||d.infoHash));$("magnet").value=""}\n' +
'$("addMag").onclick=function(){var m=$("magnet").value.trim();if(!m)return;msg("Adding...");api("POST","/api/torrents",JSON.stringify({magnet:m,mode:mode(),storage:$("storage").value||"auto"}),"application/json").then(added,function(e){msg(e.message,true)}).then(refresh)};\n' +
'$("tfile").onchange=function(e){var f=e.target.files[0];e.target.value="";if(!f)return;msg("Adding...");' +
'api("PUT","/api/torrents?mode="+mode()+"&storage="+encodeURIComponent($("storage").value||"auto"),f,"application/x-bittorrent").then(added,function(e){msg(e.message,true)}).then(refresh)};\n' +
'$("saveSet").onclick=function(){api("PUT","/api/settings",JSON.stringify({seedAfterDone:$("seed").checked,downloadLimitKBps:+$("dl").value||0,uploadLimitKBps:+$("ul").value||0}),"application/json").then(function(){msg("Settings saved")},function(e){msg(e.message,true)})};\n' +
'$("lf").onsubmit=function(e){e.preventDefault();fetch("/api/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("pw").value})}).then(function(r){' +
'$("pw").value="";if(r.ok){show("app");refresh()}else r.json().then(function(d){alert(d.retryAfter?"Too many attempts. Wait "+d.retryAfter+"s.":"Wrong password.")})})};\n' +
'$("logout").onclick=function(){api("POST","/api/logout").catch(function(){}).then(function(){show("login")})};\n' +
'fetch("/api/session",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(s){if(!s.configured)show("nocfg");else if(s.loggedIn){show("app");refresh()}else show("login")});\n' +
'setInterval(function(){if(!$("app").hidden&&!document.hidden)refresh()},2500);\n' +
'})();\n</script></body></html>\n';

if (require.main === module) start();
