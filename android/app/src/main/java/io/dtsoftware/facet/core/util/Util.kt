package io.dtsoftware.facet.core.util

import java.security.SecureRandom
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlinx.serialization.json.Json

/** Shared JSON configuration: tolerant on read, compact on write. */
val AppJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = true
    coerceInputValues = true
}

object Ids {
    private val random = SecureRandom()
    private const val ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

    /**
     * Time-sortable 22-char id: 10 chars of millisecond time + 12 random chars (base32).
     * Sorting ids lexicographically sorts by creation time, which keeps branches ordered.
     */
    fun new(): String {
        val sb = StringBuilder(22)
        var t = System.currentTimeMillis()
        val time = CharArray(10)
        for (i in 9 downTo 0) {
            time[i] = ALPHABET[(t and 31).toInt()]
            t = t shr 5
        }
        sb.append(time)
        repeat(12) { sb.append(ALPHABET[random.nextInt(32)]) }
        return sb.toString()
    }
}

object Clock {
    fun now(): Long = System.currentTimeMillis()
}

enum class DateBucket(val label: String) {
    PINNED("Pinned"), TODAY("Today"), YESTERDAY("Yesterday"), WEEK("Previous 7 days"), MONTH("Previous 30 days"), OLDER("Older")
}

object Dates {
    private val monthYear = DateTimeFormatter.ofPattern("MMMM yyyy", Locale.getDefault())
    private val dayMonth = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())
    private val time = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

    /** Section label for a conversation list grouped by recency. */
    fun bucketLabel(epochMs: Long, now: Long = Clock.now()): String {
        val zone = ZoneId.systemDefault()
        val day = Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(day, today)
        return when {
            days <= 0 -> DateBucket.TODAY.label
            days == 1L -> DateBucket.YESTERDAY.label
            days < 7 -> DateBucket.WEEK.label
            days < 30 -> DateBucket.MONTH.label
            else -> monthYear.format(day)
        }
    }

    fun short(epochMs: Long, now: Long = Clock.now()): String {
        val zone = ZoneId.systemDefault()
        val dt = Instant.ofEpochMilli(epochMs).atZone(zone)
        val today = LocalDate.now(zone)
        return if (dt.toLocalDate() == today) time.format(dt) else dayMonth.format(dt)
    }

    fun relative(epochMs: Long, now: Long = Clock.now()): String {
        val diff = (now - epochMs).coerceAtLeast(0)
        val min = diff / 60_000
        return when {
            min < 1 -> "Just now"
            min < 60 -> "$min min ago"
            min < 24 * 60 -> "${min / 60} h ago"
            else -> short(epochMs, now)
        }
    }

    fun todayIso(): String = LocalDate.now().toString()
}

object Format {
    fun tokens(n: Long): String = when {
        n < 1_000 -> n.toString()
        n < 100_000 -> String.format(Locale.US, "%.1fk", n / 1_000.0).replace(".0k", "k")
        n < 1_000_000 -> "${n / 1_000}k"
        else -> String.format(Locale.US, "%.2fM", n / 1_000_000.0)
    }

    fun cost(usd: Double): String = when {
        usd <= 0.0 -> "$0"
        usd < 0.0001 -> "<$0.0001"
        usd < 0.01 -> String.format(Locale.US, "$%.4f", usd)
        usd < 1 -> String.format(Locale.US, "$%.3f", usd)
        else -> String.format(Locale.US, "$%.2f", usd)
    }

    fun bytes(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> String.format(Locale.US, "%.0f KB", n / 1024.0)
        n < 1024L * 1024 * 1024 -> String.format(Locale.US, "%.1f MB", n / (1024.0 * 1024))
        else -> String.format(Locale.US, "%.2f GB", n / (1024.0 * 1024 * 1024))
    }

    fun seconds(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(1)
        return if (s < 60) "${s}s" else "${s / 60}m ${s % 60}s"
    }

    fun contextWindow(tokens: Int): String = when {
        tokens >= 1_000_000 -> "${tokens / 1_000_000}M"
        tokens >= 1_000 -> "${tokens / 1_000}K"
        else -> tokens.toString()
    }
}
