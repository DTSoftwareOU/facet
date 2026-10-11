/** The verified directory of remote MCP servers (port of McpDirectory.kt). */
import type { McpAuthMode } from '../data/entities';
import { msg, tm, type Msg } from '../i18n';

export type McpCategory =
  | 'KNOWLEDGE' | 'DEVELOPER' | 'PRODUCTIVITY' | 'DESIGN' | 'DATA' | 'CLOUD'
  | 'BUSINESS' | 'COMMERCE' | 'SEARCH' | 'FINANCE' | 'TRAVEL' | 'AI';

/** Categories in display order. Show `label` with tm(), or use mcpCategoryLabel(). */
export const MCP_CATEGORIES: readonly { id: McpCategory; label: Msg }[] = [
  { id: 'KNOWLEDGE', label: msg('Docs & knowledge') },
  { id: 'DEVELOPER', label: msg('Developer') },
  { id: 'PRODUCTIVITY', label: msg('Productivity') },
  { id: 'DESIGN', label: msg('Design') },
  { id: 'DATA', label: msg('Data & analytics') },
  { id: 'CLOUD', label: msg('Cloud') },
  { id: 'BUSINESS', label: msg('Business') },
  { id: 'COMMERCE', label: msg('Payments & shopping') },
  { id: 'SEARCH', label: msg('Search & web') },
  { id: 'FINANCE', label: msg('Finance') },
  { id: 'TRAVEL', label: msg('Travel & maps') },
  { id: 'AI', label: msg('AI & media') },
];

/** The category's name in the interface language. */
export function mcpCategoryLabel(id: McpCategory): string {
  const label = MCP_CATEGORIES.find((c) => c.id === id)?.label;
  return label ? tm(label) : id;
}

export interface McpDirectoryEntry {
  name: string;
  url: string;
  auth: McpAuthMode;
  /** Show with tm(). */
  blurb: Msg;
  category: McpCategory;
  popular: boolean;
}

const OPEN: McpAuthMode = 'NONE';
const OAUTH: McpAuthMode = 'OAUTH';
const TOKEN: McpAuthMode = 'HEADERS';

function entry(name: string, url: string, auth: McpAuthMode, blurb: Msg, category: McpCategory, popular = false): McpDirectoryEntry {
  return { name, url, auth, blurb, category, popular };
}

/**
 * Remote MCP servers. Each address was checked with an MCP handshake: OPEN servers answer without
 * credentials; OAUTH servers publish OAuth metadata with dynamic client registration, so "Sign in"
 * works; HEADERS servers need a token pasted into the server's headers. On the website, a server
 * also has to allow requests from web pages (CORS); the others work in the Windows and Android apps.
 */
export const MCP_DIRECTORY: readonly McpDirectoryEntry[] = [
  // Docs & knowledge
  entry('DeepWiki', 'https://mcp.deepwiki.com/mcp', OPEN, msg('Ask questions about any public GitHub repository.'), 'KNOWLEDGE', true),
  entry('Context7', 'https://mcp.context7.com/mcp', OPEN, msg('Current docs and code examples for popular libraries.'), 'KNOWLEDGE', true),
  entry('Microsoft Learn', 'https://learn.microsoft.com/api/mcp', OPEN, msg('Official Microsoft, Azure and .NET documentation.'), 'KNOWLEDGE'),
  entry('AWS Knowledge', 'https://knowledge-mcp.global.api.aws', OPEN, msg('AWS docs, best practices and regional availability.'), 'KNOWLEDGE'),
  entry('Cloudflare Docs', 'https://docs.mcp.cloudflare.com/mcp', OPEN, msg('Cloudflare developer documentation.'), 'KNOWLEDGE'),
  entry('OpenAI Docs', 'https://developers.openai.com/mcp', OPEN, msg('OpenAI API guides and reference.'), 'KNOWLEDGE'),
  entry('Claude Docs', 'https://platform.claude.com/docs/mcp', OPEN, msg('Claude and Anthropic API documentation.'), 'KNOWLEDGE'),
  entry('GitMCP', 'https://gitmcp.io/docs', OPEN, msg('Read the docs of any GitHub project on demand.'), 'KNOWLEDGE'),
  entry('Astro Docs', 'https://mcp.docs.astro.build/mcp', OPEN, msg('Astro framework documentation.'), 'KNOWLEDGE'),
  entry('Svelte Docs', 'https://mcp.svelte.dev/mcp', OPEN, msg('Svelte and SvelteKit documentation.'), 'KNOWLEDGE'),
  entry('Nuxt Docs', 'https://nuxt.com/mcp', OPEN, msg('Nuxt documentation and modules.'), 'KNOWLEDGE'),
  entry('Pinecone Docs', 'https://docs.pinecone.io/mcp', OPEN, msg('Pinecone vector database documentation.'), 'KNOWLEDGE'),

  // Developer
  entry('GitHub', 'https://api.githubcopilot.com/mcp/', TOKEN, msg('Repositories, issues and pull requests. Needs a personal access token.'), 'DEVELOPER', true),
  entry('GitLab', 'https://gitlab.com/api/v4/mcp', OAUTH, msg('Projects, merge requests and pipelines.'), 'DEVELOPER'),
  entry('Sentry', 'https://mcp.sentry.dev/mcp', OAUTH, msg('Errors, issues and releases from your projects.'), 'DEVELOPER', true),
  entry('Grep by Vercel', 'https://mcp.grep.app', OPEN, msg('Search code across a million public repositories.'), 'DEVELOPER'),
  entry('Socket', 'https://mcp.socket.dev/', OPEN, msg('Security and quality scores for open-source packages.'), 'DEVELOPER'),
  entry('Semgrep', 'https://mcp.semgrep.ai/mcp', OAUTH, msg('Scan code for security issues.'), 'DEVELOPER'),
  entry('Postman', 'https://mcp.postman.com/mcp', OAUTH, msg('APIs, collections and workspaces.'), 'DEVELOPER'),
  entry('Buildkite', 'https://mcp.buildkite.com/mcp', OAUTH, msg('Pipelines, builds and test results.'), 'DEVELOPER'),
  entry('Jam', 'https://mcp.jam.dev/mcp', OAUTH, msg('Bug reports with console logs and network requests.'), 'DEVELOPER'),
  entry('Globalping', 'https://mcp.globalping.dev/mcp', OAUTH, msg('Ping, traceroute and DNS tests from around the world.'), 'DEVELOPER'),
  entry('OpenZeppelin', 'https://mcp.openzeppelin.com/contracts/solidity/mcp', OPEN, msg('Generate secure Solidity smart contracts.'), 'DEVELOPER'),

  // Productivity
  entry('Notion', 'https://mcp.notion.com/mcp', OAUTH, msg('Search, read and edit your Notion workspace.'), 'PRODUCTIVITY', true),
  entry('Linear', 'https://mcp.linear.app/mcp', OAUTH, msg('Issues, projects and cycles.'), 'PRODUCTIVITY', true),
  entry('Atlassian', 'https://mcp.atlassian.com/v1/mcp', OAUTH, msg('Jira issues and Confluence pages.'), 'PRODUCTIVITY', true),
  entry('Asana', 'https://mcp.asana.com/sse', OAUTH, msg('Tasks, projects and goals.'), 'PRODUCTIVITY'),
  entry('monday.com', 'https://mcp.monday.com/mcp', OAUTH, msg('Boards, items and updates.'), 'PRODUCTIVITY'),
  entry('ClickUp', 'https://mcp.clickup.com/mcp', OAUTH, msg('Tasks, docs and spaces.'), 'PRODUCTIVITY'),
  entry('Todoist', 'https://ai.todoist.net/mcp', OAUTH, msg('Your tasks and projects.'), 'PRODUCTIVITY'),
  entry('Airtable', 'https://mcp.airtable.com/mcp', OAUTH, msg('Bases, tables and records.'), 'PRODUCTIVITY'),
  entry('Dropbox', 'https://mcp.dropbox.com/mcp', OAUTH, msg('Find and read files in your Dropbox.'), 'PRODUCTIVITY'),
  entry('Zapier', 'https://mcp.zapier.com/api/mcp/mcp', OAUTH, msg('Run actions in thousands of apps.'), 'PRODUCTIVITY', true),
  entry('Fireflies', 'https://api.fireflies.ai/mcp', OAUTH, msg('Meeting transcripts and summaries.'), 'PRODUCTIVITY'),
  entry('Granola', 'https://mcp.granola.ai/mcp', OAUTH, msg('Your meeting notes.'), 'PRODUCTIVITY'),
  entry('Cal.com', 'https://mcp.cal.com/mcp', OAUTH, msg('Bookings and availability.'), 'PRODUCTIVITY'),
  entry('Egnyte', 'https://mcp-server.egnyte.com/sse', OAUTH, msg('Search and read company files.'), 'PRODUCTIVITY'),

  // Design
  entry('Figma', 'https://mcp.figma.com/mcp', OAUTH, msg('Read designs, components and variables.'), 'DESIGN', true),
  entry('Canva', 'https://mcp.canva.com/mcp', OAUTH, msg('Create and edit Canva designs.'), 'DESIGN'),
  entry('Miro', 'https://mcp.miro.com/', OAUTH, msg('Boards, sticky notes and diagrams.'), 'DESIGN'),
  entry('Excalidraw', 'https://mcp.excalidraw.com/mcp', OPEN, msg('Sketch hand-drawn diagrams.'), 'DESIGN'),
  entry('Gamma', 'https://mcp.gamma.app/mcp', OAUTH, msg('Generate presentations and documents.'), 'DESIGN'),
  entry('Webflow', 'https://mcp.webflow.com/mcp', OAUTH, msg('Sites, pages and CMS collections.'), 'DESIGN'),
  entry('Wix', 'https://mcp.wix.com/sse', OAUTH, msg('Manage your Wix sites.'), 'DESIGN'),
  entry('Cloudinary', 'https://asset-management.mcp.cloudinary.com/sse', OAUTH, msg('Upload, search and transform media.'), 'DESIGN'),

  // Data & analytics
  entry('Supabase', 'https://mcp.supabase.com/mcp', OAUTH, msg('Postgres databases, auth and storage.'), 'DATA', true),
  entry('Neon', 'https://mcp.neon.tech/mcp', OAUTH, msg('Serverless Postgres: branches and queries.'), 'DATA'),
  entry('Prisma Postgres', 'https://mcp.prisma.io/mcp', OAUTH, msg('Create and query Prisma Postgres databases.'), 'DATA'),
  entry('MotherDuck', 'https://api.motherduck.com/mcp', OAUTH, msg('Query data with DuckDB in the cloud.'), 'DATA'),
  entry('Hex', 'https://app.hex.tech/mcp', OAUTH, msg('Notebooks, data apps and analyses.'), 'DATA'),
  entry('PostHog', 'https://mcp.posthog.com/mcp', OAUTH, msg('Product analytics, feature flags and experiments.'), 'DATA'),
  entry('Axiom', 'https://mcp.axiom.co/mcp', OAUTH, msg('Query logs and events.'), 'DATA'),
  entry('Grafana', 'https://mcp.grafana.com/mcp', OAUTH, msg('Dashboards, alerts and metrics.'), 'DATA'),
  entry('Honeycomb', 'https://mcp.honeycomb.io/mcp', OAUTH, msg('Traces and observability queries.'), 'DATA'),

  // Cloud
  entry('Vercel', 'https://mcp.vercel.com', OAUTH, msg('Projects, deployments and logs.'), 'CLOUD', true),
  entry('Netlify', 'https://netlify-mcp.netlify.app/mcp', OAUTH, msg('Sites, deploys and forms.'), 'CLOUD'),
  entry('Railway', 'https://mcp.railway.com/mcp', OAUTH, msg('Services, deployments and variables.'), 'CLOUD'),
  entry('DigitalOcean', 'https://apps.mcp.digitalocean.com/mcp', OAUTH, msg('App Platform apps and deployments.'), 'CLOUD'),
  entry('Cloudflare Workers', 'https://bindings.mcp.cloudflare.com/mcp', OAUTH, msg('Workers, KV, R2 and D1.'), 'CLOUD'),
  entry('Cloudflare Observability', 'https://observability.mcp.cloudflare.com/mcp', OAUTH, msg('Logs and analytics for your Workers.'), 'CLOUD'),
  entry('Cloudflare Browser', 'https://browser.mcp.cloudflare.com/mcp', OAUTH, msg('Fetch pages and take screenshots in a real browser.'), 'CLOUD'),

  // Business
  entry('Intercom', 'https://mcp.intercom.com/mcp', OAUTH, msg('Conversations, contacts and help articles.'), 'BUSINESS'),
  entry('Close', 'https://mcp.close.com/mcp', OAUTH, msg('CRM leads, deals and activities.'), 'BUSINESS'),
  entry('Klaviyo', 'https://mcp.klaviyo.com/mcp', OAUTH, msg('Email and SMS campaigns, flows and metrics.'), 'BUSINESS'),
  entry('Ahrefs', 'https://api.ahrefs.com/mcp/mcp', OAUTH, msg('SEO: backlinks, keywords and rankings.'), 'BUSINESS'),
  entry('Semrush', 'https://mcp.semrush.com/v1/mcp', OAUTH, msg('SEO and competitor research.'), 'BUSINESS'),

  // Payments & shopping
  entry('Stripe', 'https://mcp.stripe.com', OAUTH, msg('Payments, customers and subscriptions.'), 'COMMERCE', true),
  entry('PayPal', 'https://mcp.paypal.com/mcp', OAUTH, msg('Invoices, orders and transactions.'), 'COMMERCE'),
  entry('Square', 'https://mcp.squareup.com/sse', OAUTH, msg('Sales, catalog and customers.'), 'COMMERCE'),
  entry('Instacart', 'https://mcp.instacart.com/mcp', OPEN, msg('Turn recipes and lists into grocery carts.'), 'COMMERCE'),
  entry('Ramp', 'https://ramp-mcp-remote.ramp.com/mcp', OAUTH, msg('Company spend, cards and bills.'), 'COMMERCE'),

  // Search & web
  entry('Exa', 'https://mcp.exa.ai/mcp', OPEN, msg('Web search built for AI, with full page contents.'), 'SEARCH', true),
  entry('Jina AI', 'https://mcp.jina.ai/v1', OPEN, msg('Read web pages and search the web.'), 'SEARCH'),
  entry('Tavily', 'https://mcp.tavily.com/mcp/', OAUTH, msg('Web search and page extraction.'), 'SEARCH'),
  entry('Bright Data', 'https://mcp.brightdata.com/mcp', OAUTH, msg('Scrape sites and search without getting blocked.'), 'SEARCH'),
  entry('Apify', 'https://mcp.apify.com', OAUTH, msg('Thousands of ready-made scrapers and automations.'), 'SEARCH'),
  entry('Cloudflare Radar', 'https://radar.mcp.cloudflare.com/mcp', OAUTH, msg('Internet traffic trends and outages.'), 'SEARCH'),

  // Finance
  entry('CoinGecko', 'https://mcp.api.coingecko.com/mcp', OPEN, msg('Crypto prices, market data and trends.'), 'FINANCE'),
  entry('Alpha Vantage', 'https://mcp.alphavantage.co/mcp', OAUTH, msg('Stock, forex and economic data.'), 'FINANCE'),

  // Travel & maps
  entry('Kiwi.com', 'https://mcp.kiwi.com', OPEN, msg('Search flights and fares.'), 'TRAVEL', true),
  entry('Mapbox', 'https://mcp.mapbox.com/mcp', OAUTH, msg('Places, directions and maps.'), 'TRAVEL'),

  // AI & media
  entry('Hugging Face', 'https://huggingface.co/mcp', OPEN, msg('Search models, datasets, papers and Spaces.'), 'AI', true),
  entry('Replicate', 'https://mcp.replicate.com/mcp', OAUTH, msg('Run open-source models for images, video and audio.'), 'AI'),
  entry('Runway', 'https://mcp.runwayml.com/mcp', OAUTH, msg('Generate and edit video and images.'), 'AI'),
];

/**
 * The directory as the settings screen lists it: entries not added yet, matching [query] (name,
 * blurb or category), else those in [category], else the popular ones.
 */
export function filterDirectory(query: string, category: McpCategory | null, addedUrls: Iterable<string>): McpDirectoryEntry[] {
  const trim = (u: string) => u.replace(/\/+$/, '');
  const added = new Set(Array.from(addedUrls, trim));
  const q = query.trim().toLowerCase();
  return MCP_DIRECTORY.filter((e) => !added.has(trim(e.url))).filter((e) => {
    if (q) return e.name.toLowerCase().includes(q) || tm(e.blurb).toLowerCase().includes(q) || e.blurb.toLowerCase().includes(q) || mcpCategoryLabel(e.category).toLowerCase().includes(q);
    return category == null ? e.popular : e.category === category;
  });
}
