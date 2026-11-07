'use strict';
/*
 * Dash photo service: password-protected upload site + photo feed for the home screen.
 * Runs as a Tizen web service app (Node 16 on the TV) or locally: `node service.js`.
 *
 *   GET  /                      upload page
 *   POST /api/login {password}  -> session cookie
 *   POST /api/logout
 *   GET  /api/photos            loopback or session
 *   PUT  /api/photos            raw image body, session + X-Dash header
 *   DELETE /api/photos/<name>   session + X-Dash header
 *   GET  /photos/<name>         loopback or session
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');

var PORT = Number(process.env.DASH_PORT) || 8090;
var PKG_ID = 'DashHome01';
var MAX_UPLOAD = 25 * 1024 * 1024;
var MAX_PHOTOS = 1000;
var MAX_TOTAL = 2 * 1024 * 1024 * 1024;
var SESSION_TTL = 12 * 3600 * 1000;
var MAX_SESSIONS = 50;
var NAME_RE = /^[0-9a-f-]{1,64}\.(jpg|png|webp|gif)$/;
var TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

var auth = null;
try { auth = require('./auth.js'); } catch (e) { auth = null; }

var server = null;
var sessions = new Map();   // token -> expiry
var failures = new Map();   // ip -> {count, until}
var dataDir = null;

// ---------------------------------------------------------------- storage

function pickDataDir() {
  var candidates = [
    process.env.DASH_PHOTO_DIR,
    '/opt/usr/home/owner/apps_rw/' + PKG_ID + '/data/photos',
    path.join(os.homedir() || os.tmpdir(), 'dash-photos'),
    path.join(os.tmpdir(), 'dash-photos')
  ];
  for (var i = 0; i < candidates.length; i++) {
    var dir = candidates[i];
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      var probe = path.join(dir, '.probe');
      fs.writeFileSync(probe, 'x');
      fs.unlinkSync(probe);
      return dir;
    } catch (e) { /* try next */ }
  }
  throw new Error('no writable photo directory');
}

function listPhotos() {
  var out = [];
  fs.readdirSync(dataDir).forEach(function (name) {
    if (!NAME_RE.test(name)) return;
    try {
      var st = fs.statSync(path.join(dataDir, name));
      out.push({ name: name, size: st.size, mtime: st.mtimeMs });
    } catch (e) { /* raced with delete */ }
  });
  out.sort(function (a, b) { return b.mtime - a.mtime; });
  return out;
}

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  return null;
}

function newName(ext) {
  var d = new Date();
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) +
    p(d.getSeconds()) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
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
  var sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  var exp = sessions.get(sid);
  if (!exp) return null;
  if (exp < Date.now()) { sessions.delete(sid); return null; }
  return sid;
}

function isLoopback(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function clientIp(req) { return req.socket.remoteAddress || '?'; }

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

var SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

function send(res, code, body, type, extra) {
  var headers = Object.assign({}, SEC_HEADERS, extra || {});
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
  req.on('data', function (c) {
    if (done) return;
    size += c.length;
    if (size > limit) { done = true; cb(new Error('too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    if (done) return;
    done = true;
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(e); }
  });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}

function requireWrite(req, res) {
  if (!sessionOf(req)) { send(res, 401, { error: 'login required' }); return false; }
  if (req.headers['x-dash'] !== '1') { send(res, 403, { error: 'missing header' }); return false; }
  return true;
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

// ---------------------------------------------------------------- handlers

function handleLogin(req, res) {
  var ip = clientIp(req);
  var wait = lockedFor(ip);
  if (wait) return send(res, 429, { error: 'too many attempts', retryAfter: wait }, null, { 'Retry-After': String(wait) });
  if (!auth) return send(res, 503, { error: 'password not configured' });
  readJson(req, 1024, function (err, body) {
    if (err) return send(res, 400, { error: 'bad request' });
    if (!verifyPassword(body.password)) {
      recordFailure(ip);
      return send(res, 401, { error: 'wrong password' });
    }
    failures.delete(ip);
    if (sessions.size >= MAX_SESSIONS) {
      var oldest = null;
      sessions.forEach(function (exp, sid) { if (!oldest || exp < sessions.get(oldest)) oldest = sid; });
      sessions.delete(oldest);
    }
    var sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, Date.now() + SESSION_TTL);
    send(res, 200, { ok: true }, null, {
      'Set-Cookie': 'sid=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + (SESSION_TTL / 1000)
    });
  });
}

function handleUpload(req, res) {
  if (!requireWrite(req, res)) return;
  var declared = Number(req.headers['content-length']);
  if (!declared || declared > MAX_UPLOAD) return send(res, 413, { error: 'max 25 MB' });
  var photos = listPhotos();
  var total = photos.reduce(function (s, p) { return s + p.size; }, 0);
  if (photos.length >= MAX_PHOTOS || total + declared > MAX_TOTAL) return send(res, 507, { error: 'storage full' });

  var tmp = path.join(dataDir, '.upload-' + crypto.randomBytes(6).toString('hex'));
  var out = fs.createWriteStream(tmp, { mode: 384 });
  var size = 0, ext = null, head = [], failed = false;

  function fail(code, msg) {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(tmp, function () {});
    send(res, code, { error: msg });
    req.resume();
  }

  req.on('data', function (chunk) {
    if (failed) return;
    size += chunk.length;
    if (size > MAX_UPLOAD) return fail(413, 'max 25 MB');
    if (!ext) {
      head.push(chunk);
      var buf = Buffer.concat(head);
      if (buf.length >= 12) {
        ext = sniff(buf);
        if (!ext) return fail(415, 'not an image');
      }
    }
    out.write(chunk);
  });
  req.on('end', function () {
    if (failed) return;
    if (!ext) ext = sniff(Buffer.concat(head));
    if (!ext) return fail(415, 'not an image');
    out.end(function () {
      var name = newName(ext);
      fs.rename(tmp, path.join(dataDir, name), function (err) {
        if (err) return fail(500, 'save failed');
        send(res, 201, { name: name, size: size });
      });
    });
  });
  req.on('error', function () { fail(400, 'upload aborted'); });
}

function handleDelete(req, res, name) {
  if (!requireWrite(req, res)) return;
  if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad name' });
  fs.unlink(path.join(dataDir, name), function (err) {
    send(res, err ? 404 : 200, err ? { error: 'not found' } : { ok: true });
  });
}

function handlePhoto(req, res, name) {
  if (!isLoopback(req) && !sessionOf(req)) return send(res, 401, { error: 'login required' });
  if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad name' });
  var file = path.join(dataDir, name);
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    var headers = Object.assign({}, SEC_HEADERS, {
      'Content-Type': TYPES[name.split('.').pop()],
      'Content-Length': st.size,
      'Cache-Control': 'private, max-age=86400'
    });
    if (isLoopback(req)) headers['Access-Control-Allow-Origin'] = '*';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function uploadPage() {
  var nonce = crypto.randomBytes(16).toString('base64');
  return {
    body: UPLOAD_HTML.replace(/__NONCE__/g, nonce),
    csp: "default-src 'none'; img-src 'self' blob:; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce +
      "'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function route(req, res) {
  var url = (req.url || '/').split('?')[0];
  var m = req.method;
  try {
    if (m === 'GET' && url === '/') {
      var page = uploadPage();
      return send(res, 200, page.body, 'text/html; charset=utf-8', { 'Content-Security-Policy': page.csp });
    }
    if (m === 'POST' && url === '/api/login') return handleLogin(req, res);
    if (m === 'POST' && url === '/api/logout') {
      var sid = sessionOf(req);
      if (sid) sessions.delete(sid);
      return send(res, 200, { ok: true }, null, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (m === 'GET' && url === '/api/session') {
      return send(res, 200, { loggedIn: !!sessionOf(req), configured: !!auth });
    }
    if (m === 'GET' && url === '/api/photos') {
      var loop = isLoopback(req);
      if (!loop && !sessionOf(req)) return send(res, 401, { error: 'login required' });
      return send(res, 200, { ip: lanIp(), port: PORT, configured: !!auth, photos: listPhotos() }, null,
        loop ? { 'Access-Control-Allow-Origin': '*' } : null);
    }
    if (m === 'PUT' && url === '/api/photos') return handleUpload(req, res);
    if (m === 'DELETE' && url.indexOf('/api/photos/') === 0) return handleDelete(req, res, url.slice(12));
    if (m === 'GET' && url.indexOf('/photos/') === 0) return handlePhoto(req, res, url.slice(8));
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: 'server error' });
  }
}

// ---------------------------------------------------------------- lifecycle

function start() {
  if (server) return;
  dataDir = pickDataDir();
  server = http.createServer(route);
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.on('error', function (e) { console.error('[dash] server error', e.message); server = null; });
  server.listen(PORT, '0.0.0.0', function () {
    console.log('[dash] photo service on :' + PORT + ' dir=' + dataDir + (auth ? '' : ' (NO PASSWORD SET)'));
  });
  setInterval(function () {
    var now = Date.now();
    sessions.forEach(function (exp, sid) { if (exp < now) sessions.delete(sid); });
  }, 600000).unref();
}

function stop() {
  if (server) { server.close(); server = null; }
}

module.exports.onStart = start;
module.exports.onRequest = function () { start(); };
module.exports.onExit = stop;

if (require.main === module) start();

// ---------------------------------------------------------------- upload page

var UPLOAD_HTML = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>TV Photos</title><style nonce="__NONCE__">' +
':root{--bg:#0B0F14;--fg:#E6E6E6;--muted:#8A96A3;--card:#121821;--border:#1F2933;--accent:#1DB954;--bad:#F2545B}' +
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}' +
'main{max-width:720px;margin:0 auto}h1{font-size:20px;margin:8px 0 16px}' +
'.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px}' +
'input[type=password]{width:100%;padding:12px;border-radius:10px;border:1px solid var(--border);background:#0E141B;color:var(--fg);font-size:16px}' +
'button,label.btn{display:inline-block;border:0;border-radius:10px;padding:12px 16px;font-weight:700;font-size:15px;background:var(--accent);color:#03230F;cursor:pointer}' +
'button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}' +
'.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}.row.top{margin-top:0}' +
'#msg{min-height:20px;color:var(--muted);font-size:14px;margin-top:8px}#msg.bad{color:var(--bad)}' +
'.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}' +
'.tile{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:#0E141B}' +
'.tile img{width:100%;height:100%;object-fit:cover;display:block}' +
'.tile button{position:absolute;top:6px;right:6px;padding:4px 9px;font-size:13px;background:rgba(0,0,0,.65);color:#fff}' +
'[hidden]{display:none!important}input[type=file]{display:none}' +
'</style></head><body><main><h1>TV Photos</h1>' +
'<section id="login" class="card" hidden><form id="lf"><input id="pw" type="password" autocomplete="current-password" placeholder="Password" required>' +
'<div class="row"><button type="submit">Sign in</button></div></form></section>' +
'<section id="app" hidden><div class="card"><div class="row top">' +
'<label class="btn" for="files">Add photos</label><input id="files" type="file" accept="image/*" multiple>' +
'<button id="logout" class="ghost" type="button">Sign out</button></div><div id="msg"></div></div>' +
'<div id="grid" class="grid"></div></section>' +
'<p id="nocfg" class="card" hidden>No password is configured. Run tv/tools/set-password.js and redeploy.</p>' +
'</main><script nonce="__NONCE__">\n' +
'(function(){\n' +
'var $=function(id){return document.getElementById(id)};\n' +
'function msg(t,bad){$("msg").textContent=t;$("msg").className=bad?"bad":""}\n' +
'function api(method,url,body,type){var h={"X-Dash":"1"};if(type)h["Content-Type"]=type;' +
'return fetch(url,{method:method,body:body,headers:h,credentials:"same-origin"})}\n' +
'function show(view){["login","app","nocfg"].forEach(function(v){$(v).hidden=v!==view})}\n' +
'function refresh(){return fetch("/api/photos",{credentials:"same-origin"}).then(function(r){' +
'if(r.status===401){show("login");return}return r.json().then(function(d){var g=$("grid");g.textContent="";' +
'd.photos.forEach(function(p){var t=document.createElement("div");t.className="tile";var i=document.createElement("img");' +
'i.loading="lazy";i.alt="";i.src="/photos/"+encodeURIComponent(p.name);var b=document.createElement("button");b.type="button";' +
'b.textContent="Delete";b.onclick=function(){if(!confirm("Delete this photo?"))return;api("DELETE","/api/photos/"+encodeURIComponent(p.name))' +
'.then(refresh)};t.appendChild(i);t.appendChild(b);g.appendChild(t)});' +
'if(!d.photos.length)msg("No photos yet.")})})}\n' +
'function shrink(file){return new Promise(function(res){var url=URL.createObjectURL(file);var img=new Image();' +
'img.onload=function(){var max=3840,s=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));' +
'var c=document.createElement("canvas");c.width=Math.round(img.naturalWidth*s);c.height=Math.round(img.naturalHeight*s);' +
'c.getContext("2d").drawImage(img,0,0,c.width,c.height);URL.revokeObjectURL(url);' +
'c.toBlob(function(b){res(b||file)},"image/jpeg",0.88)};' +
'img.onerror=function(){URL.revokeObjectURL(url);res(file)};img.src=url})}\n' +
'$("files").onchange=function(e){var files=Array.prototype.slice.call(e.target.files);e.target.value="";var n=0,bad=0;' +
'files.reduce(function(p,f){return p.then(function(){msg("Uploading "+(++n)+" of "+files.length+"...");' +
'return shrink(f).then(function(b){return api("PUT","/api/photos",b,b.type||"application/octet-stream")})' +
'.then(function(r){if(!r.ok)bad++})})},Promise.resolve()).then(function(){msg(bad?bad+" failed":"Uploaded "+files.length,!!bad);refresh()})};\n' +
'$("lf").onsubmit=function(e){e.preventDefault();fetch("/api/login",{method:"POST",credentials:"same-origin",' +
'headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("pw").value})}).then(function(r){' +
'$("pw").value="";if(r.ok){show("app");msg("");refresh()}else r.json().then(function(d){' +
'alert(d.retryAfter?"Too many attempts. Wait "+d.retryAfter+"s.":"Wrong password.")})})};\n' +
'$("logout").onclick=function(){api("POST","/api/logout").then(function(){show("login")})};\n' +
'fetch("/api/session",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(s){' +
'if(!s.configured)show("nocfg");else if(s.loggedIn){show("app");refresh()}else show("login")});\n' +
'})();\n</script></body></html>\n';
