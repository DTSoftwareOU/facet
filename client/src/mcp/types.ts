/**
 * Contract for Facet's Model Context Protocol client (port of McpTypes.kt). Remote servers speak
 * Streamable HTTP or legacy HTTP+SSE; the Windows app also runs local servers over stdio. The app
 * talks to [McpClient] and [McpOAuth].
 */
import type { McpAuthMode, StdioSpec } from '../data/entities';

export type { McpAuthMode, StdioSpec };

/** A configured MCP server. Secrets are decrypted only in memory. */
export interface McpServerConfig {
  id: string;
  name: string;
  /** Streamable HTTP endpoint (e.g. https://mcp.example.com/mcp). Legacy HTTP+SSE endpoints are detected automatically. Unused for stdio servers. */
  url: string;
  authMode: McpAuthMode;
  /** Static headers (e.g. Authorization: Bearer …) used when [authMode] is HEADERS; for stdio servers, the environment variables. */
  headers: Record<string, string>;
  /** A local command that speaks MCP over stdin/stdout (Windows app only). */
  stdio?: StdioSpec | null;
}

export interface McpServerInfo {
  name: string;
  version?: string | null;
  protocolVersion: string;
  /** Server-provided usage instructions, if any (shown to the model with its tools). */
  instructions?: string | null;
}

/** One tool from tools/list. Cached as JSON in McpServerEntity.toolsJson (same shape as Android). */
export interface McpTool {
  name: string;
  title?: string | null;
  description?: string | null;
  /** JSON Schema object for the arguments, as a JSON string. */
  inputSchemaJson: string;
  /** MCP tool annotations: hints only, never security guarantees. */
  readOnlyHint?: boolean | null;
  destructiveHint?: boolean | null;
  openWorldHint?: boolean | null;
}

export const DEFAULT_INPUT_SCHEMA = '{"type":"object","properties":{}}';

/** Result of tools/call, flattened for the model. */
export interface McpCallResult {
  /** Text the model should see: text content, resource text, and a JSON rendering of structuredContent. */
  text: string;
  isError: boolean;
  /** Image content blocks, if the tool returned any. */
  images: { mimeType: string; bytes: Uint8Array }[];
}

/**
 * OAuth state persisted per server (client registration + tokens). Stored sealed on this device
 * and synced inside end-to-end encrypted records, where the Android app reads it: keep the field
 * names and meaning identical to McpOAuthState.kt (null fields are omitted when encoded).
 */
export interface McpOAuthState {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string | null;
  issuer?: string | null;
  /** RFC 8707 resource indicator for this server. */
  resource?: string | null;
  scope?: string | null;
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  accessToken?: string | null;
  refreshToken?: string | null;
  /** Epoch ms; null if unknown. */
  expiresAt?: number | null;
}

/** Reads an [McpOAuthState] decoded from JSON written by any app version; null when unusable. */
export function parseOAuthState(raw: unknown): McpOAuthState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const s = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const authorizationEndpoint = s('authorizationEndpoint');
  const tokenEndpoint = s('tokenEndpoint');
  const clientId = s('clientId');
  const redirectUri = s('redirectUri');
  if (authorizationEndpoint == null || tokenEndpoint == null || clientId == null || redirectUri == null) return null;
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: s('registrationEndpoint'),
    issuer: s('issuer'),
    resource: s('resource'),
    scope: s('scope'),
    clientId,
    clientSecret: s('clientSecret'),
    redirectUri,
    accessToken: s('accessToken'),
    refreshToken: s('refreshToken'),
    expiresAt: typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : null,
  };
}

/** Persists [McpOAuthState] per server id. Async because secrets are sealed with the platform SecretBox. */
export interface McpTokenStore {
  load(serverId: string): Promise<McpOAuthState | null>;
  save(serverId: string, state: McpOAuthState | null): Promise<void>;
}

/** Thrown when the server requires OAuth and no usable token exists. The app should start sign-in. */
export class McpAuthRequiredException extends Error {
  constructor(
    readonly serverId: string,
    /** Value of the WWW-Authenticate header from the 401, used for discovery. */
    readonly wwwAuthenticate: string | null,
  ) {
    super('This server needs you to sign in.');
    this.name = 'McpAuthRequiredException';
  }
}

/** Any other MCP failure, with a user-facing message. A network failure keeps the fetch TypeError as [cause]. */
export class McpException extends Error {
  constructor(message: string, readonly httpStatus: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'McpException';
  }
}

/** A pending browser sign-in, returned by [McpOAuth.begin]. Keep it until the redirect arrives. */
export interface McpPendingAuth {
  serverId: string;
  /** Open this URL in the browser. */
  authorizationUrl: string;
  /** Opaque `state` parameter to match the redirect. */
  state: string;
  codeVerifier: string;
  /** Partially filled state (endpoints + client registration, no tokens yet). */
  oauth: McpOAuthState;
}
