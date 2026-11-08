// Dash TV (Android): runs the photo, torrent and core services in one embedded Node process.
// Paths, ports and secrets arrive as environment variables set by NodeService.kt.
'use strict';
process.chdir(__dirname);
process.on('uncaughtException', function (e) { console.error('[dash] uncaught', e && e.stack || e); });
var services = ['homeapp/service/service.js', 'torrentapp/service/service.js', 'serverapp/service/service.js'];
services.forEach(function (rel) {
  try { require(__dirname + '/' + rel).onStart(); console.log('[dash] started ' + rel); }
  catch (e) { console.error('[dash] failed ' + rel + ': ' + (e && e.stack || e)); }
});
setInterval(function () {}, 1 << 30);
