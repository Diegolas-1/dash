(function () {
  'use strict';
  var C = window.AMBIENT_CONFIG || {};
  var Q = parseQuery(location.search);
  var STANDALONE = 'standalone' in Q;          // Fire TV / browser: keys don't leave the page
  var THEME = document.documentElement.getAttribute('data-theme') || 'ink';
  var STEPPED = THEME === 'poster';            // poster theme draws the temperature as steps
  var ART_PACK = THEME === 'parks' ? 'parks' : null;   // themes with bundled artwork instead of the photo service
  var FORCE_DEMO = Q.demo === '1';
  var $ = function (id) { return document.getElementById(id); };
  var SVG = 'http://www.w3.org/2000/svg';

  var S = { weather: null, dash: null, player: null, library: null, torrents: null, photos: [], photoIdx: -1, photoLayer: 0, art: null, artIdx: -1,
    calendar: null, prayer: null, demo: false, coreFails: 0, rotIdx: 0, mode: '', shift: 0,
    lights: null, lf: { idx: 0, armed: false, adjust: false, timer: null }, pending: {}, enterDown: 0, enterHeld: false };

  // ------------------------------------------------------------ utils

  function parseQuery(qs) { var o = {}; qs.replace(/^\?/, '').split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); o[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); }); return o; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function now() {
    if (Q.t) { var d = new Date(), p = Q.t.split(':'); d.setHours(+p[0], +p[1] || 0, 0, 0); return d; }
    return new Date();
  }
  function minutesOf(hhmm) { var p = String(hhmm).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
  function inWindow(d, w) { if (!w || !w.start || !w.end) return false; var m = d.getHours() * 60 + d.getMinutes(), s = minutesOf(w.start), e = minutesOf(w.end); return s <= e ? (m >= s && m < e) : (m >= s || m < e); }
  function fmtClock(d, withAmPm) { var h = d.getHours(), m = pad(d.getMinutes()); if (C.clock24h) return { h: pad(h), m: m, ap: '' }; return { h: String((h % 12) || 12), m: m, ap: h < 12 ? 'AM' : 'PM' }; }
  function fmtShort(d) { var c = fmtClock(d); return c.h + ':' + c.m + (c.ap ? ' ' + c.ap.toLowerCase() : ''); }
  function fmtHour(d) { var h = d.getHours(); if (C.clock24h) return pad(h) + ':00'; return ((h % 12) || 12) + (h < 12 ? 'am' : 'pm'); }
  function fmtB(n) { if (n === null || n === undefined) return '?'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i >= 3 ? 1 : 0) + ' ' + u[i]; }
  function fmtT(sec) { sec = Math.max(0, Math.round(sec || 0)); var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + pad(m) : m) + ':' + pad(s); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
  function svgEl(tag, attrs) { var e = document.createElementNS(SVG, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function useIcon(host, id) { host.textContent = ''; var u = document.createElementNS(SVG, 'use'); u.setAttribute('href', '#' + id); u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + id); host.appendChild(u); }
  function getJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(); x.open('GET', url); x.timeout = timeoutMs || 8000;
      x.onload = function () { if (x.status >= 200 && x.status < 300) { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); } } else reject(new Error('HTTP ' + x.status)); };
      x.onerror = x.ontimeout = function () { reject(new Error('network')); };
      x.send();
    });
  }
  function getText(url) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(); x.open('GET', url); x.timeout = 10000;
      x.onload = function () { x.status < 300 ? resolve(x.responseText) : reject(new Error('HTTP ' + x.status)); };
      x.onerror = x.ontimeout = function () { reject(new Error('network')); };
      x.send();
    });
  }
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ------------------------------------------------------------ clock & modes

  function tick() {
    var d = now(), c = fmtClock(d);
    if ($('hh').textContent !== c.h) $('hh').textContent = c.h;
    if ($('mm').textContent !== c.m) $('mm').textContent = c.m;
    $('ampm').textContent = c.ap;
    $('dow').textContent = DAYS[d.getDay()];
    $('date').textContent = MONTHS[d.getMonth()] + ' ' + d.getDate();
    var h = d.getHours(), g = h < 5 ? 'Still up?' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
    $('greeting').textContent = g + (C.greetingName ? ', ' + C.greetingName : '');
    $('sleepTime').textContent = c.h + ':' + c.m;
    $('sleepDate').textContent = DAYS[d.getDay()] + ' · ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
    var mode = inWindow(d, C.sleep) ? 'sleep' : inWindow(d, C.night) ? 'night' : 'day';
    if (mode !== S.mode) { S.mode = mode; document.body.setAttribute('data-mode', mode); $('sleepClock').hidden = mode !== 'sleep'; }
  }

  // Burn-in protection: nudge the whole stage a few pixels every 90 s.
  function pixelShift() {
    var offsets = [[0, 0], [6, 3], [-5, 6], [4, -6], [-6, -3], [3, 5], [-3, -6]];
    S.shift = (S.shift + 1) % offsets.length;
    var o = offsets[S.shift];
    $('stage').style.transform = 'translate(' + o[0] + 'px,' + o[1] + 'px)';
    $('sleepClock').style.transform = 'translate(calc(-50% + ' + (o[0] * 4) + 'px), calc(-50% + ' + (o[1] * 4) + 'px))';
  }

  // ------------------------------------------------------------ weather

  var WMO = [[0, 'Clear', 'sun'], [1, 'Mostly clear', 'sun'], [2, 'Partly cloudy', 'cloud-sun'], [3, 'Overcast', 'cloud'], [48, 'Fog', 'fog'], [57, 'Drizzle', 'rain'],
    [67, 'Rain', 'rain'], [77, 'Snow', 'snow'], [82, 'Showers', 'rain'], [86, 'Snow showers', 'snow'], [99, 'Thunderstorms', 'storm']];
  function wmo(code, isDay) {
    for (var i = 0; i < WMO.length; i++) if (code <= WMO[i][0]) { var ic = WMO[i][2]; if (isDay === 0 && ic === 'sun') ic = 'moon'; if (isDay === 0 && ic === 'cloud-sun') ic = 'cloud'; return { text: WMO[i][1], icon: 'i-' + ic }; }
    return { text: '', icon: 'i-cloud' };
  }
  function loadWeather() {
    var L = C.location || {};
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + L.latitude + '&longitude=' + L.longitude +
      '&current=temperature_2m,weather_code,is_day,wind_speed_10m,relative_humidity_2m,apparent_temperature' +
      '&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
      '&temperature_unit=' + (C.temperatureUnit || 'celsius') + '&wind_speed_unit=mph&timezone=auto&forecast_days=6';
    return getJSON(url, 12000).then(function (d) { S.weather = d; renderWeather(); }).catch(function (e) { console.error('weather', e && e.message); if (!S.weather) { S.weather = demoWeather(); S.demo = true; renderWeather(); } });
  }
  function renderWeather() {
    var w = S.weather; if (!w) return;
    $('weather').hidden = false;
    var cur = w.current, info = wmo(cur.weather_code, cur.is_day);
    useIcon(document.querySelector('.wIcon'), info.icon);
    $('wTemp').textContent = Math.round(cur.temperature_2m);
    $('wDesc').textContent = info.text + (C.location && C.location.name ? ' in ' + C.location.name : '');
    var d0 = w.daily;
    $('wSub').textContent = 'H ' + Math.round(d0.temperature_2m_max[0]) + '°  L ' + Math.round(d0.temperature_2m_min[0]) + '°   ·   feels ' + Math.round(cur.apparent_temperature) + '°   ·   wind ' + Math.round(cur.wind_speed_10m) + ' mph';
    renderCurve(w);
    var t0 = now(), nextSun = null;
    [].concat(d0.sunrise || [], d0.sunset || []).forEach(function (iso) { var dt = new Date(iso); if (dt > t0 && (!nextSun || dt < nextSun.dt)) nextSun = { dt: dt, rise: (d0.sunrise || []).indexOf(iso) >= 0 }; });
    $('pfText').textContent = nextSun ? (nextSun.rise ? 'Sunrise ' : 'Sunset ') + fmtShort(nextSun.dt) : '';
    $('pfEmpty').classList.toggle('night', !cur.is_day);
    var days = $('wDays'); days.textContent = '';
    for (var i = 1; i < Math.min(6, d0.time.length); i++) {
      var dt = new Date(d0.time[i] + 'T12:00:00'), di = wmo(d0.weather_code[i], 1), row = el('div', 'wDay');
      row.appendChild(el('span', 'd', DAYS[dt.getDay()].slice(0, 3)));
      var ic = document.createElementNS(SVG, 'svg'); useIcon(ic, di.icon); row.appendChild(ic);
      row.appendChild(el('span', 'hi', Math.round(d0.temperature_2m_max[i]) + '°'));
      row.appendChild(el('span', 'lo', Math.round(d0.temperature_2m_min[i]) + '°'));
      days.appendChild(row);
    }
  }
  function renderCurve(w) {
    var svg = $('wCurve'); svg.textContent = '';
    // size the drawing to the rendered box so text keeps its proportions in every theme
    var W = Math.round(svg.clientWidth) || 1040, H = Math.round(svg.clientHeight) || 230;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var padL = 10, padR = 10, top = Math.round(H * 0.2), bottom = Math.min(56, Math.round(H * 0.38));
    var compact = H < 160;
    var t = now(), startIdx = 0;
    for (var i = 0; i < w.hourly.time.length; i++) { if (new Date(w.hourly.time[i]) <= t) startIdx = i; else break; }
    var hours = [];
    for (var j = startIdx; j < Math.min(startIdx + 25, w.hourly.time.length); j++) hours.push({ t: new Date(w.hourly.time[j]), v: w.hourly.temperature_2m[j], p: w.hourly.precipitation_probability[j] || 0 });
    if (hours.length < 2) return;
    var vals = hours.map(function (h) { return h.v; }), min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 6) { var mid = (max + min) / 2; min = mid - 3; max = mid + 3; }
    var x = function (i) { return padL + (W - padL - padR) * i / (hours.length - 1); };
    var y = function (v) { return top + (H - top - bottom) * (1 - (v - min) / (max - min)); };
    var defs = svgEl('defs', {}), grad = svgEl('linearGradient', { id: 'curveFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svgEl('stop', { offset: '0', class: 's0' }));
    grad.appendChild(svgEl('stop', { offset: '1', class: 's1' }));
    defs.appendChild(grad); svg.appendChild(defs);
    // smooth path (Catmull-Rom -> cubic)
    var pts = hours.map(function (h, i) { return [x(i), y(h.v)]; });
    var d = 'M' + pts[0][0] + ',' + pts[0][1];
    for (var k = 0; k < pts.length - 1; k++) {
      if (STEPPED) { d += ' H' + pts[k + 1][0] + ' V' + pts[k + 1][1]; continue; }
      var p0 = pts[k - 1] || pts[k], p1 = pts[k], p2 = pts[k + 1], p3 = pts[k + 2] || p2;
      d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6) + ',' + (p1[1] + (p2[1] - p0[1]) / 6) + ' ' + (p2[0] - (p3[0] - p1[0]) / 6) + ',' + (p2[1] - (p3[1] - p1[1]) / 6) + ' ' + p2[0] + ',' + p2[1];
    }
    var base = H - bottom + 2;
    svg.appendChild(svgEl('path', { class: 'area', d: d + ' L' + pts[pts.length - 1][0] + ',' + base + ' L' + pts[0][0] + ',' + base + ' Z' }));
    svg.appendChild(svgEl('line', { class: 'grid', x1: padL, x2: W - padR, y1: base, y2: base }));
    // precipitation probability: thin bars under the baseline (only when meaningful)
    var rainH = compact ? 8 : 16, sunY = compact ? base + 20 : base + 32;
    hours.forEach(function (h, i) { if (h.p >= 20) svg.appendChild(svgEl('rect', { class: 'rain', x: x(i) - 3, y: base + 3, width: 6, height: Math.max(2, h.p / 100 * rainH), rx: 1.5 })); });
    // hour ticks every 6h
    hours.forEach(function (h, i) { if (i % 6 === 0 && i < hours.length - 1) { var tx = svgEl('text', { class: 'tick', x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : 'middle' }); tx.textContent = i === 0 ? 'NOW' : fmtHour(h.t).toUpperCase(); svg.appendChild(tx); } });
    // sunrise / sunset marks within the window
    [['sunrise', 'rise'], ['sunset', 'set']].forEach(function (pair) {
      (w.daily[pair[0]] || []).slice(0, 3).forEach(function (iso) {
        var st = new Date(iso), frac = (st - hours[0].t) / (hours[hours.length - 1].t - hours[0].t);
        if (frac <= 0.01 || frac >= 0.99) return;
        var sx = padL + (W - padL - padR) * frac;
        svg.appendChild(svgEl('line', { class: 'sun', x1: sx, x2: sx, y1: base - 10, y2: base + 1 }));
        var lbl = svgEl('text', { class: 'sunLbl', x: sx, y: sunY, 'text-anchor': compact ? (frac > 0.8 ? 'end' : 'start') : 'middle' }); lbl.textContent = (pair[1] === 'rise' ? '☀ ' : '☾ ') + fmtShort(st); svg.appendChild(lbl);
      });
    });
    svg.appendChild(svgEl('path', { class: 'line', d: d }));
    // selective labels: high and low only
    var hiI = vals.indexOf(Math.max.apply(null, vals)), loI = vals.indexOf(Math.min.apply(null, vals));
    [[hiI, compact ? -8 : -14], [loI, compact ? -8 : -14]].forEach(function (pr) {
      var i = pr[0]; if (i === 0) return;
      var lb = svgEl('text', { class: 'lbl', x: Math.min(W - 24, Math.max(24, x(i))), y: y(hours[i].v) + pr[1], 'text-anchor': 'middle' }); lb.textContent = Math.round(hours[i].v) + '°'; svg.appendChild(lb);
    });
    svg.appendChild(svgEl('line', { class: 'nowLine', x1: x(0), x2: x(0), y1: y(hours[0].v) + 10, y2: base }));
    svg.appendChild(svgEl('circle', { class: 'now', cx: x(0), cy: y(hours[0].v), r: 6 }));
  }

  // ------------------------------------------------------------ services

  function core(path) { return getJSON(C.services.core + path, 4000); }
  function loadCore() {
    return Promise.all([core('/api/dashboard'), core('/api/player'), core('/api/library')]).then(function (r) {
      S.dash = r[0]; S.player = r[1]; S.library = r[2]; S.coreFails = 0; S.demo = FORCE_DEMO;
      if (FORCE_DEMO) applyDemo();
      renderAll();
    }).catch(function () {
      S.coreFails++;
      if (!S.dash && (S.coreFails >= 2 || FORCE_DEMO)) { applyDemo(); renderAll(); }
    });
  }
  function loadTorrents() {
    return getJSON(C.services.torrents + '/api/state', 4000).then(function (d) { S.torrents = d; }).catch(function () { if (!S.torrents && S.demo) S.torrents = demoTorrents(); });
  }
  function loadPhotos() {
    if (C.backdrop === 'aurora' || ART_PACK) return;
    getJSON(C.services.photos + '/api/photos', 4000).then(function (d) {
      S.photos = (d.photos || []).map(function (p) { return C.services.photos + '/photos/' + encodeURIComponent(p.name); });
      if (S.photos.length && S.photoIdx < 0) nextPhoto();
      if (!S.photos.length) document.body.classList.remove('photos');
    }).catch(function () { if (!S.photos.length) document.body.classList.remove('photos'); });
  }
  function nextPhoto() {
    if (!S.photos.length || S.mode === 'sleep') return;
    var idx = S.photos.length > 1 ? (S.photoIdx + 1 + Math.floor(Math.random() * (S.photos.length - 1))) % S.photos.length : 0;
    S.photoIdx = idx;
    var img = new Image();
    img.onload = function () {
      var inL = $(S.photoLayer ? 'photoA' : 'photoB'), outL = $(S.photoLayer ? 'photoB' : 'photoA');
      inL.style.backgroundImage = 'url("' + S.photos[idx] + '")'; inL.classList.add('on'); outL.classList.remove('on');
      var fIn = $(S.photoLayer ? 'pfA' : 'pfB'), fOut = $(S.photoLayer ? 'pfB' : 'pfA');
      fIn.style.backgroundImage = inL.style.backgroundImage; fIn.classList.add('on'); fOut.classList.remove('on');
      S.photoLayer = 1 - S.photoLayer; document.body.classList.add('photos');
    };
    img.src = S.photos[idx];
  }

  // ------------------------------------------------------------ art pack (parks theme)

  function hexToHsl(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, sat = 0;
    if (max !== min) {
      var d = max - min; sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
    }
    return [h, sat, l];
  }
  function hsl(h, s, l) { return 'hsl(' + Math.round(h * 360) + ',' + Math.round(s * 100) + '%,' + Math.round(l * 100) + '%)'; }
  function loadArt() {
    if (!ART_PACK) return;
    var list = (window.ART_PACKS || {})[ART_PACK];   // art/<pack>/manifest.js, loaded by a script tag so it works from file://
    if (!list || !list.length) { console.error('art pack missing', ART_PACK); return; }
    S.art = list.map(function (a) { a.lum = hexToHsl(a.dominant)[2]; return a; });
    nextArt();
  }
  function nextArt() {
    if (!S.art || !S.art.length || S.mode === 'sleep') return;
    var pool = S.art;
    if (C.art && C.art.duskAtNight && S.mode === 'night') { var dusk = S.art.filter(function (a) { return a.lum < 0.42; }); if (dusk.length > 3) pool = dusk; }
    var pick, tries = 0;
    do { pick = pool[Math.floor(Math.random() * pool.length)]; tries++; } while (S.art.indexOf(pick) === S.artIdx && tries < 5);
    S.artIdx = S.art.indexOf(pick);
    var img = new Image();
    img.onload = function () {
      var inL = $(S.photoLayer ? 'photoA' : 'photoB'), outL = $(S.photoLayer ? 'photoB' : 'photoA');
      inL.style.backgroundImage = 'url("art/' + ART_PACK + '/' + pick.file + '")'; inL.classList.add('on'); outL.classList.remove('on');
      S.photoLayer = 1 - S.photoLayer; document.body.classList.add('photos');
      var acc = hexToHsl(pick.accent), dark = hexToHsl(pick.dark), light = hexToHsl(pick.light);
      var root = document.documentElement.style;
      root.setProperty('--art-accent', hsl(acc[0], Math.min(0.85, acc[1] + 0.1), Math.max(0.62, acc[2])));
      root.setProperty('--art-dark', hsl(dark[0], Math.min(0.5, dark[1]), Math.min(0.14, dark[2])));
      root.setProperty('--art-light', hsl(light[0], Math.min(0.4, light[1]), Math.max(0.9, light[2])));
      root.setProperty('--art-dominant', pick.dominant);
      var cap = $('artCaption'); cap.classList.add('swap');
      setTimeout(function () {
        $('artPark').textContent = pick.park === 'American Samoa' ? 'National Park of American Samoa' : pick.park + ' National Park';
        $('artState').textContent = pick.state; cap.classList.remove('swap');
      }, 900);
    };
    img.src = 'art/' + ART_PACK + '/' + pick.file;
  }

  function loadCalendar() {
    if (!C.calendarIcsUrl) return;
    getText(C.calendarIcsUrl).then(function (txt) { S.calendar = parseIcs(txt); renderRotate(); }).catch(function () {});
  }
  function parseIcs(txt) {
    var lines = txt.replace(/\r/g, '').replace(/\n[ \t]/g, '').split('\n'), events = [], cur = null;
    lines.forEach(function (line) {
      if (line === 'BEGIN:VEVENT') cur = {};
      else if (line === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; }
      else if (cur) {
        var i = line.indexOf(':'); if (i < 0) return;
        var key = line.slice(0, i), val = line.slice(i + 1), name = key.split(';')[0];
        if (name === 'SUMMARY') cur.title = val.replace(/\\,/g, ',');
        if (name === 'DTSTART' || name === 'DTEND') {
          var allDay = /VALUE=DATE(?!-TIME)/.test(key), m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(val);
          if (!m) return;
          var dt = m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) : new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
          cur[name === 'DTSTART' ? 'start' : 'end'] = dt; if (name === 'DTSTART') cur.allDay = allDay;
        }
      }
    });
    var t = now(), horizon = new Date(t.getTime() + 7 * 86400000);
    return events.filter(function (e) { return (e.end || e.start) >= t && e.start <= horizon; }).sort(function (a, b) { return a.start - b.start; }).slice(0, 5);
  }
  function loadPrayer() {
    var P = C.prayerTimes || {}; if (!P.enabled) return;
    var d = now(), L = C.location;
    getJSON('https://api.aladhan.com/v1/timings/' + pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear() + '?latitude=' + L.latitude + '&longitude=' + L.longitude + '&method=' + P.method + '&school=' + P.school, 10000)
      .then(function (r) { S.prayer = r.data.timings; renderRotate(); }).catch(function () {});
  }

  // ------------------------------------------------------------ render

  function renderAll() { renderMedia(); renderRotate(); renderLights(); renderStatus(); $('demoTag').hidden = !S.demo; }
  // If the column cannot fit everything, drop the rotating panel instead of showing a sliver of it.
  function fitColumn() {
    var col = document.querySelector('.column'), rot = $('pRotate');
    if (!col || !rot || rot.hidden) return;
    rot.classList.remove('squeezed');                       // measure with it shown (no paint happens in between)
    var tight = col.scrollHeight > col.clientHeight + 2 || rot.scrollHeight > rot.clientHeight + 2;
    if (tight) rot.classList.add('squeezed');
  }
  setInterval(fitColumn, 1000);

  function renderMedia() {
    var p = S.player, lib = S.library, panel = $('pMedia');
    var cw = lib && lib.continueWatching && lib.continueWatching[0];
    if (p && p.online && p.state !== 'idle' && p.id) {
      panel.hidden = false;
      $('mediaEyebrow').textContent = ''; $('mediaEyebrow').appendChild(el('i', 'live')); $('mediaEyebrow').appendChild(document.createTextNode(p.state === 'paused' ? 'Paused' : 'Now playing'));
      var item = findItem(p.id);
      setPoster(item);
      $('mediaTitle').textContent = p.title || (item && item.title) || '';
      $('mediaSub').textContent = (item && item.show ? item.show + '  ·  ' : '') + fmtT(p.pos) + (p.dur ? '  /  ' + fmtT(p.dur) : '');
      $('mediaBar').style.width = p.dur ? (p.pos / p.dur * 100) + '%' : '0';
    } else if (cw) {
      panel.hidden = false;
      $('mediaEyebrow').textContent = 'Continue watching';
      setPoster(cw);
      $('mediaTitle').textContent = cw.title;
      $('mediaSub').textContent = (cw.show ? cw.show + '  ·  ' : '') + fmtT(cw.progress.dur - cw.progress.pos) + ' left';
      $('mediaBar').style.width = (cw.progress.pos / cw.progress.dur * 100) + '%';
    } else if (lib && lib.counts && lib.counts.items) {
      panel.hidden = false;
      $('mediaEyebrow').textContent = 'Library';
      setPoster(null);
      $('mediaTitle').textContent = lib.counts.movies + ' films  ·  ' + lib.counts.shows + ' shows';
      $('mediaSub').textContent = lib.counts.albums + ' albums  ·  ' + lib.counts.items + ' files on ' + (lib.roots || []).join(', ');
      $('mediaBar').style.width = '0';
    } else panel.hidden = true;
  }
  function findItem(id) {
    var lib = S.library; if (!lib) return null;
    var all = (lib.movies || []).slice();
    (lib.shows || []).forEach(function (sh) { sh.seasons.forEach(function (s) { all = all.concat(s.episodes); }); });
    (lib.music || []).forEach(function (al) { all = all.concat(al.tracks); });
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function setPoster(item) {
    var p = $('mediaPoster');
    p.className = 'poster' + (item && item.kind === 'audio' ? ' audio' : '');
    p.style.backgroundImage = item && item.poster ? 'url("' + (item.poster.indexOf('http') === 0 ? item.poster : C.services.core + item.poster) + '")' : 'none';
  }

  function rotationPanels() {
    var list = [];
    if (S.calendar && S.calendar.length) list.push('calendar');
    if (S.prayer) list.push('prayer');
    var active = S.torrents && S.torrents.torrents ? S.torrents.torrents.filter(function (t) { return t.active && !t.complete && t.mode === 'download'; }) : [];
    if (active.length) list.push('downloads');
    if (S.dash && S.dash.speed && S.dash.speed.length) list.push('speed');
    if (S.library && S.library.continueWatching && S.library.continueWatching.length > 1) list.push('upnext');
    if (S.mode === 'night' && list.indexOf('calendar') < 0) list = list.filter(function (x) { return x !== 'speed'; });
    return list;
  }
  function renderRotate(advance) {
    var panels = rotationPanels(), panel = $('pRotate'), body = $('rotBody');
    if (!panels.length) { panel.hidden = true; return; }
    if (advance) S.rotIdx = (S.rotIdx + 1) % panels.length;
    var which = panels[S.rotIdx % panels.length];
    panel.hidden = false;
    function draw() {
      body.textContent = '';
      if (which === 'calendar') {
        $('rotEyebrow').textContent = 'Coming up';
        var t = now();
        S.calendar.slice(0, 4).forEach(function (e) {
          var row = el('div', 'evt' + (e.start <= t ? ' now' : ''));
          var sameDay = e.start.toDateString() === t.toDateString(), tomorrow = e.start.toDateString() === new Date(t.getTime() + 86400000).toDateString();
          var when = e.allDay ? (sameDay ? 'Today' : tomorrow ? 'Tomorrow' : DAYS[e.start.getDay()].slice(0, 3)) : (sameDay ? '' : tomorrow ? 'Tmrw ' : DAYS[e.start.getDay()].slice(0, 3) + ' ') + fmtShort(e.start);
          row.appendChild(el('span', 'when', when)); row.appendChild(el('span', 'what', e.title || '(untitled)')); body.appendChild(row);
        });
      } else if (which === 'prayer') {
        $('rotEyebrow').textContent = 'Prayer times';
        var nowMin = now().getHours() * 60 + now().getMinutes(), next = null;
        ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(function (n) {
          var hm = String(S.prayer[n]).slice(0, 5), m = minutesOf(hm), row = el('div', 'evt');
          if (!next && m > nowMin) { next = n; row.classList.add('now'); }
          var d = now(); d.setHours(Math.floor(m / 60), m % 60);
          row.appendChild(el('span', 'when', fmtShort(d))); row.appendChild(el('span', 'what', n)); body.appendChild(row);
        });
      } else if (which === 'downloads') {
        $('rotEyebrow').textContent = 'Downloading';
        S.torrents.torrents.filter(function (t) { return t.active && !t.complete && t.mode === 'download'; }).slice(0, 3).forEach(function (t) {
          var row = el('div', 'evt'); row.appendChild(el('span', 'when', Math.floor(t.progress * 100) + '%'));
          var w = el('span', 'what', t.name); row.appendChild(w); body.appendChild(row);
          var tr = el('div', 'track'), i = el('i'); i.style.width = (t.progress * 100) + '%'; tr.appendChild(i); body.appendChild(tr);
        });
      } else if (which === 'speed') {
        var sp = S.dash.speed[S.dash.speed.length - 1];
        $('rotEyebrow').textContent = 'Internet';
        var big = el('div', 'big'); big.textContent = sp.downMbps !== null ? sp.downMbps : '—'; var sm = el('small', null, 'Mbps down'); big.appendChild(sm); body.appendChild(big);
        body.appendChild(el('div', 'quiet', (sp.upMbps !== null ? sp.upMbps + ' Mbps up' : '') + (sp.pingMs !== null ? '  ·  ' + sp.pingMs + ' ms' : '') + '  ·  tested ' + fmtShort(new Date(sp.at))));
      } else if (which === 'upnext') {
        $('rotEyebrow').textContent = 'Pick up where you left off';
        S.library.continueWatching.slice(1, 4).forEach(function (it) {
          var row = el('div', 'evt'); row.appendChild(el('span', 'when', fmtT(it.progress.dur - it.progress.pos) + ' left')); row.appendChild(el('span', 'what', (it.show ? it.show + ' — ' : '') + it.title)); body.appendChild(row);
        });
      }
    }
    if (advance) { body.classList.add('fade'); setTimeout(function () { draw(); body.classList.remove('fade'); }, 900); } else draw();
  }

  // ------------------------------------------------------------ lights (switch bay)

  var LC = C.lights || {};
  function loadLights() {
    return core('/api/lights').then(function (d) { S.lights = d; renderLights(); }).catch(function () { if (!S.lights && (S.demo || FORCE_DEMO)) { S.lights = demoLights(); renderLights(); } });
  }
  function demoLights() {
    return { provider: 'demo', devices: [
      { id: 'd1', name: 'Floor lamp', on: true, brightness: 70, color: '#ffb366', online: true }, { id: 'd2', name: 'TV strip', on: true, brightness: 40, color: '#6ea8ff', online: true },
      { id: 'd3', name: 'Bedside', on: false, brightness: 30, color: '#ffd9a8', online: true }, { id: 'd4', name: 'Kitchen', on: true, brightness: 100, color: '#fff2d6', online: true },
      { id: 'd5', name: 'Desk', on: false, brightness: 55, color: '#c8ffd6', online: true }, { id: 'd6', name: 'Hall', on: true, brightness: 25, color: '#ffc7a1', online: true }] };
  }
  function lightIcon(name, fallback) { var ic = (LC.icons || {})[name]; return 'l-' + (ic || fallback || 'bulb'); }
  function tiles() {
    if (!S.lights) return [];
    var devs = S.lights.devices.slice(), grouped = {}, out = [];
    (LC.groups || []).forEach(function (g) {
      var members = devs.filter(function (d) { return g.members.indexOf(d.name) >= 0 || g.members.indexOf(d.id) >= 0; });
      if (!members.length) return;
      members.forEach(function (d) { grouped[d.id] = true; });
      var on = members.filter(function (d) { return d.on; });
      out.push({ key: 'g:' + g.name, name: g.name, icon: 'l-' + (g.icon || 'couch'), group: true, members: members, on: on.length > 0,
        brightness: Math.round((on.length ? on : members).reduce(function (a, d) { return a + d.brightness; }, 0) / (on.length ? on : members).length), color: (on[0] || members[0]).color });
    });
    devs.forEach(function (d) {
      if (LC.hideGroupedDevices && grouped[d.id]) return;
      out.push({ key: 'd:' + d.id, name: d.name, icon: lightIcon(d.name), group: false, members: [d], on: d.on, brightness: d.brightness, color: d.color, offline: d.online === false });
    });
    var order = LC.order || [];
    out.sort(function (a, b) { var ia = order.indexOf(a.name), ib = order.indexOf(b.name); if (ia < 0) ia = 999; if (ib < 0) ib = 999; return ia - ib || (b.group - a.group) || a.name.localeCompare(b.name); });
    return out;
  }
  function renderLights() {
    var panel = $('pLights'), bay = $('lightBay'), list = tiles();
    if (!list.length) { panel.hidden = true; return; }
    panel.hidden = false;
    bay.textContent = '';
    S.lf.idx = Math.max(0, Math.min(S.lf.idx, list.length - 1));
    list.forEach(function (t, i) {
      var sw = el('div', 'sw' + (t.on ? ' on' : '') + (t.group ? ' grp' : '') + (t.offline ? ' off' : '') + (S.lf.armed && i === S.lf.idx ? (S.lf.adjust ? ' focus adjust' : ' focus') : ''));
      sw.setAttribute('data-key', t.key);
      var rocker = el('div', 'rocker');
      var lvl = el('i', 'lvl'); lvl.style.height = (t.on ? t.brightness : 0) + '%'; lvl.style.background = t.color; rocker.appendChild(lvl);
      var ic = document.createElementNS(SVG, 'svg'); ic.setAttribute('class', 'ic'); useIcon(ic, t.icon); rocker.appendChild(ic);
      rocker.appendChild(el('span', 'pct', t.on ? t.brightness + '%' : 'off'));
      sw.appendChild(rocker);
      sw.appendChild(el('div', 'swName', t.name));
      bay.appendChild(sw);
    });
    var hint = $('lightsHint');
    hint.textContent = !S.lf.armed ? '' : S.lf.adjust ? 'Up / Down: brightness  ·  Back: done' : 'OK: on/off  ·  hold OK: brightness';
    if (S.lights && S.lights.error && S.lights.provider === 'govee') hint.textContent = 'Govee: ' + S.lights.error;
  }
  function armLights() {
    S.lf.armed = true;
    clearTimeout(S.lf.timer);
    S.lf.timer = setTimeout(function () { S.lf.armed = false; S.lf.adjust = false; renderLights(); }, 9000);
  }
  function currentTile() { var list = tiles(); return list[S.lf.idx] || null; }
  function setLight(dev, patch) {
    Object.assign(dev, patch);                 // optimistic
    S.pending[dev.id] = Object.assign(S.pending[dev.id] || {}, patch);
    clearTimeout(setLight.timers[dev.id]);
    setLight.timers[dev.id] = setTimeout(function () {
      var body = S.pending[dev.id]; delete S.pending[dev.id];
      if (!S.lights || S.lights.provider === 'demo') return;
      var x = new XMLHttpRequest(); x.open('PUT', C.services.core + '/api/lights/' + encodeURIComponent(dev.id)); x.setRequestHeader('Content-Type', 'application/json');
      x.onload = function () { if (x.status >= 300) { try { var d = JSON.parse(x.responseText); $('lightsHint').textContent = d.error || 'light error'; } catch (e) { /* ignore */ } } };
      x.send(JSON.stringify(body));
    }, 400);
  }
  setLight.timers = {};
  function toggleTile(t) { var on = !t.on; t.members.forEach(function (d) { setLight(d, { on: on }); }); renderLights(); }
  function nudgeTile(t, delta) {
    var step = LC.step || 10;
    t.members.forEach(function (d) {
      if (!d.on) { setLight(d, { on: true, brightness: d.brightness || step }); return; }   // from off: come back at the last level
      var b = Math.max(step, Math.min(100, Math.round((d.brightness + delta) / step) * step));
      if (b !== d.brightness) setLight(d, { brightness: b });
    });
    renderLights();
  }
  function lightsKey(e) {
    var k = e.keyCode, t = currentTile();
    if (!t) return false;
    if (k === 37 || k === 39) {                                           // left / right: move focus
      if (S.lf.armed) { var n = tiles().length; S.lf.idx = (S.lf.idx + (k === 39 ? 1 : -1) + n) % n; }
      S.lf.adjust = false; armLights(); renderLights(); return true;
    }
    if (k === 38 || k === 40) {                                           // up / down: brightness (in adjust mode)
      if (!S.lf.armed) { armLights(); renderLights(); return true; }
      if (!S.lf.adjust) { S.lf.adjust = true; }
      nudgeTile(t, k === 38 ? (LC.step || 10) : -(LC.step || 10)); armLights(); return true;
    }
    if (k === 13) return true;                                            // enter handled on keyup (click vs hold)
    if (k === 10009 || k === 27) {                                        // back: leave adjust, then disarm, then exit
      if (S.lf.adjust) { S.lf.adjust = false; armLights(); renderLights(); return true; }
      if (S.lf.armed) { S.lf.armed = false; clearTimeout(S.lf.timer); renderLights(); return true; }
      return false;
    }
    return false;
  }
  function enterPress(down, e) {
    var t = currentTile();
    if (!t) return;
    if (down) {
      if (!S.lf.armed) { armLights(); renderLights(); S.enterDown = Date.now(); S.enterHeld = true; return; }   // first touch only wakes the bay
      if (!S.enterDown) { S.enterDown = Date.now(); S.enterHeld = false; return; }
      if (e.repeat || Date.now() - S.enterDown > 450) { if (!S.enterHeld) { S.enterHeld = true; S.lf.adjust = true; armLights(); renderLights(); } }
      return;
    }
    var held = S.enterHeld || (S.enterDown && Date.now() - S.enterDown > 450);
    if (!held && S.enterDown && !S.lf.adjust) toggleTile(t);
    else if (held && !S.lf.adjust && S.enterDown && Date.now() - S.enterDown > 450) { S.lf.adjust = true; renderLights(); }
    S.enterDown = 0; S.enterHeld = false; armLights();
  }

  function renderStatus() {
    var d = S.dash, line = $('statusline'); line.textContent = '';
    if (!d) { line.appendChild(el('i')); line.appendChild(document.createTextNode('Connecting to the house…')); return; }
    var down = d.services.filter(function (s) { return !s.up; }), parts = [];
    line.className = 'statusline' + (down.length ? ' alert' : '');
    line.appendChild(el('i'));
    parts.push(down.length ? down.map(function (s) { return s.name; }).join(', ') + (down.length === 1 ? ' is' : ' are') + ' down' : 'Everything is running');
    var usb = d.storage.filter(function (s) { return s.kind === 'usb'; });
    if (usb.length) parts.push(usb.length + (usb.length === 1 ? ' drive' : ' drives') + ' · ' + fmtB(usb.reduce(function (s, x) { return s + (x.free || 0); }, 0)) + ' free');
    if (d.library && d.library.items) parts.push(d.library.items + ' items in the library');
    parts.push('updated ' + fmtShort(now()));
    line.appendChild(document.createTextNode(parts.join('   ·   ')));
  }

  // ------------------------------------------------------------ demo data (when no services are reachable)

  function applyDemo() {
    S.demo = true;
    S.dash = { ip: '192.168.1.40', services: [{ name: 'Dash Server', up: true }, { name: 'Photos', up: true }, { name: 'Torrents', up: true }],
      storage: [{ id: 'internal', label: 'TV storage', kind: 'internal', free: 2.1e9, total: 8e9, writable: true }, { id: 'usb', label: 'Seagate', kind: 'usb', free: 1.31e12, total: 2e12, writable: true }],
      speed: [{ at: Date.now() - 3600000 * 5, downMbps: 412.6, upMbps: 38.2, pingMs: 11 }], system: { uptime: 86400 * 12 + 3600 * 6 }, library: { items: 212 } };
    S.player = { online: true, state: 'playing', id: 'demo1', title: 'Christmas 1994', pos: 1312, dur: 3840 };
    S.library = { counts: { items: 212, movies: 64, shows: 9, albums: 23 }, roots: ['Seagate'],
      continueWatching: [{ id: 'demo1', title: 'Christmas 1994', kind: 'video', poster: null, progress: { pos: 1312, dur: 3840 } },
        { id: 'demo2', title: 'S02E04 The Lighthouse', show: 'Harbor Days', kind: 'video', progress: { pos: 900, dur: 2700 } },
        { id: 'demo3', title: 'Lake Tahoe, summer 1998', kind: 'video', progress: { pos: 300, dur: 1500 } }], movies: [], shows: [], music: [] };
    S.torrents = demoTorrents();
    if (!S.lights || S.lights.provider === 'demo') S.lights = demoLights();
    if (!S.calendar) { var t = now(); S.calendar = [
      { start: new Date(t.getTime() + 3600000 * 2), title: 'Dinner with Sam', allDay: false }, { start: new Date(t.getTime() + 86400000), title: 'Recycling day', allDay: true },
      { start: new Date(t.getTime() + 86400000 + 3600000 * 15), title: 'Parent–teacher conferences', allDay: false }]; }
  }
  function demoTorrents() { return { torrents: [{ name: 'debian-13.1-amd64-netinst.iso', active: true, complete: false, mode: 'download', progress: 0.63, downloadSpeed: 2.4e6 }] }; }
  function demoWeather() {
    var t = now(), hourly = { time: [], temperature_2m: [], precipitation_probability: [], weather_code: [] }, daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], sunrise: [], sunset: [] };
    for (var i = -1; i < 48; i++) { var d = new Date(t); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + i); hourly.time.push(isoLocal(d)); var h = d.getHours(); hourly.temperature_2m.push(Math.round(52 + 9 * Math.sin((h - 9) / 24 * Math.PI * 2) + (i > 20 ? -3 : 0))); hourly.precipitation_probability.push(i > 14 && i < 22 ? 55 : 5); hourly.weather_code.push(2); }
    for (var j = 0; j < 6; j++) { var dd = new Date(t); dd.setDate(dd.getDate() + j); daily.time.push(isoLocal(dd).slice(0, 10)); daily.weather_code.push([2, 3, 61, 1, 0, 2][j]); daily.temperature_2m_max.push(61 - j); daily.temperature_2m_min.push(44 - j); var sr = new Date(dd); sr.setHours(6, 38, 0, 0); var ss = new Date(dd); ss.setHours(16, 46, 0, 0); daily.sunrise.push(isoLocal(sr)); daily.sunset.push(isoLocal(ss)); }
    return { current: { temperature_2m: hourly.temperature_2m[1], weather_code: 2, is_day: t.getHours() > 6 && t.getHours() < 17 ? 1 : 0, wind_speed_10m: 7, relative_humidity_2m: 58, apparent_temperature: hourly.temperature_2m[1] - 2 }, hourly: hourly, daily: daily };
  }
  function isoLocal(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  // ------------------------------------------------------------ input & boot

  function leave() { if (STANDALONE) return; location.href = '../index.html'; }
  var LIGHT_KEYS = [13, 37, 38, 39, 40, 10009, 27];
  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (LIGHT_KEYS.indexOf(k) < 0) return;
    e.preventDefault();
    if (!$('pLights').hidden) {
      if (k === 13) { enterPress(true, e); return; }
      if (lightsKey(e)) return;
    }
    if (k === 10009 || k === 27 || !S.lf.armed) leave();
  });
  document.addEventListener('keyup', function (e) { if (e.keyCode === 13 && !$('pLights').hidden) enterPress(false, e); });
  document.addEventListener('click', function () { if ($('pLights').hidden) leave(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { tick(); loadCore(); loadWeather(); } });

  tick(); setInterval(tick, 1000);
  setInterval(pixelShift, 90000);
  loadWeather(); setInterval(loadWeather, 20 * 60000);
  if (FORCE_DEMO) { applyDemo(); S.weather = demoWeather(); renderWeather(); renderAll(); }
  else { loadCore(); loadTorrents(); }
  setInterval(function () { if (!FORCE_DEMO) { loadCore(); loadTorrents(); } }, 10000);
  loadPhotos(); setInterval(loadPhotos, 5 * 60000); setInterval(nextPhoto, (C.photoIntervalSec || 90) * 1000);
  loadArt(); setInterval(nextArt, ((C.art && C.art.intervalSec) || 600) * 1000);
  if (FORCE_DEMO) { S.lights = demoLights(); renderLights(); }
  else { loadLights(); setInterval(function () { if (!document.hidden && !Object.keys(S.pending).length) loadLights(); }, 5000); }
  loadCalendar(); setInterval(loadCalendar, 15 * 60000);
  loadPrayer(); setInterval(loadPrayer, 6 * 3600000);
  setInterval(function () { renderRotate(true); }, (C.rotateSec || 25) * 1000);
})();
