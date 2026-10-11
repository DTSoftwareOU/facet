/**
 * Orchestrates conversations (port of ChatEngine.kt): builds provider requests from the visible
 * branch, runs the tool loop (search, skills, MCP, media, computer), streams the reply into `live`,
 * persists the result, computes cost, and titles new chats. A generation holds a Web Lock named
 * after its chat, so other tabs know it's still running.
 */
import { fromUtf8 } from '../core/bytes';
import { Dates } from '../core/format';
import { newId } from '../core/ids';
import { parseJson, toJson } from '../core/json';
import type { AttachmentStore } from '../data/attachments';
import { MessageTree, messageAttachments, type ConversationRepository } from '../data/conversations';
import { attachmentRef, type AttachmentRef, type ComputerBinding, type ConversationEntity, type MessageEntity, type MessageStatus, type ProviderEntity } from '../data/entities';
import type { Assistant, AssistantRepository } from '../data/library';
import type { ModelRef, SettingsStore } from '../data/prefs';
import type { ProviderRepository } from '../data/providers';
import { providerKind, type ProviderKind } from '../llm/providers';
import {
  addUsage,
  defaultParams,
  LlmException,
  parseParams,
  type ChatMessage,
  type ChatRequest,
  type Citation,
  type GenParams,
  type LlmError,
  type ModelInfo,
  type ModelPricing,
  type Part,
  type ProviderBlocks,
  type StopReason,
  type Usage,
} from '../llm/types';
import type { SyncEngine } from '../sync/engine';
import type { ToolRegistry, PreparedTools } from '../tools/registry';
import type { ToolCallRecord, ToolDef, ToolKind, ToolOutcome, ToolStep, ToolTrace } from '../tools/types';

export type ToolStatus = 'PREPARING' | 'AWAITING_APPROVAL' | 'RUNNING' | 'DONE' | 'ERROR' | 'DENIED';
export type ApprovalDecision = 'ALLOW' | 'ALWAYS' | 'DENY';

/** A tool call as shown while a reply streams (and rebuilt from the ToolTrace afterwards). */
export interface ToolActivity {
  id: string;
  name: string;
  kind: ToolKind;
  label: string;
  status: ToolStatus;
  argumentsJson: string;
  result?: string | null;
  serverName?: string | null;
}

/** In-flight state of a streaming assistant turn, overlaid on the stored message by the UI. */
export interface LiveTurn {
  messageId: string;
  conversationId: string;
  text: string;
  thinking: string;
  thinkingActive: boolean;
  thinkingStartedAt: number | null;
  thinkingMs: number;
  searchQuery: string | null;
  searching: boolean;
  searchCount: number;
  citations: Citation[];
  notice: string | null;
  tools: ToolActivity[];
  /** Media created by tools during this reply. */
  attachments: AttachmentRef[];
  startedAt: number;
}

/** What a brand-new chat starts with. */
export interface NewChatSpec {
  assistantId: string | null;
  model: ModelRef;
  params: GenParams;
  folderId?: string | null;
}

export class ChatError extends Error {}

export interface Pricing {
  priceFor(kind: ProviderKind, modelId: string): ModelPricing | null | undefined;
  cost(price: ModelPricing, usage: Usage): number;
}

const TOOL_TIMEOUT_MS = 130_000;
/** Video and long music can take several minutes. */
const MEDIA_TOOL_TIMEOUT_MS = 12 * 60_000;
/** Commands can run for up to 10 minutes. */
const COMPUTER_TOOL_TIMEOUT_MS = 11 * 60_000;
const MAX_TOOL_ROUNDS = 12;
const YOLO_TOOL_ROUNDS = 40;
const MAX_RESULT_CHARS = 30_000;

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout();
      reject(new TimeoutError());
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function joinText(prefix: string, step: string): string {
  if (!prefix.trim()) return step;
  if (!step.trim()) return prefix;
  return prefix.trimEnd() + '\n\n' + step.trimStart();
}

/** Mutable state of one reply across its tool steps. */
class ReplyState {
  allText = '';
  stepText = '';
  thinking = '';
  thinkingStart: number | null = null;
  thinkingMs = 0;
  usageBase: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  stepUsage: Usage | null = null;
  blocks: ProviderBlocks | null = null;
  stop: StopReason | null = null;
  error: LlmError | null = null;
  citations = new Map<string, Citation>();
  attachments: AttachmentRef[] = [];
  activities = new Map<string, ToolActivity>();
  steps: ToolStep[] = [];
  servedModel = '';

  endThinking() {
    if (this.thinkingStart != null) this.thinkingMs += Date.now() - this.thinkingStart;
    this.thinkingStart = null;
  }

  get usage(): Usage | null {
    if (this.stepUsage) return addUsage(this.usageBase, this.stepUsage);
    return this.usageBase.inputTokens + this.usageBase.outputTokens > 0 ? this.usageBase : null;
  }
}

async function withLock(name: string, fn: () => Promise<void>): Promise<void> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) await locks.request(name, fn);
  else await fn();
}

export class ChatEngine {
  private liveValue = new Map<string, LiveTurn>();
  private activeValue = new Set<string>();
  private listeners = new Set<() => void>();
  private aborts = new Map<string, AbortController>();
  private approvals = new Map<string, (d: ApprovalDecision) => void>();
  private lastYolo: boolean;

  /** Called when a reply finishes (conversationId, title, preview); used for notifications. */
  onReplyFinished: ((conversationId: string, title: string, preview: string) => void) | null = null;

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly providers: ProviderRepository,
    private readonly assistants: AssistantRepository,
    private readonly attachments: AttachmentStore,
    private readonly settings: SettingsStore,
    private readonly pricing: Pricing,
    private readonly sync: SyncEngine,
    private readonly tools: ToolRegistry,
    private readonly mcpAutoApprove: (serverId: string, tool: string) => Promise<void> = async () => {},
  ) {
    this.lastYolo = settings.synced.yoloMode;
    // Turning on YOLO mode (here or on another device) also answers approvals already waiting.
    settings.subscribe(() => {
      const yolo = settings.synced.yoloMode;
      if (yolo && !this.lastYolo) for (const id of [...this.approvals.keys()]) this.respondToApproval(id, 'ALLOW');
      this.lastYolo = yolo;
    });
  }

  get live(): ReadonlyMap<string, LiveTurn> {
    return this.liveValue;
  }

  /** Conversation ids with a generation in progress in this tab. */
  get active(): ReadonlySet<string> {
    return this.activeValue;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  isGenerating(conversationId: string): boolean {
    return this.activeValue.has(conversationId);
  }

  stop(conversationId: string): void {
    this.aborts.get(conversationId)?.abort();
  }

  /** Answers a pending tool approval shown in the chat. */
  respondToApproval(callId: string, decision: ApprovalDecision): void {
    const resolve = this.approvals.get(callId);
    if (!resolve) return;
    this.approvals.delete(callId);
    resolve(decision);
  }

  // ---- public actions ----

  /** Sends a user message. Creates the conversation when [conversationId] is null. Returns the conversation id. */
  async send(conversationId: string | null, text: string, attachmentIds: string[], newChat: NewChatSpec | null, computer: ComputerBinding | null = null): Promise<string> {
    let conv = conversationId ? await this.conversations.get(conversationId) : undefined;
    if (!conv && newChat) {
      conv = await this.conversations.create(newChat.assistantId, newChat.model.providerId, newChat.model.modelId, newChat.params, newChat.folderId ?? null, computer);
    }
    if (!conv) throw new ChatError('Choose a model to start chatting.');
    if (this.isGenerating(conv.id)) throw new ChatError('Wait for the current reply to finish, or stop it.');
    const tree = new MessageTree(await this.conversations.messages(conv.id));
    const parent = tree.activePath(conv.currentLeafId).at(-1);
    const refs: AttachmentRef[] = [];
    for (const id of attachmentIds) {
      const a = await this.attachments.get(id);
      if (a) refs.push(attachmentRef(a));
    }
    if (refs.length) await this.attachments.commit(attachmentIds, conv.id);
    const now = Date.now();
    const user: MessageEntity = {
      id: newId(now), conversationId: conv.id, parentId: parent?.id ?? null, role: 'user', content: text.trim(),
      attachmentsJson: refs.length ? JSON.stringify(refs) : null, status: 'DONE', createdAt: now, updatedAt: now, deleted: 0, dirty: 1,
    };
    await this.conversations.insertMessage(user);
    if (!conv.titleSet && !parent) {
      const provisional = (text.trim().split('\n')[0] ?? '').slice(0, 48).trim() || refs[0]?.name || 'New chat';
      await this.conversations.update(conv.id, (c) => ({ ...c, title: provisional }));
    }
    await this.startReply(conv.id, user);
    return conv.id;
  }

  /** Generates a new sibling reply for [assistantMessageId], optionally on a different model. */
  async regenerate(assistantMessageId: string, model?: ModelRef): Promise<void> {
    const target = await this.conversations.message(assistantMessageId);
    if (!target?.parentId) return;
    const user = await this.conversations.message(target.parentId);
    if (!user) return;
    if (this.isGenerating(target.conversationId)) throw new ChatError('Wait for the current reply to finish, or stop it.');
    if (model) await this.conversations.setModel(target.conversationId, model.providerId, model.modelId);
    await this.startReply(target.conversationId, user);
  }

  /** Replaces a user message with an edited copy (a new branch) and generates a reply. */
  async editAndResend(userMessageId: string, newText: string): Promise<void> {
    const original = await this.conversations.message(userMessageId);
    if (!original) return;
    if (this.isGenerating(original.conversationId)) throw new ChatError('Wait for the current reply to finish, or stop it.');
    const now = Date.now();
    const edited: MessageEntity = { ...original, id: newId(now), content: newText.trim(), createdAt: now, updatedAt: now, dirty: 1 };
    await this.conversations.insertMessage(edited);
    await this.startReply(original.conversationId, edited);
  }

  /** Asks the model to continue a reply that hit the output limit. */
  async continueReply(conversationId: string): Promise<void> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) return;
    const leaf = new MessageTree(await this.conversations.messages(conversationId)).activePath(conv.currentLeafId).at(-1);
    if (!leaf) return;
    const now = Date.now();
    const user: MessageEntity = {
      id: newId(now), conversationId, parentId: leaf.id, role: 'user', content: 'Continue exactly where you left off.',
      status: 'DONE', createdAt: now, updatedAt: now, deleted: 0, dirty: 1,
    };
    await this.conversations.insertMessage(user);
    await this.startReply(conversationId, user);
  }

  /** Selects a sibling branch and follows it to its newest leaf. */
  async switchBranch(conversationId: string, siblingId: string): Promise<void> {
    const tree = new MessageTree(await this.conversations.messages(conversationId));
    await this.conversations.setCurrentLeaf(conversationId, tree.latestLeaf(siblingId));
  }

  // ---- generation ----

  private async startReply(conversationId: string, user: MessageEntity): Promise<void> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) return;
    const { provider, model } = await this.resolveModel(conv);
    const now = Date.now();
    const reply: MessageEntity = {
      id: newId(now), conversationId, parentId: user.id, role: 'assistant', content: '', providerId: provider.id, modelId: model.id,
      modelName: model.displayName, status: 'STREAMING', createdAt: now + 1, updatedAt: now + 1, deleted: 0, dirty: 1,
    };
    await this.conversations.insertMessage(reply);
    await this.conversations.update(conversationId, (c) => ({ ...c, currentLeafId: reply.id }), true);
    this.settings.updateLocal((l) => ({ ...l, lastProviderId: provider.id, lastModelId: model.id }));

    const abort = new AbortController();
    this.aborts.set(conversationId, abort);
    this.liveValue = new Map(this.liveValue).set(reply.id, {
      messageId: reply.id, conversationId, text: '', thinking: '', thinkingActive: false, thinkingStartedAt: null, thinkingMs: 0,
      searchQuery: null, searching: false, searchCount: 0, citations: [], notice: null, tools: [], attachments: [], startedAt: Date.now(),
    });
    this.activeValue = new Set(this.activeValue).add(conversationId);
    this.emit();
    void withLock(`facet-gen:${conversationId}`, async () => {
      try {
        await this.generate(conversationId, reply, provider, model, abort.signal);
      } finally {
        this.aborts.delete(conversationId);
        const active = new Set(this.activeValue);
        active.delete(conversationId);
        this.activeValue = active;
        const live = new Map(this.liveValue);
        live.delete(reply.id);
        this.liveValue = live;
        this.emit();
      }
    });
  }

  private async resolveModel(conv: ConversationEntity): Promise<{ provider: ProviderEntity; model: ModelInfo }> {
    const provider = conv.providerId ? await this.providers.get(conv.providerId) : undefined;
    if (!provider || provider.deleted || !provider.enabled) throw new ChatError('The provider for this chat was removed. Pick another model.');
    if (!conv.modelId) throw new ChatError('Choose a model to continue.');
    return { provider, model: this.providers.modelInfo(provider, conv.modelId) };
  }

  private async generate(conversationId: string, reply: MessageEntity, provider: ProviderEntity, model: ModelInfo, signal: AbortSignal): Promise<void> {
    const st = new ReplyState();
    st.servedModel = model.id;
    let lastPersist = 0;
    let frame = 0;

    const publish = (transform: (t: LiveTurn) => LiveTurn) => {
      const cur = this.liveValue.get(reply.id);
      if (!cur) return;
      // Immutable updates: the UI compares snapshots by identity.
      this.liveValue = new Map(this.liveValue).set(reply.id, transform(cur));
      // Coalesce bursts of deltas into one render per frame.
      if (!frame) {
        frame = (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16) as unknown as number)(() => {
          frame = 0;
          this.emit();
        });
      }
    };
    const publishTools = () =>
      publish((t) => ({ ...t, tools: [...st.activities.values()], citations: [...st.citations.values()], attachments: [...st.attachments] }));

    try {
      const base = await this.buildRequest(conversationId, reply, model);
      let prepared: PreparedTools;
      try {
        prepared = await this.tools.prepare(base.params, model.caps, conversationId);
      } catch {
        prepared = { defs: [], systemAddendum: null, byName: new Map() } as unknown as PreparedTools;
      }
      const system = [base.system, prepared.systemAddendum].filter((s) => s && s.trim()).join('\n\n') || null;
      let messages = base.messages;
      let round = 0;
      const client = await this.providers.client(provider);

      for (;;) {
        const request: ChatRequest = { ...base, system, messages, tools: prepared.defs.map((d) => d.spec) };
        const calls: { id: string; name: string; argumentsJson: string }[] = [];
        st.stepText = '';
        st.stop = null;
        st.blocks = null;
        st.stepUsage = null;
        const textPrefix = st.allText;

        for await (const ev of client.stream(request, signal)) {
          switch (ev.type) {
            case 'started':
              st.servedModel = ev.model;
              break;
            case 'text': {
              if (st.thinkingStart != null) st.endThinking();
              st.stepText += ev.text;
              const shown = joinText(textPrefix, st.stepText);
              publish((t) => ({ ...t, text: shown, thinkingActive: false, thinkingMs: st.thinkingMs, searching: false }));
              break;
            }
            case 'thinking':
              if (st.thinkingStart == null) st.thinkingStart = Date.now();
              st.thinking += ev.text;
              publish((t) => ({ ...t, thinking: st.thinking, thinkingActive: true, thinkingStartedAt: t.thinkingStartedAt ?? st.thinkingStart }));
              break;
            case 'thinkingStarted':
              if (st.thinkingStart == null) st.thinkingStart = Date.now();
              publish((t) => ({ ...t, thinkingActive: true, thinkingStartedAt: t.thinkingStartedAt ?? st.thinkingStart }));
              break;
            case 'thinkingEnded':
              st.endThinking();
              publish((t) => ({ ...t, thinkingActive: false, thinkingMs: st.thinkingMs }));
              break;
            case 'webSearch':
              publish((t) => ({ ...t, searching: !ev.done, searchQuery: ev.query ?? t.searchQuery, searchCount: ev.done ? t.searchCount : t.searchCount + 1 }));
              break;
            case 'citations':
              for (const c of ev.citations) if (!st.citations.has(c.url)) st.citations.set(c.url, c);
              publish((t) => ({ ...t, citations: [...st.citations.values()] }));
              break;
            case 'usage':
              st.stepUsage = ev.usage;
              break;
            case 'notice':
              publish((t) => ({ ...t, notice: ev.text }));
              break;
            case 'toolCallStarted': {
              const def = prepared.byName.get(ev.name);
              st.activities.set(ev.id, {
                id: ev.id, name: ev.name, kind: def?.kind ?? 'MCP', label: preparingLabel(def, ev.name), status: 'PREPARING',
                argumentsJson: '', serverName: def?.serverName ?? null,
              });
              publishTools();
              break;
            }
            case 'toolCallReady': {
              calls.push(ev);
              const def = prepared.byName.get(ev.name);
              const existing = st.activities.get(ev.id) ?? {
                id: ev.id, name: ev.name, kind: def?.kind ?? 'MCP', label: preparingLabel(def, ev.name), status: 'PREPARING' as ToolStatus,
                argumentsJson: '', serverName: def?.serverName ?? null,
              };
              st.activities.set(ev.id, { ...existing, argumentsJson: ev.argumentsJson, label: runningLabel(def, ev.argumentsJson) });
              publishTools();
              break;
            }
            case 'completed':
              st.stop = ev.stopReason;
              st.blocks = ev.blocks;
              if (ev.blocks?.model) st.servedModel = ev.blocks.model;
              break;
            case 'failed':
              st.error = ev.error;
              break;
          }
          const now = Date.now();
          if (now - lastPersist > 1_000) {
            lastPersist = now;
            void this.conversations.updateStreaming(reply.id, joinText(textPrefix, st.stepText), st.thinking || null);
          }
        }
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');

        st.usageBase = st.usage ?? st.usageBase;
        st.stepUsage = null;
        st.allText = joinText(textPrefix, st.stepText);

        if (st.error || st.stop !== 'TOOL_USE' || calls.length === 0) break;
        const roundLimit = this.settings.synced.yoloMode ? YOLO_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
        if (round >= roundLimit) {
          publish((t) => ({ ...t, notice: `Stopped after ${roundLimit} rounds of tool use.` }));
          st.stop = 'END';
          break;
        }
        round++;

        const records = await Promise.all(calls.map((call) => this.runTool(call, prepared, st, reply, signal, publishTools)));
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        st.steps.push({ text: st.stepText, calls: records, blocks: st.blocks });
        const assistantParts: Part[] = [];
        if (st.stepText.trim()) assistantParts.push({ type: 'text', text: st.stepText });
        for (const c of calls) assistantParts.push({ type: 'toolCall', id: c.id, name: c.name, argumentsJson: c.argumentsJson });
        messages = [
          ...messages,
          { role: 'ASSISTANT', parts: assistantParts, blocks: st.blocks },
          { role: 'USER', parts: records.map((r) => ({ type: 'toolResult' as const, callId: r.id, name: r.name, content: r.result, isError: r.isError })) },
        ];
        await this.conversations.updateStreaming(reply.id, st.allText, st.thinking || null);
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal.aborted) {
        st.endThinking();
        await this.finish(reply, st, provider, model, 'STOPPED', false);
        return;
      }
      if (e instanceof ChatError) st.error = { kind: 'BAD_REQUEST', message: e.message };
      else if (e instanceof LlmException) st.error = e.error;
      else if (e instanceof TypeError) st.error = { kind: 'NETWORK', message: `Couldn’t reach ${provider.label}. Check your connection and try again.` };
      else st.error = { kind: 'UNKNOWN', message: `Something went wrong: ${(e as Error)?.message ?? String(e)}` };
    }
    st.endThinking();
    const status: MessageStatus = st.error ? 'ERROR' : st.stop === 'REFUSAL' ? 'REFUSED' : st.stop === 'MAX_TOKENS' ? 'TRUNCATED' : st.stop === 'CANCELLED' ? 'STOPPED' : 'DONE';
    await this.finish(reply, st, provider, model, status, true);
    if (status === 'DONE') {
      const conv = await this.conversations.get(conversationId);
      if (conv) {
        this.onReplyFinished?.(conversationId, conv.title, st.allText.slice(0, 160));
        if (!conv.titleSet && this.settings.synced.autoTitle) void this.generateTitle(conversationId).catch(() => {});
      }
    }
  }

  /** Runs one tool call (after approval when required) and records it. */
  private async runTool(
    call: { id: string; name: string; argumentsJson: string },
    prepared: PreparedTools,
    st: ReplyState,
    reply: MessageEntity,
    signal: AbortSignal,
    onUpdate: () => void,
  ): Promise<ToolCallRecord> {
    const def = prepared.byName.get(call.name);
    const update = (transform: (a: ToolActivity) => ToolActivity) => {
      const a = st.activities.get(call.id);
      if (a) st.activities.set(call.id, transform(a));
      onUpdate();
    };
    if (!def) {
      const msg = `There is no tool named "${call.name}". Use only the tools provided.`;
      update((a) => ({ ...a, status: 'ERROR', result: msg }));
      return { id: call.id, name: call.name, kind: 'MCP', label: call.name, argumentsJson: call.argumentsJson, result: msg, isError: true };
    }
    const allowedForChat = def.kind === 'COMPUTER' && this.isSessionApproved(reply.conversationId, def.spec.name);
    if (def.needsApproval && !this.settings.synced.yoloMode && !allowedForChat) {
      update((a) => ({ ...a, status: 'AWAITING_APPROVAL' }));
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        this.approvals.set(call.id, resolve);
        const onAbort = () => this.respondToApproval(call.id, 'DENY');
        signal.addEventListener('abort', onAbort, { once: true });
        if (this.settings.synced.yoloMode) this.respondToApproval(call.id, 'ALLOW');
      });
      if (decision === 'ALWAYS' && def.kind === 'MCP' && def.serverId && def.remoteName) await this.mcpAutoApprove(def.serverId, def.remoteName).catch(() => {});
      if (decision === 'ALWAYS' && def.kind === 'COMPUTER') this.sessionApproved.add(reply.conversationId + '/' + def.spec.name);
      if (decision === 'DENY') {
        const msg = 'The user declined this tool call. Don’t retry it; continue without it or ask the user how to proceed.';
        update((a) => ({ ...a, status: 'DENIED', result: msg }));
        return { id: call.id, name: call.name, kind: def.kind, label: runningLabel(def, call.argumentsJson), argumentsJson: call.argumentsJson, result: msg, isError: true, serverName: def.serverName ?? null };
      }
    }
    update((a) => ({ ...a, status: 'RUNNING' }));
    const start = Date.now();
    const timeoutMs = def.kind === 'MEDIA' ? MEDIA_TOOL_TIMEOUT_MS : def.kind === 'COMPUTER' ? COMPUTER_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
    const toolAbort = new AbortController();
    const forward = () => toolAbort.abort();
    signal.addEventListener('abort', forward, { once: true });
    let outcome: ToolOutcome;
    try {
      outcome = await withTimeout(
        this.tools.execute(def, call.argumentsJson, {
          conversationId: reply.conversationId,
          callId: call.id,
          signal: toolAbort.signal,
          onProgress: (label) => update((a) => ({ ...a, label })),
        }),
        timeoutMs,
        () => toolAbort.abort(),
      );
    } catch (e) {
      if (e instanceof TimeoutError) {
        outcome = { content: `The tool timed out after ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min.` : `${timeoutMs / 1000} s.`}`, isError: true };
      } else {
        outcome = { content: (e as Error)?.message || 'The tool failed.', isError: true };
      }
    } finally {
      signal.removeEventListener('abort', forward);
    }
    const result = outcome.content.length > MAX_RESULT_CHARS ? outcome.content.slice(0, MAX_RESULT_CHARS) + '\n\n[Output truncated.]' : outcome.content;
    for (const c of outcome.citations ?? []) if (!st.citations.has(c.url)) st.citations.set(c.url, c);
    st.attachments.push(...(outcome.attachments ?? []));
    const label = outcome.label || runningLabel(def, call.argumentsJson, true);
    update((a) => ({ ...a, status: outcome.isError ? 'ERROR' : 'DONE', label, result: result.slice(0, 2_000) }));
    return {
      id: call.id, name: call.name, kind: def.kind, label, argumentsJson: call.argumentsJson, result, isError: !!outcome.isError,
      durationMs: Date.now() - start, serverName: def.serverName ?? null,
    };
  }

  /** Computer tools the user allowed for the rest of a chat ("Always allow" on an approval card). */
  private sessionApproved = new Set<string>();

  /** Whether a computer tool was already allowed for this chat. */
  isSessionApproved(conversationId: string, toolName: string): boolean {
    return this.sessionApproved.has(conversationId + '/' + toolName);
  }

  private async finish(reply: MessageEntity, st: ReplyState, provider: ProviderEntity, model: ModelInfo, status: MessageStatus, includeFinalBlocks: boolean): Promise<void> {
    const kind = providerKind(provider.kind);
    const served = st.servedModel || model.id;
    const price = served === model.id ? model.pricing ?? this.pricing.priceFor(kind, served) : this.pricing.priceFor(kind, served);
    const usage = st.usage;
    const cost = usage && price ? this.pricing.cost(price, usage) : null;
    const current = (await this.conversations.message(reply.id)) ?? reply;
    const text = st.allText.trim() ? st.allText : st.stepText;
    const trace: ToolTrace | null = st.steps.length ? { steps: st.steps, finalText: st.stepText } : null;
    const err = st.error;
    await this.conversations.updateMessage({
      ...current,
      content: text,
      thinking: st.thinking.trim() ? st.thinking : null,
      thinkingMs: st.thinkingMs > 0 ? st.thinkingMs : null,
      blocksJson: includeFinalBlocks && st.blocks ? toJson(st.blocks) : null,
      citationsJson: st.citations.size ? toJson([...st.citations.values()]) : null,
      modelId: served,
      modelName: served === model.id ? model.displayName : served,
      status,
      errorJson: err ? toJson({ kind: err.kind, message: err.message, detail: err.detail ?? null }) : null,
      usageJson: usage ? toJson(usage) : null,
      costUsd: cost,
      stepsJson: trace ? toJson(trace) : null,
      attachmentsJson: st.attachments.length ? JSON.stringify(st.attachments) : current.attachmentsJson ?? null,
    });
    await this.conversations.update(reply.conversationId, (c) => c, true);
  }

  /** Builds the provider request from the visible branch ending at [reply]'s parent. */
  private async buildRequest(conversationId: string, reply: MessageEntity, model: ModelInfo): Promise<ChatRequest> {
    const conv = await this.conversations.get(conversationId);
    if (!conv) throw new ChatError('This chat no longer exists.');
    if (!reply.parentId) throw new ChatError('Nothing to reply to.');
    const tree = new MessageTree(await this.conversations.messages(conversationId));
    const path = tree.pathTo(reply.parentId);
    const messages: ChatMessage[] = [];
    const hasToolParts = (m: ChatMessage) => m.parts.some((p) => p.type === 'toolCall' || p.type === 'toolResult');
    const add = (msg: ChatMessage) => {
      const last = messages.at(-1);
      if (last && last.role === msg.role && !hasToolParts(last) && !hasToolParts(msg)) {
        messages[messages.length - 1] = { ...last, parts: [...last.parts, ...msg.parts], blocks: null };
      } else messages.push(msg);
    };
    for (const m of path) {
      if (m.role === 'user') {
        add({ role: 'USER', parts: await this.userParts(m, model) });
        continue;
      }
      const status = m.status ?? 'DONE';
      if (status === 'ERROR' || status === 'REFUSED') continue;
      const trace = parseJson<ToolTrace | null>(m.stepsJson, null);
      const replayable = status === 'DONE' || status === 'TRUNCATED';
      const blocks = replayable ? parseJson<ProviderBlocks | null>(m.blocksJson, null) : null;
      if (trace?.steps) {
        for (const step of trace.steps) {
          const parts: Part[] = [];
          if (step.text?.trim()) parts.push({ type: 'text', text: step.text });
          for (const c of step.calls) parts.push({ type: 'toolCall', id: c.id, name: c.name, argumentsJson: c.argumentsJson });
          add({ role: 'ASSISTANT', parts, blocks: step.blocks ?? null });
          add({ role: 'USER', parts: step.calls.map((c) => ({ type: 'toolResult' as const, callId: c.id, name: c.name, content: c.result, isError: c.isError })) });
        }
        if (trace.finalText?.trim()) add({ role: 'ASSISTANT', parts: [{ type: 'text', text: trace.finalText }], blocks });
      } else {
        if (!m.content.trim()) continue;
        add({ role: 'ASSISTANT', parts: [{ type: 'text', text: m.content }], blocks });
      }
    }
    const assistant = await this.assistants.get(conv.assistantId);
    return {
      model: model.id,
      system: this.buildSystem(conv, assistant),
      messages,
      params: parseParams(conv.paramsJson),
      caps: model.caps,
      modelMaxOutput: model.maxOutput ?? null,
      tools: [],
    };
  }

  private async userParts(m: MessageEntity, model: ModelInfo): Promise<Part[]> {
    const parts: Part[] = [];
    for (const ref of messageAttachments(m)) parts.push(await this.attachmentPart(ref, model));
    if (m.content.trim()) parts.push({ type: 'text', text: m.content });
    if (parts.length === 0) parts.push({ type: 'text', text: '(empty message)' });
    return parts;
  }

  private async attachmentPart(ref: AttachmentRef, model: ModelInfo): Promise<Part> {
    await this.sync.ensureLocal(ref.id);
    const bytes = await this.attachments.bytes(ref.id);
    if (!bytes) return { type: 'text', text: `[Attachment "${ref.name}" isn't available on this device yet.]` };
    switch (ref.kind) {
      case 'image':
        return model.caps.vision
          ? { type: 'image', mimeType: ref.mimeType, bytes }
          : { type: 'text', text: `[Image "${ref.name}" attached, but ${model.displayName} can't view images.]` };
      case 'pdf':
        return model.caps.pdf
          ? { type: 'document', mimeType: ref.mimeType, name: ref.name, bytes }
          : { type: 'text', text: `[PDF "${ref.name}" attached, but ${model.displayName} can't read PDFs. Try a Claude, GPT, or Gemini model.]` };
      case 'text':
      case 'file': {
        const dot = ref.name.lastIndexOf('.');
        const lang = dot >= 0 ? ref.name.slice(dot + 1) : '';
        return { type: 'text', text: `File: ${ref.name}\n\`\`\`${lang}\n${fromUtf8(bytes)}\n\`\`\`` };
      }
      default:
        return { type: 'text', text: `[${ref.kind} "${ref.name}" attached (${ref.mimeType}).]` };
    }
  }

  private buildSystem(conv: ConversationEntity, assistant: Assistant | undefined): string {
    const prefs = this.settings.synced;
    const parts: string[] = [];
    if (assistant?.instructions?.trim()) parts.push(assistant.instructions);
    parts.push('Your replies are rendered as GitHub-flavored Markdown, including tables, fenced code blocks with language tags, and LaTeX math between $…$ or $$…$$.');
    parts.push(`The conversation started on ${Dates.isoDate(conv.createdAt)}.`);
    if (prefs.customInstructionsEnabled) {
      if (prefs.aboutMe.trim()) parts.push(`About the user:\n${prefs.aboutMe}`);
      if (prefs.responseStyle.trim()) parts.push(`How the user wants you to respond:\n${prefs.responseStyle}`);
    }
    if (conv.systemPrompt?.trim()) parts.push(conv.systemPrompt);
    return parts.join('\n\n');
  }

  // ---- titles ----

  private async generateTitle(conversationId: string): Promise<void> {
    const conv = await this.conversations.get(conversationId);
    if (!conv || conv.titleSet) return;
    const path = new MessageTree(await this.conversations.messages(conversationId)).activePath(conv.currentLeafId);
    const firstUser = path.find((m) => m.role === 'user');
    if (!firstUser) return;
    const firstReply = path.find((m) => m.role === 'assistant' && m.content.trim());
    const ref = this.settings.synced.titleModel;
    const providerId = ref?.providerId ?? conv.providerId;
    const provider = providerId ? await this.providers.get(providerId) : undefined;
    if (!provider || provider.deleted || !provider.enabled) return;
    const modelId = ref && ref.providerId === provider.id ? ref.modelId : conv.modelId;
    if (!modelId) return;
    const model = this.providers.modelInfo(provider, modelId);
    const atts = messageAttachments(firstUser);
    let transcript = 'User: ' + firstUser.content.slice(0, 1500);
    if (atts.length) transcript += ' [with attachments: ' + atts.map((a) => a.name).join(', ') + ']';
    if (firstReply) transcript += '\n\nAssistant: ' + firstReply.content.slice(0, 1500);
    const request: ChatRequest = {
      model: model.id,
      system: 'You write short, specific titles for chat conversations. Reply with the title only: 2 to 6 words in the conversation\'s language, no quotes, no trailing punctuation, no emoji.',
      messages: [{ role: 'USER', parts: [{ type: 'text', text: `${transcript}\n\nWrite the title.` }] }],
      params: defaultParams({ showThinking: false }),
      caps: model.caps,
      utility: true,
      tools: [],
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    let out = '';
    try {
      for await (const ev of (await this.providers.client(provider)).stream(request, abort.signal)) {
        if (ev.type === 'text') out += ev.text;
      }
    } finally {
      clearTimeout(timer);
    }
    const title = (out.split('\n').find((l) => l.trim()) ?? '')
      .trim()
      .replace(/^["'“”*# ]+|["'“”*# ]+$/g, '')
      .replace(/\.$/, '')
      .slice(0, 60);
    if (title) await this.conversations.update(conversationId, (c) => ({ ...c, title, titleSet: true }));
  }
}

function preparingLabel(def: ToolDef | undefined, name: string): string {
  switch (def?.kind) {
    case 'SEARCH':
      return 'Searching the web';
    case 'FETCH':
      return 'Reading a page';
    case 'SKILL':
      return 'Loading a skill';
    case 'COMPUTER':
      return computerLabel(def.remoteName ?? name, '{}', false);
    default: {
      const remote = def?.remoteName ?? name;
      return def?.serverName ? `${def.serverName}: ${remote}` : remote;
    }
  }
}

function argString(args: string, key: string): string {
  const obj = parseJson<Record<string, unknown> | null>(args, null);
  const v = obj?.[key];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

/** Labels for the Windows app's computer tools while they run; the bridge supplies the final label. */
function computerLabel(tool: string, args: string, done: boolean): string {
  const path = shortPath(argString(args, 'path'));
  switch (tool) {
    case 'run_command': {
      const cmd = argString(args, 'command').split('\n')[0];
      return (done ? 'Ran ' : 'Running ') + (cmd ? '`' + (cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd) + '`' : 'a command');
    }
    case 'read_file':
      return (done ? 'Read ' : 'Reading ') + (path || 'a file');
    case 'write_file':
      return (done ? 'Wrote ' : 'Writing ') + (path || 'a file');
    case 'edit_file':
      return (done ? 'Edited ' : 'Editing ') + (path || 'a file');
    case 'list_directory':
      return (done ? 'Listed ' : 'Listing ') + (path || 'the folder');
    case 'glob':
      return (done ? 'Found files matching ' : 'Finding files matching ') + (argString(args, 'pattern') || '…');
    case 'grep':
      return (done ? 'Searched for ' : 'Searching for ') + `“${argString(args, 'pattern').slice(0, 40)}”`;
    default:
      return tool.replace(/_/g, ' ');
  }
}

function runningLabel(def: ToolDef | undefined, args: string, done = false): string {
  switch (def?.kind) {
    case 'SEARCH':
      return (done ? 'Searched' : 'Searching') + ` “${argString(args, 'query').slice(0, 60)}”`;
    case 'FETCH':
      return (done ? 'Read ' : 'Reading ') + (hostOf(argString(args, 'url')) ?? 'a page');
    case 'SKILL': {
      const name = argString(args, 'name');
      return name ? (done ? 'Used skill ' : 'Using skill ') + name : (done ? 'Read ' : 'Reading ') + argString(args, 'path');
    }
    case 'MCP':
      return `${def.serverName}: ${def.remoteName}`;
    case 'MEDIA': {
      const what = def.output === 'IMAGE' ? 'an image' : def.output === 'VIDEO' ? 'a video' : def.output === 'SPEECH' ? 'speech' : def.output === 'MUSIC' ? 'music' : 'media';
      return (done ? 'Created ' : 'Creating ') + what;
    }
    case 'COMPUTER':
      return computerLabel(def.remoteName ?? def.spec.name, args, done);
    default:
      return 'Tool';
  }
}
