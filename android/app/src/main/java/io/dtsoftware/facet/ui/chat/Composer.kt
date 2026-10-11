package io.dtsoftware.facet.ui.chat

import android.content.Context
import android.content.Intent
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
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
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
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
import java.io.File
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    yolo: Boolean = false,
    onYoloOff: () -> Unit = {},
    /** Built-in slash commands that apply right now (saved prompts are always listed). */
    slashCommands: Set<SlashCommand> = emptySet(),
    onSlashCommand: (SlashCommand) -> Unit = {},
    /** Shown just above the message box, e.g. the PC chip. */
    header: (@Composable () -> Unit)? = null,
) {
    val c = FacetTheme.colors
    val canSend = (value.text.isNotBlank() || attachments.isNotEmpty()) && caps != null
    // "/" at the start of the message opens the command list, filtered as you type.
    val slashQuery = remember(value.text) { SlashCommands.query(value.text) }
    val matches = remember(slashQuery, prompts, slashCommands) {
        if (slashQuery == null) emptyList() else SlashCommands.filter(slashQuery, slashCommands, prompts)
    }
    var highlight by remember(slashQuery) { mutableIntStateOf(0) }
    val slashOpen = matches.isNotEmpty() && !voice.listening

    fun pick(item: SlashItem) {
        when (item) {
            is SlashItem.Command -> onSlashCommand(item.command)
            is SlashItem.Prompt -> onValueChange(TextFieldValue(item.prompt.body, TextRange(item.prompt.body.length)))
        }
    }

    Column(modifier.fillMaxWidth()) {
        AnimatedVisibility(slashOpen, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            SlashCommandList(matches, highlight.coerceIn(0, (matches.size - 1).coerceAtLeast(0)), ::pick)
        }
        header?.invoke()
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
            } else if (voice.transcribing) {
                TranscribingRow()
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
                        keyboardActions = KeyboardActions(onSend = {
                            if (slashOpen) pick(matches[highlight.coerceIn(0, matches.lastIndex)]) else if (canSend && !generating) onSend()
                        }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 26.dp)
                            // Hardware keyboards: arrows move through the command list, Enter or Tab picks.
                            .onPreviewKeyEvent { e ->
                                if (!slashOpen || e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                                when (e.key) {
                                    Key.DirectionDown -> { highlight = (highlight + 1).coerceAtMost(matches.lastIndex); true }
                                    Key.DirectionUp -> { highlight = (highlight - 1).coerceAtLeast(0); true }
                                    Key.Enter, Key.NumPadEnter, Key.Tab -> { pick(matches[highlight.coerceIn(0, matches.lastIndex)]); true }
                                    else -> false
                                }
                            },
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().padding(start = 6.dp, end = 8.dp, bottom = 8.dp, top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FacetIconButton(R.drawable.ic_plus, stringResource(R.string.chat_add_attachment), onAttach, tint = c.textSecondary, size = 21.dp)
                if (caps?.webSearch == true || (caps?.tools == true && searchAvailable)) {
                    FacetChip(
                        stringResource(R.string.chat_web_search), params.webSearch, { onParams(params.copy(webSearch = !params.webSearch)) },
                        icon = R.drawable.ic_globe,
                    )
                    Spacer(Modifier.width(6.dp))
                }
                if (caps != null && caps.reasoning.kind != ReasoningKind.NONE) {
                    EffortChip(caps, params, onParams)
                }
                AnimatedVisibility(yolo && caps?.tools == true, enter = fadeIn() + scaleIn(initialScale = 0.6f), exit = fadeOut() + scaleOut(targetScale = 0.6f)) {
                    YoloBadge(onYoloOff, Modifier.padding(start = 6.dp))
                }
                Spacer(Modifier.weight(1f))
                AnimatedVisibility(value.text.isBlank() && attachments.isEmpty() && !generating, enter = fadeIn(), exit = fadeOut()) {
                    FacetIconButton(
                        if (voice.listening) R.drawable.ic_mic_off else R.drawable.ic_mic,
                        stringResource(if (voice.listening) R.string.chat_dictation_stop else R.string.chat_dictate), onMic,
                        tint = if (voice.listening) c.primary else c.textSecondary, size = 21.dp,
                    )
                }
                Spacer(Modifier.width(4.dp))
                SendButton(enabled = canSend && !voice.listening, generating = generating, onSend = onSend, onStop = onStop)
            }
        }
    }
}

/** Shown while YOLO mode is on: tools run without asking. Tapping it turns the mode off. */
@Composable
private fun YoloBadge(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = FacetTheme.colors
    Box(
        modifier
            .size(34.dp)
            .clip(FacetShapes.chip)
            .background(c.warning.copy(alpha = 0.16f))
            .border(1.dp, c.warning.copy(alpha = 0.55f), FacetShapes.chip)
            .clickable(onClickLabel = stringResource(R.string.chat_yolo_turn_off), onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        FacetIcon(R.drawable.ic_rocket, stringResource(R.string.chat_yolo_on), tint = c.warning, size = 17.dp)
    }
}

@Composable
private fun EffortChip(caps: ModelCaps, params: GenParams, onParams: (GenParams) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val levels = caps.reasoning.efforts
    val current = params.effort
    val label = current?.label ?: caps.reasoning.defaultEffort?.let { "${it.label}" } ?: stringResource(R.string.common_auto)
    Box {
        FacetChip(label, current != null && current != Effort.NONE, { open = true }, icon = R.drawable.ic_brain)
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            containerColor = FacetTheme.colors.surface,
            shape = RoundedCornerShape(16.dp),
        ) {
            Text(
                stringResource(R.string.chat_reasoning_effort),
                style = FacetTheme.type.labelS,
                color = FacetTheme.colors.textTertiary,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            DropdownMenuItem(
                text = {
                    val modelDefault = caps.reasoning.defaultEffort
                    Text(
                        if (modelDefault != null) stringResource(R.string.chat_model_default_with, modelDefault.label) else stringResource(R.string.chat_model_default),
                        style = FacetTheme.type.labelL,
                    )
                },
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
            FacetIconButton(R.drawable.ic_close, stringResource(R.string.chat_remove_attachment, a.name), onRemove, tint = c.textSecondary, size = 16.dp, modifier = Modifier.size(34.dp))
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
        FacetIcon(R.drawable.ic_close, stringResource(R.string.action_remove), tint = androidx.compose.ui.graphics.Color.White, size = 13.dp)
    }
}

/** The slash command list above the composer: built-in commands, then saved prompts as /their-title. */
@Composable
private fun SlashCommandList(items: List<SlashItem>, highlighted: Int, onPick: (SlashItem) -> Unit) {
    val c = FacetTheme.colors
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(highlighted) { if (items.isNotEmpty()) listState.animateScrollToItem(highlighted) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(c.surface)
            .border(1.dp, c.outlineVariant, RoundedCornerShape(20.dp))
            .padding(vertical = 6.dp),
    ) {
        LazyColumn(Modifier.heightIn(max = 260.dp), state = listState) {
            itemsIndexed(items, key = { _, it -> if (it is SlashItem.Prompt) "p/" + it.prompt.id else "c/" + it.name }) { i, item ->
                val selected = i == highlighted
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 6.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (selected) c.surfaceHigh else androidx.compose.ui.graphics.Color.Transparent)
                        .clickable(role = androidx.compose.ui.semantics.Role.Button) { onPick(item) }
                        .padding(horizontal = 10.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.size(30.dp).clip(RoundedCornerShape(9.dp)).background(c.surfaceHighest), contentAlignment = Alignment.Center) {
                        FacetIcon(
                            if (item is SlashItem.Command) item.command.icon else R.drawable.ic_library, null,
                            tint = c.textSecondary, size = 16.dp,
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        // Built-in commands read left to right; saved prompts follow their title's direction.
                        // Either way the name sits at the row's start edge, next to the icon.
                        Text(
                            "/" + item.name,
                            style = if (item is SlashItem.Command) FacetTheme.type.labelL.copy(textDirection = TextDirection.Ltr) else FacetTheme.type.labelL,
                            color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.wrapContentWidth(Alignment.Start),
                        )
                        Text(
                            when (item) {
                                is SlashItem.Command -> stringResource(item.command.descriptionRes)
                                is SlashItem.Prompt -> item.prompt.body.replace('\n', ' ')
                            },
                            style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
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
    val hint = stringResource(if (voice.recording) R.string.chat_dictation_listening_tap_to_finish else R.string.chat_dictation_listening)
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Waveform(voice.level, Modifier.height(22.dp).width(46.dp))
        Spacer(Modifier.width(12.dp))
        Text(
            voice.partial.ifBlank { hint },
            style = FacetTheme.type.chat,
            color = if (voice.partial.isBlank()) c.textTertiary else c.text,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun TranscribingRow() {
    val c = FacetTheme.colors
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.CircularProgressIndicator(Modifier.size(18.dp), color = c.primary, strokeWidth = 2.dp)
        Spacer(Modifier.width(12.dp))
        Text(stringResource(R.string.chat_dictation_transcribing), style = FacetTheme.type.chat, color = c.textTertiary)
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

    /** True while recording for an AI transcription model (as opposed to the system recognizer). */
    var recording by mutableStateOf(false)
        private set
    var transcribing by mutableStateOf(false)
        private set
    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var onRecorded: (() -> Unit)? = null

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    /**
     * Records from the microphone until [stop], then sends the audio to [transcribe] (the transcription
     * model chosen in Settings) and delivers the text.
     */
    fun startRecording(
        scope: CoroutineScope,
        transcribe: suspend (audio: ByteArray, mimeType: String, fileName: String) -> String,
        onResult: (String) -> Unit,
        onError: (String) -> Unit,
    ) {
        if (listening || transcribing) return
        val file = File(context.cacheDir, "dictation.m4a").apply { delete() }
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(16_000)
            r.setAudioEncodingBitRate(64_000)
            r.setAudioChannels(1)
            r.setOutputFile(file.path)
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            onError(Strings.get(R.string.chat_dictation_mic_failed))
            return
        }
        recorder = r
        recordFile = file
        recording = true
        listening = true
        scope.launch {
            while (recording) {
                level = (runCatching { r.maxAmplitude }.getOrDefault(0) / 12_000f).coerceIn(0f, 1f)
                delay(90)
            }
            level = 0f
        }
        onRecorded = {
            transcribing = true
            scope.launch {
                try {
                    val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                    if (bytes.size < 1_000) {
                        onError(Strings.get(R.string.chat_dictation_no_match))
                    } else {
                        val text = transcribe(bytes, "audio/mp4", "dictation.m4a")
                        if (text.isNotBlank()) onResult(text) else onError(Strings.get(R.string.chat_dictation_no_match))
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    onError(e.message ?: Strings.get(R.string.chat_dictation_failed))
                } finally {
                    transcribing = false
                    file.delete()
                }
            }
        }
    }

    private fun finishRecording() {
        val r = recorder ?: return
        recorder = null
        recording = false
        listening = false
        val ok = runCatching { r.stop() }.isSuccess
        r.release()
        val done = onRecorded
        onRecorded = null
        if (ok) done?.invoke() else recordFile?.delete()
    }

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
                            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> Strings.get(R.string.chat_dictation_no_match)
                            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> Strings.get(R.string.chat_dictation_permission)
                            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> Strings.get(R.string.chat_dictation_offline)
                            else -> Strings.get(R.string.chat_dictation_stopped)
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
        if (recorder != null) finishRecording() else recognizer?.stopListening()
    }

    fun destroy() {
        recorder?.runCatching { stop() }
        recorder?.release()
        recorder = null
        recording = false
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
