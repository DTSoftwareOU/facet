package io.dtsoftware.facet.domain.tools

import io.dtsoftware.facet.mcp.McpAuthMode

enum class McpCategory(val label: String) {
    KNOWLEDGE("Docs & knowledge"),
    DEVELOPER("Developer"),
    PRODUCTIVITY("Productivity"),
    DESIGN("Design"),
    DATA("Data & analytics"),
    CLOUD("Cloud"),
    BUSINESS("Business"),
    COMMERCE("Payments & shopping"),
    SEARCH("Search & web"),
    FINANCE("Finance"),
    TRAVEL("Travel & maps"),
    AI("AI & media"),
}

data class McpDirectoryEntry(
    val name: String,
    val url: String,
    val auth: McpAuthMode,
    val blurb: String,
    val category: McpCategory,
    val popular: Boolean = false,
)

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
        McpDirectoryEntry("DeepWiki", "https://mcp.deepwiki.com/mcp", OPEN, "Ask questions about any public GitHub repository.", K, popular = true),
        McpDirectoryEntry("Context7", "https://mcp.context7.com/mcp", OPEN, "Current docs and code examples for popular libraries.", K, popular = true),
        McpDirectoryEntry("Microsoft Learn", "https://learn.microsoft.com/api/mcp", OPEN, "Official Microsoft, Azure and .NET documentation.", K),
        McpDirectoryEntry("AWS Knowledge", "https://knowledge-mcp.global.api.aws", OPEN, "AWS docs, best practices and regional availability.", K),
        McpDirectoryEntry("Cloudflare Docs", "https://docs.mcp.cloudflare.com/mcp", OPEN, "Cloudflare developer documentation.", K),
        McpDirectoryEntry("OpenAI Docs", "https://developers.openai.com/mcp", OPEN, "OpenAI API guides and reference.", K),
        McpDirectoryEntry("Claude Docs", "https://platform.claude.com/docs/mcp", OPEN, "Claude and Anthropic API documentation.", K),
        McpDirectoryEntry("GitMCP", "https://gitmcp.io/docs", OPEN, "Read the docs of any GitHub project on demand.", K),
        McpDirectoryEntry("Astro Docs", "https://mcp.docs.astro.build/mcp", OPEN, "Astro framework documentation.", K),
        McpDirectoryEntry("Svelte Docs", "https://mcp.svelte.dev/mcp", OPEN, "Svelte and SvelteKit documentation.", K),
        McpDirectoryEntry("Nuxt Docs", "https://nuxt.com/mcp", OPEN, "Nuxt documentation and modules.", K),
        McpDirectoryEntry("Pinecone Docs", "https://docs.pinecone.io/mcp", OPEN, "Pinecone vector database documentation.", K),

        // Developer
        McpDirectoryEntry("GitHub", "https://api.githubcopilot.com/mcp/", TOKEN, "Repositories, issues and pull requests. Needs a personal access token.", D, popular = true),
        McpDirectoryEntry("GitLab", "https://gitlab.com/api/v4/mcp", OAUTH, "Projects, merge requests and pipelines.", D),
        McpDirectoryEntry("Sentry", "https://mcp.sentry.dev/mcp", OAUTH, "Errors, issues and releases from your projects.", D, popular = true),
        McpDirectoryEntry("Grep by Vercel", "https://mcp.grep.app", OPEN, "Search code across a million public repositories.", D),
        McpDirectoryEntry("Socket", "https://mcp.socket.dev/", OPEN, "Security and quality scores for open-source packages.", D),
        McpDirectoryEntry("Semgrep", "https://mcp.semgrep.ai/mcp", OAUTH, "Scan code for security issues.", D),
        McpDirectoryEntry("Postman", "https://mcp.postman.com/mcp", OAUTH, "APIs, collections and workspaces.", D),
        McpDirectoryEntry("Buildkite", "https://mcp.buildkite.com/mcp", OAUTH, "Pipelines, builds and test results.", D),
        McpDirectoryEntry("Jam", "https://mcp.jam.dev/mcp", OAUTH, "Bug reports with console logs and network requests.", D),
        McpDirectoryEntry("Globalping", "https://mcp.globalping.dev/mcp", OAUTH, "Ping, traceroute and DNS tests from around the world.", D),
        McpDirectoryEntry("OpenZeppelin", "https://mcp.openzeppelin.com/contracts/solidity/mcp", OPEN, "Generate secure Solidity smart contracts.", D),

        // Productivity
        McpDirectoryEntry("Notion", "https://mcp.notion.com/mcp", OAUTH, "Search, read and edit your Notion workspace.", P, popular = true),
        McpDirectoryEntry("Linear", "https://mcp.linear.app/mcp", OAUTH, "Issues, projects and cycles.", P, popular = true),
        McpDirectoryEntry("Atlassian", "https://mcp.atlassian.com/v1/mcp", OAUTH, "Jira issues and Confluence pages.", P, popular = true),
        McpDirectoryEntry("Asana", "https://mcp.asana.com/sse", OAUTH, "Tasks, projects and goals.", P),
        McpDirectoryEntry("monday.com", "https://mcp.monday.com/mcp", OAUTH, "Boards, items and updates.", P),
        McpDirectoryEntry("ClickUp", "https://mcp.clickup.com/mcp", OAUTH, "Tasks, docs and spaces.", P),
        McpDirectoryEntry("Todoist", "https://ai.todoist.net/mcp", OAUTH, "Your tasks and projects.", P),
        McpDirectoryEntry("Airtable", "https://mcp.airtable.com/mcp", OAUTH, "Bases, tables and records.", P),
        McpDirectoryEntry("Dropbox", "https://mcp.dropbox.com/mcp", OAUTH, "Find and read files in your Dropbox.", P),
        McpDirectoryEntry("Zapier", "https://mcp.zapier.com/api/mcp/mcp", OAUTH, "Run actions in thousands of apps.", P, popular = true),
        McpDirectoryEntry("Fireflies", "https://api.fireflies.ai/mcp", OAUTH, "Meeting transcripts and summaries.", P),
        McpDirectoryEntry("Granola", "https://mcp.granola.ai/mcp", OAUTH, "Your meeting notes.", P),
        McpDirectoryEntry("Cal.com", "https://mcp.cal.com/mcp", OAUTH, "Bookings and availability.", P),
        McpDirectoryEntry("Egnyte", "https://mcp-server.egnyte.com/sse", OAUTH, "Search and read company files.", P),

        // Design
        McpDirectoryEntry("Figma", "https://mcp.figma.com/mcp", OAUTH, "Read designs, components and variables.", G, popular = true),
        McpDirectoryEntry("Canva", "https://mcp.canva.com/mcp", OAUTH, "Create and edit Canva designs.", G),
        McpDirectoryEntry("Miro", "https://mcp.miro.com/", OAUTH, "Boards, sticky notes and diagrams.", G),
        McpDirectoryEntry("Excalidraw", "https://mcp.excalidraw.com/mcp", OPEN, "Sketch hand-drawn diagrams.", G),
        McpDirectoryEntry("Gamma", "https://mcp.gamma.app/mcp", OAUTH, "Generate presentations and documents.", G),
        McpDirectoryEntry("Webflow", "https://mcp.webflow.com/mcp", OAUTH, "Sites, pages and CMS collections.", G),
        McpDirectoryEntry("Wix", "https://mcp.wix.com/sse", OAUTH, "Manage your Wix sites.", G),
        McpDirectoryEntry("Cloudinary", "https://asset-management.mcp.cloudinary.com/sse", OAUTH, "Upload, search and transform media.", G),

        // Data & analytics
        McpDirectoryEntry("Supabase", "https://mcp.supabase.com/mcp", OAUTH, "Postgres databases, auth and storage.", A, popular = true),
        McpDirectoryEntry("Neon", "https://mcp.neon.tech/mcp", OAUTH, "Serverless Postgres: branches and queries.", A),
        McpDirectoryEntry("Prisma Postgres", "https://mcp.prisma.io/mcp", OAUTH, "Create and query Prisma Postgres databases.", A),
        McpDirectoryEntry("MotherDuck", "https://api.motherduck.com/mcp", OAUTH, "Query data with DuckDB in the cloud.", A),
        McpDirectoryEntry("Hex", "https://app.hex.tech/mcp", OAUTH, "Notebooks, data apps and analyses.", A),
        McpDirectoryEntry("PostHog", "https://mcp.posthog.com/mcp", OAUTH, "Product analytics, feature flags and experiments.", A),
        McpDirectoryEntry("Axiom", "https://mcp.axiom.co/mcp", OAUTH, "Query logs and events.", A),
        McpDirectoryEntry("Grafana", "https://mcp.grafana.com/mcp", OAUTH, "Dashboards, alerts and metrics.", A),
        McpDirectoryEntry("Honeycomb", "https://mcp.honeycomb.io/mcp", OAUTH, "Traces and observability queries.", A),

        // Cloud
        McpDirectoryEntry("Vercel", "https://mcp.vercel.com", OAUTH, "Projects, deployments and logs.", C, popular = true),
        McpDirectoryEntry("Netlify", "https://netlify-mcp.netlify.app/mcp", OAUTH, "Sites, deploys and forms.", C),
        McpDirectoryEntry("Railway", "https://mcp.railway.com/mcp", OAUTH, "Services, deployments and variables.", C),
        McpDirectoryEntry("DigitalOcean", "https://apps.mcp.digitalocean.com/mcp", OAUTH, "App Platform apps and deployments.", C),
        McpDirectoryEntry("Cloudflare Workers", "https://bindings.mcp.cloudflare.com/mcp", OAUTH, "Workers, KV, R2 and D1.", C),
        McpDirectoryEntry("Cloudflare Observability", "https://observability.mcp.cloudflare.com/mcp", OAUTH, "Logs and analytics for your Workers.", C),
        McpDirectoryEntry("Cloudflare Browser", "https://browser.mcp.cloudflare.com/mcp", OAUTH, "Fetch pages and take screenshots in a real browser.", C),

        // Business
        McpDirectoryEntry("Intercom", "https://mcp.intercom.com/mcp", OAUTH, "Conversations, contacts and help articles.", B),
        McpDirectoryEntry("Close", "https://mcp.close.com/mcp", OAUTH, "CRM leads, deals and activities.", B),
        McpDirectoryEntry("Klaviyo", "https://mcp.klaviyo.com/mcp", OAUTH, "Email and SMS campaigns, flows and metrics.", B),
        McpDirectoryEntry("Ahrefs", "https://api.ahrefs.com/mcp/mcp", OAUTH, "SEO: backlinks, keywords and rankings.", B),
        McpDirectoryEntry("Semrush", "https://mcp.semrush.com/v1/mcp", OAUTH, "SEO and competitor research.", B),

        // Payments & shopping
        McpDirectoryEntry("Stripe", "https://mcp.stripe.com", OAUTH, "Payments, customers and subscriptions.", S, popular = true),
        McpDirectoryEntry("PayPal", "https://mcp.paypal.com/mcp", OAUTH, "Invoices, orders and transactions.", S),
        McpDirectoryEntry("Square", "https://mcp.squareup.com/sse", OAUTH, "Sales, catalog and customers.", S),
        McpDirectoryEntry("Instacart", "https://mcp.instacart.com/mcp", OPEN, "Turn recipes and lists into grocery carts.", S),
        McpDirectoryEntry("Ramp", "https://ramp-mcp-remote.ramp.com/mcp", OAUTH, "Company spend, cards and bills.", S),

        // Search & web
        McpDirectoryEntry("Exa", "https://mcp.exa.ai/mcp", OPEN, "Web search built for AI, with full page contents.", W, popular = true),
        McpDirectoryEntry("Jina AI", "https://mcp.jina.ai/v1", OPEN, "Read web pages and search the web.", W),
        McpDirectoryEntry("Tavily", "https://mcp.tavily.com/mcp/", OAUTH, "Web search and page extraction.", W),
        McpDirectoryEntry("Bright Data", "https://mcp.brightdata.com/mcp", OAUTH, "Scrape sites and search without getting blocked.", W),
        McpDirectoryEntry("Apify", "https://mcp.apify.com", OAUTH, "Thousands of ready-made scrapers and automations.", W),
        McpDirectoryEntry("Cloudflare Radar", "https://radar.mcp.cloudflare.com/mcp", OAUTH, "Internet traffic trends and outages.", W),

        // Finance
        McpDirectoryEntry("CoinGecko", "https://mcp.api.coingecko.com/mcp", OPEN, "Crypto prices, market data and trends.", F),
        McpDirectoryEntry("Alpha Vantage", "https://mcp.alphavantage.co/mcp", OAUTH, "Stock, forex and economic data.", F),

        // Travel & maps
        McpDirectoryEntry("Kiwi.com", "https://mcp.kiwi.com", OPEN, "Search flights and fares.", T, popular = true),
        McpDirectoryEntry("Mapbox", "https://mcp.mapbox.com/mcp", OAUTH, "Places, directions and maps.", T),

        // AI & media
        McpDirectoryEntry("Hugging Face", "https://huggingface.co/mcp", OPEN, "Search models, datasets, papers and Spaces.", M, popular = true),
        McpDirectoryEntry("Replicate", "https://mcp.replicate.com/mcp", OAUTH, "Run open-source models for images, video and audio.", M),
        McpDirectoryEntry("Runway", "https://mcp.runwayml.com/mcp", OAUTH, "Generate and edit video and images.", M),
    )
}
