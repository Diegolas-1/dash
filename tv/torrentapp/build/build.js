// Bundles WebTorrent into one CommonJS file for the TV's Node 16 service runtime.
// uint8-util is pinned to 2.2.5 in package.json: newer versions break webtorrent 2.8.5 (arr2hex on strings).
const path = require('path')
const esbuild = require('esbuild')

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'entry.mjs')],
  outfile: path.join(__dirname, '..', 'service', 'engine.js'),
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  alias: { 'webrtc-polyfill': path.join(__dirname, 'webrtc-stub.mjs') },
  external: ['utp-native', 'bufferutil', 'utf-8-validate', 'node-datachannel'],
  legalComments: 'none',
  logLevel: 'warning'
})
console.log('built service/engine.js')
