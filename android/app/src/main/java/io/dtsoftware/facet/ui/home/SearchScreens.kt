package io.dtsoftware.facet.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.SearchHit
import io.dtsoftware.facet.ui.chat.SearchField
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.components.EmptyState
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.FacetTopBar
import io.dtsoftware.facet.ui.components.SectionLabel
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun SearchScreen(container: AppContainer, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = FacetTheme.colors
    var query by remember { mutableStateOf("") }
    var titles by remember { mutableStateOf<List<ConversationEntity>>(emptyList()) }
    var hits by remember { mutableStateOf<List<SearchHit>>(emptyList()) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    LaunchedEffect(query) {
        delay(160)
        val (t, h) = container.conversations.search(query)
        titles = t
        hits = h
    }
    Column(Modifier.fillMaxSize().background(c.background).statusBarsPadding().imePadding()) {
        Row(Modifier.padding(start = 4.dp, end = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            FacetIconButton(R.drawable.ic_arrow_left, stringResource(R.string.action_back), onBack)
            SearchField(query, { query = it }, stringResource(R.string.search_placeholder), Modifier.focusRequester(focus))
        }
        when {
            query.isBlank() -> EmptyState(
                stringResource(R.string.search_empty_title), stringResource(R.string.search_empty_body),
                icon = R.drawable.ic_search, modifier = Modifier.fillMaxWidth(),
            )
            titles.isEmpty() && hits.isEmpty() -> EmptyState(
                stringResource(R.string.search_no_results_title), stringResource(R.string.search_no_results_body, query),
                modifier = Modifier.fillMaxWidth(),
            )
            else -> LazyColumn(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)) {
                if (titles.isNotEmpty()) {
                    item { SectionLabel(stringResource(R.string.search_section_chats), Modifier.padding(start = 8.dp)) }
                    items(titles, key = { "t/" + it.id }) { conv ->
                        ResultRow(conv.title, null, Dates.short(conv.lastActivityAt)) { onOpen(conv.id) }
                    }
                }
                if (hits.isNotEmpty()) {
                    item { SectionLabel(stringResource(R.string.search_section_messages), Modifier.padding(start = 8.dp, top = 12.dp)) }
                    items(hits, key = { "m/" + it.messageId }) { hit ->
                        ResultRow(hit.title, hit.snippet, Dates.short(hit.createdAt)) { onOpen(hit.conversationId) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ResultRow(title: String, snippet: String?, date: String, onClick: () -> Unit) {
    val c = FacetTheme.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 11.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title.ifBlank { stringResource(R.string.common_untitled) }, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            Text(date, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary)
        }
        if (snippet != null) {
            Spacer(Modifier.height(3.dp))
            Text(highlight(snippet, c.text), style = FacetTheme.type.body, color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

private fun highlight(snippet: String, strong: androidx.compose.ui.graphics.Color) = buildAnnotatedString {
    var i = 0
    while (i < snippet.length) {
        val start = snippet.indexOf("[[", i)
        if (start < 0) { append(snippet.substring(i)); break }
        append(snippet.substring(i, start))
        val end = snippet.indexOf("]]", start + 2).takeIf { it >= 0 } ?: snippet.length
        withStyle(SpanStyle(color = strong, fontWeight = FontWeight.SemiBold)) { append(snippet.substring(start + 2, end)) }
        i = (end + 2).coerceAtMost(snippet.length)
    }
}

@Composable
fun ArchiveScreen(container: AppContainer, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val c = FacetTheme.colors
    val archived by container.conversations.observeConversations(archived = true).collectAsStateWithLifecycle(emptyList())
    val scope = rememberCoroutineScope()
    var deleteAll by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().background(c.background)) {
        FacetTopBar(stringResource(R.string.search_archive_title), onNav = onBack, actions = {
            if (archived.isNotEmpty()) {
                FacetIconButton(R.drawable.ic_delete, stringResource(R.string.search_archive_delete_all), { deleteAll = true }, tint = c.textSecondary)
            }
        })
        if (archived.isEmpty()) {
            EmptyState(
                stringResource(R.string.search_archive_empty_title), stringResource(R.string.search_archive_empty_body),
                icon = R.drawable.ic_archive, modifier = Modifier.fillMaxWidth(),
            )
        } else {
            LazyColumn(contentPadding = PaddingValues(12.dp)) {
                items(archived, key = { it.id }) { conv ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).clickable { onOpen(conv.id) }.padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(conv.title.ifBlank { stringResource(R.string.common_untitled) }, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(Dates.short(conv.lastActivityAt), style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary)
                        }
                        FacetIconButton(R.drawable.ic_unarchive, stringResource(R.string.search_archive_unarchive), { scope.launch { container.conversations.setArchived(conv.id, false) } }, tint = c.textSecondary)
                        FacetIconButton(R.drawable.ic_delete, stringResource(R.string.action_delete), { scope.launch { container.conversations.delete(conv.id) } }, tint = c.textSecondary)
                    }
                }
            }
        }
    }
    if (deleteAll) {
        ConfirmDialog(
            stringResource(R.string.search_archive_delete_all_title),
            pluralStringResource(R.plurals.search_archive_delete_all_body, archived.size, archived.size),
            stringResource(R.string.search_archive_delete_all_confirm),
            onConfirm = { scope.launch { archived.forEach { container.conversations.delete(it.id) } } },
            onDismiss = { deleteAll = false }, danger = true,
        )
    }
}
