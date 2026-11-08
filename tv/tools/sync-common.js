#!/usr/bin/env node
'use strict';
// Copies tv/common/*.js into each app so every package is self-contained. Run by deploy.py; safe to run any time.
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
[['remote.js', ['homeapp/js/remote.js', 'torrentapp/js/remote.js', 'serverapp/js/remote.js', 'serverapp/ambient/remote.js']],
 ['host.js', ['homeapp/js/host.js', 'torrentapp/js/host.js', 'serverapp/js/host.js', 'serverapp/ambient/host.js']]].forEach(function (pair) {
  var src = path.join(root, 'common', pair[0]);
  var body = '// GENERATED from tv/common/' + pair[0] + ' by tv/tools/sync-common.js - edit the source, not this copy.\n' + fs.readFileSync(src, 'utf8');
  pair[1].forEach(function (t) { fs.writeFileSync(path.join(root, t), body); console.log('synced ' + t); });
});
