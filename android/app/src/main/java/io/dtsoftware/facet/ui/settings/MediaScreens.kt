package io.dtsoftware.facet.ui.settings

import androidx.annotation.StringRes
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.Format
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

/** "None of your providers makes images", one whole sentence per kind of media. */
@StringRes
private fun noneMakes(o: ModelOutput): Int? = when (o) {
    ModelOutput.IMAGE -> R.string.mediasettings_none_images
    ModelOutput.VIDEO -> R.string.mediasettings_none_video
    ModelOutput.SPEECH -> R.string.mediasettings_none_speech
    ModelOutput.MUSIC -> R.string.mediasettings_none_music
    ModelOutput.TRANSCRIPTION -> R.string.mediasettings_none_transcripts
    ModelOutput.TEXT -> null
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

    SettingsPage(stringResource(R.string.mediasettings_title), onBack) {
        Intro(stringResource(R.string.mediasettings_intro))
        SettingsGroup {
            OUTPUTS.forEachIndexed { i, o ->
                if (i > 0) GroupDivider()
                val r = resolved[o]
                SettingsRow(
                    o.label,
                    subtitle = when {
                        r == null -> noneMakes(o)?.let { stringResource(it) }
                        r.explicit -> r.label
                        else -> stringResource(R.string.mediasettings_automatic_model, r.label)
                    },
                    icon = outputIcon(o),
                    onClick = { picking = o },
                )
            }
        }

        SettingsGroup(title = stringResource(R.string.mediasettings_options)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Option(stringResource(R.string.mediasettings_image_shape)) {
                    Segmented(Aspect.entries.toList(), prefs.imageAspect, { it.label }, { a -> update { it.copy(imageAspect = a) } })
                }
                Option(stringResource(R.string.mediasettings_video_shape)) {
                    Segmented(listOf(Aspect.LANDSCAPE, Aspect.PORTRAIT), prefs.videoAspect, { it.label }, { a -> update { it.copy(videoAspect = a) } })
                }
                Option(stringResource(R.string.mediasettings_music_length)) {
                    val oneMinute = pluralStringResource(R.plurals.mediasettings_music_minutes, 1, 1)
                    val twoMinutes = pluralStringResource(R.plurals.mediasettings_music_minutes, 2, 2)
                    Segmented(
                        listOf(15, 30, 60, 120), prefs.musicSeconds,
                        {
                            when (it) {
                                60 -> oneMinute
                                120 -> twoMinutes
                                else -> Format.seconds(it * 1000L)
                            }
                        },
                        { s -> update { it.copy(musicSeconds = s) } },
                    )
                }
            }
            GroupDivider()
            SettingsRow(
                stringResource(R.string.mediasettings_voice),
                subtitle = speech?.let { container.media.voiceFor(it).let { v -> voiceName(it, v) } } ?: stringResource(R.string.mediasettings_choose_speech_first),
                icon = R.drawable.ic_audio,
                onClick = if (speech != null) ({ pickingVoice = true }) else null,
            )
        }

        SettingsGroup {
            SwitchRow(
                stringResource(R.string.mediasettings_chat_tools), prefs.chatTools, { v -> update { it.copy(chatTools = v) } },
                subtitle = stringResource(R.string.mediasettings_chat_tools_subtitle), icon = R.drawable.ic_sparkles,
            )
            GroupDivider()
            SwitchRow(
                stringResource(R.string.mediasettings_read_aloud), prefs.aiReadAloud && prefs.speech != null, { v -> update { it.copy(aiReadAloud = v) } },
                subtitle = stringResource(if (prefs.speech != null) R.string.mediasettings_read_aloud_on else R.string.mediasettings_read_aloud_off),
                icon = R.drawable.ic_speak, enabled = prefs.speech != null,
            )
            GroupDivider()
            SwitchRow(
                stringResource(R.string.mediasettings_dictation), prefs.aiDictation && prefs.transcription != null, { v -> update { it.copy(aiDictation = v) } },
                subtitle = stringResource(if (prefs.transcription != null) R.string.mediasettings_dictation_on else R.string.mediasettings_dictation_off),
                icon = R.drawable.ic_mic, enabled = prefs.transcription != null,
            )
        }

        FacetButton(stringResource(R.string.mediasettings_add_provider), onProviders, style = ButtonStyle.Tonal, icon = R.drawable.ic_plus, modifier = Modifier.fillMaxWidth())
        Text(
            stringResource(R.string.mediasettings_footer),
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
    if (voice.isBlank()) Strings.get(R.string.mediasettings_default_voice) else if (ProviderKind.fromId(choice.provider.kind) == ProviderKind.ELEVENLABS && voice == io.dtsoftware.facet.llm.media.MediaGen.defaultVoice(ProviderKind.ELEVENLABS, choice.model.id)) "George"
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
            val title = when (output) {
                ModelOutput.IMAGE -> stringResource(R.string.mediasettings_picker_image)
                ModelOutput.VIDEO -> stringResource(R.string.mediasettings_picker_video)
                ModelOutput.SPEECH -> stringResource(R.string.mediasettings_picker_speech)
                ModelOutput.MUSIC -> stringResource(R.string.mediasettings_picker_music)
                ModelOutput.TRANSCRIPTION -> stringResource(R.string.mediasettings_picker_transcription)
                ModelOutput.TEXT -> output.label
            }
            Text(title, style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            if (choices.isEmpty()) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    // Two whole sentences: nobody makes this yet, and which providers do.
                    val sentences = when (output) {
                        ModelOutput.IMAGE -> R.string.mediasettings_none_yet_images to R.string.mediasettings_who_images
                        ModelOutput.VIDEO -> R.string.mediasettings_none_yet_video to R.string.mediasettings_who_video
                        ModelOutput.SPEECH -> R.string.mediasettings_none_yet_speech to R.string.mediasettings_who_speech
                        ModelOutput.MUSIC -> R.string.mediasettings_none_yet_music to R.string.mediasettings_who_music
                        ModelOutput.TRANSCRIPTION -> R.string.mediasettings_none_yet_transcripts to R.string.mediasettings_who_transcripts
                        ModelOutput.TEXT -> null
                    }
                    sentences?.let { (none, who) ->
                        Text(
                            stringResource(none) + " " + stringResource(who),
                            style = FacetTheme.type.body, color = c.textSecondary,
                        )
                    }
                    FacetButton(stringResource(R.string.mediasettings_add_a_provider), onAddProvider, icon = R.drawable.ic_plus)
                }
                return@Column
            }
            LazyColumn(Modifier.weight(1f)) {
                item {
                    PickRow(
                        title = stringResource(R.string.mediasettings_automatic),
                        subtitle = automatic?.let { stringResource(R.string.mediasettings_automatic_now, it.label) }
                            ?: stringResource(R.string.mediasettings_automatic_best),
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
        if (checked) FacetIcon(R.drawable.ic_check, stringResource(R.string.mediasettings_selected), tint = c.primary, size = 20.dp)
    }
}

@Composable
private fun VoicePicker(container: AppContainer, speech: MediaChoice, current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val c = FacetTheme.colors
    val voices by produceState<List<Voice>?>(null, speech.ref) { value = container.media.voices(speech) }
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.75f).navigationBarsPadding()) {
            Text(stringResource(R.string.mediasettings_voice), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
            Text(speech.label, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, modifier = Modifier.padding(horizontal = 20.dp))
            Spacer(Modifier.height(8.dp))
            val list = voices
            if (list == null) {
                Text(stringResource(R.string.mediasettings_loading_voices), style = FacetTheme.type.body, color = c.textTertiary, modifier = Modifier.padding(20.dp))
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
