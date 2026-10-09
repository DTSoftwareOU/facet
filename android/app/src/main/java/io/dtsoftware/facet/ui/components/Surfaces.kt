package io.dtsoftware.facet.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme

/** Plain top bar: back/menu on the left, title, actions on the right. */
@Composable
fun FacetTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    @DrawableRes navIcon: Int? = R.drawable.ic_arrow_left,
    onNav: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.statusBars)
            .height(60.dp)
            .padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (navIcon != null && onNav != null) {
            FacetIconButton(navIcon, "Back", onNav)
        } else {
            Spacer(Modifier.width(10.dp))
        }
        Column(Modifier.weight(1f).padding(start = 4.dp)) {
            Text(title, style = FacetTheme.type.titleM, color = FacetTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) {
                Text(subtitle, style = FacetTheme.type.labelS, color = FacetTheme.colors.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        actions()
    }
}

/** Rounded settings group container. */
@Composable
fun SettingsGroup(modifier: Modifier = Modifier, title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth()) {
        if (title != null) SectionLabel(title, Modifier.padding(start = 12.dp))
        Column(
            Modifier
                .fillMaxWidth()
                .clip(FacetShapes.group)
                .background(FacetTheme.colors.surface),
            content = content,
        )
    }
}

@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    @DrawableRes icon: Int? = null,
    iconTint: Color = FacetTheme.colors.textSecondary,
    titleColor: Color = FacetTheme.colors.text,
    onClick: (() -> Unit)? = null,
    showChevron: Boolean = onClick != null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            leading != null -> { leading(); Spacer(Modifier.width(14.dp)) }
            icon != null -> { FacetIcon(icon, null, tint = iconTint, size = 21.dp); Spacer(Modifier.width(16.dp)) }
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = FacetTheme.type.labelL, color = titleColor)
            if (subtitle != null) {
                Spacer(Modifier.height(2.dp))
                Text(subtitle, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = FacetTheme.colors.textSecondary)
            }
        }
        trailing?.let { Spacer(Modifier.width(12.dp)); it() }
        if (showChevron && trailing == null) FacetIcon(R.drawable.ic_chevron_right, null, tint = FacetTheme.colors.textTertiary, size = 18.dp)
    }
}

@Composable
fun SwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    @DrawableRes icon: Int? = null,
    enabled: Boolean = true,
) {
    SettingsRow(
        title = title,
        subtitle = subtitle,
        icon = icon,
        modifier = modifier,
        onClick = if (enabled) ({ onCheckedChange(!checked) }) else null,
        showChevron = false,
        trailing = {
            Switch(
                checked = checked,
                onCheckedChange = if (enabled) onCheckedChange else null,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = FacetTheme.colors.onPrimary,
                    checkedTrackColor = FacetTheme.colors.primary,
                    uncheckedThumbColor = FacetTheme.colors.textTertiary,
                    uncheckedTrackColor = FacetTheme.colors.surfaceHigh,
                    uncheckedBorderColor = FacetTheme.colors.outline,
                ),
            )
        },
    )
}

@Composable
fun GroupDivider() = Hairline(Modifier.padding(start = 53.dp).fillMaxWidth())

/** Labeled text field in the Facet style. */
@Composable
fun FacetTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String = "",
    password: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 8,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    onIme: (() -> Unit)? = null,
    supporting: String? = null,
    isError: Boolean = false,
    mono: Boolean = false,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = FacetTheme.colors
    var focused by remember { mutableStateOf(false) }
    var reveal by remember { mutableStateOf(false) }
    val border = when {
        isError -> c.error
        focused -> c.primary
        else -> c.outline
    }
    Column(modifier) {
        if (label != null) {
            Text(label, style = FacetTheme.type.labelM, color = c.textSecondary, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
        }
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(c.surfaceHigh)
                .border(if (focused || isError) 1.5.dp else 1.dp, border, RoundedCornerShape(14.dp))
                .padding(start = 14.dp, end = if (trailing != null || password) 4.dp else 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val style: TextStyle = (if (mono) FacetTheme.type.code.copy(fontSize = 14.sp) else FacetTheme.type.body).copy(color = c.text)
            Box(Modifier.weight(1f).padding(vertical = 14.dp)) {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = c.textTertiary), maxLines = if (singleLine) 1 else maxLines)
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    textStyle = style,
                    singleLine = singleLine,
                    minLines = minLines,
                    maxLines = maxLines,
                    cursorBrush = SolidColor(c.primary),
                    visualTransformation = if (password && !reveal) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (password) KeyboardType.Password else keyboardType,
                        imeAction = imeAction,
                        autoCorrectEnabled = !password && keyboardType == KeyboardType.Text,
                    ),
                    keyboardActions = KeyboardActions(onAny = { onIme?.invoke() }),
                    modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
                )
            }
            if (password) {
                FacetIconButton(
                    if (reveal) R.drawable.ic_eye_off else R.drawable.ic_eye,
                    if (reveal) "Hide" else "Show",
                    { reveal = !reveal },
                    tint = c.textSecondary,
                    size = 19.dp,
                )
            }
            trailing?.invoke()
        }
        if (supporting != null) {
            Text(
                supporting,
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                color = if (isError) c.error else c.textTertiary,
                modifier = Modifier.padding(start = 4.dp, top = 6.dp),
            )
        }
    }
}

/** Bottom sheet styled for Facet. */
@Composable
fun FacetSheet(
    onDismiss: () -> Unit,
    state: SheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        shape = FacetShapes.sheet,
        containerColor = FacetTheme.colors.surface,
        scrimColor = FacetTheme.colors.scrim,
        dragHandle = {
            Box(
                Modifier
                    .padding(top = 10.dp, bottom = 6.dp)
                    .size(width = 36.dp, height = 4.dp)
                    .clip(CircleShape)
                    .background(FacetTheme.colors.outline),
            )
        },
        content = content,
    )
}

@Composable
fun ConfirmDialog(
    title: String,
    body: String,
    confirmText: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    danger: Boolean = false,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = FacetTheme.colors.surface,
        shape = RoundedCornerShape(24.dp),
        title = { Text(title, style = FacetTheme.type.titleM, color = FacetTheme.colors.text) },
        text = { Text(body, style = FacetTheme.type.body, color = FacetTheme.colors.textSecondary) },
        confirmButton = {
            FacetButton(confirmText, { onConfirm(); onDismiss() }, style = if (danger) ButtonStyle.Danger else ButtonStyle.Primary)
        },
        dismissButton = { FacetButton("Cancel", onDismiss, style = ButtonStyle.Text) },
    )
}

@Composable
fun TextInputDialog(
    title: String,
    initial: String,
    confirmText: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
    placeholder: String = "",
) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = FacetTheme.colors.surface,
        shape = RoundedCornerShape(24.dp),
        title = { Text(title, style = FacetTheme.type.titleM, color = FacetTheme.colors.text) },
        text = {
            FacetTextField(text, { text = it }, placeholder = placeholder, imeAction = ImeAction.Done, onIme = {
                if (text.isNotBlank()) { onConfirm(text); onDismiss() }
            })
        },
        confirmButton = {
            FacetButton(confirmText, { onConfirm(text); onDismiss() }, enabled = text.isNotBlank())
        },
        dismissButton = { FacetButton("Cancel", onDismiss, style = ButtonStyle.Text) },
    )
}

/** Monogram badge for a provider (no third-party logos are bundled). */
@Composable
fun ProviderBadge(kind: ProviderKind, modifier: Modifier = Modifier, size: Dp = 32.dp) {
    val (glyph, color) = providerGlyph(kind)
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.3f))
            .background(color.copy(alpha = if (FacetTheme.colors.isDark) 0.18f else 0.14f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            glyph,
            color = color,
            style = FacetTheme.type.labelM.copy(fontSize = (size.value * 0.36f).sp, fontWeight = FontWeight.Bold),
            textAlign = TextAlign.Center,
        )
    }
}

fun providerGlyph(kind: ProviderKind): Pair<String, Color> = when (kind) {
    ProviderKind.OPENAI -> "AI" to Color(0xFF3FB98F)
    ProviderKind.ANTHROPIC -> "A" to Color(0xFFD9895B)
    ProviderKind.GOOGLE -> "G" to Color(0xFF6E9BFF)
    ProviderKind.OPENROUTER -> "OR" to Color(0xFF8A8FFF)
    ProviderKind.XAI -> "x" to Color(0xFFB8C0CC)
    ProviderKind.DEEPSEEK -> "DS" to Color(0xFF5B8CFF)
    ProviderKind.MISTRAL -> "M" to Color(0xFFF2994A)
    ProviderKind.GROQ -> "Gq" to Color(0xFFF26B5B)
    ProviderKind.CEREBRAS -> "Cb" to Color(0xFFF2A65A)
    ProviderKind.TOGETHER -> "T" to Color(0xFF4FA3F7)
    ProviderKind.FIREWORKS -> "F" to Color(0xFFB66DFF)
    ProviderKind.PERPLEXITY -> "P" to Color(0xFF49D3C1)
    ProviderKind.OLLAMA -> "Ol" to Color(0xFFC7CDD6)
    ProviderKind.LMSTUDIO -> "LM" to Color(0xFF7FA7FF)
    ProviderKind.CUSTOM -> "{}" to Color(0xFFA3ACBA)
}

/** Palette used for user-colored items (assistants, folders). */
val AccentChoices = listOf(
    Color(0xFF49D3C1), Color(0xFF6E9BFF), Color(0xFFF2C66D), Color(0xFFFF8F8F),
    Color(0xFFB98CFF), Color(0xFF5BD69B), Color(0xFFF2994A), Color(0xFFA3ACBA),
)

fun accent(index: Int): Color = AccentChoices[index.mod(AccentChoices.size)]

@Composable
fun EmptyState(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    @DrawableRes icon: Int? = null,
    action: (@Composable () -> Unit)? = null,
) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        if (icon != null) {
            Box(Modifier.size(56.dp).clip(CircleShape).background(FacetTheme.colors.surfaceHigh), contentAlignment = Alignment.Center) {
                FacetIcon(icon, null, tint = FacetTheme.colors.textSecondary, size = 24.dp)
            }
            Spacer(Modifier.height(16.dp))
        }
        Text(title, style = FacetTheme.type.titleM, color = FacetTheme.colors.text, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(body, style = FacetTheme.type.body, color = FacetTheme.colors.textSecondary, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.height(20.dp))
            action()
        }
    }
}
