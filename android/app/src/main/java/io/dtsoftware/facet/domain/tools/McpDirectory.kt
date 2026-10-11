package io.dtsoftware.facet.domain.tools

import androidx.annotation.StringRes
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.mcp.McpAuthMode

enum class McpCategory(@StringRes val labelRes: Int) {
    KNOWLEDGE(R.string.mcpdir_cat_knowledge),
    DEVELOPER(R.string.mcpdir_cat_developer),
    PRODUCTIVITY(R.string.mcpdir_cat_productivity),
    DESIGN(R.string.mcpdir_cat_design),
    DATA(R.string.mcpdir_cat_data),
    CLOUD(R.string.mcpdir_cat_cloud),
    BUSINESS(R.string.mcpdir_cat_business),
    COMMERCE(R.string.mcpdir_cat_commerce),
    SEARCH(R.string.mcpdir_cat_search),
    FINANCE(R.string.mcpdir_cat_finance),
    TRAVEL(R.string.mcpdir_cat_travel),
    AI(R.string.mcpdir_cat_ai);

    /** The category's name in the app's language. */
    val label: String get() = Strings.get(labelRes)
}

data class McpDirectoryEntry(
    val name: String,
    val url: String,
    val auth: McpAuthMode,
    @StringRes val blurbRes: Int,
    val category: McpCategory,
    val popular: Boolean = false,
) {
    /** What the server does, in the app's language. */
    val blurb: String get() = Strings.get(blurbRes)
}

/**
 * Remote MCP servers that work from a phone. Each address was checked with an MCP handshake: OPEN servers
 * answer without credentials; OAUTH servers publish OAuth metadata with dynamic client registration, so
 * "Sign in" works; HEADERS servers need a token pasted into the server's headers.
 */
object McpDirectory {
    private val K = McpCategory.KNOWLEDGE
    private val D = McpCategory.DEVELOPER
    private val P = McpCategory.PRODUCTIVITY
    private val G = McpCategory.DESIGN
    private val A = McpCategory.DATA
    private val C = McpCategory.CLOUD
    private val B = McpCategory.BUSINESS
    private val S = McpCategory.COMMERCE
    private val W = McpCategory.SEARCH
    private val F = McpCategory.FINANCE
    private val T = McpCategory.TRAVEL
    private val M = McpCategory.AI
    private val OPEN = McpAuthMode.NONE
    private val OAUTH = McpAuthMode.OAUTH
    private val TOKEN = McpAuthMode.HEADERS

    val entries: List<McpDirectoryEntry> = listOf(
        // Docs & knowledge
        McpDirectoryEntry("DeepWiki", "https://mcp.deepwiki.com/mcp", OPEN, R.string.mcpdir_blurb_deepwiki, K, popular = true),
        McpDirectoryEntry("Context7", "https://mcp.context7.com/mcp", OPEN, R.string.mcpdir_blurb_context7, K, popular = true),
        McpDirectoryEntry("Microsoft Learn", "https://learn.microsoft.com/api/mcp", OPEN, R.string.mcpdir_blurb_microsoft_learn, K),
        McpDirectoryEntry("AWS Knowledge", "https://knowledge-mcp.global.api.aws", OPEN, R.string.mcpdir_blurb_aws_knowledge, K),
        McpDirectoryEntry("Cloudflare Docs", "https://docs.mcp.cloudflare.com/mcp", OPEN, R.string.mcpdir_blurb_cloudflare_docs, K),
        McpDirectoryEntry("OpenAI Docs", "https://developers.openai.com/mcp", OPEN, R.string.mcpdir_blurb_openai_docs, K),
        McpDirectoryEntry("Claude Docs", "https://platform.claude.com/docs/mcp", OPEN, R.string.mcpdir_blurb_claude_docs, K),
        McpDirectoryEntry("GitMCP", "https://gitmcp.io/docs", OPEN, R.string.mcpdir_blurb_gitmcp, K),
        McpDirectoryEntry("Astro Docs", "https://mcp.docs.astro.build/mcp", OPEN, R.string.mcpdir_blurb_astro_docs, K),
        McpDirectoryEntry("Svelte Docs", "https://mcp.svelte.dev/mcp", OPEN, R.string.mcpdir_blurb_svelte_docs, K),
        McpDirectoryEntry("Nuxt Docs", "https://nuxt.com/mcp", OPEN, R.string.mcpdir_blurb_nuxt_docs, K),
        McpDirectoryEntry("Pinecone Docs", "https://docs.pinecone.io/mcp", OPEN, R.string.mcpdir_blurb_pinecone_docs, K),

        // Developer
        McpDirectoryEntry("GitHub", "https://api.githubcopilot.com/mcp/", TOKEN, R.string.mcpdir_blurb_github, D, popular = true),
        McpDirectoryEntry("GitLab", "https://gitlab.com/api/v4/mcp", OAUTH, R.string.mcpdir_blurb_gitlab, D),
        McpDirectoryEntry("Sentry", "https://mcp.sentry.dev/mcp", OAUTH, R.string.mcpdir_blurb_sentry, D, popular = true),
        McpDirectoryEntry("Grep by Vercel", "https://mcp.grep.app", OPEN, R.string.mcpdir_blurb_grep_by_vercel, D),
        McpDirectoryEntry("Socket", "https://mcp.socket.dev/", OPEN, R.string.mcpdir_blurb_socket, D),
        McpDirectoryEntry("Semgrep", "https://mcp.semgrep.ai/mcp", OAUTH, R.string.mcpdir_blurb_semgrep, D),
        McpDirectoryEntry("Postman", "https://mcp.postman.com/mcp", OAUTH, R.string.mcpdir_blurb_postman, D),
        McpDirectoryEntry("Buildkite", "https://mcp.buildkite.com/mcp", OAUTH, R.string.mcpdir_blurb_buildkite, D),
        McpDirectoryEntry("Jam", "https://mcp.jam.dev/mcp", OAUTH, R.string.mcpdir_blurb_jam, D),
        McpDirectoryEntry("Globalping", "https://mcp.globalping.dev/mcp", OAUTH, R.string.mcpdir_blurb_globalping, D),
        McpDirectoryEntry("OpenZeppelin", "https://mcp.openzeppelin.com/contracts/solidity/mcp", OPEN, R.string.mcpdir_blurb_openzeppelin, D),

        // Productivity
        McpDirectoryEntry("Notion", "https://mcp.notion.com/mcp", OAUTH, R.string.mcpdir_blurb_notion, P, popular = true),
        McpDirectoryEntry("Linear", "https://mcp.linear.app/mcp", OAUTH, R.string.mcpdir_blurb_linear, P, popular = true),
        McpDirectoryEntry("Atlassian", "https://mcp.atlassian.com/v1/mcp", OAUTH, R.string.mcpdir_blurb_atlassian, P, popular = true),
        McpDirectoryEntry("Asana", "https://mcp.asana.com/sse", OAUTH, R.string.mcpdir_blurb_asana, P),
        McpDirectoryEntry("monday.com", "https://mcp.monday.com/mcp", OAUTH, R.string.mcpdir_blurb_monday_com, P),
        McpDirectoryEntry("ClickUp", "https://mcp.clickup.com/mcp", OAUTH, R.string.mcpdir_blurb_clickup, P),
        McpDirectoryEntry("Todoist", "https://ai.todoist.net/mcp", OAUTH, R.string.mcpdir_blurb_todoist, P),
        McpDirectoryEntry("Airtable", "https://mcp.airtable.com/mcp", OAUTH, R.string.mcpdir_blurb_airtable, P),
        McpDirectoryEntry("Dropbox", "https://mcp.dropbox.com/mcp", OAUTH, R.string.mcpdir_blurb_dropbox, P),
        McpDirectoryEntry("Zapier", "https://mcp.zapier.com/api/mcp/mcp", OAUTH, R.string.mcpdir_blurb_zapier, P, popular = true),
        McpDirectoryEntry("Fireflies", "https://api.fireflies.ai/mcp", OAUTH, R.string.mcpdir_blurb_fireflies, P),
        McpDirectoryEntry("Granola", "https://mcp.granola.ai/mcp", OAUTH, R.string.mcpdir_blurb_granola, P),
        McpDirectoryEntry("Cal.com", "https://mcp.cal.com/mcp", OAUTH, R.string.mcpdir_blurb_cal_com, P),
        McpDirectoryEntry("Egnyte", "https://mcp-server.egnyte.com/sse", OAUTH, R.string.mcpdir_blurb_egnyte, P),

        // Design
        McpDirectoryEntry("Figma", "https://mcp.figma.com/mcp", OAUTH, R.string.mcpdir_blurb_figma, G, popular = true),
        McpDirectoryEntry("Canva", "https://mcp.canva.com/mcp", OAUTH, R.string.mcpdir_blurb_canva, G),
        McpDirectoryEntry("Miro", "https://mcp.miro.com/", OAUTH, R.string.mcpdir_blurb_miro, G),
        McpDirectoryEntry("Excalidraw", "https://mcp.excalidraw.com/mcp", OPEN, R.string.mcpdir_blurb_excalidraw, G),
        McpDirectoryEntry("Gamma", "https://mcp.gamma.app/mcp", OAUTH, R.string.mcpdir_blurb_gamma, G),
        McpDirectoryEntry("Webflow", "https://mcp.webflow.com/mcp", OAUTH, R.string.mcpdir_blurb_webflow, G),
        McpDirectoryEntry("Wix", "https://mcp.wix.com/sse", OAUTH, R.string.mcpdir_blurb_wix, G),
        McpDirectoryEntry("Cloudinary", "https://asset-management.mcp.cloudinary.com/sse", OAUTH, R.string.mcpdir_blurb_cloudinary, G),

        // Data & analytics
        McpDirectoryEntry("Supabase", "https://mcp.supabase.com/mcp", OAUTH, R.string.mcpdir_blurb_supabase, A, popular = true),
        McpDirectoryEntry("Neon", "https://mcp.neon.tech/mcp", OAUTH, R.string.mcpdir_blurb_neon, A),
        McpDirectoryEntry("Prisma Postgres", "https://mcp.prisma.io/mcp", OAUTH, R.string.mcpdir_blurb_prisma_postgres, A),
        McpDirectoryEntry("MotherDuck", "https://api.motherduck.com/mcp", OAUTH, R.string.mcpdir_blurb_motherduck, A),
        McpDirectoryEntry("Hex", "https://app.hex.tech/mcp", OAUTH, R.string.mcpdir_blurb_hex, A),
        McpDirectoryEntry("PostHog", "https://mcp.posthog.com/mcp", OAUTH, R.string.mcpdir_blurb_posthog, A),
        McpDirectoryEntry("Axiom", "https://mcp.axiom.co/mcp", OAUTH, R.string.mcpdir_blurb_axiom, A),
        McpDirectoryEntry("Grafana", "https://mcp.grafana.com/mcp", OAUTH, R.string.mcpdir_blurb_grafana, A),
        McpDirectoryEntry("Honeycomb", "https://mcp.honeycomb.io/mcp", OAUTH, R.string.mcpdir_blurb_honeycomb, A),

        // Cloud
        McpDirectoryEntry("Vercel", "https://mcp.vercel.com", OAUTH, R.string.mcpdir_blurb_vercel, C, popular = true),
        McpDirectoryEntry("Netlify", "https://netlify-mcp.netlify.app/mcp", OAUTH, R.string.mcpdir_blurb_netlify, C),
        McpDirectoryEntry("Railway", "https://mcp.railway.com/mcp", OAUTH, R.string.mcpdir_blurb_railway, C),
        McpDirectoryEntry("DigitalOcean", "https://apps.mcp.digitalocean.com/mcp", OAUTH, R.string.mcpdir_blurb_digitalocean, C),
        McpDirectoryEntry("Cloudflare Workers", "https://bindings.mcp.cloudflare.com/mcp", OAUTH, R.string.mcpdir_blurb_cloudflare_workers, C),
        McpDirectoryEntry("Cloudflare Observability", "https://observability.mcp.cloudflare.com/mcp", OAUTH, R.string.mcpdir_blurb_cloudflare_observability, C),
        McpDirectoryEntry("Cloudflare Browser", "https://browser.mcp.cloudflare.com/mcp", OAUTH, R.string.mcpdir_blurb_cloudflare_browser, C),

        // Business
        McpDirectoryEntry("Intercom", "https://mcp.intercom.com/mcp", OAUTH, R.string.mcpdir_blurb_intercom, B),
        McpDirectoryEntry("Close", "https://mcp.close.com/mcp", OAUTH, R.string.mcpdir_blurb_close, B),
        McpDirectoryEntry("Klaviyo", "https://mcp.klaviyo.com/mcp", OAUTH, R.string.mcpdir_blurb_klaviyo, B),
        McpDirectoryEntry("Ahrefs", "https://api.ahrefs.com/mcp/mcp", OAUTH, R.string.mcpdir_blurb_ahrefs, B),
        McpDirectoryEntry("Semrush", "https://mcp.semrush.com/v1/mcp", OAUTH, R.string.mcpdir_blurb_semrush, B),

        // Payments & shopping
        McpDirectoryEntry("Stripe", "https://mcp.stripe.com", OAUTH, R.string.mcpdir_blurb_stripe, S, popular = true),
        McpDirectoryEntry("PayPal", "https://mcp.paypal.com/mcp", OAUTH, R.string.mcpdir_blurb_paypal, S),
        McpDirectoryEntry("Square", "https://mcp.squareup.com/sse", OAUTH, R.string.mcpdir_blurb_square, S),
        McpDirectoryEntry("Instacart", "https://mcp.instacart.com/mcp", OPEN, R.string.mcpdir_blurb_instacart, S),
        McpDirectoryEntry("Ramp", "https://ramp-mcp-remote.ramp.com/mcp", OAUTH, R.string.mcpdir_blurb_ramp, S),

        // Search & web
        McpDirectoryEntry("Exa", "https://mcp.exa.ai/mcp", OPEN, R.string.mcpdir_blurb_exa, W, popular = true),
        McpDirectoryEntry("Jina AI", "https://mcp.jina.ai/v1", OPEN, R.string.mcpdir_blurb_jina_ai, W),
        McpDirectoryEntry("Tavily", "https://mcp.tavily.com/mcp/", OAUTH, R.string.mcpdir_blurb_tavily, W),
        McpDirectoryEntry("Bright Data", "https://mcp.brightdata.com/mcp", OAUTH, R.string.mcpdir_blurb_bright_data, W),
        McpDirectoryEntry("Apify", "https://mcp.apify.com", OAUTH, R.string.mcpdir_blurb_apify, W),
        McpDirectoryEntry("Cloudflare Radar", "https://radar.mcp.cloudflare.com/mcp", OAUTH, R.string.mcpdir_blurb_cloudflare_radar, W),

        // Finance
        McpDirectoryEntry("CoinGecko", "https://mcp.api.coingecko.com/mcp", OPEN, R.string.mcpdir_blurb_coingecko, F),
        McpDirectoryEntry("Alpha Vantage", "https://mcp.alphavantage.co/mcp", OAUTH, R.string.mcpdir_blurb_alpha_vantage, F),

        // Travel & maps
        McpDirectoryEntry("Kiwi.com", "https://mcp.kiwi.com", OPEN, R.string.mcpdir_blurb_kiwi_com, T, popular = true),
        McpDirectoryEntry("Mapbox", "https://mcp.mapbox.com/mcp", OAUTH, R.string.mcpdir_blurb_mapbox, T),

        // AI & media
        McpDirectoryEntry("Hugging Face", "https://huggingface.co/mcp", OPEN, R.string.mcpdir_blurb_hugging_face, M, popular = true),
        McpDirectoryEntry("Replicate", "https://mcp.replicate.com/mcp", OAUTH, R.string.mcpdir_blurb_replicate, M),
        McpDirectoryEntry("Runway", "https://mcp.runwayml.com/mcp", OAUTH, R.string.mcpdir_blurb_runway, M),
    )
}
