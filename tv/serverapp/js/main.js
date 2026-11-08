(function () {
  'use strict';
  var BASE = 'http://127.0.0.1:8092';
  var SERVICE_ID = 'DashSrv01.core';
  var APPS = { torrents: 'DashTorr01.torrent', home: 'DashHome01.home' };
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19,
    STOP: 413, FF: 417, RW: 412, NEXT: 10233, PREV: 10232, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406 };
  var hasTizen = typeof window.tizen !== 'undefined';
  var hasAV = !!(window.webapis && window.webapis.avplay);
  var $ = function (id) { return document.getElementById(id); };

  var S = { view: 'home', lib: null, dash: null, libStack: [], sel: null, lastSel: {}, playing: null, remoteSeq: 0, cmdSeq: 0,
    osdTimer: null, osdNote: '', subs: null, subsOn: true, failures: 0, logsAt: 0 };

  // ------------------------------------------------------------ helpers

  function fmtB(n) { if (n === null || n === undefined) return '?'; if (!n) return '0 B'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }
  function fmtT(sec) { if (sec === null || sec === undefined || !isFinite(sec)) return ''; sec = Math.max(0, Math.round(sec)); var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function fmtUp(s) { s = Math.round(s || 0); var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 4500); }
  function request(method, path, body) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(method, BASE + path);
      x.timeout = 25000;
      if (body !== undefined) x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () { var d = null; try { d = JSON.parse(x.responseText); } catch (e) { /* text */ } if (x.status >= 200 && x.status < 300) resolve(d); else reject(new Error((d && d.error) || ('HTTP ' + x.status))); };
      x.onerror = x.ontimeout = function () { reject(new Error('service not reachable')); };
      x.send(body === undefined ? null : JSON.stringify(body));
    });
  }
  function startService(id) {
    if (!hasTizen) return;
    try {
      tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'), id || SERVICE_ID,
        function () {}, function (e) { console.log('service launch failed', id, e && e.message); });
    } catch (e) { console.log('service launch error', e.message); }
  }
  function launchApp(appId, name) {
    if (!hasTizen) return toast('Would open ' + name);
    tizen.application.launch(appId, function () {}, function () { toast(name + ' is not installed'); });
  }

  // ------------------------------------------------------------ TV info -> service

  function sendSystemHints() {
    var h = {};
    try {
      if (window.webapis && webapis.productinfo) {
        h.model = webapis.productinfo.getModel();
        h.realModel = webapis.productinfo.getRealModel();
        h.firmware = webapis.productinfo.getFirmware();
        h.duid = webapis.productinfo.getDuid();
      }
    } catch (e) { /* no productinfo */ }
    function post() { request('POST', '/api/system-hints', h).catch(function () {}); }
    if (hasTizen && tizen.systeminfo) {
      try {
        tizen.systeminfo.getPropertyValue('CPU', function (cpu) { h.cpuLoad = cpu.load; finishBuild(); }, finishBuild);
      } catch (e) { finishBuild(); }
    } else post();
    function finishBuild() {
      try {
        tizen.systeminfo.getPropertyValue('BUILD', function (b) { h.tizen = b.buildVersion; if (!h.model) h.model = b.model; post(); }, post);
      } catch (e) { post(); }
    }
  }

  function sendStorageHints() {
    if (!hasTizen || !tizen.filesystem) return;
    try {
      tizen.filesystem.listStorages(function (list) {
        var usb = list.filter(function (s) { return s.type === 'EXTERNAL' && s.state === 'MOUNTED'; });
        var paths = [], pending = usb.length;
        if (!pending) return request('POST', '/api/storage-hints', { paths: [] }).catch(function () {});
        usb.forEach(function (s) {
          function done() { if (--pending === 0) request('POST', '/api/storage-hints', { paths: paths }).catch(function () {}); }
          try {
            tizen.filesystem.resolve(s.label, function (dir) { var uri = dir.toURI ? dir.toURI() : ''; if (uri.indexOf('file://') === 0) paths.push(decodeURI(uri.slice(7))); done(); }, done, 'r');
          } catch (e) { done(); }
        });
      });
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ data

  function loadLib(rescan) {
    return request('GET', '/api/library' + (rescan ? '?rescan=1' : '')).then(function (d) {
      S.lib = d; S.failures = 0;
      if (S.view === 'home' || S.view === 'library') render();
    }, onFail);
  }
  function loadDash(withLogs) {
    return request('GET', '/api/dashboard' + (withLogs ? '?logs=1' : '')).then(function (d) {
      if (!withLogs && S.dash) d.services.forEach(function (s) { S.dash.services.forEach(function (o) { if (o.id === s.id) s.log = o.log; }); });
      S.dash = d; S.failures = 0;
      if (S.view === 'home' || S.view === 'dashboard') render();
    }, onFail);
  }
  function onFail() {
    S.failures++;
    $('hint').textContent = 'Starting Dash Server service…';
    if (S.failures % 5 === 1) startService();
  }

  function pollRemote() {
    request('GET', '/api/remote?after=' + S.remoteSeq).then(function (d) {
      S.remoteSeq = d.seq;
      (d.commands || []).forEach(handleRemote);
    }).catch(function () {});
    request('GET', '/api/commands?after=' + S.cmdSeq).then(function (d) {
      S.cmdSeq = d.seq;
      (d.commands || []).forEach(function (c) { if (c.type === 'launchService') { startService(c.appId); toast('Starting ' + c.appId); setTimeout(function () { loadDash(false); }, 3000); } });
    }).catch(function () {});
  }
  function handleRemote(c) {
    if (c.cmd === 'play') { var it = findItem(c.id); if (it) play(it); return; }
    if (!S.playing) return;
    if (c.cmd === 'toggle') togglePause();
    else if (c.cmd === 'pause') { if (!S.playing.paused) togglePause(); }
    else if (c.cmd === 'resume') { if (S.playing.paused) togglePause(); }
    else if (c.cmd === 'stop') stopPlayback();
    else if (c.cmd === 'seek') seek(c.seconds);
    else if (c.cmd === 'next') playRelative(1);
    else if (c.cmd === 'prev') playRelative(-1);
  }
  function reportPlayer() {
    var p = S.playing;
    request('PUT', '/api/player', p ? { state: p.paused ? 'paused' : 'playing', id: p.item.id, title: p.item.title, pos: p.pos, dur: p.dur } : { state: 'idle' }).catch(function () {});
  }

  function allItems() {
    if (!S.lib) return [];
    var out = S.lib.movies.slice();
    S.lib.shows.forEach(function (sh) { sh.seasons.forEach(function (s) { out = out.concat(s.episodes); }); });
    S.lib.music.forEach(function (al) { out = out.concat(al.tracks); });
    return out;
  }
  function findItem(id) { var all = allItems(); for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i]; return null; }
  function siblingsOf(item) {
    if (!S.lib) return [item];
    if (item.show) { for (var i = 0; i < S.lib.shows.length; i++) if (S.lib.shows[i].title === item.show) { var eps = []; S.lib.shows[i].seasons.forEach(function (s) { eps = eps.concat(s.episodes); }); return eps; } }
    if (item.kind === 'audio') { for (var j = 0; j < S.lib.music.length; j++) if (S.lib.music[j].album === (item.album || 'Music')) return S.lib.music[j].tracks; }
    return [item];
  }

  // ------------------------------------------------------------ views

  function clearSel() { if (S.sel) S.sel.classList.remove('sel'); S.sel = null; }
  function setView(v) {
    if (S.sel) S.lastSel[S.view] = S.sel.getAttribute('data-key');
    clearSel();
    S.view = v;
    ['home', 'library', 'dashboard'].forEach(function (id) { $(id + 'View').hidden = id !== v; });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (t) { t.classList.toggle('on', t.getAttribute('data-view') === v); });
    if (v === 'dashboard') loadDash(true);
    render();
  }

  function render() {
    var keep = S.sel && S.sel.getAttribute('data-key');
    if (keep === null || keep === undefined) keep = S.lastSel[S.view];
    if (S.view === 'home') renderHome();
    else if (S.view === 'library') renderLibrary();
    else renderDashboard();
    var target = keep && (document.querySelector('#' + S.view + 'View [data-key="' + keep + '"]') || document.querySelector('#tabs [data-key="' + keep + '"]'));
    focus(target || firstFocusable());
    $('hint').textContent = hintFor();
  }
  function hintFor() {
    var d = S.dash;
    var url = d && d.ip ? 'Phone: http://' + d.ip + ':' + d.port + (d.configured ? '' : ' (password not set)') + '   ·   ' : '';
    if (S.view === 'library') return url + 'OK: open/play   ·   Back: up a level   ·   Blue: rescan drives';
    if (S.view === 'dashboard') return url + 'OK on a service: start it   ·   OK on Speed: run test   ·   Blue: refresh logs';
    return url + 'Left/Right on tabs to switch   ·   OK: open   ·   Yellow: ambient screen';
  }

  function posterCard(it, key, sub) {
    var c = el('div', 'card poster');
    c.setAttribute('data-key', key);
    c.setAttribute('tabindex', '-1');
    if (it.poster) { var im = el('img'); im.src = BASE + it.poster; im.alt = ''; im.onerror = function () { im.replaceWith(ph()); }; c.appendChild(im); } else c.appendChild(ph());
    function ph() { return el('div', 'ph', it.kind === 'audio' ? '♪' : '▶'); }
    if (it.progress && it.progress.dur) { var b = el('div', 'bar'), i = el('i'); i.style.width = (it.progress.pos / it.progress.dur * 100) + '%'; b.appendChild(i); c.appendChild(b); }
    var cap = el('div', 'cap');
    cap.appendChild(el('div', null, it.title));
    if (sub) cap.appendChild(el('div', 'sub', sub));
    c.appendChild(cap);
    c._action = function () { play(it); };
    return c;
  }
  function wideCard(title, sub, key, action, cls) {
    var c = el('div', 'card wide' + (cls ? ' ' + cls : ''));
    c.setAttribute('data-key', key);
    c.appendChild(el('div', null, title));
    if (sub) c.appendChild(el('div', 'sub', sub));
    c._action = action;
    return c;
  }

  function renderHome() {
    var d = S.dash, g = $('hwGrid');
    g.textContent = '';
    if (d) {
      var s = d.system;
      [['MODEL', s.realModel || s.model || 'Samsung TV'], ['FIRMWARE', s.firmware || '—'], ['UPTIME', fmtUp(s.uptime)], ['CPU', s.cpuLoad !== undefined ? Math.round(s.cpuLoad * 100) + '%' : (s.load ? s.load[0].toFixed(2) : '—')],
        ['MEMORY', fmtB(s.memTotal - s.memFree) + ' / ' + fmtB(s.memTotal)], ['NODE', s.node], ['IP', d.ip || '—'], ['LIBRARY', d.library.items + ' items']]
        .forEach(function (p) { g.appendChild(el('b', null, p[0])); g.appendChild(el('span', null, String(p[1]))); });
      var sv = $('hwServices'); sv.textContent = '';
      d.services.forEach(function (x) { var r = el('div', 'svcRow'); var l = el('span'); l.appendChild(el('span', 'dot' + (x.up ? ' up' : ''))); l.appendChild(document.createTextNode(x.name)); r.appendChild(l); r.appendChild(el('span', null, x.up ? 'UP' : 'DOWN')); sv.appendChild(r); });
      var st = $('hwStorage'); st.textContent = '';
      d.storage.forEach(function (x) {
        var r = el('div', 'storRow');
        r.appendChild(el('div', null, (x.kind === 'usb' ? 'USB ' : '') + x.label + (x.writable ? '' : ' (read-only)') + '  ' + (x.total ? fmtB(x.free) + ' free' : '')));
        var used = x.total ? 1 - x.free / x.total : 0;
        var b = el('div', 'bar' + (used > 0.9 ? ' warn' : '')), i = el('i'); i.style.width = (used * 100) + '%'; b.appendChild(i); r.appendChild(b); st.appendChild(r);
      });
    } else { g.appendChild(el('b', null, 'STATUS')); g.appendChild(el('span', null, 'connecting to service…')); }

    var shelf = $('cwShelf'); shelf.textContent = '';
    var cw = S.lib ? S.lib.continueWatching : [];
    $('cwLabel').hidden = !cw.length; shelf.hidden = !cw.length;
    cw.slice(0, 8).forEach(function (it) { shelf.appendChild(posterCard(it, 'cw-' + it.id, (it.show ? it.show + ' · ' : '') + fmtT(it.progress.pos) + ' / ' + fmtT(it.progress.dur))); });

    var dock = $('homeDock'); dock.textContent = '';
    [['Library', 'lib', function () { setView('library'); }], ['Dashboard', 'dash', function () { setView('dashboard'); }],
      ['Rescan drives', 'rescan', function () { toast('Rescanning…'); sendStorageHints(); loadLib(true); }],
      ['Ambient', 'ambient', goAmbient], ['Speed test', 'speed', runSpeedTest], ['Torrents', 'torr', function () { launchApp(APPS.torrents, 'Torrents'); }], ['Home screen', 'home', function () { launchApp(APPS.home, 'Home screen'); }]]
      .forEach(function (a) { var c = el('div', 'card', a[0]); c.setAttribute('data-key', 'dock-' + a[1]); c._action = a[2]; dock.appendChild(c); });
  }

  function renderLibrary() {
    var grid = $('libGrid'); grid.textContent = '';
    var crumb = [], level = S.libStack[S.libStack.length - 1];
    if (!S.lib) { $('libCrumb').textContent = 'Loading…'; return; }
    if (!level) {
      crumb = ['Library', S.lib.counts.items + ' items on ' + (S.lib.roots.join(', ') || 'no drives')];
      grid.appendChild(wideCard('Movies', S.lib.counts.movies + ' titles', 'movies', function () { pushLevel({ type: 'movies' }); }));
      grid.appendChild(wideCard('Shows', S.lib.counts.shows + ' series', 'shows', function () { pushLevel({ type: 'shows' }); }));
      grid.appendChild(wideCard('Music', S.lib.counts.albums + ' albums', 'music', function () { pushLevel({ type: 'music' }); }));
      grid.appendChild(wideCard('Everything', S.lib.counts.items + ' files, newest first', 'all', function () { pushLevel({ type: 'all' }); }));
      if (!S.lib.counts.items) grid.appendChild(wideCard('No media found', 'Plug in a USB drive with video or music files, then press Blue to rescan', 'none', null));
    } else if (level.type === 'movies') {
      crumb = ['Movies'];
      S.lib.movies.forEach(function (it) { grid.appendChild(posterCard(it, it.id, (it.year ? it.year + ' · ' : '') + it.source)); });
    } else if (level.type === 'shows') {
      crumb = ['Shows'];
      S.lib.shows.forEach(function (sh) {
        var c = posterCard({ title: sh.title, poster: sh.poster, kind: 'video' }, 'show-' + sh.title, sh.count + ' episodes');
        c._action = function () { pushLevel({ type: 'show', show: sh }); };
        grid.appendChild(c);
      });
    } else if (level.type === 'show') {
      crumb = ['Shows', level.show.title];
      level.show.seasons.forEach(function (s) {
        grid.appendChild(wideCard(s.season ? 'Season ' + s.season : 'Episodes', s.episodes.length + ' episodes', 'season-' + s.season, function () { pushLevel({ type: 'season', show: level.show, season: s }); }));
      });
    } else if (level.type === 'season') {
      crumb = ['Shows', level.show.title, level.season.season ? 'Season ' + level.season.season : 'Episodes'];
      level.season.episodes.forEach(function (e) {
        grid.appendChild(wideCard(e.title, fmtB(e.size) + (e.progress ? ' · ' + (e.progress.done ? 'watched' : fmtT(e.progress.pos) + ' in') : ''), e.id, function () { play(e); }));
      });
    } else if (level.type === 'music') {
      crumb = ['Music'];
      S.lib.music.forEach(function (al) {
        var c = posterCard({ title: al.album, poster: al.poster, kind: 'audio' }, 'album-' + al.album, al.tracks.length + ' tracks');
        c._action = function () { pushLevel({ type: 'album', album: al }); };
        grid.appendChild(c);
      });
    } else if (level.type === 'album') {
      crumb = ['Music', level.album.album];
      level.album.tracks.forEach(function (t) { grid.appendChild(wideCard(t.title, fmtB(t.size), t.id, function () { play(t); })); });
    } else if (level.type === 'all') {
      crumb = ['Everything'];
      allItems().sort(function (a, b) { return b.id < a.id ? -1 : 1; }).forEach(function (it) { grid.appendChild(wideCard(it.title, (it.show ? it.show + ' · ' : it.album ? it.album + ' · ' : '') + it.folder + ' · ' + fmtB(it.size), it.id, function () { play(it); })); });
    }
    $('libCrumb').textContent = crumb.join('  ›  ');
  }
  function pushLevel(l) { S.lastSel.library = null; clearSel(); S.libStack.push(l); render(); }
  function popLevel() { if (!S.libStack.length) return false; S.libStack.pop(); S.lastSel.library = null; clearSel(); render(); return true; }

  function renderDashboard() {
    var d = S.dash;
    var sv = $('dashServices'); sv.textContent = '';
    if (!d) { sv.appendChild(el('div', 'meta', 'Connecting…')); return; }
    d.services.forEach(function (x) {
      var c = el('div', 'item'); c.setAttribute('data-key', 'svc-' + x.id);
      c.appendChild(el('div', null, (x.up ? '● ' : '○ ') + x.name + '   ' + (x.up ? 'UP · ' + x.latency + ' ms' : 'DOWN')));
      c.appendChild(el('div', 'sub', x.desc + ' · port ' + x.port + (x.up ? '' : ' · OK to start')));
      c._action = x.up ? function () { toast(x.name + ' is running'); } : function () { startService(x.appId); toast('Starting ' + x.name + '…'); setTimeout(function () { loadDash(true); }, 3000); };
      sv.appendChild(c);
    });
    var st = $('dashStorage'); st.textContent = '';
    d.storage.forEach(function (x) {
      var c = el('div', 'item');
      c.appendChild(el('div', null, (x.kind === 'usb' ? 'USB: ' : '') + x.label + (x.writable ? '' : ' (read-only)')));
      c.appendChild(el('div', 'sub', x.total ? fmtB(x.total - x.free) + ' used of ' + fmtB(x.total) : 'size unknown'));
      var used = x.total ? 1 - x.free / x.total : 0;
      var b = el('div', 'bar' + (used > 0.9 ? ' warn' : '')), i = el('i'); i.style.width = (used * 100) + '%'; b.appendChild(i); c.appendChild(b);
      st.appendChild(c);
    });
    var sp = $('dashSpeed'); sp.textContent = '';
    var last = d.speed[d.speed.length - 1];
    var c = el('div', 'item'); c.setAttribute('data-key', 'speed');
    c.appendChild(el('div', null, last ? (last.error ? 'Last test failed' : '↓ ' + last.downMbps + ' Mbps   ↑ ' + last.upMbps + ' Mbps   ping ' + last.pingMs + ' ms') : 'No speed test yet'));
    c.appendChild(el('div', 'sub', (last ? new Date(last.at).toLocaleString() + ' · ' : '') + 'OK to run an internet speed test from the TV'));
    c._action = runSpeedTest;
    sp.appendChild(c);
    var lines = [];
    d.services.forEach(function (x) { (x.log || []).forEach(function (l) { lines.push([l.t, x.name, l.l, l.m]); }); });
    lines.sort(function (a, b) { return a[0] - b[0]; });
    var pre = $('dashLogs'); pre.textContent = '';
    lines.slice(-34).forEach(function (l) {
      var row = el('div', l[2] === 'error' ? 'logErr' : null, new Date(l[0]).toLocaleTimeString() + ' [' + l[1] + '] ' + l[3]);
      pre.appendChild(row);
    });
    if (!lines.length) pre.textContent = '(no log lines yet)';
  }

  var speedRunning = false;
  function runSpeedTest() {
    if (speedRunning) return toast('Speed test already running');
    speedRunning = true;
    toast('Running internet speed test (about 20 s)…');
    request('POST', '/api/speedtest').then(function (r) {
      toast(r.error ? 'Speed test failed: ' + r.error : 'Internet: ↓ ' + r.downMbps + ' Mbps  ↑ ' + r.upMbps + ' Mbps');
    }, function (e) { toast(e.message); }).then(function () { speedRunning = false; loadDash(false); });
  }

  // ------------------------------------------------------------ spatial focus

  function focusables() {
    var view = $(S.view + 'View');
    var list = Array.prototype.slice.call(document.querySelectorAll('#tabs .tab'));
    return list.concat(Array.prototype.filter.call(view.querySelectorAll('.card, .item'), function (e) { return !!e._action || e.classList.contains('poster') || e.classList.contains('wide'); }));
  }
  function firstFocusable() {
    var view = $(S.view + 'View');
    var f = view.querySelector('[data-key]');
    return f || document.querySelector('#tabs .tab.on');
  }
  function focus(e) {
    if (S.sel) S.sel.classList.remove('sel');
    S.sel = e;
    if (e) { e.classList.add('sel'); if (e.scrollIntoView) e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  function move(dir) {
    var cur = S.sel;
    if (!cur) return focus(firstFocusable());
    var r = cur.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    var best = null, bestScore = Infinity;
    focusables().forEach(function (e) {
      if (e === cur) return;
      var b = e.getBoundingClientRect(), bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
      var dx = bx - cx, dy = by - cy, primary, secondary;
      if (dir === 'left') { primary = -dx; secondary = Math.abs(dy); }
      else if (dir === 'right') { primary = dx; secondary = Math.abs(dy); }
      else if (dir === 'up') { primary = -dy; secondary = Math.abs(dx); }
      else { primary = dy; secondary = Math.abs(dx); }
      var overlap = (dir === 'left' || dir === 'right') ? (b.top < r.bottom && b.bottom > r.top) : (b.left < r.right && b.right > r.left);
      if (primary < 8) return;
      if (!overlap && secondary > primary) return;   // stay within a 45-degree cone unless aligned
      var score = primary + secondary * (overlap ? 0.5 : 2.5);
      if (score < bestScore) { bestScore = score; best = e; }
    });
    if (best) focus(best);
  }
  function activate() {
    var e = S.sel;
    if (!e) return;
    if (e.classList.contains('tab')) { setView(e.getAttribute('data-view')); return; }
    if (e._action) e._action();
  }

  // ------------------------------------------------------------ subtitles

  function parseCues(text) {
    var cues = [];
    text.replace(/\r/g, '').split(/\n\n+/).forEach(function (block) {
      var lines = block.split('\n').filter(function (l) { return l.trim(); });
      var ti = -1;
      for (var i = 0; i < lines.length && i < 2; i++) if (lines[i].indexOf('-->') > 0) ti = i;
      if (ti < 0) return;
      var m = /(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/.exec(lines[ti]) || /(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+)[.,](\d+)/.exec(lines[ti]);
      if (!m) return;
      var a, b;
      if (m.length === 9) { a = m[1] * 3600 + m[2] * 60 + +m[3] + m[4] / 1000; b = m[5] * 3600 + m[6] * 60 + +m[7] + m[8] / 1000; }
      else { a = m[1] * 60 + +m[2] + m[3] / 1000; b = m[4] * 60 + +m[5] + m[6] / 1000; }
      cues.push({ a: a, b: b, text: lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '') });
    });
    return cues;
  }
  function loadSubs(item) {
    S.subs = null;
    if (!item.subs || !item.subs.length) return;
    var pick = item.subs[0];
    item.subs.forEach(function (s) { if (/^(en|eng|english|default)$/i.test(s.lang)) pick = s; });
    var x = new XMLHttpRequest();
    x.open('GET', BASE + pick.url);
    x.onload = function () { if (x.status === 200) { S.subs = parseCues(x.responseText); updateSubs(); } };
    x.send();
  }
  function updateSubs() {
    var box = $('subs');
    if (!S.playing || !S.subs || !S.subsOn) { box.hidden = true; return; }
    var t = S.playing.pos, show = null;
    for (var i = 0; i < S.subs.length; i++) if (S.subs[i].a <= t && t <= S.subs[i].b) { show = S.subs[i]; break; }
    box.hidden = !show;
    if (show) box.textContent = show.text;
  }

  // ------------------------------------------------------------ player

  var av = hasAV ? window.webapis.avplay : null;
  var vid = $('vid');

  function play(item) {
    stopPlayback(true);
    var startAt = item.progress && !item.progress.done ? item.progress.pos : 0;
    S.playing = { item: item, paused: false, pos: startAt, dur: (item.progress && item.progress.dur) || 0, buffering: 0 };
    document.body.classList.add('playing');
    $('osdTitle').textContent = (item.show ? item.show + ' — ' : '') + item.title;
    showOsd(startAt ? 'Resuming at ' + fmtT(startAt) : 'Starting…');
    loadSubs(item);
    var url = BASE + '/media/' + item.id;
    if (av) {
      try {
        av.open(url);
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setListener({
          onbufferingstart: function () { if (S.playing) S.playing.buffering = 0; showOsd('Buffering…'); },
          onbufferingprogress: function (p) { if (S.playing) { S.playing.buffering = p; updateOsdInfo(); } },
          onbufferingcomplete: function () { if (S.playing) { S.playing.buffering = 100; S.osdNote = ''; updateOsdInfo(); } },
          oncurrentplaytime: function (ms) { if (S.playing) { S.playing.pos = ms / 1000; updateOsdTime(); updateSubs(); } },
          onstreamcompleted: function () { finished(); },
          onerror: function (e) { toast('Playback error: ' + e + ' (format may not be supported)'); stopPlayback(); }
        });
        av.prepareAsync(function () {
          if (!S.playing) return;
          S.playing.dur = av.getDuration() / 1000;
          if (startAt > 5 && startAt < S.playing.dur - 10) { try { av.seekTo(startAt * 1000); } catch (e) { /* not seekable */ } }
          av.play();
          showOsd();
        }, function (e) { toast('Could not open: ' + (e && e.name ? e.name : e)); stopPlayback(); });
      } catch (e) { toast('Player error: ' + e.message); stopPlayback(); }
    } else {
      vid.hidden = false; vid.src = url;
      vid.onloadedmetadata = function () { if (S.playing) { S.playing.dur = vid.duration; if (startAt > 5 && startAt < vid.duration - 10) vid.currentTime = startAt; } };
      vid.ontimeupdate = function () { if (S.playing) { S.playing.pos = vid.currentTime; updateOsdTime(); updateSubs(); } };
      vid.onwaiting = function () { showOsd('Buffering…'); };
      vid.onplaying = function () { S.osdNote = ''; updateOsdInfo(); };
      vid.onended = function () { finished(); };
      vid.onerror = function () { toast('This browser cannot play ' + item.name); stopPlayback(); };
      vid.play().catch(function () {});
    }
    reportPlayer();
  }
  function finished() {
    var item = S.playing && S.playing.item;
    if (item) request('PUT', '/api/progress/' + item.id, { pos: S.playing.dur || S.playing.pos, dur: S.playing.dur || S.playing.pos }).catch(function () {});
    var sib = item ? siblingsOf(item) : [];
    var idx = -1; sib.forEach(function (x, i) { if (x.id === item.id) idx = i; });
    if (idx >= 0 && idx + 1 < sib.length) { toast('Next: ' + sib[idx + 1].title); play(sib[idx + 1]); }
    else { stopPlayback(); loadLib(false); }
  }
  function saveProgress() {
    var p = S.playing;
    if (!p || !p.item) return;
    request('PUT', '/api/progress/' + p.item.id, { pos: p.pos, dur: p.dur }).catch(function () {});
  }
  function stopPlayback(silent) {
    if (S.playing && !silent) saveProgress();
    if (av) { try { av.stop(); av.close(); } catch (e) { /* idle */ } }
    if (!vid.hidden || vid.src) { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.hidden = true; }
    var was = S.playing;
    S.playing = null; S.subs = null;
    $('osd').hidden = true; $('subs').hidden = true;
    document.body.classList.remove('playing');
    reportPlayer();
    if (was && !silent) loadLib(false);
  }
  function togglePause() {
    if (!S.playing) return;
    if (av) { var st = av.getState(); if (st === 'PLAYING') { av.pause(); S.playing.paused = true; } else if (st === 'PAUSED' || st === 'READY') { av.play(); S.playing.paused = false; } }
    else if (vid.paused) { vid.play(); S.playing.paused = false; } else { vid.pause(); S.playing.paused = true; }
    showOsd(S.playing.paused ? 'Paused' : '');
    if (S.playing.paused) saveProgress();
    reportPlayer();
  }
  function seek(sec) {
    if (!S.playing) return;
    if (av) { try { if (sec > 0) av.jumpForward(sec * 1000); else av.jumpBackward(-sec * 1000); } catch (e) { toast('Can’t seek yet'); } }
    else if (isFinite(vid.duration)) vid.currentTime = Math.max(0, Math.min(vid.duration - 1, vid.currentTime + sec));
    showOsd((sec > 0 ? '+' : '−') + Math.abs(sec) + 's');
  }
  function playRelative(step) {
    var item = S.playing && S.playing.item;
    if (!item) return;
    var sib = siblingsOf(item), idx = -1;
    sib.forEach(function (x, i) { if (x.id === item.id) idx = i; });
    var next = sib[idx + step];
    if (next) { saveProgress(); play(next); } else toast(step > 0 ? 'No next item' : 'No previous item');
  }
  function showOsd(note) {
    $('osd').hidden = false;
    if (note !== undefined) S.osdNote = note;
    updateOsdInfo(); updateOsdTime();
    clearTimeout(S.osdTimer);
    S.osdTimer = setTimeout(function () { if (S.playing && !S.playing.paused) $('osd').hidden = true; }, 4000);
  }
  function updateOsdInfo() {
    if (!S.playing) return;
    var parts = [];
    if (S.osdNote) parts.push(S.osdNote);
    if (S.playing.buffering > 0 && S.playing.buffering < 100) parts.push('Buffering ' + S.playing.buffering + '%');
    if (S.subs) parts.push('Subtitles ' + (S.subsOn ? 'on' : 'off') + ' (Green)');
    $('osdInfo').textContent = parts.join('     ');
  }
  function updateOsdTime() {
    if (!S.playing) return;
    var p = S.playing;
    $('osdTime').textContent = fmtT(p.pos) + (p.dur ? ' / ' + fmtT(p.dur) : '');
    $('osdBar').style.width = p.dur ? Math.min(100, p.pos / p.dur * 100) + '%' : '0';
  }

  // ------------------------------------------------------------ input

  var R = window.Remote || { KEY: {}, register: function () {}, digit: function () { return -1; } };
  function registerKeys() { R.register(); }
  function hideApp() { if (hasTizen) { try { tizen.application.getCurrentApplication().hide(); } catch (e) { /* ignore */ } } }
  function back() {
    if (S.playing) { stopPlayback(); return; }
    if (S.view === 'library' && popLevel()) return;
    if (S.view !== 'home') { setView('home'); return; }
    if (hasTizen) { try { tizen.application.getCurrentApplication().hide(); } catch (e) { /* ignore */ } }
  }
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (S.playing) {
      switch (k) {
        case KEY.ENTER: case KEY.PLAYPAUSE: togglePause(); break;
        case KEY.PLAY: if (S.playing.paused) togglePause(); break;
        case KEY.PAUSE: if (!S.playing.paused) togglePause(); break;
        case KEY.LEFT: seek(-10); break;
        case KEY.RIGHT: seek(10); break;
        case KEY.RW: seek(-60); break;
        case KEY.FF: seek(60); break;
        case KEY.NEXT: playRelative(1); break;
        case KEY.PREV: playRelative(-1); break;
        case KEY.GREEN: case R.KEY.CAPTION: S.subsOn = !S.subsOn; updateSubs(); showOsd(); break;   // CC/VD toggles subtitles
        case R.KEY.CH_UP: playRelative(1); break;
        case R.KEY.CH_DOWN: playRelative(-1); break;
        case KEY.UP: case KEY.DOWN: case R.KEY.INFO: showOsd(); break;
        case KEY.STOP: case KEY.BACK: case KEY.ESC: case R.KEY.EXIT: stopPlayback(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    switch (k) {
      case KEY.UP: move('up'); break;
      case KEY.DOWN: move('down'); break;
      case KEY.LEFT: move('left'); break;
      case KEY.RIGHT: move('right'); break;
      case KEY.ENTER: activate(); break;
      case KEY.BACK: case KEY.ESC: back(); break;
      case KEY.BLUE: if (S.view === 'dashboard') loadDash(true); else { toast('Rescanning drives…'); sendStorageHints(); loadLib(true); } break;
      case KEY.YELLOW: goAmbient(); break;
      case R.KEY.GUIDE: S.libStack = []; setView('library'); break;
      case R.KEY.CH_LIST: S.libStack = [{ type: 'all' }]; setView('library'); break;
      case R.KEY.CH_UP: move('up'); move('up'); move('up'); break;
      case R.KEY.CH_DOWN: move('down'); move('down'); move('down'); break;
      case R.KEY.INFO: if (S.sel) toast(S.sel.innerText.replace(/\s*\n\s*/g, '  ·  ')); break;
      case R.KEY.EXIT: hideApp(); break;
      default: {
        var d = R.digit(k);
        if (d === 1) setView('home'); else if (d === 2) { S.libStack = []; setView('library'); } else if (d === 3) setView('dashboard'); else if (d === 0) goAmbient();
        else return;
      }
    }
    e.preventDefault();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (S.playing && !S.playing.paused) togglePause(); }
    else { sendStorageHints(); sendSystemHints(); loadLib(false); loadDash(false); }
  });

  // ------------------------------------------------------------ ambient (idle screen)

  var AMB = window.AMBIENT_CONFIG || {};
  var lastInput = Date.now();
  function goAmbient() { saveProgress(); location.href = 'ambient/index.html'; }
  document.addEventListener('keydown', function () { lastInput = Date.now(); }, true);
  setInterval(function () {
    if (!AMB.idleMinutes || S.playing || document.hidden) return;
    if (Date.now() - lastInput > AMB.idleMinutes * 60000) goAmbient();
  }, 15000);

  // ------------------------------------------------------------ boot

  function tickClock() { var d = new Date(); $('clock').textContent = ((d.getHours() % 12) || 12) + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() + (d.getHours() < 12 ? ' AM' : ' PM'); }
  registerKeys();
  startService();
  tickClock(); setInterval(tickClock, 15000);
  sendStorageHints(); sendSystemHints();
  setInterval(sendStorageHints, 30000); setInterval(sendSystemHints, 60000);
  setView(['home', 'library', 'dashboard'].indexOf(location.hash.slice(1)) >= 0 ? location.hash.slice(1) : 'home');
  if (location.hash) history.replaceState(null, '', location.pathname);
  setTimeout(function () { loadLib(false); loadDash(true); }, hasTizen ? 1200 : 0);
  setInterval(function () { if (document.hidden) return; pollRemote(); if (S.playing) reportPlayer(); }, 2000);
  setInterval(function () { if (document.hidden) return; if (!S.playing) loadDash(S.view === 'dashboard'); }, 10000);
  setInterval(function () { if (S.playing && !S.playing.paused) saveProgress(); }, 15000);
})();
