/* Shared remote-control map for the TV apps. Source of truth: tv/common/remote.js (copied into each app by tv/tools/sync-common.js).
   Target remote: Samsung BN59-01315A layout (and look-alikes): Power, Source, 0-9, '-', PRE-CH, Vol, Mute, CH, CH LIST, Netflix,
   Home, Prime Video, Hulu, Guide, arrows + OK, Return, Exit, A/B/C/D, Settings, Info, CC/VD, Stop, |<< >>| << > || >>.
   Buttons the TV keeps for itself (never reach an app): Power, Source, Vol +/-, Mute, Home, Settings, Netflix / Prime Video / Hulu
   (the TV launches those apps). Everything else is delivered once registered. */
(function () {
  'use strict';
  var KEY = {
    UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, RETURN: 10009, ESC: 27,
    EXIT: 10182, INFO: 457, GUIDE: 458, CH_LIST: 10073, PRE_CH: 10190, CH_UP: 427, CH_DOWN: 428, CAPTION: 10221, TOOLS: 10135,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAY: 415, PAUSE: 19, STOP: 413, REWIND: 412, FF: 417, PREV: 10232, NEXT: 10233, PLAY_PAUSE: 10252, RECORD: 416,
    D0: 48, D1: 49, D2: 50, D3: 51, D4: 52, D5: 53, D6: 54, D7: 55, D8: 56, D9: 57, MINUS: 189
  };
  var REGISTER = ['Exit', 'Info', 'Guide', 'ChannelList', 'PreviousChannel', 'ChannelUp', 'ChannelDown', 'Caption', 'Tools',
    'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
    'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'MediaTrackPrevious', 'MediaTrackNext', 'MediaPlayPause', 'MediaRecord',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Minus'];
  var NAMES = {};
  Object.keys(KEY).forEach(function (n) { NAMES[KEY[n]] = n; });

  function register() {
    if (typeof window.tizen === 'undefined' || !tizen.tvinputdevice) return 0;
    var ok = 0;
    REGISTER.forEach(function (k) { try { tizen.tvinputdevice.registerKey(k); ok++; } catch (e) { /* not on this model */ } });
    return ok;
  }
  function name(code) { return NAMES[code] || null; }
  function digit(code) { return code >= 48 && code <= 57 ? code - 48 : -1; }
  function isMedia(code) { return [KEY.PLAY, KEY.PAUSE, KEY.STOP, KEY.REWIND, KEY.FF, KEY.PREV, KEY.NEXT, KEY.PLAY_PAUSE].indexOf(code) >= 0; }
  function isBack(code) { return code === KEY.RETURN || code === KEY.ESC; }

  window.Remote = { KEY: KEY, REGISTER: REGISTER, register: register, name: name, digit: digit, isMedia: isMedia, isBack: isBack };
})();
