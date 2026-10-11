/** Messages between a PC (host) and the account's other devices (controllers): docs/REMOTE.md. */
import { msg, tm, type Msg } from '../i18n';

export type RemoteMethod = 'computer.info' | 'computer.tools' | 'computer.call' | 'computer.cancel' | 'files.list' | 'agents.list' | 'agents.read';

/** What a PC says about itself in answer to `hello`, and when its settings change. */
export interface HostAnnouncement {
  hostId: string;
  name: string;
  os: string;
  version: string;
  /** False until the PC's owner lets other devices use it. */
  remote: boolean;
  home: string;
  defaultFolder: string;
  recentFolders: string[];
  features: string[];
}

/** An online PC as a controller sees it. */
export interface HostInfo extends HostAnnouncement {
  sessionId: string;
  seenAt: number;
}

export type RemoteErrorCode = 'remote_disabled' | 'bad_request' | 'not_found' | 'unknown_method' | 'too_large' | 'failed' | 'offline' | 'timeout';

const CODES = new Set<RemoteErrorCode>(['remote_disabled', 'bad_request', 'not_found', 'unknown_method', 'too_large', 'failed', 'offline', 'timeout']);

/**
 * A failed call. `english` is what goes over the wire to other devices and into tool results for
 * models; `message` is for people, in the interface language. A PC's English message that Facet
 * knows (a msg() key) is shown translated on the device that receives it.
 */
export class RemoteError extends Error {
  readonly english: string;

  constructor(
    readonly code: RemoteErrorCode,
    english: string,
    shown?: string,
  ) {
    super(shown ?? english);
    this.english = english;
    this.name = 'RemoteError';
  }

  static from(code: unknown, message: unknown): RemoteError {
    const c = typeof code === 'string' && CODES.has(code as RemoteErrorCode) ? (code as RemoteErrorCode) : 'failed';
    if (typeof message === 'string' && message) return new RemoteError(c, message, tm(message as Msg));
    return remoteError(c, msg('The PC couldn’t do that.'));
  }
}

/** A RemoteError from a msg()-marked sentence: English for the wire and models, translated for people. */
export function remoteError(code: RemoteErrorCode, text: Msg, vars?: Record<string, string>): RemoteError {
  const english = vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m) : text;
  return new RemoteError(code, english, tm(text, vars));
}

/** How long a controller waits for each method (commands have their own timeouts on the PC). */
export const CALL_TIMEOUT_MS: Record<RemoteMethod, number> = {
  'computer.info': 20_000,
  'computer.tools': 20_000,
  'computer.call': 15 * 60_000,
  'computer.cancel': 20_000,
  'files.list': 20_000,
  'agents.list': 20_000,
  'agents.read': 60_000,
};

/** Every relayed message: version, id, sender clock and type, plus the type's fields. */
export interface RemoteMessage {
  v: number;
  id: string;
  ts: number;
  type: string;
  [field: string]: unknown;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** A `host` message as a HostInfo, or null when it's malformed. */
export function parseHost(sessionId: string, m: RemoteMessage, now = Date.now()): HostInfo | null {
  const hostId = str(m.hostId).trim();
  if (!hostId || hostId.length > 100) return null;
  const folders = Array.isArray(m.recentFolders) ? m.recentFolders.filter((f): f is string => typeof f === 'string').slice(0, 20) : [];
  const features = Array.isArray(m.features) ? m.features.filter((f): f is string => typeof f === 'string') : [];
  return {
    hostId,
    sessionId,
    name: str(m.name, 'PC').slice(0, 80) || 'PC',
    os: str(m.os).slice(0, 80),
    version: str(m.version).slice(0, 40),
    remote: m.remote === true,
    home: str(m.home),
    defaultFolder: str(m.defaultFolder) || str(m.home),
    recentFolders: folders,
    features,
    seenAt: now,
  };
}
