package io.dtsoftware.facet.ui.chat

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/** Read-aloud with the system text-to-speech engine. */
@Stable
class Speaker(context: Context) {
    var speakingId by mutableStateOf<String?>(null)
        private set
    private var ready = false
    private var pending: Pair<String, String>? = null
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        ready = status == TextToSpeech.SUCCESS
        pending?.let { (id, text) -> if (ready) speak(id, text) }
        pending = null
    }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { if (utteranceId?.endsWith("#last") == true) speakingId = null }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { speakingId = null }
        })
    }

    fun toggle(id: String, markdown: String) {
        if (speakingId == id) stop() else speak(id, markdown)
    }

    private fun speak(id: String, markdown: String) {
        if (!ready) {
            pending = id to markdown
            return
        }
        tts.stop()
        speakingId = id
        val chunks = plain(markdown).chunked(3500)
        chunks.forEachIndexed { i, chunk ->
            tts.speak(chunk, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, if (i == chunks.lastIndex) "$id#last" else "$id#$i")
        }
    }

    fun stop() {
        tts.stop()
        speakingId = null
    }

    fun shutdown() = tts.shutdown()

    companion object {
        /** Markdown → speakable text: drops code blocks and syntax characters. */
        fun plain(md: String): String = md
            .replace(Regex("```[\\s\\S]*?(```|$)"), " Code omitted. ")
            .replace(Regex("\\$\\$[\\s\\S]*?\\$\\$"), " An equation. ")
            .replace(Regex("!\\[([^]]*)]\\([^)]*\\)"), "$1")
            .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1")
            .replace(Regex("(?m)^\\s{0,3}#{1,6}\\s*"), "")
            .replace(Regex("(?m)^\\s*[-*+]\\s+"), "")
            .replace(Regex("(?m)^\\s*>\\s?"), "")
            .replace(Regex("[*_`~|]"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
    }
}

@Composable
fun rememberSpeaker(): Speaker {
    val context = LocalContext.current
    val speaker = remember { Speaker(context) }
    DisposableEffect(Unit) { onDispose { speaker.shutdown() } }
    return speaker
}
