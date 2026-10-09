package io.dtsoftware.facet.ui.chat

import android.media.AudioAttributes
import android.media.MediaPlayer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File

/** One app-wide player for audio clips and AI read-aloud, so starting one stops the other. */
object AudioPlayback {
    var currentId by mutableStateOf<String?>(null)
        private set
    var playing by mutableStateOf(false)
        private set
    var positionMs by mutableLongStateOf(0L)
        private set
    var durationMs by mutableLongStateOf(0L)
        private set

    private var player: MediaPlayer? = null
    private var onComplete: (() -> Unit)? = null

    fun play(id: String, file: File, onDone: () -> Unit = {}) {
        stop()
        currentId = id
        onComplete = onDone
        positionMs = 0
        durationMs = 0
        player = MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setOnPreparedListener { mp ->
                durationMs = mp.duration.toLong().coerceAtLeast(0)
                mp.start()
                playing = true
            }
            setOnCompletionListener { finish() }
            setOnErrorListener { _, _, _ -> finish(); true }
            runCatching {
                setDataSource(file.path)
                prepareAsync()
            }.onFailure { finish() }
        }
    }

    /** Play/pause [id], starting it from [file] if something else is loaded. */
    fun toggle(id: String, file: File) {
        val p = player
        when {
            currentId != id || p == null -> play(id, file)
            playing -> { p.pause(); playing = false }
            else -> { p.start(); playing = true }
        }
    }

    fun seekTo(fraction: Float) {
        val p = player ?: return
        val target = (durationMs * fraction.coerceIn(0f, 1f)).toInt()
        p.seekTo(target)
        positionMs = target.toLong()
    }

    /** Called by visible players about five times a second while playing. */
    fun tick() {
        player?.let { p -> runCatching { positionMs = p.currentPosition.toLong() } }
    }

    fun stop() {
        val done = onComplete
        player?.runCatching { stop(); release() }
        player = null
        playing = false
        currentId = null
        onComplete = null
        done?.invoke()
    }

    private fun finish() {
        val done = onComplete
        player?.runCatching { release() }
        player = null
        playing = false
        currentId = null
        positionMs = 0
        onComplete = null
        done?.invoke()
    }
}
