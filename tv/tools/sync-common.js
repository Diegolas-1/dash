#!/usr/bin/env node
'use strict';
// Copies tv/common/*.js into each app so every package is self-contained. Run by deploy.py; safe to run any time.
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
var src = path.join(root, 'common', 'remote.js');
var targets = ['homeapp/js/remote.js', 'torrentapp/js/remote.js', 'serverapp/js/remote.js', 'serverapp/ambient/remote.js'];
var body = '// GENERATED from tv/common/remote.js by tv/tools/sync-common.js - edit the source, not this copy.\n' + fs.readFileSync(src, 'utf8');
targets.forEach(function (t) { fs.writeFileSync(path.join(root, t), body); console.log('synced ' + t); });
