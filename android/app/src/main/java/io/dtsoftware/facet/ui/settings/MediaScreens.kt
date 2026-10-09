package io.dtsoftware.facet.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.data.prefs.MediaPrefs
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.domain.media.MediaChoice
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.media.Aspect
import io.dtsoftware.facet.llm.media.Voice
import io.dtsoftware.facet.ui.chat.Segmented
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.ProviderBadge
import io.dtsoftware.facet.ui.components.SectionLabel
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme

private val OUTPUTS = listOf(ModelOutput.IMAGE, ModelOutput.VIDEO, ModelOutput.SPEECH, ModelOutput.MUSIC, ModelOutput.TRANSCRIPTION)

fun outputIcon(o: ModelOutput): Int = when (o) {
    ModelOutput.IMAGE -> R.drawable.ic_image
    ModelOutput.VIDEO -> R.drawable.ic_film
    ModelOutput.SPEECH -> R.drawable.ic_speak
    ModelOutput.MUSIC -> R.drawable.ic_music
    ModelOutput.TRANSCRIPTION -> R.drawable.ic_mic
    ModelOutput.TEXT -> R.drawable.ic_message
}

/** Settings → Media models: which model makes images, video, speech, music and transcripts. */
@Composable
fun MediaModelsScreen(container: AppContainer, onBack: () -> Unit, onProviders: () -> Unit) {
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    val prefs = synced.media
    val providers by container.providers.observeAll().collectAsStateWithLifecycle(emptyList())
    val available by produceState(emptyMap<ModelOutput, List<MediaChoice>>(), providers) {
        value = OUTPUTS.associateWith { container.media.available(it) }
    }
    val resolved by produceState(emptyMap<ModelOutput, MediaChoice?>(), providers, prefs) {
        value = OUTPUTS.associateWith { container.media.resolve(it) }
    }
    var picking by remember { mutableStateOf<ModelOutput?>(null) }
    var pickingVoice by remember { mutableStateOf(false) }
    fun update(t: (MediaPrefs) -> MediaPrefs) = container.settings.updateSynced { it.copy(media = t(it.media)) }
    val speech = resolved[ModelOutput.SPEECH]

    SettingsPage("Media models", onBack) {
        Intro(
            "Pick the model that makes each kind of media. Chat models use them when you ask for a picture, a video, " +
                "a voiceover or a song, and the results are saved in the chat. Models are sorted automatically by what they make.",
        )
        SettingsGroup {
            OUTPUTS.forEachIndexed { i, o ->
                if (i > 0) GroupDivider()
                val r = resolved[o]
                SettingsRow(
                    o.label,
                    subtitle = when {
                        r == null -> "None of your providers makes ${o.noun}"
                        r.explicit -> r.label
                        else -> "Automatic · ${r.label}"
                    },
                    icon = outputIcon(o),
                    onClick = { picking = o },
                )
            }
        }

        SettingsGroup(title = "Options") {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Option("Image shape") {
                    Segmented(Aspect.entries.toList(), prefs.imageAspect, { it.label }, { a -> update { it.copy(imageAspect = a) } })
                }
                Option("Video shape") {
                    Segmented(listOf(Aspect.LANDSCAPE, Aspect.PORTRAIT), prefs.videoAspect, { it.label }, { a -> update { it.copy(videoAspect = a) } })
                }
                Option("Music length") {
                    Segmented(listOf(15, 30, 60, 120), prefs.musicSeconds, { if (it < 60) "${it}s" else "${it / 60} min" }, { s -> update { it.copy(musicSeconds = s) } })
                }
            }
            GroupDivider()
            SettingsRow(
                "Voice",
                subtitle = speech?.let { container.media.voiceFor(it).let { v -> voiceName(it, v) } } ?: "Choose a speech model first",
                icon = R.drawable.ic_audio,
                onClick = if (speech != null) ({ pickingVoice = true }) else null,
            )
        }

        SettingsGroup {
            SwitchRow(
                "Let chat models create media", prefs.chatTools, { v -> update { it.copy(chatTools = v) } },
                subtitle = "Gives tool-capable chat models image, video, speech and music tools.", icon = R.drawable.ic_sparkles,
            )
            GroupDivider()
            SwitchRow(
                "Read aloud with this voice", prefs.aiReadAloud && prefs.speech != null, { v -> update { it.copy(aiReadAloud = v) } },
                subtitle = if (prefs.speech != null) "Read aloud uses your speech model instead of the phone's voice." else "Choose a speech model above to use it for Read aloud.",
                icon = R.drawable.ic_speak, enabled = prefs.speech != null,
            )
            GroupDivider()
            SwitchRow(
                "Dictate with this model", prefs.aiDictation && prefs.transcription != null, { v -> update { it.copy(aiDictation = v) } },
                subtitle = if (prefs.transcription != null) "The mic records, then your transcription model writes it down." else "Choose a transcription model above to use it for dictation.",
                icon = R.drawable.ic_mic, enabled = prefs.transcription != null,
            )
        }

        FacetButton("Add a media provider", onProviders, style = ButtonStyle.Tonal, icon = R.drawable.ic_plus, modifier = Modifier.fillMaxWidth())
        Text(
            "Media is made by the provider you pick, with your own key, and billed by them. OpenAI, Google, OpenRouter, xAI, " +
                "Together and Groq keys cover several kinds; ElevenLabs, Stability AI, Black Forest Labs and Deepgram add more.",
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = FacetTheme.colors.textTertiary,
            modifier = Modifier.padding(horizontal = 12.dp),
        )
    }

    picking?.let { o ->
        MediaModelPicker(
            output = o,
            choices = available[o].orEmpty(),
            selected = prefs.ref(o),
            automatic = resolved[o]?.takeIf { !it.explicit },
            onPick = { ref -> update { it.with(o, ref) }; picking = null },
            onAddProvider = { picking = null; onProviders() },
            onDismiss = { picking = null },
        )
    }
    if (pickingVoice && speech != null) {
        VoicePicker(container, speech, current = container.media.voiceFor(speech), onPick = { v ->
            update { it.copy(voice = v, voiceFor = "${speech.provider.id}/${speech.model.id}") }
            pickingVoice = false
        }) { pickingVoice = false }
    }
}

@Composable
private fun Option(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = FacetTheme.type.labelM, color = FacetTheme.colors.textSecondary)
        content()
    }
}

/** Voice ids are opaque for some providers (ElevenLabs); show a friendly name when we know one. */
private fun voiceName(choice: MediaChoice, voice: String): String =
    if (ProviderKind.fromId(choice.provider.kind) == ProviderKind.ELEVENLABS && voice == io.dtsoftware.facet.llm.media.MediaGen.defaultVoice(ProviderKind.ELEVENLABS, choice.model.id)) "George"
    else voice.replaceFirstChar(Char::titlecase)

@Composable
private fun MediaModelPicker(
    output: ModelOutput,
    choices: List<MediaChoice>,
    selected: ModelRef?,
    automatic: MediaChoice?,
    onPick: (ModelRef?) -> Unit,
    onAddProvider: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.8f).navigationBarsPadding()) {
            Text("${output.label} model", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            if (choices.isEmpty()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        "None of your providers makes ${output.noun} yet. " + when (output) {
                            ModelOutput.IMAGE -> "OpenAI, Google, OpenRouter, xAI, Together, Stability AI and Black Forest Labs do."
                            ModelOutput.VIDEO -> "Google (Gemini API) does."
                            ModelOutput.SPEECH -> "OpenAI, Google, ElevenLabs and Deepgram do."
                            ModelOutput.MUSIC -> "Google, ElevenLabs and Stability AI do."
                            ModelOutput.TRANSCRIPTION -> "OpenAI, Groq, Together, ElevenLabs and Deepgram do."
                            ModelOutput.TEXT -> ""
                        },
                        style = FacetTheme.type.body, color = c.textSecondary,
                    )
                    FacetButton("Add a provider", onAddProvider, icon = R.drawable.ic_plus)
                }
                return@Column
            }
            LazyColumn(Modifier.weight(1f)) {
                item {
                    PickRow(
                        title = "Automatic",
                        subtitle = automatic?.let { "Now: ${it.label}" } ?: "The best model you have",
                        checked = selected == null,
                        leading = { FacetIcon(R.drawable.ic_sparkles, null, tint = c.primary, size = 20.dp) },
                    ) { onPick(null) }
                }
                choices.groupBy { it.provider.id }.forEach { (_, group) ->
                    val p = group.first().provider
                    item(key = "h/${p.id}") { SectionLabel(p.label, Modifier.padding(start = 20.dp, top = 14.dp, bottom = 2.dp)) }
                    items(group, key = { "${it.provider.id}/${it.model.id}" }) { ch ->
                        PickRow(
                            title = ch.model.displayName,
                            subtitle = ch.model.id,
                            checked = selected?.providerId == ch.provider.id && selected.modelId == ch.model.id,
                            leading = { ProviderBadge(ProviderKind.fromId(ch.provider.kind), size = 28.dp) },
                        ) { onPick(ch.ref) }
                    }
                }
            }
        }
    }
}

@Composable
private fun PickRow(title: String, subtitle: String?, checked: Boolean, leading: @Composable () -> Unit, onClick: () -> Unit) {
    val c = FacetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .clip(FacetShapes.small)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.let { Text(it, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        if (checked) FacetIcon(R.drawable.ic_check, "Selected", tint = c.primary, size = 20.dp)
    }
}

@Composable
private fun VoicePicker(container: AppContainer, speech: MediaChoice, current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val c = FacetTheme.colors
    val voices by produceState<List<Voice>?>(null, speech.ref) { value = container.media.voices(speech) }
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.75f).navigationBarsPadding()) {
            Text("Voice", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            Text(speech.label, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, modifier = Modifier.padding(horizontal = 20.dp))
            Spacer(Modifier.height(8.dp))
            val list = voices
            if (list == null) {
                Text("Loading voices…", style = FacetTheme.type.body, color = c.textTertiary, modifier = Modifier.padding(20.dp))
            } else {
                LazyColumn(Modifier.weight(1f)) {
                    items(list, key = { it.id }) { v ->
                        PickRow(v.name, null, checked = v.id == current, leading = { FacetIcon(R.drawable.ic_audio, null, tint = c.textSecondary, size = 20.dp) }) { onPick(v.id) }
                    }
                }
            }
        }
    }
}
