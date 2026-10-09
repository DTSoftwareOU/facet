package io.dtsoftware.facet.ui.chat

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.llm.Effort
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ReasoningKind
import io.dtsoftware.facet.ui.components.FacetChip
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.SendButton
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme

@Composable
fun Composer(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    placeholder: String,
    attachments: List<AttachmentEntity>,
    onRemoveAttachment: (String) -> Unit,
    thumbnail: suspend (String, Int) -> ImageBitmap?,
    caps: ModelCaps?,
    params: GenParams,
    onParams: (GenParams) -> Unit,
    generating: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onAttach: () -> Unit,
    voice: VoiceInput,
    onMic: () -> Unit,
    prompts: List<PromptEntity>,
    sendOnEnter: Boolean,
    modifier: Modifier = Modifier,
    searchAvailable: Boolean = false,
) {
    val c = FacetTheme.colors
    val canSend = (value.text.isNotBlank() || attachments.isNotEmpty()) && caps != null
    val slashQuery = remember(value.text) {
        val t = value.text
        if (t.startsWith("/") && !t.contains('\n') && t.length <= 40) t.drop(1).trim().lowercase() else null
    }
    val matches = remember(slashQuery, prompts) {
        if (slashQuery == null) emptyList() else prompts.filter { it.title.lowercase().contains(slashQuery) || it.body.lowercase().contains(slashQuery) }.take(6)
    }

    Column(modifier.fillMaxWidth()) {
        AnimatedVisibility(slashQuery != null, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            PromptSuggestions(matches, hasAny = prompts.isNotEmpty()) { p ->
                onValueChange(TextFieldValue(p.body, TextRange(p.body.length)))
            }
        }
        Column(
            Modifier
                .fillMaxWidth()
                .clip(FacetShapes.composer)
                .background(c.surfaceHigh)
                .border(1.dp, c.outlineVariant, FacetShapes.composer)
                .animateContentSize(),
        ) {
            if (attachments.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(attachments, key = { it.id }) { a -> DraftAttachment(a, thumbnail) { onRemoveAttachment(a.id) } }
                }
            }
            if (voice.listening) {
                ListeningRow(voice)
            } else {
                Box(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 4.dp)) {
                    if (value.text.isEmpty()) {
                        Text(placeholder, style = FacetTheme.type.chat, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    BasicTextField(
                        value = value,
                        onValueChange = onValueChange,
                        textStyle = FacetTheme.type.chat.copy(color = c.text),
                        cursorBrush = SolidColor(c.primary),
                        maxLines = 8,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Sentences,
                            imeAction = if (sendOnEnter) ImeAction.Send else ImeAction.Default,
                        ),
                        keyboardActions = KeyboardActions(onSend = { if (canSend && !generating) onSend() }),
                        modifier = Modifier.fillMaxWidth().heightIn(min = 26.dp),
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(start = 6.dp, end = 8.dp, bottom = 8.dp, top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FacetIconButton(R.drawable.ic_plus, "Add attachment", onAttach, tint = c.textSecondary, size = 21.dp)
                if (caps?.webSearch == true || (caps?.tools == true && searchAvailable)) {
                    FacetChip(
                        "Search", params.webSearch, { onParams(params.copy(webSearch = !params.webSearch)) },
                        icon = R.drawable.ic_globe,
                    )
                    Spacer(Modifier.width(6.dp))
                }
                if (caps != null && caps.reasoning.kind != ReasoningKind.NONE) {
                    EffortChip(caps, params, onParams)
                }
                Spacer(Modifier.weight(1f))
                AnimatedVisibility(value.text.isBlank() && attachments.isEmpty() && !generating, enter = fadeIn(), exit = fadeOut()) {
                    FacetIconButton(
                        if (voice.listening) R.drawable.ic_mic_off else R.drawable.ic_mic,
                        if (voice.listening) "Stop dictation" else "Dictate", onMic,
                        tint = if (voice.listening) c.primary else c.textSecondary, size = 21.dp,
                    )
                }
                Spacer(Modifier.width(4.dp))
                SendButton(enabled = canSend && !voice.listening, generating = generating, onSend = onSend, onStop = onStop)
            }
        }
    }
}

@Composable
private fun EffortChip(caps: ModelCaps, params: GenParams, onParams: (GenParams) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val levels = caps.reasoning.efforts
    val current = params.effort
    val label = current?.label ?: caps.reasoning.defaultEffort?.let { "${it.label}" } ?: "Auto"
    Box {
        FacetChip(label, current != null && current != Effort.NONE, { open = true }, icon = R.drawable.ic_brain)
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = FacetTheme.colors.surface,
            shape = RoundedCornerShape(16.dp),
        ) {
            Text(
                "Reasoning effort",
                style = FacetTheme.type.labelS,
                color = FacetTheme.colors.textTertiary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            DropdownMenuItem(
                text = { Text("Model default" + (caps.reasoning.defaultEffort?.let { " (${it.label})" } ?: ""), style = FacetTheme.type.labelL) },
                onClick = { onParams(params.copy(effort = null)); open = false },
                trailingIcon = { if (current == null) FacetIcon(R.drawable.ic_check, null, tint = FacetTheme.colors.primary, size = 18.dp) },
            )
            levels.forEach { e ->
                DropdownMenuItem(
                    text = { Text(e.label, style = FacetTheme.type.labelL) },
                    onClick = { onParams(params.copy(effort = e)); open = false },
                    trailingIcon = { if (current == e) FacetIcon(R.drawable.ic_check, null, tint = FacetTheme.colors.primary, size = 18.dp) },
                )
            }
        }
    }
}

@Composable
private fun DraftAttachment(a: AttachmentEntity, thumbnail: suspend (String, Int) -> ImageBitmap?, onRemove: () -> Unit) {
    val c = FacetTheme.colors
    if (a.kind == "image") {
        val px = with(LocalDensity.current) { 64.dp.roundToPx() }
        val bmp by produceState<ImageBitmap?>(null, a.id) { value = thumbnail(a.id, px) }
        Box(Modifier.size(64.dp)) {
            Box(Modifier.fillMaxSize().clip(RoundedCornerShape(14.dp)).background(c.surfaceHighest)) {
                bmp?.let { Image(it, a.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
            }
            RemoveBadge(Modifier.align(Alignment.TopEnd), onRemove)
        }
    } else {
        FileChip(AttachmentStore.ref(a), onClick = {}) {
            FacetIconButton(R.drawable.ic_close, "Remove ${a.name}", onRemove, tint = c.textSecondary, size = 16.dp, modifier = Modifier.size(34.dp))
        }
    }
}

@Composable
private fun RemoveBadge(modifier: Modifier, onRemove: () -> Unit) {
    Box(
        modifier
            .padding(3.dp)
            .size(22.dp)
            .clip(CircleShape)
            .background(FacetTheme.colors.scrim)
            .clickable(onClick = onRemove),
        contentAlignment = Alignment.Center,
    ) {
        FacetIcon(R.drawable.ic_close, "Remove", tint = androidx.compose.ui.graphics.Color.White, size = 13.dp)
    }
}

@Composable
private fun PromptSuggestions(matches: List<PromptEntity>, hasAny: Boolean, onPick: (PromptEntity) -> Unit) {
    val c = FacetTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(c.surface)
            .border(1.dp, c.outlineVariant, RoundedCornerShape(20.dp))
            .padding(vertical = 6.dp),
    ) {
        if (matches.isEmpty()) {
            Text(
                if (hasAny) "No saved prompt matches." else "Save prompts in Settings → Prompt library, then type / to insert them.",
                style = FacetTheme.type.body,
                color = c.textSecondary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            )
        } else {
            LazyColumn(Modifier.heightIn(max = 260.dp)) {
                items(matches, key = { it.id }) { p ->
                    Column(
                        Modifier.fillMaxWidth().clickable { onPick(p) }.padding(horizontal = 16.dp, vertical = 10.dp),
                    ) {
                        Text(p.title, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            p.body, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ListeningRow(voice: VoiceInput) {
    val c = FacetTheme.colors
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Waveform(voice.level, Modifier.height(22.dp).width(46.dp))
        Spacer(Modifier.width(12.dp))
        Text(
            voice.partial.ifBlank { "Listening…" },
            style = FacetTheme.type.chat,
            color = if (voice.partial.isBlank()) c.textTertiary else c.text,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun Waveform(level: Float, modifier: Modifier) {
    val c = FacetTheme.colors
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        val weights = floatArrayOf(0.5f, 0.85f, 1f, 0.7f, 0.45f)
        weights.forEachIndexed { i, w ->
            val h by animateFloatAsState((0.2f + level * w).coerceIn(0.15f, 1f), label = "bar$i")
            Box(Modifier.width(5.dp).fillMaxHeight(h).clip(CircleShape).background(c.primary))
        }
    }
}

/** Inline speech-to-text using the system recognizer; no audio leaves the device beyond the system service. */
@Stable
class VoiceInput(private val context: Context) {
    var listening by mutableStateOf(false)
        private set
    var partial by mutableStateOf("")
        private set
    var level by mutableFloatStateOf(0f)
        private set
    private var recognizer: SpeechRecognizer? = null

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    fun start(onResult: (String) -> Unit, onError: (String) -> Unit) {
        if (listening) return
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        partial = ""
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { listening = true }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) { level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { level = 0f }
            override fun onError(error: Int) {
                listening = false
                level = 0f
                val text = partial
                if (text.isNotBlank()) onResult(text) else if (error != SpeechRecognizer.ERROR_CLIENT) {
                    onError(
                        when (error) {
                            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Didn't catch that. Try again."
                            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Allow microphone access to dictate."
                            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Speech recognition needs a connection."
                            else -> "Dictation stopped."
                        },
                    )
                }
                partial = ""
            }
            override fun onResults(results: Bundle?) {
                listening = false
                level = 0f
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().ifBlank { partial }
                partial = ""
                if (text.isNotBlank()) onResult(text)
            }
            override fun onPartialResults(partialResults: Bundle?) {
                partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { partial = it }
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
        }
        listening = true
        r.startListening(intent)
    }

    fun stop() {
        recognizer?.stopListening()
    }

    fun destroy() {
        recognizer?.destroy()
        recognizer = null
        listening = false
    }
}

@Composable
fun rememberVoiceInput(): VoiceInput {
    val context = LocalContext.current
    val voice = remember { VoiceInput(context.applicationContext) }
    DisposableEffect(Unit) { onDispose { voice.destroy() } }
    return voice
}
