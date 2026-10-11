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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import java.io.File
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** Read-aloud with the speech model chosen in Settings, or the system text-to-speech engine. */
@Stable
class Speaker(context: Context, private val scope: CoroutineScope) {
    var speakingId by mutableStateOf<String?>(null)
        private set

    /** Makes an audio file of the text with the chosen speech model; null means "use the phone's voice". */
    var aiVoice: (suspend (String) -> File?)? = null
    var onError: (String) -> Unit = {}
    private var aiJob: Job? = null
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
        val ai = aiVoice
        if (ai != null) {
            stop()
            speakingId = id
            aiJob = scope.launch {
                val file = try {
                    ai(plain(markdown))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    onError(e.message ?: Strings.get(R.string.chat_read_aloud_failed))
                    if (speakingId == id) speakingId = null
                    return@launch
                }
                if (speakingId != id) return@launch
                if (file != null) AudioPlayback.play(PLAYBACK_PREFIX + id, file) { if (speakingId == id) speakingId = null }
                else systemSpeak(id, markdown)
            }
            return
        }
        systemSpeak(id, markdown)
    }

    private fun systemSpeak(id: String, markdown: String) {
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
        aiJob?.cancel()
        aiJob = null
        tts.stop()
        if (AudioPlayback.currentId?.startsWith(PLAYBACK_PREFIX) == true) AudioPlayback.stop()
        speakingId = null
    }

    fun shutdown() = tts.shutdown()

    companion object {
        private const val PLAYBACK_PREFIX = "speak:"

        /** Markdown → speakable text: drops code blocks and syntax characters (said in the app's language). */
        fun plain(md: String): String = md
            // Lambdas, so a "$" or "\" in a translation isn't read as a group reference.
            .replace(Regex("```[\\s\\S]*?(```|$)")) { " " + Strings.get(R.string.chat_read_aloud_code_omitted) + " " }
            .replace(Regex("\\$\\$[\\s\\S]*?\\$\\$")) { " " + Strings.get(R.string.chat_read_aloud_equation) + " " }
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
    val scope = rememberCoroutineScope()
    val speaker = remember { Speaker(context, scope) }
    DisposableEffect(Unit) { onDispose { speaker.stop(); speaker.shutdown() } }
    return speaker
}
