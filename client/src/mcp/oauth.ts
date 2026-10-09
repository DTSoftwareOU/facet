/**
 * OAuth 2.1 for MCP servers (port of McpOAuth.kt, MCP authorization spec): protected-resource and
 * authorization-server discovery, dynamic client registration (RFC 7591), PKCE (S256), resource
 * indicators (RFC 8707), code exchange and refresh. The browser leg (opening
 * [McpPendingAuth.authorizationUrl] and catching the redirect) belongs to the app's OAuthBridge.
 */
import { b64, utf8 } from '../core/bytes';
import { isObject } from '../core/json';
import { platform } from '../platform';
import {
  canonicalResource,
  httpUrl,
  jarr,
  jstr,
  originOf,
  parseBearerChallenge,
  randomUrlSafe,
  s256,
  wellKnown,
  type Json,
} from './internal';
import { McpException, type McpOAuthState, type McpPendingAuth } from './types';

/** An OAuth error response from a token or registration endpoint. */
export class OAuthErrorException extends Error {
  constructor(readonly error: string | null, message: string, readonly status: number) {
    super(message);
    this.name = 'OAuthErrorException';
  }
}

/** Endpoints and parameters found by discovery. */
export interface OAuthDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  issuer: string | null;
  resource: string;
  scope: string | null;
  codeChallengeMethods: string[] | null;
}

const fetchFn = (input: string, init?: RequestInit) => platform().fetch(input, init);

const nonBlank = (s: string | null | undefined): string | null => (s != null && s.trim() !== '' ? s : null);

/** Appends query parameters, encoding spaces as %20 like OkHttp's addQueryParameter. */
function withQuery(base: URL, params: [string, string][]): string {
  const q = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const search = base.search.length > 1 ? `${base.search}&${q}` : `?${q}`;
  return base.origin + base.pathname + search + base.hash;
}

/** Discovers endpoints, registers a client if needed, and builds the authorization URL. */
async function begin(
  serverId: string,
  serverUrl: string,
  wwwAuthenticate: string | null,
  redirectUri: string,
  clientName: string,
  previous: McpOAuthState | null = null,
): Promise<McpPendingAuth> {
  const d = await discover(serverUrl, wwwAuthenticate);
  if (d.codeChallengeMethods != null && !d.codeChallengeMethods.includes('S256')) {
    throw new McpException("This server's sign-in doesn't support PKCE (S256), so Facet can't sign in safely.");
  }
  const reuse = previous != null && previous.clientId.trim() !== '' &&
    previous.authorizationEndpoint === d.authorizationEndpoint &&
    previous.tokenEndpoint === d.tokenEndpoint &&
    previous.redirectUri === redirectUri;
  const [clientId, clientSecret] = reuse
    ? [previous!.clientId, previous!.clientSecret ?? null]
    : await register(d, redirectUri, clientName);
  const verifier = randomUrlSafe(48);
  const state = randomUrlSafe(24);
  const authUrl = httpUrl(d.authorizationEndpoint);
  if (!authUrl) throw new McpException('This server advertised an invalid sign-in address.');
  const params: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', clientId],
    ['redirect_uri', redirectUri],
    ['code_challenge', await s256(verifier)],
    ['code_challenge_method', 'S256'],
    ['state', state],
    ['resource', d.resource],
  ];
  if (d.scope) params.push(['scope', d.scope]);
  return {
    serverId,
    authorizationUrl: withQuery(authUrl, params),
    state,
    codeVerifier: verifier,
    oauth: {
      authorizationEndpoint: d.authorizationEndpoint,
      tokenEndpoint: d.tokenEndpoint,
      registrationEndpoint: d.registrationEndpoint,
      issuer: d.issuer,
      resource: d.resource,
      scope: d.scope,
      clientId,
      clientSecret,
      redirectUri,
    },
  };
}

/** Exchanges the authorization code from the redirect for tokens. */
async function complete(pending: McpPendingAuth, code: string): Promise<McpOAuthState> {
  const o = pending.oauth;
  const form: [string, string][] = [
    ['grant_type', 'authorization_code'],
    ['code', code],
    ['redirect_uri', o.redirectUri],
    ['client_id', o.clientId],
    ['code_verifier', pending.codeVerifier],
  ];
  if (o.resource != null) form.push(['resource', o.resource]);
  let res: Json;
  try {
    res = await tokenRequest(o, form);
  } catch (e) {
    if (e instanceof OAuthErrorException) throw new McpException(`Sign-in didn't complete: ${e.message}`, e.status);
    throw e;
  }
  return applyTokens(o, res, null);
}

/** Uses the refresh token. Throws [OAuthErrorException] when the grant is no longer valid. */
async function refresh(state: McpOAuthState): Promise<McpOAuthState> {
  const token = state.refreshToken;
  if (token == null) throw new OAuthErrorException('invalid_grant', 'No refresh token', 400);
  const form: [string, string][] = [
    ['grant_type', 'refresh_token'],
    ['refresh_token', token],
    ['client_id', state.clientId],
  ];
  if (state.resource != null) form.push(['resource', state.resource]);
  return applyTokens(state, await tokenRequest(state, form), token);
}

function applyTokens(state: McpOAuthState, res: Json, keepRefresh: string | null): McpOAuthState {
  const access = jstr(res, 'access_token');
  if (access == null) throw new McpException("The sign-in server didn't return an access token.");
  const raw = res.expires_in;
  const expiresIn = typeof raw === 'number' ? Math.trunc(raw) : typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? parseInt(raw, 10) : null;
  return {
    ...state,
    accessToken: access,
    refreshToken: jstr(res, 'refresh_token') ?? keepRefresh,
    expiresAt: expiresIn != null ? Date.now() + expiresIn * 1000 : null,
    scope: jstr(res, 'scope') ?? state.scope ?? null,
  };
}

// ---- discovery ----

async function discover(serverUrl: string, wwwAuthenticate: string | null): Promise<OAuthDiscovery> {
  const server = httpUrl(serverUrl.trim());
  if (!server) throw new McpException("That server address isn't a valid URL.");
  const challenge = parseBearerChallenge(wwwAuthenticate);

  let prm: Json | null = challenge.resource_metadata ? await getJson(challenge.resource_metadata) : null;
  if (prm == null) {
    prm = (await getJson(wellKnown(server, 'oauth-protected-resource', true))) ??
      (server.pathname.replace(/\/+$/, '') ? await getJson(wellKnown(server, 'oauth-protected-resource', false)) : null);
  }

  const first = jarr(prm, 'authorization_servers')?.[0];
  const authServer = (typeof first === 'string' ? httpUrl(first) : null) ?? new URL(server.origin + '/');

  const asHasPath = authServer.pathname.replace(/\/+$/, '') !== '';
  const candidates = [
    wellKnown(authServer, 'oauth-authorization-server', true),
    wellKnown(authServer, 'openid-configuration', true),
  ];
  if (asHasPath) candidates.push(authServer.toString().replace(/\/+$/, '') + '/.well-known/openid-configuration');
  let meta: Json | null = null;
  for (const url of candidates) {
    const m = await getJson(url);
    meta = m && (jstr(m, 'authorization_endpoint') != null || jstr(m, 'token_endpoint') != null) ? m : null;
    if (meta) break;
  }

  const origin = originOf(authServer);
  const resource = nonBlank(jstr(prm, 'resource')) ?? canonicalResource(serverUrl);
  const scopes = jarr(prm, 'scopes_supported')?.filter((s): s is string => typeof s === 'string').join(' ');
  const scope = nonBlank(challenge.scope) ?? nonBlank(scopes);
  const methods = jarr(meta, 'code_challenge_methods_supported');
  return {
    authorizationEndpoint: jstr(meta, 'authorization_endpoint') ?? `${origin}/authorize`,
    tokenEndpoint: jstr(meta, 'token_endpoint') ?? `${origin}/token`,
    registrationEndpoint: meta != null ? jstr(meta, 'registration_endpoint') : `${origin}/register`,
    issuer: jstr(meta, 'issuer'),
    resource,
    scope,
    codeChallengeMethods: methods ? methods.filter((m): m is string => typeof m === 'string') : null,
  };
}

async function register(d: OAuthDiscovery, redirectUri: string, clientName: string): Promise<[string, string | null]> {
  const endpoint = d.registrationEndpoint;
  if (endpoint == null) {
    throw new McpException(
      "This server requires an app that was registered in advance, and it doesn't allow automatic registration. " +
        "Facet can't sign in to it yet; use a server that supports dynamic client registration, or connect with an access token in headers.",
    );
  }
  const body: Json = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  if (d.scope != null) body.scope = d.scope;
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new McpException("Couldn't reach the server's sign-in service.", null, e);
  }
  const json = parseObject(await response.text().catch(() => ''));
  if (!response.ok) {
    const reason = jstr(json, 'error_description') ?? jstr(json, 'error') ?? `HTTP ${response.status}`;
    throw new McpException(`The server didn't accept Facet's sign-in registration: ${reason}`, response.status);
  }
  const clientId = jstr(json, 'client_id');
  if (clientId == null) throw new McpException("The server's sign-in registration didn't return a client id.");
  return [clientId, jstr(json, 'client_secret')];
}

// ---- HTTP helpers ----

function parseObject(text: string): Json | null {
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<Json | null> {
  if (!httpUrl(url)) return null;
  try {
    const response = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return null;
    }
    return parseObject(await response.text());
  } catch {
    return null;
  }
}

async function tokenRequest(state: McpOAuthState, form: [string, string][]): Promise<Json> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (state.clientSecret != null) headers.Authorization = 'Basic ' + b64(utf8(`${state.clientId}:${state.clientSecret}`));
  let response: Response;
  try {
    response = await fetchFn(state.tokenEndpoint, { method: 'POST', headers, body: new URLSearchParams(form) });
  } catch (e) {
    throw new McpException("Couldn't reach the server's sign-in service.", null, e);
  }
  const json = parseObject(await response.text().catch(() => ''));
  if (!response.ok || json == null || jstr(json, 'error') != null) {
    const error = jstr(json, 'error');
    const description = jstr(json, 'error_description') ?? error ?? `HTTP ${response.status}`;
    throw new OAuthErrorException(error, description, response.status);
  }
  return json;
}

export const McpOAuth = { begin, complete, refresh, discover, tokenRequest };
