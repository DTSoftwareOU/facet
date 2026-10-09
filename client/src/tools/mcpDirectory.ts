/** The verified directory of remote MCP servers (port of McpDirectory.kt). */
import type { McpAuthMode } from '../data/entities';

export type McpCategory =
  | 'KNOWLEDGE' | 'DEVELOPER' | 'PRODUCTIVITY' | 'DESIGN' | 'DATA' | 'CLOUD'
  | 'BUSINESS' | 'COMMERCE' | 'SEARCH' | 'FINANCE' | 'TRAVEL' | 'AI';

/** Categories in display order. */
export const MCP_CATEGORIES: readonly { id: McpCategory; label: string }[] = [
  { id: 'KNOWLEDGE', label: 'Docs & knowledge' },
  { id: 'DEVELOPER', label: 'Developer' },
  { id: 'PRODUCTIVITY', label: 'Productivity' },
  { id: 'DESIGN', label: 'Design' },
  { id: 'DATA', label: 'Data & analytics' },
  { id: 'CLOUD', label: 'Cloud' },
  { id: 'BUSINESS', label: 'Business' },
  { id: 'COMMERCE', label: 'Payments & shopping' },
  { id: 'SEARCH', label: 'Search & web' },
  { id: 'FINANCE', label: 'Finance' },
  { id: 'TRAVEL', label: 'Travel & maps' },
  { id: 'AI', label: 'AI & media' },
];

export const mcpCategoryLabel = (id: McpCategory): string => MCP_CATEGORIES.find((c) => c.id === id)?.label ?? id;

export interface McpDirectoryEntry {
  name: string;
  url: string;
  auth: McpAuthMode;
  blurb: string;
  category: McpCategory;
  popular: boolean;
}

const OPEN: McpAuthMode = 'NONE';
const OAUTH: McpAuthMode = 'OAUTH';
const TOKEN: McpAuthMode = 'HEADERS';

function entry(name: string, url: string, auth: McpAuthMode, blurb: string, category: McpCategory, popular = false): McpDirectoryEntry {
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
  entry('DeepWiki', 'https://mcp.deepwiki.com/mcp', OPEN, 'Ask questions about any public GitHub repository.', 'KNOWLEDGE', true),
  entry('Context7', 'https://mcp.context7.com/mcp', OPEN, 'Current docs and code examples for popular libraries.', 'KNOWLEDGE', true),
  entry('Microsoft Learn', 'https://learn.microsoft.com/api/mcp', OPEN, 'Official Microsoft, Azure and .NET documentation.', 'KNOWLEDGE'),
  entry('AWS Knowledge', 'https://knowledge-mcp.global.api.aws', OPEN, 'AWS docs, best practices and regional availability.', 'KNOWLEDGE'),
  entry('Cloudflare Docs', 'https://docs.mcp.cloudflare.com/mcp', OPEN, 'Cloudflare developer documentation.', 'KNOWLEDGE'),
  entry('OpenAI Docs', 'https://developers.openai.com/mcp', OPEN, 'OpenAI API guides and reference.', 'KNOWLEDGE'),
  entry('Claude Docs', 'https://platform.claude.com/docs/mcp', OPEN, 'Claude and Anthropic API documentation.', 'KNOWLEDGE'),
  entry('GitMCP', 'https://gitmcp.io/docs', OPEN, 'Read the docs of any GitHub project on demand.', 'KNOWLEDGE'),
  entry('Astro Docs', 'https://mcp.docs.astro.build/mcp', OPEN, 'Astro framework documentation.', 'KNOWLEDGE'),
  entry('Svelte Docs', 'https://mcp.svelte.dev/mcp', OPEN, 'Svelte and SvelteKit documentation.', 'KNOWLEDGE'),
  entry('Nuxt Docs', 'https://nuxt.com/mcp', OPEN, 'Nuxt documentation and modules.', 'KNOWLEDGE'),
  entry('Pinecone Docs', 'https://docs.pinecone.io/mcp', OPEN, 'Pinecone vector database documentation.', 'KNOWLEDGE'),

  // Developer
  entry('GitHub', 'https://api.githubcopilot.com/mcp/', TOKEN, 'Repositories, issues and pull requests. Needs a personal access token.', 'DEVELOPER', true),
  entry('GitLab', 'https://gitlab.com/api/v4/mcp', OAUTH, 'Projects, merge requests and pipelines.', 'DEVELOPER'),
  entry('Sentry', 'https://mcp.sentry.dev/mcp', OAUTH, 'Errors, issues and releases from your projects.', 'DEVELOPER', true),
  entry('Grep by Vercel', 'https://mcp.grep.app', OPEN, 'Search code across a million public repositories.', 'DEVELOPER'),
  entry('Socket', 'https://mcp.socket.dev/', OPEN, 'Security and quality scores for open-source packages.', 'DEVELOPER'),
  entry('Semgrep', 'https://mcp.semgrep.ai/mcp', OAUTH, 'Scan code for security issues.', 'DEVELOPER'),
  entry('Postman', 'https://mcp.postman.com/mcp', OAUTH, 'APIs, collections and workspaces.', 'DEVELOPER'),
  entry('Buildkite', 'https://mcp.buildkite.com/mcp', OAUTH, 'Pipelines, builds and test results.', 'DEVELOPER'),
  entry('Jam', 'https://mcp.jam.dev/mcp', OAUTH, 'Bug reports with console logs and network requests.', 'DEVELOPER'),
  entry('Globalping', 'https://mcp.globalping.dev/mcp', OAUTH, 'Ping, traceroute and DNS tests from around the world.', 'DEVELOPER'),
  entry('OpenZeppelin', 'https://mcp.openzeppelin.com/contracts/solidity/mcp', OPEN, 'Generate secure Solidity smart contracts.', 'DEVELOPER'),

  // Productivity
  entry('Notion', 'https://mcp.notion.com/mcp', OAUTH, 'Search, read and edit your Notion workspace.', 'PRODUCTIVITY', true),
  entry('Linear', 'https://mcp.linear.app/mcp', OAUTH, 'Issues, projects and cycles.', 'PRODUCTIVITY', true),
  entry('Atlassian', 'https://mcp.atlassian.com/v1/mcp', OAUTH, 'Jira issues and Confluence pages.', 'PRODUCTIVITY', true),
  entry('Asana', 'https://mcp.asana.com/sse', OAUTH, 'Tasks, projects and goals.', 'PRODUCTIVITY'),
  entry('monday.com', 'https://mcp.monday.com/mcp', OAUTH, 'Boards, items and updates.', 'PRODUCTIVITY'),
  entry('ClickUp', 'https://mcp.clickup.com/mcp', OAUTH, 'Tasks, docs and spaces.', 'PRODUCTIVITY'),
  entry('Todoist', 'https://ai.todoist.net/mcp', OAUTH, 'Your tasks and projects.', 'PRODUCTIVITY'),
  entry('Airtable', 'https://mcp.airtable.com/mcp', OAUTH, 'Bases, tables and records.', 'PRODUCTIVITY'),
  entry('Dropbox', 'https://mcp.dropbox.com/mcp', OAUTH, 'Find and read files in your Dropbox.', 'PRODUCTIVITY'),
  entry('Zapier', 'https://mcp.zapier.com/api/mcp/mcp', OAUTH, 'Run actions in thousands of apps.', 'PRODUCTIVITY', true),
  entry('Fireflies', 'https://api.fireflies.ai/mcp', OAUTH, 'Meeting transcripts and summaries.', 'PRODUCTIVITY'),
  entry('Granola', 'https://mcp.granola.ai/mcp', OAUTH, 'Your meeting notes.', 'PRODUCTIVITY'),
  entry('Cal.com', 'https://mcp.cal.com/mcp', OAUTH, 'Bookings and availability.', 'PRODUCTIVITY'),
  entry('Egnyte', 'https://mcp-server.egnyte.com/sse', OAUTH, 'Search and read company files.', 'PRODUCTIVITY'),

  // Design
  entry('Figma', 'https://mcp.figma.com/mcp', OAUTH, 'Read designs, components and variables.', 'DESIGN', true),
  entry('Canva', 'https://mcp.canva.com/mcp', OAUTH, 'Create and edit Canva designs.', 'DESIGN'),
  entry('Miro', 'https://mcp.miro.com/', OAUTH, 'Boards, sticky notes and diagrams.', 'DESIGN'),
  entry('Excalidraw', 'https://mcp.excalidraw.com/mcp', OPEN, 'Sketch hand-drawn diagrams.', 'DESIGN'),
  entry('Gamma', 'https://mcp.gamma.app/mcp', OAUTH, 'Generate presentations and documents.', 'DESIGN'),
  entry('Webflow', 'https://mcp.webflow.com/mcp', OAUTH, 'Sites, pages and CMS collections.', 'DESIGN'),
  entry('Wix', 'https://mcp.wix.com/sse', OAUTH, 'Manage your Wix sites.', 'DESIGN'),
  entry('Cloudinary', 'https://asset-management.mcp.cloudinary.com/sse', OAUTH, 'Upload, search and transform media.', 'DESIGN'),

  // Data & analytics
  entry('Supabase', 'https://mcp.supabase.com/mcp', OAUTH, 'Postgres databases, auth and storage.', 'DATA', true),
  entry('Neon', 'https://mcp.neon.tech/mcp', OAUTH, 'Serverless Postgres: branches and queries.', 'DATA'),
  entry('Prisma Postgres', 'https://mcp.prisma.io/mcp', OAUTH, 'Create and query Prisma Postgres databases.', 'DATA'),
  entry('MotherDuck', 'https://api.motherduck.com/mcp', OAUTH, 'Query data with DuckDB in the cloud.', 'DATA'),
  entry('Hex', 'https://app.hex.tech/mcp', OAUTH, 'Notebooks, data apps and analyses.', 'DATA'),
  entry('PostHog', 'https://mcp.posthog.com/mcp', OAUTH, 'Product analytics, feature flags and experiments.', 'DATA'),
  entry('Axiom', 'https://mcp.axiom.co/mcp', OAUTH, 'Query logs and events.', 'DATA'),
  entry('Grafana', 'https://mcp.grafana.com/mcp', OAUTH, 'Dashboards, alerts and metrics.', 'DATA'),
  entry('Honeycomb', 'https://mcp.honeycomb.io/mcp', OAUTH, 'Traces and observability queries.', 'DATA'),

  // Cloud
  entry('Vercel', 'https://mcp.vercel.com', OAUTH, 'Projects, deployments and logs.', 'CLOUD', true),
  entry('Netlify', 'https://netlify-mcp.netlify.app/mcp', OAUTH, 'Sites, deploys and forms.', 'CLOUD'),
  entry('Railway', 'https://mcp.railway.com/mcp', OAUTH, 'Services, deployments and variables.', 'CLOUD'),
  entry('DigitalOcean', 'https://apps.mcp.digitalocean.com/mcp', OAUTH, 'App Platform apps and deployments.', 'CLOUD'),
  entry('Cloudflare Workers', 'https://bindings.mcp.cloudflare.com/mcp', OAUTH, 'Workers, KV, R2 and D1.', 'CLOUD'),
  entry('Cloudflare Observability', 'https://observability.mcp.cloudflare.com/mcp', OAUTH, 'Logs and analytics for your Workers.', 'CLOUD'),
  entry('Cloudflare Browser', 'https://browser.mcp.cloudflare.com/mcp', OAUTH, 'Fetch pages and take screenshots in a real browser.', 'CLOUD'),

  // Business
  entry('Intercom', 'https://mcp.intercom.com/mcp', OAUTH, 'Conversations, contacts and help articles.', 'BUSINESS'),
  entry('Close', 'https://mcp.close.com/mcp', OAUTH, 'CRM leads, deals and activities.', 'BUSINESS'),
  entry('Klaviyo', 'https://mcp.klaviyo.com/mcp', OAUTH, 'Email and SMS campaigns, flows and metrics.', 'BUSINESS'),
  entry('Ahrefs', 'https://api.ahrefs.com/mcp/mcp', OAUTH, 'SEO: backlinks, keywords and rankings.', 'BUSINESS'),
  entry('Semrush', 'https://mcp.semrush.com/v1/mcp', OAUTH, 'SEO and competitor research.', 'BUSINESS'),

  // Payments & shopping
  entry('Stripe', 'https://mcp.stripe.com', OAUTH, 'Payments, customers and subscriptions.', 'COMMERCE', true),
  entry('PayPal', 'https://mcp.paypal.com/mcp', OAUTH, 'Invoices, orders and transactions.', 'COMMERCE'),
  entry('Square', 'https://mcp.squareup.com/sse', OAUTH, 'Sales, catalog and customers.', 'COMMERCE'),
  entry('Instacart', 'https://mcp.instacart.com/mcp', OPEN, 'Turn recipes and lists into grocery carts.', 'COMMERCE'),
  entry('Ramp', 'https://ramp-mcp-remote.ramp.com/mcp', OAUTH, 'Company spend, cards and bills.', 'COMMERCE'),

  // Search & web
  entry('Exa', 'https://mcp.exa.ai/mcp', OPEN, 'Web search built for AI, with full page contents.', 'SEARCH', true),
  entry('Jina AI', 'https://mcp.jina.ai/v1', OPEN, 'Read web pages and search the web.', 'SEARCH'),
  entry('Tavily', 'https://mcp.tavily.com/mcp/', OAUTH, 'Web search and page extraction.', 'SEARCH'),
  entry('Bright Data', 'https://mcp.brightdata.com/mcp', OAUTH, 'Scrape sites and search without getting blocked.', 'SEARCH'),
  entry('Apify', 'https://mcp.apify.com', OAUTH, 'Thousands of ready-made scrapers and automations.', 'SEARCH'),
  entry('Cloudflare Radar', 'https://radar.mcp.cloudflare.com/mcp', OAUTH, 'Internet traffic trends and outages.', 'SEARCH'),

  // Finance
  entry('CoinGecko', 'https://mcp.api.coingecko.com/mcp', OPEN, 'Crypto prices, market data and trends.', 'FINANCE'),
  entry('Alpha Vantage', 'https://mcp.alphavantage.co/mcp', OAUTH, 'Stock, forex and economic data.', 'FINANCE'),

  // Travel & maps
  entry('Kiwi.com', 'https://mcp.kiwi.com', OPEN, 'Search flights and fares.', 'TRAVEL', true),
  entry('Mapbox', 'https://mcp.mapbox.com/mcp', OAUTH, 'Places, directions and maps.', 'TRAVEL'),

  // AI & media
  entry('Hugging Face', 'https://huggingface.co/mcp', OPEN, 'Search models, datasets, papers and Spaces.', 'AI', true),
  entry('Replicate', 'https://mcp.replicate.com/mcp', OAUTH, 'Run open-source models for images, video and audio.', 'AI'),
  entry('Runway', 'https://mcp.runwayml.com/mcp', OAUTH, 'Generate and edit video and images.', 'AI'),
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
    if (q) return e.name.toLowerCase().includes(q) || e.blurb.toLowerCase().includes(q) || mcpCategoryLabel(e.category).toLowerCase().includes(q);
    return category == null ? e.popular : e.category === category;
  });
}
