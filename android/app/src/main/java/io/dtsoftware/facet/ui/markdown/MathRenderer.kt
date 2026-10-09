package io.dtsoftware.facet.ui.markdown

import android.content.Context
import android.graphics.drawable.Drawable
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.noties.jlatexmath.JLatexMathAndroid
import ru.noties.jlatexmath.JLatexMathDrawable

/**
 * LaTeX rendering via JLatexMath. All parsing happens on one background thread (the library's
 * static tables aren't thread-safe); results are cached by (latex, size, color, display).
 *
 * The library self-initializes through its manifest ContentProvider; [warmUp] additionally loads
 * its fonts and symbol tables ahead of first use. Call [warmUpAsync] once at app start (optional:
 * without it the first formula renders a frame or two later).
 */
object MathRenderer {

    @Immutable
    data class Key(val latex: String, val sizePx: Int, val color: Int, val display: Boolean)

    /** A rendered formula, or [failed] when the LaTeX couldn't be parsed. */
    class Rendered(val drawable: Drawable?, val width: Int, val height: Int) {
        val failed: Boolean get() = drawable == null
    }

    private val lock = Any()
    private val cache = LruCache<Key, Rendered>(160)
    private val dispatcher = Dispatchers.Default.limitedParallelism(1)

    @Volatile
    var isWarm: Boolean = false
        private set

    fun warmUp(context: Context) {
        synchronized(lock) {
            if (isWarm) return
            JLatexMathAndroid.init(context.applicationContext)
            runCatching { JLatexMathDrawable.builder("\\frac{a}{b}+\\sqrt{x^2}").textSize(48f).build() }
            isWarm = true
        }
    }

    suspend fun warmUpAsync(context: Context) = withContext(dispatcher) { warmUp(context) }

    fun cached(key: Key): Rendered? = cache.get(key)

    fun render(context: Context, key: Key): Rendered {
        cache.get(key)?.let { return it }
        synchronized(lock) {
            cache.get(key)?.let { return it }
            if (!isWarm) {
                JLatexMathAndroid.init(context.applicationContext)
                isWarm = true
            }
            val result = try {
                val source = if (key.display) key.latex else "\\textstyle ${key.latex}"
                val d = JLatexMathDrawable.builder(source)
                    .textSize(key.sizePx.toFloat())
                    .color(key.color)
                    .align(JLatexMathDrawable.ALIGN_LEFT)
                    .padding(0)
                    .build()
                val w = d.intrinsicWidth
                val h = d.intrinsicHeight
                if (w <= 0 || h <= 0) Rendered(null, 0, 0) else Rendered(d, w, h)
            } catch (t: Throwable) {
                Rendered(null, 0, 0)
            }
            cache.put(key, result)
            return result
        }
    }

    suspend fun renderAsync(context: Context, key: Key): Rendered =
        cached(key) ?: withContext(dispatcher) { render(context, key) }
}

/**
 * Renders synchronously when the engine is warm (cheap, keeps layout stable and screenshot tests
 * deterministic); otherwise renders in the background and returns null until ready.
 */
@Composable
internal fun rememberMath(key: MathRenderer.Key): MathRenderer.Rendered? {
    val context = LocalContext.current
    MathRenderer.cached(key)?.let { return it }
    return if (MathRenderer.isWarm) {
        remember(key) { MathRenderer.render(context, key) }
    } else {
        produceState<MathRenderer.Rendered?>(null, key) { value = MathRenderer.renderAsync(context, key) }.value
    }
}

@Composable
internal fun MathImage(rendered: MathRenderer.Rendered, modifier: Modifier = Modifier) {
    val d = rendered.drawable ?: return
    val density = LocalDensity.current
    val w = with(density) { rendered.width.toDp() }
    val h = with(density) { rendered.height.toDp() }
    Canvas(modifier.size(w, h)) {
        drawIntoCanvas { canvas ->
            d.setBounds(0, 0, rendered.width, rendered.height)
            d.draw(canvas.nativeCanvas)
        }
    }
}
