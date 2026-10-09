package io.dtsoftware.facet.llm

import java.util.concurrent.ConcurrentHashMap

/**
 * Non-persistent [QuirkStore]. The app should persist quirks (keys are opaque strings such as
 * `temperature`, `effort:xhigh` or `max_tokens:32000`) so they survive restarts.
 */
class InMemoryQuirkStore : QuirkStore {
    private val map = ConcurrentHashMap<String, MutableSet<String>>()

    override fun dropped(providerId: String, model: String): Set<String> =
        map["$providerId|$model"]?.toSet() ?: emptySet()

    override fun markDropped(providerId: String, model: String, param: String) {
        map.getOrPut("$providerId|$model") { ConcurrentHashMap.newKeySet() }.add(param)
    }
}

/** A request parameter an adapter sent, with the substrings that identify it in error messages. */
internal data class ParamSpec(val key: String, val tokens: List<String>)

internal sealed interface HealAction {
    data class Drop(val key: String) : HealAction
    /** [unsupported] effort level rejected; [replacement] is the next level to try (null = drop effort). */
    data class EffortValue(val unsupported: Effort, val replacement: Effort?) : HealAction
    data class CapMaxTokens(val max: Int) : HealAction
}

/**
 * Turns "this parameter isn't supported for this model" style 400s into a corrective action.
 * Context-length errors are never healed.
 */
internal object ParamHealer {
    private val quoted = Regex("""['"`]([a-z_]+)['"`]""")
    private val maxTokenPatterns = listOf(
        Regex("""> ?(\d{3,7}),? which is the maximum"""),
        Regex("""at most (\d{3,7})"""),
        Regex("""maximum (?:allowed )?(?:value |number of (?:output |completion )?tokens )?(?:is |of )?(\d{3,7})"""),
        Regex("""less than or equal to (\d{3,7})"""),
        Regex("""<= ?(\d{3,7})"""),
    )

    fun isContextLength(message: String): Boolean {
        val m = message.lowercase()
        return "prompt is too long" in m || "context length" in m || "context_length" in m ||
            "context window" in m || "maximum context" in m || "too many tokens" in m ||
            "input is too long" in m || "reduce the length" in m || "exceeds the context" in m
    }

    fun diagnose(
        message: String,
        sent: List<ParamSpec>,
        effort: Effort?,
        supportedEfforts: List<Effort>,
    ): HealAction? {
        if (message.isBlank() || isContextLength(message)) return null
        val m = message.lowercase()
        val sentKeys = sent.map { it.key }.toSet()

        if ("max_tokens" in sentKeys || "max_output_tokens" in sentKeys) {
            val mentionsMax = "max_tokens" in m || "max_output_tokens" in m || "max_completion_tokens" in m
            if (mentionsMax && !("max_completion_tokens" in m && "max_tokens" in sentKeys && "instead" in m)) {
                maxTokenPatterns.firstNotNullOfOrNull { it.find(m)?.groupValues?.get(1)?.toIntOrNull() }
                    ?.let { return HealAction.CapMaxTokens(it) }
            }
        }

        if (effort != null && effort != Effort.NONE && "effort" in sentKeys && "effort" in m) {
            val valueProblem = effort.wire in m || "unsupported value" in m || "invalid value" in m ||
                "should be" in m || "must be one of" in m || "supported values" in m
            if (valueProblem) {
                val listed = quoted.findAll(m).map { it.groupValues[1] }
                    .mapNotNull { w -> Effort.entries.firstOrNull { it.wire == w } }
                    .filter { it != effort }.toSet()
                val candidates = if (listed.isNotEmpty()) listed.toList() else supportedEfforts.filter { it != effort && it != Effort.NONE }
                return HealAction.EffortValue(effort, nearestEffort(effort, candidates.sortedBy { it.ordinal }))
            }
        }

        val blamed = sent.firstOrNull { spec -> spec.tokens.any { it in m } } ?: return null
        return HealAction.Drop(blamed.key)
    }
}

/** Highest supported level at or below [requested], else the lowest above it. */
internal fun nearestEffort(requested: Effort, supported: List<Effort>): Effort? {
    if (supported.isEmpty()) return null
    if (requested in supported) return requested
    return supported.filter { it.ordinal < requested.ordinal }.maxByOrNull { it.ordinal }
        ?: supported.minByOrNull { it.ordinal }
}

/**
 * Resolves the effort to send for a model, honoring quirks (`effort` dropped entirely, or
 * individual `effort:<wire>` levels rejected). [Effort.NONE] is handled by adapters, not here.
 */
internal fun resolveEffort(requested: Effort?, supported: List<Effort>, dropped: Set<String>): Effort? {
    if (requested == null || requested == Effort.NONE || "effort" in dropped) return null
    val levels = supported.filter { it != Effort.NONE }
    val pool = (levels.ifEmpty { Effort.entries.filter { it != Effort.NONE } })
        .filter { "effort:${it.wire}" !in dropped }
    return nearestEffort(requested, pool)
}

/** Applies a heal action to the quirk store; returns false if nothing actionable happened. */
internal fun QuirkStore.record(providerId: String, model: String, action: HealAction) {
    when (action) {
        is HealAction.Drop -> markDropped(providerId, model, action.key)
        is HealAction.EffortValue -> {
            markDropped(providerId, model, "effort:${action.unsupported.wire}")
            if (action.replacement == null) markDropped(providerId, model, "effort")
        }
        is HealAction.CapMaxTokens -> markDropped(providerId, model, "max_tokens:${action.max}")
    }
}

/** Smallest `max_tokens:N` cap learned for this model, if any. */
internal fun maxTokensCap(dropped: Set<String>): Int? =
    dropped.mapNotNull { if (it.startsWith("max_tokens:")) it.substringAfter(':').toIntOrNull() else null }.minOrNull()
