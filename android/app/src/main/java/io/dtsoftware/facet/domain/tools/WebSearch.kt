package io.dtsoftware.facet.domain.tools

import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.llm.Citation
import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

data class SearchResult(val title: String, val url: String, val snippet: String, val published: String? = null)

/** A configured search backend (bring your own key). */
data class SearchConfig(val kind: SearchKind, val apiKey: String, val baseUrl: String)

class SearchException(message: String) : IOException(message)

/** Web search over the user's chosen API, plus a local page reader. Nothing is proxied through Facet. */
class WebSearch(http: OkHttpClient, allowPrivateAddresses: Boolean = false) {
    private val http = http.newBuilder().callTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    /**
     * Page reads can be triggered by text a model read elsewhere, so they never reach this phone's own
     * network (router, LAN devices, localhost). Checked on the connected address, so redirects are covered.
     */
    private val pageHttp = if (allowPrivateAddresses) this.http else this.http.newBuilder().addNetworkInterceptor { chain ->
        val address = chain.connection()?.route()?.socketAddress?.address
        if (address != null && isPrivateAddress(address)) throw IOException("Facet doesn't read pages on local or private networks.")
        chain.proceed(chain.request())
    }.build()
    private val jsonType = "application/json".toMediaType()

    suspend fun search(config: SearchConfig, query: String, count: Int = 6): List<SearchResult> = withContext(Dispatchers.IO) {
        val q = query.trim().take(400)
        if (q.isEmpty()) throw SearchException("The search query was empty.")
        val n = count.coerceIn(1, 10)
        val base = config.baseUrl.trimEnd('/')
        val request = when (config.kind) {
            SearchKind.BRAVE -> Request.Builder()
                .url("$base/res/v1/web/search?q=${enc(q)}&count=$n&text_decorations=false")
                .header("X-Subscription-Token", config.apiKey)
                .header("Accept", "application/json")
                .build()
            SearchKind.TAVILY -> Request.Builder()
                .url("$base/search")
                .header("Authorization", "Bearer ${config.apiKey}")
                .post(
                    AppJson.encodeToString(
                        JsonObject.serializer(),
                        buildJsonObject { put("query", q); put("max_results", n); put("search_depth", "basic") },
                    ).toRequestBody(jsonType),
                )
                .build()
            SearchKind.EXA -> Request.Builder()
                .url("$base/search")
                .header("x-api-key", config.apiKey)
                .post(
                    """{"query":${AppJson.encodeToString(q)},"numResults":$n,"contents":{"text":{"maxCharacters":1200}}}""".toRequestBody(jsonType),
                )
                .build()
            SearchKind.JINA -> Request.Builder()
                .url("$base/?q=${enc(q)}")
                .header("Authorization", "Bearer ${config.apiKey}")
                .header("Accept", "application/json")
                .header("X-Respond-With", "no-content")
                .build()
            SearchKind.SEARXNG -> Request.Builder()
                .url("$base/search?q=${enc(q)}&format=json")
                .header("Accept", "application/json")
                .build()
        }
        val body = http.newCall(request).execute().use { resp ->
            val text = resp.body.string()
            if (!resp.isSuccessful) {
                throw SearchException(
                    when (resp.code) {
                        401, 403 -> "${config.kind.displayName} rejected the search key. Check it in Settings → Web search."
                        429 -> "${config.kind.displayName} rate limit reached. Try again shortly."
                        else -> "${config.kind.displayName} search failed (HTTP ${resp.code})."
                    },
                )
            }
            text
        }
        parse(config.kind, body).take(n)
    }

    private fun parse(kind: SearchKind, body: String): List<SearchResult> {
        val root = runCatching { AppJson.parseToJsonElement(body).jsonObject }.getOrElse {
            throw SearchException("The search service returned something unexpected.")
        }
        fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.contentOrNull.orEmpty()
        val items: JsonArray = when (kind) {
            SearchKind.BRAVE -> root["web"]?.jsonObject?.get("results")?.jsonArray
            SearchKind.TAVILY, SearchKind.EXA, SearchKind.SEARXNG -> root["results"]?.jsonArray
            SearchKind.JINA -> root["data"]?.jsonArray
        } ?: return emptyList()
        return items.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val url = o.s("url")
            if (url.isBlank()) return@mapNotNull null
            val snippet = when (kind) {
                SearchKind.BRAVE -> o.s("description")
                SearchKind.EXA -> o.s("text")
                SearchKind.JINA -> o.s("description").ifBlank { o.s("content") }
                else -> o.s("content")
            }
            SearchResult(
                title = o.s("title").ifBlank { url },
                url = url,
                snippet = HtmlText.stripTags(snippet).take(800),
                published = o.s("age").ifBlank { o.s("publishedDate") }.ifBlank { null },
            )
        }
    }

    /** Formats results for the model, numbered so it can cite them. */
    fun formatResults(query: String, results: List<SearchResult>): String = buildString {
        if (results.isEmpty()) {
            append("No results for \"").append(query).append("\".")
            return@buildString
        }
        append("Search results for \"").append(query).append("\":\n\n")
        results.forEachIndexed { i, r ->
            append('[').append(i + 1).append("] ").append(r.title).append('\n')
            append(r.url).append('\n')
            r.published?.let { append("Published: ").append(it).append('\n') }
            if (r.snippet.isNotBlank()) append(r.snippet).append('\n')
            append('\n')
        }
        append("Cite sources inline with their URLs as Markdown links. Use fetch_page to read a result in full when the snippet isn't enough.")
    }

    fun citations(results: List<SearchResult>) = results.map { Citation(it.url, it.title, it.snippet.take(200)) }

    /** Downloads a page and returns readable text (title + main text), at most [maxChars]. */
    suspend fun fetchPage(url: String, maxChars: Int = 40_000): Pair<String, String> = withContext(Dispatchers.IO) {
        val clean = url.trim()
        if (!clean.startsWith("http://") && !clean.startsWith("https://")) throw SearchException("Only http and https links can be read.")
        val request = Request.Builder()
            .url(clean)
            .header("User-Agent", "Mozilla/5.0 (Linux; Android 16) Facet/1.0 (+https://facet.dtsoftware.io)")
            .header("Accept", "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5")
            .build()
        pageHttp.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw SearchException("That page returned HTTP ${resp.code}.")
            val type = resp.header("Content-Type").orEmpty().lowercase()
            if (type.contains("pdf") || type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) {
                throw SearchException("That link points to a ${type.substringBefore(';')} file, which can't be read as text.")
            }
            val source = resp.body.source()
            source.request(3_000_000)
            val raw = source.buffer.readUtf8(minOf(source.buffer.size, 3_000_000L))
            if (type.contains("html") || raw.trimStart().startsWith("<")) {
                val (title, text) = HtmlText.extract(raw)
                title to text.take(maxChars)
            } else {
                "" to raw.take(maxChars)
            }
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

/** Small, dependency-free HTML → readable text converter. */
object HtmlText {
    private val dropBlocks = Regex(
        "(?is)<(script|style|noscript|svg|nav|footer|header|form|iframe|template|aside)\\b[^>]*>.*?</\\1>",
    )
    private val comments = Regex("(?s)<!--.*?-->")
    private val title = Regex("(?is)<title[^>]*>(.*?)</title>")
    private val headings = Regex("(?is)<h([1-6])[^>]*>(.*?)</h\\1>")
    private val listItems = Regex("(?is)<li[^>]*>")
    private val links = Regex("(?is)<a\\s[^>]*href=\"(https?://[^\"]+)\"[^>]*>(.*?)</a>")
    private val breaks = Regex("(?is)<(br|/p|/div|/section|/article|/tr|/li|/h[1-6]|/blockquote|/pre)[^>]*>")
    private val cells = Regex("(?is)</t[dh]>")
    private val tags = Regex("(?s)<[^>]+>")
    private val spaces = Regex("[ \\t\\u00A0]+")
    private val blankLines = Regex("\\n\\s*\\n\\s*\\n+")

    fun extract(html: String): Pair<String, String> {
        val pageTitle = title.find(html)?.groupValues?.get(1)?.let { decode(stripTags(it)).trim() }.orEmpty()
        var body = html.substringAfter("<body", html)
        body = comments.replace(body, " ")
        body = dropBlocks.replace(body, " ")
        val main = Regex("(?is)<(main|article)\\b[^>]*>(.*?)</\\1>").findAll(body).map { it.groupValues[2] }.joinToString("\n")
        if (main.length > 500) body = main
        body = headings.replace(body) { m -> "\n\n" + "#".repeat(m.groupValues[1].toInt()) + " " + stripTags(m.groupValues[2]).trim() + "\n\n" }
        body = links.replace(body) { m ->
            val text = stripTags(m.groupValues[2]).trim()
            if (text.isEmpty()) "" else "$text (${m.groupValues[1]})"
        }
        body = listItems.replace(body, "\n- ")
        body = cells.replace(body, " | ")
        body = breaks.replace(body, "\n")
        body = tags.replace(body, " ")
        body = decode(body)
        body = body.lines().joinToString("\n") { spaces.replace(it, " ").trim() }
        body = blankLines.replace(body, "\n\n").trim()
        return pageTitle to body
    }

    fun stripTags(s: String) = decode(tags.replace(s, "")).trim()

    private val entity = Regex("&(#x?[0-9a-fA-F]+|[a-zA-Z]+);")
    private val named = mapOf(
        "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ",
        "mdash" to "\u2014", "ndash" to "–", "hellip" to "…", "rsquo" to "’", "lsquo" to "‘", "rdquo" to "”", "ldquo" to "“",
        "copy" to "©", "reg" to "®", "trade" to "™", "euro" to "€", "pound" to "£", "middot" to "·",
    )

    fun decode(s: String): String = entity.replace(s) { m ->
        val e = m.groupValues[1]
        when {
            e.startsWith("#x") || e.startsWith("#X") -> e.substring(2).toIntOrNull(16)?.let { cp -> runCatching { String(Character.toChars(cp)) }.getOrNull() } ?: m.value
            e.startsWith("#") -> e.substring(1).toIntOrNull()?.let { cp -> runCatching { String(Character.toChars(cp)) }.getOrNull() } ?: m.value
            else -> named[e] ?: m.value
        }
    }
}

/** Loopback, link-local, private (RFC 1918), carrier-grade NAT, unique-local IPv6, wildcard and multicast addresses. */
internal fun isPrivateAddress(a: InetAddress): Boolean {
    if (a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || a.isAnyLocalAddress || a.isMulticastAddress) return true
    val b = a.address
    return when (a) {
        is Inet4Address -> (b[0].toInt() and 0xFF) == 100 && (b[1].toInt() and 0xC0) == 64
        is Inet6Address -> (b[0].toInt() and 0xFE) == 0xFC
        else -> false
    }
}
