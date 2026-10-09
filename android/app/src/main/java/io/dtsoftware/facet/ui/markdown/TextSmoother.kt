package io.dtsoftware.facet.ui.markdown

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive

/**
 * Paces how much of a growing string is visible, so bursty network deltas read as a steady flow.
 *
 * The comfortable reveal rate is backlog / [targetLagSec], clamped to [minRate]..[maxRate]
 * chars/s. On top of that every arrival carries a deadline ([maxLagSec] after it was first seen):
 * the rate is raised as needed so no text is ever shown later than its deadline, which keeps
 * large bursts from lagging. Pure logic; driven by frame timestamps.
 */
class TextSmoother(
    initialShown: Int = 0,
    private val minRate: Float = 40f,
    private val maxRate: Float = 400f,
    private val targetLagSec: Float = 0.35f,
    private val maxLagSec: Float = 0.7f,
) {
    var shown: Int = initialShown
        private set
    private var carry = 0f
    private var lastNanos = -1L
    private var knownLength = initialShown

    // Pending arrivals: text up to thresholds[k] arrived at arrivals[k]. Ring buffer.
    private val thresholds = IntArray(QUEUE)
    private val arrivals = LongArray(QUEUE)
    private var head = 0
    private var count = 0

    /** Forget the frame clock (call after idling so the next frame doesn't count the pause). */
    fun pause() {
        lastNanos = -1L
        carry = 0f
    }

    fun snapTo(target: CharSequence) {
        shown = target.length
        knownLength = target.length
        count = 0
        pause()
    }

    private fun enqueue(threshold: Int, at: Long) {
        if (count == QUEUE) {
            // Merge into the newest entry; keeping its earlier arrival only tightens the deadline.
            thresholds[(head + count - 1) % QUEUE] = threshold
            return
        }
        val idx = (head + count) % QUEUE
        thresholds[idx] = threshold
        arrivals[idx] = at
        count++
    }

    /** Advances to the frame at [nowNanos] and returns the number of visible chars. */
    fun step(target: CharSequence, nowNanos: Long): Int {
        val len = target.length
        if (shown > len) {
            shown = len
            carry = 0f
        }
        if (len > knownLength) enqueue(len, nowNanos)
        knownLength = len
        while (count > 0 && thresholds[head] <= shown) {
            head = (head + 1) % QUEUE
            count--
        }
        val backlog = len - shown
        if (backlog <= 0) {
            count = 0
            lastNanos = nowNanos
            return shown
        }
        val dt = if (lastNanos < 0) 1f / 60f else ((nowNanos - lastNanos) / 1_000_000_000f).coerceIn(0f, 0.1f)
        lastNanos = nowNanos
        var rate = (backlog / targetLagSec).coerceIn(minRate, maxRate)
        for (k in 0 until count) {
            val idx = (head + k) % QUEUE
            val need = (thresholds[idx].coerceAtMost(len) - shown).toFloat()
            if (need <= 0f) continue
            val left = (arrivals[idx] - nowNanos) / 1_000_000_000f + maxLagSec
            val required = if (left <= dt || dt == 0f) need / dt.coerceAtLeast(1f / 120f) else need / left
            if (required > rate) rate = required
        }
        carry += rate * dt
        val add = carry.toInt()
        if (add > 0) {
            carry -= add
            shown = (shown + add).coerceAtMost(len)
        }
        // Never split a surrogate pair.
        if (shown in 1 until len && Character.isHighSurrogate(target[shown - 1])) shown++
        return shown
    }

    private companion object {
        const val QUEUE = 48
    }
}

/**
 * Returns the portion of [target] to display while a reply streams. Snaps to the full text when
 * [streaming] is false or reduced motion is on. Text already present when this first composes is
 * shown immediately; only text that arrives afterwards is paced.
 */
@Composable
fun rememberSmoothedText(target: String, streaming: Boolean): String {
    val reduced = FacetTheme.reducedMotion
    val smoother = remember { TextSmoother(initialShown = target.length) }
    // Frame-driven invalidation; the visible length itself lives in the smoother.
    var frame by remember { mutableIntStateOf(0) }
    val latest by rememberUpdatedState(target)

    if (!streaming || reduced) {
        smoother.snapTo(target)
        return target
    }

    LaunchedEffect(smoother) {
        while (isActive) {
            if (smoother.shown >= latest.length) {
                smoother.pause()
                snapshotFlow { latest.length }.first { it > smoother.shown }
            }
            withFrameNanos { now ->
                val before = smoother.shown
                if (smoother.step(latest, now) != before) frame++
            }
        }
    }
    @Suppress("UNUSED_EXPRESSION") frame // subscribe to frame ticks
    val n = smoother.shown.coerceIn(0, target.length)
    return if (n == target.length) target else target.substring(0, n)
}
