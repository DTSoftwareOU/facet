/** Messages between a PC (host) and the account's other devices (controllers): docs/REMOTE.md. */

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

export class RemoteError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteError';
  }

  static from(code: unknown, message: unknown): RemoteError {
    const c = typeof code === 'string' && CODES.has(code as RemoteErrorCode) ? (code as RemoteErrorCode) : 'failed';
    return new RemoteError(c, typeof message === 'string' && message ? message : 'The PC couldn’t do that.');
  }
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
