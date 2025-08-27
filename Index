<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0B0F14" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>Open in Spotify (via Shortcut)</title>
  <style>
    :root{ --bg:#0B0F14; --fg:#E6E6E6; --accent:#1DB954; --border:#1F2933; --shadow:0 10px 30px rgba(0,0,0,0.35); --radius:16px; }
    *{ box-sizing:border-box; }
    html,body{ height:100%; margin:0; background:var(--bg); }
    body{ color:var(--fg); font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;
          display:flex; align-items:center; justify-content:center; padding:24px; }
    .card{ width:100%; max-width:420px; text-align:center; padding:24px; border-radius:var(--radius);
           border:1px solid var(--border); background:linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0));
           box-shadow:var(--shadow); }
    .logo{ width:112px; height:112px; border-radius:24px; display:block; margin:0 auto 16px; object-fit:contain; }
    h1{ font-size:18px; margin:0 0 16px; font-weight:700; }
    .btn{ width:100%; border:none; border-radius:14px; padding:14px 16px; font-size:16px; font-weight:800; cursor:pointer;
          color:#03230F; background:var(--accent); box-shadow:0 8px 16px rgba(29,185,84,0.25); -webkit-tap-highlight-color:transparent; }
    .btn:active{ transform:translateY(0.5px); }
    .tiny{ margin-top:10px; font-size:12px; opacity:0.65; }
  </style>
</head>
<body>
  <main class="card" role="main" aria-labelledby="title">
    <img class="logo" src="https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/Spotify_icon.svg/192px-Spotify_icon.svg.png" alt="Spotify">
    <h1 id="title">Open in Spotify (via Shortcut)</h1>
    <button id="openBtn" class="btn" type="button">Open</button>
    <div class="tiny">Shortcut required: “Open Spotify Deep Link”.</div>
  </main>

  <script>
    const SHORTCUT_NAME  = 'Open Spotify Deep Link';
    const SHORTCUT_INPUT = 'spotify://';
    const RESTORE_WINDOW_MS = 10000;

    function buildShortcutsURL(name, input){
      return 'shortcuts://run-shortcut?name=' + encodeURIComponent(name) +
             '&input=' + encodeURIComponent(input || '');
    }
    function cacheBustedSelf(){
      const u = new URL(location.href);
      u.searchParams.set('_r', String(Date.now()));
      return u.toString();
    }
    function maybeRestore(){
      try{
        const ts = Number(sessionStorage.getItem('lastLaunchTs') || 0);
        if (!ts) return;
        sessionStorage.removeItem('lastLaunchTs');
        if (Date.now() - ts <= RESTORE_WINDOW_MS){
          location.replace(cacheBustedSelf());
        }
      }catch(e){}
    }
    document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) maybeRestore(); }, {passive:true});
    window.addEventListener('pageshow', ()=>{ maybeRestore(); }, {passive:true});

    function runShortcut(){
      try{ sessionStorage.setItem('lastLaunchTs', String(Date.now())); }catch(e){}
      location.href = buildShortcutsURL(SHORTCUT_NAME, SHORTCUT_INPUT);
    }
    document.getElementById('openBtn').addEventListener('click', runShortcut, {passive:true});
  </script>
</body>
</html>
