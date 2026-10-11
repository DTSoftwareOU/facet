package io.dtsoftware.facet.core.util

import android.icu.text.DateFormat
import android.icu.text.DisplayContext
import android.icu.text.MeasureFormat
import android.icu.text.RelativeDateTimeFormatter
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import android.icu.util.ULocale
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import java.math.RoundingMode
import java.security.SecureRandom
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Currency
import java.util.Date
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

/** Dates in the app's language (see Strings.locale), in the device's time zone. */
object Dates {
    private fun day(epochMs: Long) = Instant.ofEpochMilli(epochMs).atZone(ZoneId.systemDefault()).toLocalDate()

    private fun daysBetween(epochMs: Long, now: Long): Long = ChronoUnit.DAYS.between(day(epochMs), day(now))

    private fun pattern(skeleton: String, epochMs: Long, standalone: Boolean = false): String {
        val format = DateFormat.getInstanceForSkeleton(skeleton, Strings.locale)
        if (standalone) format.setContext(DisplayContext.CAPITALIZATION_FOR_STANDALONE)
        return format.format(Date(epochMs))
    }

    /** Section label for a conversation list grouped by recency ("Today", "Previous 7 days", "October 2026"). */
    fun bucketLabel(epochMs: Long, now: Long = Clock.now()): String {
        val days = daysBetween(epochMs, now)
        return when {
            days <= 0 -> Strings.get(R.string.date_today)
            days == 1L -> Strings.get(R.string.date_yesterday)
            days < 7 -> Strings.get(R.string.date_previous_7_days)
            days < 30 -> Strings.get(R.string.date_previous_30_days)
            else -> pattern("yMMMM", epochMs, standalone = true)
        }
    }

    /** A time of day, in the device's 12- or 24-hour setting. */
    fun time(epochMs: Long): String {
        val h24 = runCatching { android.text.format.DateFormat.is24HourFormat(Strings.context) }.getOrNull()
        return pattern(if (h24 == null) "jmm" else if (h24) "Hmm" else "hmm", epochMs)
    }

    /** The time for today, otherwise a short date ("Oct 3"). */
    fun short(epochMs: Long, now: Long = Clock.now()): String =
        if (daysBetween(epochMs, now) == 0L) time(epochMs) else pattern("MMMd", epochMs)

    /**
     * Under a minute ago, [relative] says "Just now". In a sentence, use a whole sentence for that
     * case instead: if (justNow(ms)) "Synced just now" else "Synced %1$s" with relative(ms).
     */
    fun justNow(epochMs: Long, now: Long = Clock.now()): Boolean = now - epochMs < 60_000

    /** "Just now", "5 min. ago", "3 hr. ago" (in the app's language), then a short date. */
    fun relative(epochMs: Long, now: Long = Clock.now()): String {
        val min = (now - epochMs).coerceAtLeast(0) / 60_000
        if (min < 1) return Strings.get(R.string.date_just_now)
        if (min >= 24 * 60) return short(epochMs, now)
        val f = RelativeDateTimeFormatter.getInstance(
            ULocale.forLocale(Strings.locale), null, RelativeDateTimeFormatter.Style.SHORT, DisplayContext.CAPITALIZATION_NONE,
        )
        return if (min < 60) f.format(min.toDouble(), RelativeDateTimeFormatter.Direction.LAST, RelativeDateTimeFormatter.RelativeUnit.MINUTES)
        else f.format((min / 60).toDouble(), RelativeDateTimeFormatter.Direction.LAST, RelativeDateTimeFormatter.RelativeUnit.HOURS)
    }

    /** A date without time ("Oct 3, 2026"). */
    fun date(epochMs: Long): String = DateFormat.getDateInstance(DateFormat.MEDIUM, Strings.locale).format(Date(epochMs))

    /** A date and time, e.g. for "last synced" details. */
    fun dateTime(epochMs: Long): String =
        DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT, Strings.locale).format(Date(epochMs))

    /** Today as yyyy-MM-dd (for the model and file names, not for display). */
    fun todayIso(): String = LocalDate.now().toString()
}

/** Numbers, sizes and prices in the app's language (digits and separators follow Strings.locale). */
object Format {
    private fun decimal(minFraction: Int, maxFraction: Int): NumberFormat = NumberFormat.getNumberInstance(Strings.locale).apply {
        minimumFractionDigits = minFraction
        maximumFractionDigits = maxFraction
        roundingMode = RoundingMode.HALF_UP
    }

    /** A whole number with the language's digit grouping ("12,480"). */
    fun number(n: Long): String = NumberFormat.getIntegerInstance(Strings.locale).format(n)

    fun tokens(n: Long): String = when {
        n < 1_000 -> number(n)
        n < 100_000 -> decimal(0, 1).format(n / 1_000.0) + "k"
        n < 1_000_000 -> number(n / 1_000) + "k"
        else -> decimal(2, 2).format(n / 1_000_000.0) + "M"
    }

    /** An amount in US dollars, the currency providers bill in. */
    fun cost(usd: Double): String {
        fun usd(value: Double, digits: Int) = NumberFormat.getCurrencyInstance(Strings.locale).apply {
            currency = Currency.getInstance("USD")
            minimumFractionDigits = digits
            maximumFractionDigits = digits
            roundingMode = RoundingMode.HALF_UP
        }.format(value)
        val text = when {
            usd <= 0.0 -> usd(0.0, 0)
            usd < 0.0001 -> "<" + usd(0.0001, 4)
            usd < 0.01 -> usd(usd, 4)
            usd < 1 -> usd(usd, 3)
            else -> usd(usd, 2)
        }
        // In Arabic and Urdu, "US$" in right-to-left text renders as "$US": show the amount as one
        // left-to-right unit (an isolate, without the format's own right-to-left mark).
        return if (Strings.isRtl) "\u2066" + text.replace("\u200F", "").replace("\u061C", "") + "\u2069" else text
    }

    fun bytes(n: Long): String = when {
        n < 1024 -> number(n) + " B"
        n < 1024 * 1024 -> decimal(0, 0).format(n / 1024.0) + " KB"
        n < 1024L * 1024 * 1024 -> decimal(1, 1).format(n / (1024.0 * 1024)) + " MB"
        else -> decimal(2, 2).format(n / (1024.0 * 1024 * 1024)) + " GB"
    }

    /** A duration such as "5s" or "1m 5s", with the language's units. */
    fun seconds(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(1)
        val f = MeasureFormat.getInstance(ULocale.forLocale(Strings.locale), MeasureFormat.FormatWidth.NARROW)
        return if (s < 60) f.format(Measure(s, MeasureUnit.SECOND))
        else f.formatMeasures(Measure(s / 60, MeasureUnit.MINUTE), Measure(s % 60, MeasureUnit.SECOND))
    }

    fun contextWindow(tokens: Int): String = when {
        tokens >= 1_000_000 -> number(tokens / 1_000_000L) + "M"
        tokens >= 1_000 -> number(tokens / 1_000L) + "K"
        else -> number(tokens.toLong())
    }
}

