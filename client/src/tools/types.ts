/** Tool contracts (port of ToolModels.kt), plus the desktop app's computer tools. */
import type { AttachmentRef } from '../data/entities';
import { msg, type Msg } from '../i18n';
import type { Citation, ModelOutput, ProviderBlocks, ToolSpec } from '../llm/types';

/** When an MCP tool needs the user's go-ahead before it runs. Stored by name in synced records. */
export type ToolApproval = 'ALWAYS' | 'WRITES' | 'NEVER';
/** `label` and `blurb` are shown with tm(). */
export const TOOL_APPROVAL_INFO: Record<ToolApproval, { label: Msg; blurb: Msg }> = {
  ALWAYS: { label: msg('Always ask'), blurb: msg('Ask before every tool call.') },
  WRITES: { label: msg('Ask for changes'), blurb: msg('Ask unless the server marks a tool as read-only.') },
  NEVER: { label: msg('Never ask'), blurb: msg('Run tools without asking.') },
};

/**
 * Stored by name in ToolCallRecord.kind. COMPUTER is the desktop app's local tools (commands,
 * files); Android shows unknown kinds as MCP, which renders fine.
 */
export type ToolKind = 'SEARCH' | 'FETCH' | 'SKILL' | 'MCP' | 'MEDIA' | 'COMPUTER';

/** A tool offered to the model for one request. */
export interface ToolDef {
  spec: ToolSpec;
  kind: ToolKind;
  /** MCP server id and the tool's original name on that server (or the computer tool's name). */
  serverId?: string | null;
  serverName?: string | null;
  remoteName?: string | null;
  needsApproval: boolean;
  /** For MEDIA tools: what the tool makes. */
  output?: ModelOutput | null;
}

/** Where a tool runs: the reply's chat, and a way to show progress (e.g. "Creating video · 1:20"). */
export interface ToolContext {
  conversationId?: string | null;
  /** The model's id for this call (computer tools use it to cancel a running command). */
  callId?: string;
  onProgress?: (label: string) => void;
  signal?: AbortSignal;
}

/** What a tool returned, ready for the model and the UI. */
export interface ToolOutcome {
  content: string;
  isError?: boolean;
  citations?: Citation[];
  /** Short past-tense line for the UI, e.g. "Searched “rent prices in Porto”". */
  label?: string | null;
  /** Media the tool created, shown with the reply. */
  attachments?: AttachmentRef[];
}

export interface SkillResource {
  path: string;
  content: string;
}

/** One executed tool call, stored with the reply (synced JSON; same shape as Android). */
export interface ToolCallRecord {
  id: string;
  name: string;
  kind: string;
  label: string;
  argumentsJson: string;
  result: string;
  isError: boolean;
  durationMs?: number;
  serverName?: string | null;
}

/** One assistant step that ended in tool calls. */
export interface ToolStep {
  text: string;
  calls: ToolCallRecord[];
  blocks?: ProviderBlocks | null;
}

/** All tool steps of a reply plus the text of the final step, for exact replay. */
export interface ToolTrace {
  steps: ToolStep[];
  finalText: string;
}

/** Bring-your-own-key web search backends for models without built-in search (stored as providers). */
export interface SearchKind {
  id: string;
  displayName: string;
  /** Show with tm(). */
  blurb: Msg;
  keyUrl: string | null;
  needsKey: boolean;
  defaultUrl: string;
  /** Whether the API accepts requests from web pages (see ProviderKind.browserOk). */
  browserOk: boolean;
}

export const SEARCH_KINDS: readonly SearchKind[] = [
  { id: 'search.brave', displayName: 'Brave Search', blurb: msg('Independent index. Free tier available.'), keyUrl: 'https://api-dashboard.search.brave.com/app/keys', needsKey: true, defaultUrl: 'https://api.search.brave.com', browserOk: false },
  { id: 'search.tavily', displayName: 'Tavily', blurb: msg('Search built for AI agents. Free tier available.'), keyUrl: 'https://app.tavily.com/home', needsKey: true, defaultUrl: 'https://api.tavily.com', browserOk: true },
  { id: 'search.exa', displayName: 'Exa', blurb: msg('Neural search with page text.'), keyUrl: 'https://dashboard.exa.ai/api-keys', needsKey: true, defaultUrl: 'https://api.exa.ai', browserOk: false },
  { id: 'search.jina', displayName: 'Jina Search', blurb: msg('Search with full page content.'), keyUrl: 'https://jina.ai/api-dashboard/key-manager', needsKey: true, defaultUrl: 'https://s.jina.ai', browserOk: true },
  { id: 'search.searxng', displayName: 'SearXNG', blurb: msg('Your own metasearch instance (JSON output enabled).'), keyUrl: 'https://docs.searxng.org', needsKey: false, defaultUrl: 'https://', browserOk: true },
];

export const SEARCH_PREFIX = 'search.';
export const searchKind = (id: string): SearchKind | undefined => SEARCH_KINDS.find((k) => k.id === id);
export const isSearchKind = (kindId: string): boolean => kindId.startsWith(SEARCH_PREFIX);
