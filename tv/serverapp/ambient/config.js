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

  calendarIcsUrl: '',                 // optional: a private iCal address (Google Calendar: Settings > Integrate > Secret address)
  prayerTimes: { enabled: false, method: 2, school: 0 }
};
