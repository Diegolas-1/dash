package local.dash.tv

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.Manifest
import android.content.pm.PackageManager
import android.os.Environment
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray

/**
 * Full-screen WebView hosting the Dash web apps (home screen, Dash Server + ambient, torrents).
 * Remote keys that the UIs expect as Tizen key codes are translated here; D-pad and OK go to the
 * page natively. `window.AndroidHost` (HostBridge) gives the pages app launching, hide, native video.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var prefs: Prefs

    private val playerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data ?: return@registerForActivityResult
        val id = data.getStringExtra(PlayerActivity.EXTRA_ITEM_ID) ?: ""
        val pos = data.getLongExtra(PlayerActivity.RESULT_POSITION, 0L) / 1000.0
        val dur = data.getLongExtra(PlayerActivity.RESULT_DURATION, 0L) / 1000.0
        web.evaluateJavascript("window.onAndroidPlayback && window.onAndroidPlayback(${jsString(id)}, $pos, $dur);", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        NodeService.start(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        web.setBackgroundColor(0xFF0B1114.toInt())
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true     // file:// pages talk to http://127.0.0.1
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
        }
        web.addJavascriptInterface(HostBridge(), "AndroidHost")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith("file://") || url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return false
                return try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))); true } catch (e: Exception) { false }
            }
        }
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        setContentView(web)
        hideSystemUi()
        requestStorageAccess()
        loadApp(prefs.lastApp)
    }

    /** Fire OS 7 (Android 9) asks once for storage; Android 11+ needs the "all files" switch for USB drives. */
    private fun requestStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager() && !prefs.askedAllFiles) {
                prefs.askedAllFiles = true
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    try { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) } catch (_: Exception) {}
                }
            }
        } else {
            val needed = arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
            if (needed.isNotEmpty()) ActivityCompat.requestPermissions(this, needed.toTypedArray(), 7)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 7 && grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
            web.evaluateJavascript("window.dispatchEvent(new Event('dash-storage-granted'));", null)
        }
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
    }

    /** `homeapp`, `serverapp`, `torrentapp`, or `serverapp/ambient`. */
    fun loadApp(app: String) {
        val path = when (app) {
            "homeapp", "DashHome01.home" -> "homeapp"
            "serverapp", "DashSrv01.server" -> "serverapp"
            "torrentapp", "DashTorr01.torrent" -> "torrentapp"
            "ambient" -> "serverapp/ambient"
            else -> "homeapp"
        }
        prefs.lastApp = if (path == "serverapp/ambient") "serverapp" else path
        web.loadUrl("file:///android_asset/www/$path/index.html")
    }

    override fun onResume() {
        super.onResume()
        hideSystemUi()
        web.requestFocus()
    }

    // ---- remote keys: translate Fire TV / Android keycodes to the Tizen codes the web apps use

    @Volatile private var inputFocused = false

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = translate(event.keyCode)
        if (code == null) return super.dispatchKeyEvent(event)
        val isLetter = event.keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z || event.keyCode == KeyEvent.KEYCODE_SPACE ||
            event.keyCode == KeyEvent.KEYCODE_DEL || event.keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9
        if (isLetter && inputFocused) return super.dispatchKeyEvent(event)   // typing into a page field
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) sendKey("keydown", code)
        if (event.action == KeyEvent.ACTION_UP) sendKey("keyup", code)
        return true
    }

    private fun translate(keyCode: Int): Int? = when (keyCode) {
        KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> 10009
        KeyEvent.KEYCODE_MENU -> 457                        // Fire TV "menu" (hamburger) acts as INFO
        KeyEvent.KEYCODE_INFO -> 457
        KeyEvent.KEYCODE_GUIDE -> 458
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> 10252
        KeyEvent.KEYCODE_MEDIA_PLAY -> 415
        KeyEvent.KEYCODE_MEDIA_PAUSE -> 19
        KeyEvent.KEYCODE_MEDIA_STOP -> 413
        KeyEvent.KEYCODE_MEDIA_REWIND -> 412
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> 417
        KeyEvent.KEYCODE_MEDIA_NEXT -> 10233
        KeyEvent.KEYCODE_MEDIA_PREVIOUS -> 10232
        KeyEvent.KEYCODE_PROG_RED -> 403
        KeyEvent.KEYCODE_PROG_GREEN -> 404
        KeyEvent.KEYCODE_PROG_YELLOW -> 405
        KeyEvent.KEYCODE_PROG_BLUE -> 406
        KeyEvent.KEYCODE_CHANNEL_UP -> 427
        KeyEvent.KEYCODE_CHANNEL_DOWN -> 428
        KeyEvent.KEYCODE_LAST_CHANNEL -> 10190
        KeyEvent.KEYCODE_CAPTIONS -> 10221
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> 48 + (keyCode - KeyEvent.KEYCODE_0)
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> 48 + (keyCode - KeyEvent.KEYCODE_NUMPAD_0)
        // USB keyboard / Flirc-style IR receiver: letters and function keys stand in for the Samsung remote's extra buttons
        KeyEvent.KEYCODE_F1 -> 403
        KeyEvent.KEYCODE_F2 -> 404
        KeyEvent.KEYCODE_F3 -> 405
        KeyEvent.KEYCODE_F4 -> 406
        KeyEvent.KEYCODE_I -> 457                           // Info
        KeyEvent.KEYCODE_G -> 458                           // Guide
        KeyEvent.KEYCODE_L -> 10073                         // CH LIST
        KeyEvent.KEYCODE_C -> 10221                         // CC/VD
        KeyEvent.KEYCODE_PAGE_UP -> 427                     // CH +
        KeyEvent.KEYCODE_PAGE_DOWN -> 428                   // CH -
        KeyEvent.KEYCODE_P -> 10190                         // PRE-CH
        KeyEvent.KEYCODE_FORWARD_DEL, KeyEvent.KEYCODE_DEL -> 10182   // Exit
        KeyEvent.KEYCODE_SPACE -> 10252                     // play/pause
        KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_MOVE_HOME -> null
        else -> null                                        // D-pad, Enter and everything else: native WebView handling
    }

    private fun sendKey(type: String, code: Int) {
        web.evaluateJavascript(
            "document.dispatchEvent(new KeyboardEvent('$type', {keyCode: $code, which: $code, bubbles: true, cancelable: true}));", null
        )
    }

    private fun jsString(s: String): String = "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"

    /** Methods callable from the pages as `AndroidHost.*`. */
    inner class HostBridge {
        @JavascriptInterface fun hide() { runOnUiThread { moveTaskToBack(true) } }
        @JavascriptInterface fun inputFocus(focused: Boolean) { inputFocused = focused }
        @JavascriptInterface fun launch(appId: String) { runOnUiThread { loadApp(appId) } }
        @JavascriptInterface fun ambient() { runOnUiThread { loadApp("ambient") } }
        @JavascriptInterface fun pin(): String = prefs.pin
        @JavascriptInterface fun platform(): String = "firetv"
        @JavascriptInterface fun storageRoots(): String = JSONArray(Storage.externalRoots(this@MainActivity)).toString()
        @JavascriptInterface fun servicesRunning(): Boolean = NodeService.running
        @JavascriptInterface fun openUrl(url: String) {
            runOnUiThread { try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { Log.w("DashHost", "no handler for $url") } }
        }
        @JavascriptInterface fun play(url: String, title: String, startSeconds: Int, itemId: String) {
            runOnUiThread {
                val intent = Intent(this@MainActivity, PlayerActivity::class.java)
                    .putExtra(PlayerActivity.EXTRA_URL, url)
                    .putExtra(PlayerActivity.EXTRA_TITLE, title)
                    .putExtra(PlayerActivity.EXTRA_START_MS, startSeconds * 1000L)
                    .putExtra(PlayerActivity.EXTRA_ITEM_ID, itemId)
                playerLauncher.launch(intent)
            }
        }
    }
}
