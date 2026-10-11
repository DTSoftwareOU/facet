package io.dtsoftware.facet.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.ThemeMode
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h3600dp-xxhdpi")
class MarkdownScreenshotTest {

    @get:Rule
    val compose = createComposeRule()

    @Test
    fun richDocumentDark() = capture(ThemeMode.DARK, "markdown_rich_dark", SAMPLE)

    @Test
    fun richDocumentLight() = capture(ThemeMode.LIGHT, "markdown_rich_light", SAMPLE)

    @Test
    fun streamingDark() = capture(ThemeMode.DARK, "markdown_streaming_dark", STREAMING, streaming = true)

    @Test
    fun streamingTextDark() = capture(ThemeMode.DARK, "markdown_streaming_text_dark", STREAMING_TEXT, streaming = true)

    private fun capture(mode: ThemeMode, name: String, text: String, streaming: Boolean = false) {
        MathRenderer.warmUp(RuntimeEnvironment.getApplication())
        compose.mainClock.autoAdvance = false
        compose.setContent {
            FacetTheme(mode = mode) {
                Box(
                    Modifier
                        .width(412.dp)
                        .background(FacetTheme.colors.background)
                        .padding(horizontal = 16.dp, vertical = 20.dp),
                ) {
                    SelectionContainer {
                        Markdown(text = text, streaming = streaming, modifier = Modifier.fillMaxWidth())
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/$name.png")
    }

    companion object {
        val SAMPLE = """
            # Shipping a release build

            Facet streams answers from **any model** you choose. Here's what *matters* when you cut a release, with `R8`, ~~ProGuard~~ and a few [docs](https://developer.android.com) links.

            ## Checklist

            1. Bump `versionCode` and `versionName`
            2. Run the full test suite
               - unit tests
               - screenshot tests
            3. Sign with the upload key

            - [x] Update the changelog
            - [ ] Publish to the website

            > Ship small, ship often. A release you can roll back is a release you can trust.

            ### Kotlin

            ```kotlin
            @Composable
            fun Greeting(name: String, count: Int = 3) {
                // Remember the state across recompositions
                var clicks by remember { mutableIntStateOf(0) }
                Text(text = "Hello, ${'$'}name! (${'$'}clicks)")
            }
            ```

            ### Python

            ```python
            def fib(n: int) -> list[int]:
                ""${'"'}Return the first n Fibonacci numbers.""${'"'}
                a, b = 0, 1
                out = []
                for _ in range(n):
                    out.append(a)
                    a, b = b, a + b
                return out  # done
            ```

            | Model | Context | Input ${'$'}/1M | Reasoning |
            |:------|:-------:|-----------:|:----------|
            | Claude Opus 5.5 | 1M | 4.00 | Adaptive |
            | GPT-5.5 | 400K | 1.25 | Effort levels |
            | Gemini 3 Pro | 1M | 2.00 | Thinking budget |

            The roots of ${'$'}ax^2 + bx + c = 0${'$'} are given by

            ${'$'}${'$'}
            x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
            ${'$'}${'$'}

            and the plan costs ${'$'}5 to ${'$'}10 per month.

            ---

            That's it. Happy shipping.
        """.trimIndent()

        val STREAMING = """
            Here's a quick script that prints the files in a folder:

            ```bash
            #!/usr/bin/env bash
            for f in "${'$'}1"/*; do
              echo "${'$'}{f##*/}"
        """.trimIndent()

        val STREAMING_TEXT = """
            ## Why streaming feels fast

            Tokens arrive in bursts, so Facet paces them into a steady flow and keeps a small gem cursor at the end of the text while the model is still writing
        """.trimIndent()

        val EDGE_CASES = """
            Setext heading
            ==============

            #### Level four
            ##### Level five

            > A quote with a list:
            > - first
            > - second
            >
            > ```js
            > const ok = a => a ?? null;
            > ```

            Line one
            Line two with a very long URL https://example.com/a/really/long/path/that/keeps/going/and/going?query=value&more=1 to see wrapping.

            Broken math stays readable: ${'$'}\notacommand{x}${'$'} and emoji 🚀 plus 日本語のテキスト.

            Image: ![architecture diagram](https://example.com/arch.png)

            <details>raw html</details>

            1. Loose item one

            2. Loose item two

               ```json
               {"key": "value", "n": 2}
               ```

            10. Wide numbers
            11. Still aligned
        """.trimIndent()
    }

    @Test
    fun edgeCasesDark() = capture(ThemeMode.DARK, "markdown_edge_dark", EDGE_CASES)
}
