/* Ambient dashboard settings (also read by the Dash Server app for the idle timeout). */
window.AMBIENT_CONFIG = {
  theme: 'ink',                       // 'ink' (quiet editorial) | 'poster' (color blocks) | 'parks' (national park art); preview with ?theme=parks
  art: { intervalSec: 600, duskAtNight: true },   // parks theme: how often the artwork changes; prefer dusk scenes at night
  location: { name: 'New York', latitude: 40.7128, longitude: -74.006 },
  temperatureUnit: 'fahrenheit',      // 'celsius' | 'fahrenheit'
  clock24h: false,
  greetingName: '',                   // e.g. 'J' -> "Good evening, J"

  services: {                         // where the TV services live (loopback when running on the TV)
    core: 'http://127.0.0.1:8092',
    photos: 'http://127.0.0.1:8090',
    torrents: 'http://127.0.0.1:8091'
  },

  backdrop: 'auto',                   // 'photos' | 'aurora' | 'auto' (photos when the photo service has any)
  photoIntervalSec: 90,

  night: { start: '21:30', end: '06:30' },   // ember palette, fewer panels, lower brightness
  sleep: { start: '00:30', end: '05:45' },   // black screen with a small clock
  idleMinutes: 5,                     // Dash Server switches to this screen after idle (0 = never)
  rotateSec: 25,                      // how often the second panel changes

  lights: {                           // tiles in the Lights panel; devices come from the Dash Server service (mock until a Govee key is set)
    icons: { 'Floor lamp': 'floor-lamp', 'TV strip': 'strip', 'Bedside': 'bed', 'Kitchen': 'kitchen', 'Desk': 'desk', 'Hall': 'door' },
    groups: [ { name: 'Living room', icon: 'couch', members: ['Floor lamp', 'TV strip'] } ],   // members by device name or id
    hideGroupedDevices: false,        // true: a device inside a group gets no tile of its own
    step: 10,                         // brightness step for Up/Down
    order: []                         // optional explicit tile order by name; the rest follow alphabetically
  },
  // icons: bulb lamp floor-lamp strip ceiling spot desk bed couch kitchen tv plug fan candle string door bath plant

  nav: [                              // nav bar (parks theme). actions: app:<tizen app id> | view:<home|library|dashboard> | theme | mode | lights | rescan | art | speed
    { label: 'Home screen', icon: 'home', action: 'app:DashHome01.home' },
    { label: 'Library', icon: 'library', action: 'view:library' },
    { label: 'Dashboard', icon: 'dashboard', action: 'view:dashboard' },
    { label: 'Torrents', icon: 'torrents', action: 'app:DashTorr01.torrent' },
    { label: 'Photos', icon: 'photos', action: 'app:DashHome01.home' },
    { label: 'Theme', icon: 'theme', action: 'theme' },
    { label: 'Mode', icon: 'mode', action: 'mode' },
    { label: 'Rescan', icon: 'rescan', action: 'rescan' }
  ],

  calendarIcsUrl: '',                 // optional: a private iCal address (Google Calendar: Settings > Integrate > Secret address)
  prayerTimes: { enabled: false, method: 2, school: 0 }
};
