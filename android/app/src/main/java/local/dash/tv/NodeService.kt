package local.dash.tv

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.File

/**
 * Foreground service that hosts the embedded Node runtime with the three Dash services
 * (photos :8090, torrents :8091, core :8092). Node runs once per process; the thread never returns.
 */
class NodeService : Service() {

    companion object {
        private const val TAG = "DashNodeService"
        private const val CHANNEL = "dash.services"
        private const val NOTIFICATION_ID = 41
        @Volatile var running = false
            private set

        fun start(context: Context) {
            val intent = Intent(context, NodeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }

        init {
            System.loadLibrary("node")
            System.loadLibrary("native-lib")
        }
    }

    private external fun startNodeWithArguments(arguments: Array<String>): Int
    private external fun setEnv(key: String, value: String)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        if (!running) {
            running = true
            Thread({ runNode() }, "dash-node").start()
        }
        return START_STICKY
    }

    private fun runNode() {
        try {
            val project = Assets.ensureNodeProject(this)
            val data = File(filesDir, "data").apply { mkdirs() }
            val prefs = Prefs(this)
            setEnv("DASH_PHOTO_DIR", File(data, "photos").path)
            setEnv("DASH_TORRENT_DIR", File(data, "torrents").path)
            setEnv("DASH_SERVER_DIR", File(data, "server").path)
            setEnv("DASH_USB_ROOTS", Storage.externalRoots(this).joinToString(":"))
            setEnv("DASH_MEDIA_ROOTS", Storage.mediaRoots(this).joinToString(":"))
            setEnv("DASH_PASSWORD", prefs.pin)
            prefs.goveeKey?.takeIf { it.isNotBlank() }?.let { setEnv("GOVEE_API_KEY", it) }
            setEnv("HOME", filesDir.path)
            setEnv("TMPDIR", cacheDir.path)
            Log.i(TAG, "starting node: ${project.path}/main.js")
            val code = startNodeWithArguments(arrayOf("node", File(project, "main.js").path))
            Log.w(TAG, "node exited with $code")
        } catch (e: Throwable) {
            Log.e(TAG, "node failed", e)
        } finally {
            running = false
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL, getString(R.string.service_channel), NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        return builder
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.service_running))
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }
}
