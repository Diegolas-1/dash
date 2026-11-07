(function () {
  'use strict';
  var C = window.DASH_CONFIG;
  var SERVICE_ID = 'DashHome01.photos';
  var YOUTUBE_ID = '111299001912';
  var BASE = 'http://127.0.0.1:' + C.servicePort;
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406 };
  var hasTizen = typeof window.tizen !== 'undefined';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    photos: [], photoIdx: -1, layer: 0, photoTimer: null,
    rows: [], row: 0, col: 0,
    lastInput: Date.now(), saver: false, dimOverride: null,
    uploadUrl: null, prayer: null, prayerDay: null
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function getJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url);
      x.timeout = timeoutMs || 10000;
      x.onload = function () {
        if (x.status >= 200 && x.status < 300) {
          try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
        } else reject(new Error('HTTP ' + x.status));
      };
      x.onerror = x.ontimeout = function () { reject(new Error('network')); };
      x.send();
    });
  }
  function fmtTime(h, m) {
    if (C.clock24h) return pad(h) + ':' + pad(m);
    return ((h % 12) || 12) + ':' + pad(m) + (h < 12 ? ' AM' : ' PM');
  }
  function minutesOf(hhmm) {
    var p = String(hhmm).slice(0, 5).split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  // ------------------------------------------------------------ clock

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function tickClock() {
    var d = new Date();
    $('time').textContent = C.clock24h ? fmtTime(d.getHours(), d.getMinutes())
      : fmtTime(d.getHours(), d.getMinutes()).replace(/ (AM|PM)$/, '');
    $('date').textContent = DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
    updateDim(d);
    updatePrayerHighlight(d);
    if (state.prayerDay !== d.toDateString() && C.prayerTimes.enabled) loadPrayers();
    if (C.screensaverMinutes > 0 && !state.saver && Date.now() - state.lastInput > C.screensaverMinutes * 60000) {
      setSaver(true);
    }
  }

  // ------------------------------------------------------------ weather (open-meteo, no key)

  var WMO = [[0, 'Clear'], [1, 'Mostly clear'], [2, 'Partly cloudy'], [3, 'Overcast'], [48, 'Fog'], [57, 'Drizzle'],
    [67, 'Rain'], [77, 'Snow'], [82, 'Showers'], [86, 'Snow showers'], [99, 'Thunderstorms']];
  function wmoText(code) {
    for (var i = 0; i < WMO.length; i++) if (code <= WMO[i][0]) return WMO[i][1];
    return '';
  }
  function loadWeather() {
    var L = C.location;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + L.latitude + '&longitude=' + L.longitude +
      '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min' +
      '&temperature_unit=' + C.temperatureUnit + '&timezone=auto&forecast_days=1';
    getJSON(url).then(function (d) {
      var deg = '°';
      $('wTemp').textContent = Math.round(d.current.temperature_2m) + deg;
      $('wDesc').textContent = wmoText(d.current.weather_code) + ' · ' + L.name;
      $('wRange').textContent = 'H ' + Math.round(d.daily.temperature_2m_max[0]) + deg +
        '  L ' + Math.round(d.daily.temperature_2m_min[0]) + deg;
      $('weather').hidden = false;
    }).catch(function () { /* keep last value */ });
  }

  // ------------------------------------------------------------ prayer times (aladhan, no key)

  var PRAYERS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
  function loadPrayers() {
    var d = new Date();
    state.prayerDay = d.toDateString();
    var P = C.prayerTimes, L = C.location;
    var url = 'https://api.aladhan.com/v1/timings/' + pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear() +
      '?latitude=' + L.latitude + '&longitude=' + L.longitude + '&method=' + P.method + '&school=' + P.school;
    getJSON(url).then(function (r) {
      state.prayer = r.data.timings;
      var box = $('prayers');
      box.textContent = '';
      PRAYERS.forEach(function (name) {
        var hhmm = String(state.prayer[name]).slice(0, 5);
        var row = document.createElement('div');
        row.className = 'p';
        row.setAttribute('data-min', minutesOf(hhmm));
        var a = document.createElement('span'); a.textContent = name;
        var b = document.createElement('span'); b.textContent = fmtTime(Math.floor(minutesOf(hhmm) / 60), minutesOf(hhmm) % 60);
        row.appendChild(a); row.appendChild(b); box.appendChild(row);
      });
      box.hidden = false;
      updatePrayerHighlight(new Date());
    }).catch(function () { state.prayerDay = null; });
  }
  function updatePrayerHighlight(d) {
    if (!state.prayer) return;
    var now = d.getHours() * 60 + d.getMinutes();
    var rows = $('prayers').querySelectorAll('.p'), next = null;
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.remove('next');
      if (!next && parseInt(rows[i].getAttribute('data-min'), 10) > now) next = rows[i];
    }
    (next || rows[0]).classList.add('next');
  }

  // ------------------------------------------------------------ dimming & screensaver

  function inDimWindow(d) {
    var now = d.getHours() * 60 + d.getMinutes();
    var s = minutesOf(C.dim.start), e = minutesOf(C.dim.end);
    return s <= e ? (now >= s && now < e) : (now >= s || now < e);
  }
  function updateDim(d) {
    var on = state.dimOverride !== null ? state.dimOverride : inDimWindow(d || new Date());
    $('dim').style.opacity = on ? C.dim.level : 0;
  }
  function setSaver(on) {
    state.saver = on;
    document.body.classList.toggle('saver', on);
    restartPhotoTimer(on ? 2 : 1);
  }

  // ------------------------------------------------------------ photos

  function startService() {
    if (!hasTizen) return;
    [SERVICE_ID].concat(C.backgroundServices || []).forEach(function (id) {
      try {
        tizen.application.launchAppControl(
          new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'),
          id, function () {}, function (e) { console.log('service launch failed', id, e && e.message); });
      } catch (e) { console.log('service launch error', id, e.message); }
    });
  }
  function loadPhotos() {
    return getJSON(BASE + '/api/photos', 5000).then(function (d) {
      var had = state.photos.length;
      state.photos = d.photos.map(function (p) { return BASE + '/photos/' + encodeURIComponent(p.name); });
      state.uploadUrl = d.ip ? 'http://' + d.ip + ':' + d.port : null;
      if (!had && state.photos.length) nextPhoto();
      if (!state.photos.length) showEmpty();
      renderHint(d.configured);
    }).catch(function () {
      startService();
      if (!state.photos.length) showEmpty();
    });
  }
  function showEmpty() {
    var l = $(state.layer ? 'bgB' : 'bgA');
    l.className = 'layer on empty';
    l.style.backgroundImage = '';
  }
  function nextPhoto() {
    if (!state.photos.length) return;
    var order = state.photos.length > 1 ? state.photos.length : 1;
    var idx = state.photoIdx;
    if (order > 1) {
      do { idx = Math.floor(Math.random() * order); } while (idx === state.photoIdx);
    } else idx = 0;
    state.photoIdx = idx;
    var url = state.photos[idx];
    var img = new Image();
    img.onload = function () {
      var incoming = $(state.layer ? 'bgA' : 'bgB');
      var outgoing = $(state.layer ? 'bgB' : 'bgA');
      incoming.style.backgroundImage = 'url("' + url + '")';
      incoming.className = 'layer on';
      outgoing.className = 'layer';
      state.layer = 1 - state.layer;
    };
    img.src = url;
  }
  function restartPhotoTimer(factor) {
    clearInterval(state.photoTimer);
    state.photoTimer = setInterval(nextPhoto, C.photoIntervalSec * 1000 * (factor || 1));
  }

  // ------------------------------------------------------------ dock

  function initials(name) {
    return name.split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
  }
  function appTile(app) {
    var t = document.createElement('div');
    t.className = 'tile';
    var icon = null;
    if (hasTizen) {
      try {
        var info = tizen.application.getAppInfo(app.appId);
        if (info && info.iconPath) {
          icon = document.createElement('img');
          icon.src = info.iconPath;
          icon.onerror = function () { icon.replaceWith(ini()); };
        }
      } catch (e) { t.classList.add('missing'); }
    }
    function ini() { var s = document.createElement('div'); s.className = 'ini'; s.textContent = initials(app.name); return s; }
    t.appendChild(icon || ini());
    var label = document.createElement('div');
    label.textContent = app.name;
    t.appendChild(label);
    t.action = function () { launchApp(app); };
    return t;
  }
  function ytTile(s) {
    var t = document.createElement('div');
    t.className = 'tile yt';
    var a = document.createElement('div'); a.textContent = s.title;
    var b = document.createElement('div'); b.className = 'kind'; b.textContent = s.type === 'playlist' ? 'Playlist' : 'Video';
    t.appendChild(a); t.appendChild(b);
    t.action = function () { launchYouTube(s); };
    return t;
  }
  function buildDock() {
    var appRow = $('appRow'), ytRow = $('ytRow');
    state.rows = [C.apps.map(function (a) { var t = appTile(a); appRow.appendChild(t); return t; })];
    if (C.youtube && C.youtube.length) {
      state.rows.push(C.youtube.map(function (s) { var t = ytTile(s); ytRow.appendChild(t); return t; }));
    } else {
      $('ytLabel').hidden = true;
    }
    focus(0, 0);
  }
  function focus(r, c) {
    if (!state.rows.length || !state.rows[0].length) return;
    r = Math.max(0, Math.min(state.rows.length - 1, r));
    c = Math.max(0, Math.min(state.rows[r].length - 1, c));
    var cur = state.rows[state.row] && state.rows[state.row][state.col];
    if (cur) cur.classList.remove('focus');
    state.row = r; state.col = c;
    state.rows[r][c].classList.add('focus');
  }
  function renderHint(configured) {
    var parts = [];
    if (state.uploadUrl) parts.push('Add photos: ' + state.uploadUrl + (configured ? '' : ' (password not set)'));
    parts.push('Red: dim  ·  Green: next photo  ·  Yellow: screensaver');
    $('hint').textContent = parts.join('  \u00B7  ');
  }

  // ------------------------------------------------------------ launching

  function launchApp(app) {
    if (!hasTizen) return toast('Would launch ' + app.name);
    tizen.application.launch(app.appId, function () {}, function (e) {
      toast(app.name + ' could not be opened (' + (e && e.name) + ')');
    });
  }
  function launchYouTube(s) {
    var values = (s.type === 'playlist' ? 'list=' : 'v=') + s.id;
    if (!hasTizen) return toast('Would open YouTube ' + values);
    try {
      var ctrl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', null, null, null,
        [new tizen.ApplicationControlData('PAYLOAD', [JSON.stringify({ values: values })])]);
      tizen.application.launchAppControl(ctrl, YOUTUBE_ID, function () {}, function () {
        launchApp({ name: 'YouTube', appId: YOUTUBE_ID });
      });
    } catch (e) {
      launchApp({ name: 'YouTube', appId: YOUTUBE_ID });
    }
  }

  // ------------------------------------------------------------ input

  function registerKeys() {
    if (!hasTizen || !tizen.tvinputdevice) return;
    ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'].forEach(function (k) {
      try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* unsupported key */ }
    });
  }
  document.addEventListener('keydown', function (e) {
    state.lastInput = Date.now();
    if (state.saver) {
      setSaver(false);
      e.preventDefault();
      return;
    }
    switch (e.keyCode) {
      case KEY.LEFT: focus(state.row, state.col - 1); break;
      case KEY.RIGHT: focus(state.row, state.col + 1); break;
      case KEY.UP: focus(state.row - 1, state.col); break;
      case KEY.DOWN: focus(state.row + 1, state.col); break;
      case KEY.ENTER: { var t = state.rows[state.row] && state.rows[state.row][state.col]; if (t) t.action(); break; }
      case KEY.RED:
        state.dimOverride = state.dimOverride === null ? !inDimWindow(new Date()) : null;
        updateDim();
        toast(state.dimOverride === null ? 'Dimming: schedule' : (state.dimOverride ? 'Dimmed' : 'Not dimmed'));
        break;
      case KEY.GREEN: nextPhoto(); restartPhotoTimer(); break;
      case KEY.YELLOW: setSaver(true); break;
      case KEY.BLUE: loadPhotos(); toast('Reloading photos'); break;
      case KEY.BACK:
        if (hasTizen) { try { tizen.application.getCurrentApplication().hide(); } catch (err) { /* ignore */ } }
        break;
      default: return;
    }
    e.preventDefault();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      state.lastInput = Date.now();
      setSaver(false);
      loadPhotos();
    }
  });

  // ------------------------------------------------------------ boot

  registerKeys();
  startService();
  buildDock();
  tickClock();
  setInterval(tickClock, 15000);
  loadWeather();
  setInterval(loadWeather, 30 * 60000);
  if (C.prayerTimes.enabled) loadPrayers();
  showEmpty();
  setTimeout(loadPhotos, hasTizen ? 1500 : 0);
  setInterval(loadPhotos, 60000);
  restartPhotoTimer();
})();
