package io.dtsoftware.facet.ui.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TextSmootherTest {

    private val frameNs = 16_666_667L

    /** Runs frames until caught up or [maxFrames]; returns frames taken. */
    private fun drain(s: TextSmoother, target: String, startNs: Long, maxFrames: Int = 10_000): Int {
        var t = startNs
        var frames = 0
        while (s.shown < target.length && frames < maxFrames) {
            t += frameNs
            s.step(target, t)
            frames++
        }
        return frames
    }

    @Test
    fun smallBacklogRevealsAtLeastMinRate() {
        val s = TextSmoother()
        val target = "Hello"
        val frames = drain(s, target, 0)
        // 5 chars at >= 40 chars/s must take <= ~0.15 s.
        assertTrue("frames=$frames", frames <= 10)
        assertEquals(5, s.shown)
    }

    @Test
    fun largeBurstNeverLagsMoreThanMaxLag() {
        val s = TextSmoother()
        val target = "x".repeat(3000)
        val frames = drain(s, target, 0)
        val seconds = frames / 60f
        assertTrue("took $seconds s", seconds <= 0.75f)
    }

    @Test
    fun revealIsGradualNotInstant() {
        val s = TextSmoother()
        val target = "x".repeat(200)
        s.step(target, frameNs)
        assertTrue("first frame shows ${s.shown}", s.shown in 1..20)
    }

    @Test
    fun neverSplitsSurrogatePairs() {
        val emoji = "😀" // 😀
        val target = emoji.repeat(50)
        val s = TextSmoother(minRate = 61f, maxRate = 61f, targetLagSec = 100f, maxLagSec = 100f)
        var t = 0L
        repeat(200) {
            t += frameNs
            val n = s.step(target, t)
            if (n in 1 until target.length) assertTrue(!Character.isHighSurrogate(target[n - 1]))
        }
    }

    @Test
    fun shrinkingTargetClamps() {
        val s = TextSmoother(initialShown = 10)
        s.step("abc", frameNs)
        assertEquals(3, s.shown)
    }

    @Test
    fun pauseDoesNotCountIdleTime() {
        val s = TextSmoother()
        drain(s, "abc", 0)
        s.pause()
        // After a 10 s idle gap, a new burst still starts gradually.
        s.step("abc" + "y".repeat(300), 10_000_000_000L)
        assertTrue(s.shown < 3 + 40)
    }
}
