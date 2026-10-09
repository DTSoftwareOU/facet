package io.dtsoftware.facet.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.domain.ApprovalDecision
import io.dtsoftware.facet.domain.ToolActivity
import io.dtsoftware.facet.domain.ToolStatus
import io.dtsoftware.facet.domain.tools.ToolKind
import io.dtsoftware.facet.domain.tools.ToolTrace
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme

/** Tool activity of a finished reply, rebuilt from its stored trace. */
fun MessageEntity.toolActivities(): List<ToolActivity> {
    val trace = stepsJson?.let { runCatching { AppJson.decodeFromString<ToolTrace>(it) }.getOrNull() } ?: return emptyList()
    return trace.steps.flatMap { step ->
        step.calls.map { c ->
            ToolActivity(
                id = c.id,
                name = c.name,
                kind = runCatching { ToolKind.valueOf(c.kind) }.getOrDefault(ToolKind.MCP),
                label = c.label,
                status = when {
                    c.result.startsWith("The user declined") -> ToolStatus.DENIED
                    c.isError -> ToolStatus.ERROR
                    else -> ToolStatus.DONE
                },
                argumentsJson = c.argumentsJson,
                result = c.result.take(2_000),
                serverName = c.serverName,
            )
        }
    }
}

private fun iconFor(kind: ToolKind) = when (kind) {
    ToolKind.SEARCH -> R.drawable.ic_globe
    ToolKind.FETCH -> R.drawable.ic_file_text
    ToolKind.SKILL -> R.drawable.ic_wand
    ToolKind.MCP -> R.drawable.ic_server
}

@Composable
fun ToolActivityList(activities: List<ToolActivity>, onApproval: (String, ApprovalDecision) -> Unit, modifier: Modifier = Modifier) {
    if (activities.isEmpty()) return
    var showAll by rememberSaveable { mutableStateOf(false) }
    val visible = if (showAll || activities.size <= 4) activities else activities.take(3)
    Column(modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        visible.forEach { a ->
            if (a.status == ToolStatus.AWAITING_APPROVAL) ApprovalCard(a, onApproval) else ToolRow(a)
        }
        if (visible.size < activities.size) {
            Text(
                "Show ${activities.size - visible.size} more",
                style = FacetTheme.type.labelM, color = FacetTheme.colors.primary,
                modifier = Modifier.clip(FacetShapes.small).clickable { showAll = true }.padding(horizontal = 4.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun ToolRow(a: ToolActivity) {
    val c = FacetTheme.colors
    var expanded by rememberSaveable(a.id) { mutableStateOf(false) }
    val rotation by animateFloatAsState(if (expanded) 90f else 0f, label = "toolChev")
    val hasDetails = a.argumentsJson.length > 2 || !a.result.isNullOrBlank()
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .clip(RoundedCornerShape(10.dp))
                .clickable(enabled = hasDetails) { expanded = !expanded }
                .padding(vertical = 5.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                when (a.status) {
                    ToolStatus.PREPARING, ToolStatus.RUNNING -> CircularProgressIndicator(Modifier.size(13.dp), color = c.primary, strokeWidth = 1.6.dp)
                    ToolStatus.ERROR, ToolStatus.DENIED -> FacetIcon(R.drawable.ic_circle_x, null, tint = c.error, size = 15.dp)
                    else -> FacetIcon(iconFor(a.kind), null, tint = c.textTertiary, size = 15.dp)
                }
            }
            Spacer(Modifier.width(8.dp))
            Text(
                a.label + when (a.status) {
                    ToolStatus.DENIED -> " · declined"
                    ToolStatus.ERROR -> " · failed"
                    else -> ""
                },
                style = FacetTheme.type.labelM,
                color = if (a.status == ToolStatus.ERROR || a.status == ToolStatus.DENIED) c.textSecondary else c.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (hasDetails) {
                Spacer(Modifier.width(4.dp))
                FacetIcon(R.drawable.ic_chevron_right, if (expanded) "Hide details" else "Show details", tint = c.textTertiary, size = 14.dp, modifier = Modifier.rotate(rotation))
            }
        }
        AnimatedVisibility(expanded, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 24.dp, top = 2.dp, bottom = 6.dp)
                    .clip(FacetShapes.code)
                    .background(c.codeBackground)
                    .border(1.dp, c.outlineVariant, FacetShapes.code)
                    .padding(12.dp),
            ) {
                if (a.argumentsJson.length > 2) {
                    Text("Input", style = FacetTheme.type.labelS, color = c.textTertiary)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        prettyJson(a.argumentsJson),
                        style = FacetTheme.type.code.copy(fontSize = 12.sp, lineHeight = 18.sp),
                        color = c.syntax.plain,
                        modifier = Modifier.heightIn(max = 160.dp).horizontalScroll(rememberScrollState()),
                    )
                }
                if (!a.result.isNullOrBlank()) {
                    if (a.argumentsJson.length > 2) Spacer(Modifier.height(10.dp))
                    Text("Result", style = FacetTheme.type.labelS, color = c.textTertiary)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        a.result.take(1_200) + if (a.result.length > 1_200) "…" else "",
                        style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal),
                        color = c.textSecondary,
                        maxLines = 14,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(a: ToolActivity, onApproval: (String, ApprovalDecision) -> Unit) {
    val c = FacetTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .clip(FacetShapes.group)
            .background(c.surface)
            .border(1.dp, c.primary.copy(alpha = 0.5f), FacetShapes.group)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FacetIcon(R.drawable.ic_shield, null, tint = c.primary, size = 18.dp)
            Spacer(Modifier.width(10.dp))
            Text(
                "Allow ${a.serverName ?: "this tool"} to run ${a.label.substringAfter(": ")}?",
                style = FacetTheme.type.labelL, color = c.text,
            )
        }
        if (a.argumentsJson.length > 2) {
            Spacer(Modifier.height(10.dp))
            Text(
                prettyJson(a.argumentsJson),
                style = FacetTheme.type.code.copy(fontSize = 12.sp, lineHeight = 18.sp),
                color = c.syntax.plain,
                maxLines = 10,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().clip(FacetShapes.small).background(c.codeBackground).padding(10.dp),
            )
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FacetButton("Deny", { onApproval(a.id, ApprovalDecision.DENY) }, style = ButtonStyle.Tonal, modifier = Modifier.weight(1f))
            FacetButton("Allow", { onApproval(a.id, ApprovalDecision.ALLOW) }, modifier = Modifier.weight(1f))
        }
        Text(
            "Always allow this tool",
            style = FacetTheme.type.labelM, color = c.primary,
            modifier = Modifier.padding(top = 6.dp).clip(FacetShapes.small).clickable { onApproval(a.id, ApprovalDecision.ALWAYS) }.padding(6.dp),
        )
    }
}

private fun prettyJson(raw: String): String = runCatching {
    val el = AppJson.parseToJsonElement(raw)
    kotlinx.serialization.json.Json { prettyPrint = true }.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), el)
}.getOrDefault(raw)
