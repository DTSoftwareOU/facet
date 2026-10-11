/**
 * Lists and imports Claude Code and Codex CLI sessions for a working folder, so a chat in Facet
 * can continue them with another model (docs/REMOTE.md, "Continuing a Claude Code or Codex
 * session"). Pure Node: no Electron imports.
 *
 * Conversion keeps the user's prompts and the assistant's visible replies, turns each tool call
 * into one "› …" line in the reply, and drops tool output, reasoning, system and injected context.
 * Session ids are validated and only looked up inside the agent's own folders; files are streamed,
 * malformed lines are skipped, and missing folders give empty results. Nothing here throws.
 */
import os from 'node:os';
import { listClaudeSessions, readClaudeSession } from './claudeCode';
import { listCodexSessions, readCodexSession } from './codex';
import type { AgentKind, AgentOptions, AgentSessionSummary, Ctx, ImportedSession } from './common';

export type { AgentKind, AgentOptions, AgentSessionSummary, ImportedMessage, ImportedSession } from './common';

function context(opts?: AgentOptions): Ctx {
  return { home: opts?.home ?? os.homedir(), env: opts?.env ?? process.env, platform: opts?.platform ?? process.platform };
}

/** Sessions whose working directory is [cwd], newest first, at most 50. Missing folders → []. */
export async function listAgentSessions(agent: AgentKind, cwd: string, opts?: AgentOptions): Promise<AgentSessionSummary[]> {
  if (typeof cwd !== 'string' || !cwd.trim()) return [];
  try {
    const ctx = context(opts);
    if (agent === 'claude') return await listClaudeSessions(cwd, ctx);
    if (agent === 'codex') return await listCodexSessions(cwd, ctx);
  } catch {
    // Unreadable folders or files: nothing to list.
  }
  return [];
}

/** The session converted for Facet, or null when it doesn't exist or isn't for [cwd]. */
export async function readAgentSession(agent: AgentKind, cwd: string, id: string, opts?: AgentOptions): Promise<ImportedSession | null> {
  if (typeof cwd !== 'string' || !cwd.trim() || typeof id !== 'string') return null;
  try {
    const ctx = context(opts);
    if (agent === 'claude') return await readClaudeSession(cwd, id, ctx);
    if (agent === 'codex') return await readCodexSession(cwd, id, ctx);
  } catch {
    // Unreadable: treat as missing.
  }
  return null;
}
