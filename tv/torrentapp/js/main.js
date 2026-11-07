(function () {
  'use strict';
  var BASE = 'http://127.0.0.1:8091';
  var SERVICE_ID = 'DashTorr01.engine';
  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412
  };
  var hasTizen = typeof window.tizen !== 'undefined';
  var hasAV = !!(window.webapis && window.webapis.avplay);
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    view: 'list', data: null, items: [], sel: 0, selByView: {},
    detailHash: null, playing: null, lastPlayId: null, osdTimer: null, failures: 0
  };

  // ------------------------------------------------------------ helpers

  function fmtB(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < 4) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtT(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '';
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function peerText(n) { return n + (n === 1 ? ' peer' : ' peers'); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function request(method, path, body) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(method, BASE + path);
      x.timeout = 15000;
      if (body !== undefined) x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () {
        var d = null;
        try { d = JSON.parse(x.responseText); } catch (e) { /* empty */ }
        if (x.status >= 200 && x.status < 300) resolve(d);
        else reject(new Error((d && d.error) || ('HTTP ' + x.status)));
      };
      x.onerror = x.ontimeout = function () { reject(new Error('engine not reachable')); };
      x.send(body === undefined ? null : JSON.stringify(body));
    });
  }
  function act(method, path, body, okMsg) {
    return request(method, path, body).then(function (d) {
      if (okMsg) toast(okMsg);
      return poll().then(function () { return d; });
    }, function (e) { toast(e.message); });
  }
  function entry(hash) {
    var list = (S.data && S.data.torrents) || [];
    for (var i = 0; i < list.length; i++) if (list[i].infoHash === hash) return list[i];
    return null;
  }
  function usbStorage() {
    var list = (S.data && S.data.storages) || [];
    for (var i = 0; i < list.length; i++) if (list[i].kind === 'usb' && list[i].writable) return list[i];
    return null;
  }
  function statusLabel(t) {
    if (t.complete) return ['done', 'Complete'];
    if (t.paused) return ['', 'Paused'];
    return t.mode === 'stream' ? ['stream', 'Stream'] : ['download', 'Downloading'];
  }
  function torrentLine(t) {
    var parts = [Math.floor(t.progress * 100) + '% of ' + fmtB(t.length)];
    if (t.active) {
      parts.push('↓ ' + fmtB(t.downloadSpeed) + '/s', peerText(t.peers));
      if (t.mode === 'download' && !t.complete && t.timeRemaining) parts.push(fmtT(t.timeRemaining) + ' left');
    }
    if (!t.ready && t.active && !t.files.length) parts = ['Finding peers and reading torrent info…'];
    if (t.error) parts.push('Error: ' + t.error);
    return parts.join('  ·  ');
  }

  // ------------------------------------------------------------ engine / storage

  function startService() {
    if (!hasTizen) return;
    try {
      tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
        SERVICE_ID, function () {}, function (e) { console.log('service launch failed', e && e.message); });
    } catch (e) { console.log('service launch error', e.message); }
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
            tizen.filesystem.resolve(s.label, function (dir) {
              var uri = dir.toURI ? dir.toURI() : '';
              if (uri.indexOf('file://') === 0) paths.push(decodeURI(uri.slice(7)));
              done();
            }, done, 'r');
          } catch (e) { done(); }
        });
      });
    } catch (e) { console.log('listStorages failed', e.message); }
  }

  function poll() {
    return request('GET', '/api/state').then(function (d) {
      S.data = d;
      S.failures = 0;
      renderStatus();
      if (S.playing) updateOsdInfo();
      else render();
      var pr = d.playRequest;
      if (pr && pr.id !== S.lastPlayId) {
        S.lastPlayId = pr.id;
        var t = entry(pr.infoHash);
        if (t && t.files[pr.file]) play(t, t.files[pr.file]);
      }
    }, function () {
      S.failures++;
      $('status').textContent = 'Starting torrent engine…';
      if (S.failures % 5 === 1) startService();
    });
  }

  function renderStatus() {
    var d = S.data, lines = [];
    var usb = (d.storages || []).filter(function (s) { return s.kind === 'usb'; });
    if (!usb.length) lines.push('No USB drive · downloads go to TV storage');
    usb.forEach(function (s) {
      lines.push('USB ' + s.label + ': ' + (s.writable ? (s.free !== null ? fmtB(s.free) + ' free' : 'ready') : 'read-only'));
    });
    if (d.engine !== 'ok') lines.push('Engine error: ' + d.engine);
    $('status').textContent = lines.join('\n');
    $('status').style.whiteSpace = 'pre-line';
    var url = d.ip ? 'http://' + d.ip + ':' + d.port : '';
    Array.prototype.forEach.call(document.querySelectorAll('.phoneUrl'), function (n) { n.textContent = url; });
    $('hint').textContent = (url ? 'Add torrents from your phone: ' + url + (d.configured ? '' : ' (password not set)') + '   ·   ' : '') +
      'OK: open  ·  Back: return';
  }

  // ------------------------------------------------------------ views

  function setView(v) {
    S.selByView[S.view] = S.sel;
    S.view = v;
    S.sel = S.selByView[v] || 0;
    ['listView', 'detailView', 'addView'].forEach(function (id) { $(id).hidden = id !== v + 'View'; });
    render();
  }

  function item(container, cls, title, sub, action) {
    var e = el('div', 'item ' + (cls || ''));
    if (title instanceof Node) e.appendChild(title); else e.appendChild(el('div', null, title));
    if (sub) e.appendChild(el('div', 'sub', sub));
    container.appendChild(e);
    S.items.push({ el: e, action: action });
    return e;
  }

  function render() {
    if (!S.data && S.view !== 'add') return;
    S.items = [];
    if (S.view === 'list') renderList();
    else if (S.view === 'detail') renderDetail();
    else renderAdd();
    S.sel = Math.max(0, Math.min(S.sel, S.items.length - 1));
    highlight();
  }

  function renderList() {
    var box = $('list');
    box.textContent = '';
    item(box, '', '+  Add magnet link', null, function () { setView('add'); });
    var list = S.data.torrents.slice().reverse();
    if (!list.length) box.appendChild(el('p', 'meta', 'No torrents yet. Add one here or from your phone.'));
    list.forEach(function (t) {
      var head = el('div');
      var st = statusLabel(t);
      head.appendChild(el('span', 'badge ' + st[0], st[1]));
      head.appendChild(document.createTextNode(t.name));
      var e = item(box, '', head, torrentLine(t), function () { S.detailHash = t.infoHash; S.selByView.detail = 0; setView('detail'); });
      var bar = el('div', 'bar'), fill = el('i');
      fill.style.width = (t.progress * 100) + '%';
      bar.appendChild(fill);
      e.appendChild(bar);
    });
  }

  function renderDetail() {
    var t = entry(S.detailHash);
    if (!t) { setView('list'); return; }
    $('dTitle').textContent = t.name;
    $('dMeta').textContent = statusLabel(t)[1] + '  ·  ' + torrentLine(t);
    $('dBar').style.width = (t.progress * 100) + '%';
    var box = $('detail');
    box.textContent = '';
    var files = t.files.slice().sort(function (a, b) { return (b.playable - a.playable) || (b.length - a.length); });
    files.forEach(function (f) {
      var sub = fmtB(f.length) + '  ·  ' + Math.floor(f.progress * 100) + '%';
      item(box, '', (f.playable ? '▶  ' : '') + f.name, sub, f.playable ? function () { play(t, f); } : null);
    });
    if (!files.length) box.appendChild(el('p', 'meta', 'Waiting for torrent info…'));
    var h = '/api/torrents/' + t.infoHash;
    if (t.paused) item(box, 'action', 'Resume', null, function () { act('POST', h + '/resume', undefined, 'Resumed'); });
    else if (!t.complete) item(box, 'action', 'Pause', null, function () { act('POST', h + '/pause', undefined, 'Paused'); });
    if (t.mode === 'stream') {
      var usb = usbStorage();
      if (usb) item(box, 'action', 'Download to USB', null, function () { act('POST', h + '/download', { storage: usb.id }, 'Downloading to ' + usb.label); });
      item(box, 'action', 'Download to TV', null, function () { act('POST', h + '/download', { storage: 'internal' }, 'Downloading to TV storage'); });
    }
    item(box, 'action danger', 'Remove', null, function () {
      act('DELETE', h, undefined, 'Removed').then(function () { setView('list'); });
    });
    if (t.mode === 'download') {
      item(box, 'action danger', 'Remove + delete files', null, function () {
        act('DELETE', h + '?data=1', undefined, 'Removed and deleted').then(function () { setView('list'); });
      });
    }
  }

  function renderAdd() {
    var box = $('add');
    if (box.childNodes.length) {          // keep the input (and its text) across re-renders
      S.items = Array.prototype.map.call(box.querySelectorAll('.item'), function (e) { return { el: e, action: e._action }; });
      return;
    }
    var input = el('input');
    input.type = 'text';
    input.id = 'magnet';
    input.placeholder = 'magnet:?xt=urn:btih:…';
    var wrap = el('div');
    wrap.appendChild(input);
    function add(mode) {
      var m = input.value.trim();
      if (!m) { toast('Type or paste a magnet link first'); return; }
      var usb = usbStorage();
      act('POST', '/api/torrents', { magnet: m, mode: mode, storage: usb ? usb.id : 'internal' },
        mode === 'stream' ? 'Added for streaming' : 'Downloading to ' + (usb ? 'USB ' + usb.label : 'TV storage'))
        .then(function (d) { if (d) { input.value = ''; setView('list'); } });
    }
    var actions = [
      [wrap, '', function () { input.focus(); }],
      ['Stream', 'action', function () { add('stream'); }],
      ['Download', 'action', function () { add('download'); }],
      ['Cancel', 'action', function () { setView('list'); }]
    ];
    actions.forEach(function (a) { item(box, a[1], a[0], null, a[2])._action = a[2]; });
  }

  function highlight() {
    S.items.forEach(function (it, i) { it.el.classList.toggle('sel', i === S.sel); });
    var cur = S.items[S.sel];
    if (cur && cur.el.scrollIntoView) cur.el.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ player

  var av = hasAV ? window.webapis.avplay : null;
  var vid = $('vid');

  function play(t, f) {
    stopPlayback(true);
    S.playing = { hash: t.infoHash, file: f.index, name: f.name, buffering: 0, paused: false, pos: 0, dur: 0 };
    document.body.classList.add('playing');
    $('osdTitle').textContent = f.name;
    showOsd('Starting…');
    var url = BASE + '/stream/' + t.infoHash + '/' + f.index;
    if (av) {
      try {
        av.open(url);
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setListener({
          onbufferingstart: function () { S.playing && (S.playing.buffering = 0); showOsd('Buffering…'); },
          onbufferingprogress: function (p) { if (S.playing) { S.playing.buffering = p; updateOsdInfo(); } },
          onbufferingcomplete: function () { if (S.playing) { S.playing.buffering = 100; updateOsdInfo(); } },
          oncurrentplaytime: function (ms) { if (S.playing) { S.playing.pos = ms / 1000; updateOsdTime(); } },
          onstreamcompleted: function () { stopPlayback(); },
          onerror: function (e) { toast('Playback error: ' + e + ' (format may not be supported)'); stopPlayback(); }
        });
        av.prepareAsync(function () {
          if (!S.playing) return;
          S.playing.dur = av.getDuration() / 1000;
          av.play();
          showOsd();
        }, function (e) {
          toast('Could not open video: ' + (e && e.name ? e.name : e));
          stopPlayback();
        });
      } catch (e) {
        toast('Player error: ' + e.message);
        stopPlayback();
      }
    } else {
      vid.hidden = false;
      vid.src = url;
      vid.onloadedmetadata = function () { if (S.playing) S.playing.dur = vid.duration; };
      vid.ontimeupdate = function () { if (S.playing) { S.playing.pos = vid.currentTime; updateOsdTime(); } };
      vid.onwaiting = function () { showOsd('Buffering…'); };
      vid.onended = function () { stopPlayback(); };
      vid.onerror = function () { toast('This browser cannot play ' + f.name); stopPlayback(); };
      vid.play().catch(function () { /* autoplay policy; OK starts it */ });
    }
  }

  function stopPlayback(silent) {
    if (av) { try { av.stop(); av.close(); } catch (e) { /* idle */ } }
    if (!vid.hidden || vid.src) { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.hidden = true; }
    var was = S.playing;
    S.playing = null;
    $('osd').hidden = true;
    document.body.classList.remove('playing');
    if (was && !silent) render();
  }

  function togglePause() {
    if (!S.playing) return;
    if (av) {
      var st = av.getState();
      if (st === 'PLAYING') { av.pause(); S.playing.paused = true; } else if (st === 'PAUSED' || st === 'READY') { av.play(); S.playing.paused = false; }
    } else if (vid.paused) { vid.play(); S.playing.paused = false; } else { vid.pause(); S.playing.paused = true; }
    showOsd(S.playing.paused ? 'Paused' : null);
  }

  function seek(sec) {
    if (!S.playing) return;
    if (av) {
      try {
        if (sec > 0) av.jumpForward(sec * 1000); else av.jumpBackward(-sec * 1000);
      } catch (e) { toast('Can’t seek yet'); }
    } else if (isFinite(vid.duration)) {
      vid.currentTime = Math.max(0, Math.min(vid.duration - 1, vid.currentTime + sec));
    }
    showOsd((sec > 0 ? '+' : '−') + Math.abs(sec) + 's');
  }

  function showOsd(info) {
    $('osd').hidden = false;
    if (info !== undefined) S.osdNote = info;
    updateOsdInfo();
    updateOsdTime();
    clearTimeout(S.osdTimer);
    S.osdTimer = setTimeout(function () { if (S.playing && !S.playing.paused) $('osd').hidden = true; }, 4000);
  }

  function updateOsdInfo() {
    if (!S.playing) return;
    var t = entry(S.playing.hash), parts = [];
    if (S.osdNote) parts.push(S.osdNote);
    if (S.playing.buffering > 0 && S.playing.buffering < 100) parts.push('Buffering ' + S.playing.buffering + '%');
    if (t && t.active && !t.complete) parts.push('↓ ' + fmtB(t.downloadSpeed) + '/s  ·  ' + peerText(t.peers) + '  ·  ' + Math.floor(t.progress * 100) + '% downloaded');
    $('osdInfo').textContent = parts.join('     ');
  }

  function updateOsdTime() {
    if (!S.playing) return;
    var p = S.playing;
    $('osdTime').textContent = fmtT(p.pos) + (p.dur ? ' / ' + fmtT(p.dur) : '');
    $('osdBar').style.width = p.dur ? Math.min(100, p.pos / p.dur * 100) + '%' : '0';
  }

  // ------------------------------------------------------------ input

  function registerKeys() {
    if (!hasTizen || !tizen.tvinputdevice) return;
    ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind'].forEach(function (k) {
      try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* unsupported */ }
    });
  }

  function back() {
    if (S.playing) { stopPlayback(); return; }
    if (S.view !== 'list') { setView('list'); return; }
    if (hasTizen) { try { tizen.application.getCurrentApplication().hide(); } catch (e) { /* ignore */ } }
  }

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    var input = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (input) {
      if (k === KEY.ENTER || k === KEY.BACK || k === KEY.ESC || k === KEY.DOWN) {
        document.activeElement.blur();
        if (k === KEY.ENTER || k === KEY.DOWN) { S.sel = 1; highlight(); }
        e.preventDefault();
      }
      return;
    }
    if (S.playing) {
      switch (k) {
        case KEY.ENTER: case KEY.PLAYPAUSE: togglePause(); break;
        case KEY.PLAY: if (S.playing.paused) togglePause(); break;
        case KEY.PAUSE: if (!S.playing.paused) togglePause(); break;
        case KEY.LEFT: seek(-10); break;
        case KEY.RIGHT: seek(10); break;
        case KEY.RW: seek(-60); break;
        case KEY.FF: seek(60); break;
        case KEY.UP: case KEY.DOWN: showOsd(); break;
        case KEY.STOP: case KEY.BACK: case KEY.ESC: stopPlayback(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    switch (k) {
      case KEY.UP: case KEY.LEFT: S.sel = Math.max(0, S.sel - 1); highlight(); break;
      case KEY.DOWN: case KEY.RIGHT: S.sel = Math.min(S.items.length - 1, S.sel + 1); highlight(); break;
      case KEY.ENTER: { var it = S.items[S.sel]; if (it && it.action) it.action(); break; }
      case KEY.BACK: case KEY.ESC: back(); break;
      default: return;
    }
    e.preventDefault();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && S.playing && !S.playing.paused) togglePause();
    if (!document.hidden) { sendStorageHints(); poll(); }
  });

  // ------------------------------------------------------------ boot

  registerKeys();
  startService();
  sendStorageHints();
  setInterval(sendStorageHints, 30000);
  poll();
  setInterval(function () { if (!document.hidden) poll(); }, 2000);
})();
