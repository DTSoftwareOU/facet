/**
 * Tracks MCP connections started from Settings, so the server list and the server page can both
 * show "Connecting…". Connections go through McpManager.refreshTools, which caches tools and status.
 */
import { useSyncExternalStore } from 'react';
import { getApp } from '../../app';
import type { McpTool } from '../../mcp/types';

const inFlight = new Map<string, Promise<McpTool[]>>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function emit() {
  snapshot = new Set(inFlight.keys());
  for (const l of listeners) l();
}

/** Connects to a server and refreshes its tools. Concurrent calls for one server share the attempt. */
export function connectMcp(id: string): Promise<McpTool[]> {
  const running = inFlight.get(id);
  if (running) return running;
  const p = getApp().mcp.refreshTools(id).finally(() => {
    inFlight.delete(id);
    emit();
  });
  inFlight.set(id, p);
  emit();
  return p;
}

/** Ids of servers connecting right now. */
export function useMcpConnecting(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
