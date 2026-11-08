package local.dash.tv

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Environment
import android.util.Log
import java.io.File
import kotlin.random.Random

class DashApp : Application()

/** Starts the services when the TV boots so the phone pages and downloads come back without opening the app. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == "android.intent.action.QUICKBOOT_POWERON") {
            NodeService.start(context)
        }
    }
}

/** Small settings store: the phone-page PIN (shown on the TV), optional Govee key, last UI app. */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("dash", Context.MODE_PRIVATE)

    val pin: String
        get() = sp.getString("pin", null) ?: Random.nextInt(100000, 999999).toString().also { sp.edit().putString("pin", it).apply() }
    var goveeKey: String?
        get() = sp.getString("govee", null)
        set(v) = sp.edit().putString("govee", v).apply()
    var askedAllFiles: Boolean
        get() = sp.getBoolean("askedAllFiles", false)
        set(v) = sp.edit().putBoolean("askedAllFiles", v).apply()
    var lastApp: String
        get() = sp.getString("lastApp", "homeapp") ?: "homeapp"
        set(v) = sp.edit().putString("lastApp", v).apply()
}

/** Where USB drives and media live on this device. */
object Storage {
    fun externalRoots(context: Context): List<String> {
        val roots = mutableListOf<String>()
        File("/storage").listFiles()?.forEach { f ->
            if (f.isDirectory && f.name !in setOf("emulated", "self", "enc_emulated")) roots += f.path
        }
        context.getExternalFilesDirs(null)?.forEach { dir ->
            if (dir != null && Environment.isExternalStorageRemovable(dir)) {
                // .../Android/data/<pkg>/files -> volume root
                var v: File? = dir
                repeat(4) { v = v?.parentFile }
                v?.path?.let { if (it !in roots) roots += it }
            }
        }
        return roots
    }

    fun mediaRoots(context: Context): List<String> {
        val list = mutableListOf<String>()
        @Suppress("DEPRECATION")
        val primary = Environment.getExternalStorageDirectory()
        listOf("Movies", "Download", "DCIM", "Music").forEach { sub ->
            val f = File(primary, sub)
            if (f.isDirectory) list += f.path
        }
        return list
    }
}

/** Copies assets/nodejs-project into the app's files dir (once per APK install). */
object Assets {
    private const val TAG = "DashAssets"

    fun ensureNodeProject(context: Context): File {
        val target = File(context.filesDir, "nodejs-project")
        val stamp = File(target, ".apk-stamp")
        val current = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        if (target.isDirectory && stamp.isFile && stamp.readText() == current) return target
        target.deleteRecursively()
        copyAssetDir(context, "nodejs-project", target)
        stamp.writeText(current)
        Log.i(TAG, "node project unpacked to ${target.path}")
        return target
    }

    private fun copyAssetDir(context: Context, assetPath: String, dest: File) {
        val am = context.assets
        val children = am.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            am.open(assetPath).use { input -> dest.outputStream().use { output -> input.copyTo(output) } }
            return
        }
        dest.mkdirs()
        children.forEach { copyAssetDir(context, "$assetPath/$it", File(dest, it)) }
    }
}
