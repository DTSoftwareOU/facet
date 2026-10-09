package io.dtsoftware.facet.ui.markdown

// TEMPORARY stand-ins so the app compiles while the Markdown module is built on its own branch.
// Delete this file when merging that branch.

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import io.dtsoftware.facet.ui.theme.FacetTheme

@Composable
fun Markdown(
    text: String,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
    textStyle: TextStyle = FacetTheme.type.chat,
    onLinkClick: ((String) -> Unit)? = null,
    onCopyCode: ((String) -> Unit)? = null,
) {
    Text(text, modifier, style = textStyle.copy(color = FacetTheme.colors.text))
}

@Composable
fun rememberSmoothedText(target: String, streaming: Boolean): String = target
