package local.dash.tv

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/** Native playback (MKV, AVI, MP4…) for files streamed by the on-device services. Returns the position on exit. */
class PlayerActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TITLE = "title"
        const val EXTRA_START_MS = "startMs"
        const val EXTRA_ITEM_ID = "itemId"
        const val RESULT_POSITION = "position"
        const val RESULT_DURATION = "duration"
    }

    private var player: ExoPlayer? = null
    private lateinit var view: PlayerView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        view = PlayerView(this).apply {
            useController = true
            controllerShowTimeoutMs = 4000
            setShowNextButton(false)
            setShowPreviousButton(false)
            setBackgroundColor(0xFF000000.toInt())
        }
        setContentView(view)
        val url = intent.getStringExtra(EXTRA_URL) ?: run { finish(); return }
        val start = intent.getLongExtra(EXTRA_START_MS, 0L)
        val exo = ExoPlayer.Builder(this).build()
        player = exo
        view.player = exo
        exo.setMediaItem(MediaItem.Builder().setUri(url).setMediaId(intent.getStringExtra(EXTRA_ITEM_ID) ?: "").build())
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_ENDED) finishWithResult(ended = true) }
        })
        exo.prepare()
        if (start > 0) exo.seekTo(start)
        exo.playWhenReady = true
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val exo = player ?: return super.onKeyDown(keyCode, event)
        when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                if (view.isControllerFullyVisible) return super.onKeyDown(keyCode, event)
                exo.playWhenReady = !exo.playWhenReady; view.showController(); return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { exo.playWhenReady = true; return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { exo.playWhenReady = false; return true }
            KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_DPAD_LEFT -> {
                if (view.isControllerFullyVisible && keyCode == KeyEvent.KEYCODE_DPAD_LEFT) return super.onKeyDown(keyCode, event)
                exo.seekTo(maxOf(0L, exo.currentPosition - if (keyCode == KeyEvent.KEYCODE_MEDIA_REWIND) 60_000 else 10_000)); view.showController(); return true
            }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if (view.isControllerFullyVisible && keyCode == KeyEvent.KEYCODE_DPAD_RIGHT) return super.onKeyDown(keyCode, event)
                exo.seekTo(exo.currentPosition + if (keyCode == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) 60_000 else 10_000); view.showController(); return true
            }
            KeyEvent.KEYCODE_MEDIA_STOP, KeyEvent.KEYCODE_BACK -> { finishWithResult(ended = false); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun finishWithResult(ended: Boolean) {
        val exo = player
        val dur = exo?.duration?.takeIf { it > 0 } ?: 0L
        val pos = if (ended) dur else (exo?.currentPosition ?: 0L)
        setResult(RESULT_OK, Intent()
            .putExtra(EXTRA_ITEM_ID, intent.getStringExtra(EXTRA_ITEM_ID) ?: "")
            .putExtra(RESULT_POSITION, pos)
            .putExtra(RESULT_DURATION, dur))
        finish()
    }

    override fun onStop() {
        super.onStop()
        player?.playWhenReady = false
    }

    override fun onDestroy() {
        player?.release()
        player = null
        super.onDestroy()
    }
}
