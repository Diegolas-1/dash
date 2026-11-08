// GENERATED from tv/common/host.js by tv/tools/sync-common.js - edit the source, not this copy.
/* Host shim for the Android (Fire TV) build. Source: tv/common/host.js, synced into each app as js/host.js / ambient/host.js.
   The Android app injects `window.AndroidHost` (Kotlin @JavascriptInterface) before the page loads. When present and no real
   Tizen runtime exists, this defines the small `tizen` subset the UIs call, so the same code runs on both platforms. */
(function () {
  'use strict';
  var H = window.AndroidHost;
  if (!H || window.tizen) return;
  window.tizen = {
    ApplicationControl: function () {},
    ApplicationControlData: function () {},
    application: {
      launch: function (appId, ok, fail) { try { H.launch(String(appId)); ok && ok(); } catch (e) { fail && fail(e); } },
      launchAppControl: function (ctrl, appId, ok) { ok && ok(); },                    // services are always running in-process
      getCurrentApplication: function () { return { hide: function () { H.hide(); } }; },
      getAppInfo: function () { throw new Error('no app info on Android'); }
    },
    tvinputdevice: { registerKey: function () {} }
  };
  window.ANDROID_HOST = true;
  function isField(el) { return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }
  document.addEventListener('focusin', function (e) { if (H.inputFocus) H.inputFocus(isField(e.target)); }, true);
  document.addEventListener('focusout', function () { if (H.inputFocus) H.inputFocus(false); }, true);
})();
