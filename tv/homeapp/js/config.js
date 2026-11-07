/* Home screen settings. App IDs for your TV: python3 tv/tv.py apps */
window.DASH_CONFIG = {
  location: { name: 'New York', latitude: 40.7128, longitude: -74.006 },
  temperatureUnit: 'fahrenheit',          // 'celsius' | 'fahrenheit'
  clock24h: false,

  servicePort: 8090,
  photoIntervalSec: 20,
  screensaverMinutes: 10,                 // 0 disables
  dim: { start: '22:30', end: '06:30', level: 0.55 },   // level = overlay opacity 0..1

  prayerTimes: { enabled: false, method: 2, school: 0 }, // api.aladhan.com methods; school 1 = Hanafi Asr

  // Started with the home screen so torrent downloads resume after the TV turns on (ignored if not installed)
  backgroundServices: ['DashSrv01.core', 'DashTorr01.engine'],

  apps: [
    { name: 'Dash Server', appId: 'DashSrv01.server' },
    { name: 'Torrents', appId: 'DashTorr01.torrent' },
    { name: 'YouTube', appId: '111299001912' },
    { name: 'Netflix', appId: '3201907018807' },
    { name: 'Prime Video', appId: '3201910019365' },
    { name: 'Disney+', appId: '3201901017640' },
    { name: 'Spotify', appId: '3201606009684' }
  ],

  // type: 'video' (v=ID) or 'playlist' (list=ID)
  youtube: [
    { title: 'Lofi beats', type: 'video', id: 'jfKfPfyJRdk' }
  ]
};
