/** Assistants, folders and saved prompts (port of LibraryRepositories.kt). */
import { newId } from '../core/ids';
import { parseJson, toJson } from '../core/json';
import { locale, t } from '../i18n';
import { parseParams, type GenParams } from '../llm/types';
import { db } from './db';
import type { AssistantEntity } from './entities';
import type { ModelRef } from './prefs';

/** An assistant (persona): built-in or user-made. */
export interface Assistant {
  id: string;
  name: string;
  emoji: string | null;
  /** Built-ins draw an icon instead of an emoji. */
  icon: 'gem' | 'code' | 'writer' | 'tutor' | 'languages' | 'analyst' | null;
  colorIndex: number;
  instructions: string;
  model: ModelRef | null;
  params: GenParams | null;
  starters: string[];
  builtin: boolean;
}

export const DEFAULT_ASSISTANT_ID = 'builtin.facet';

function builtin(id: string, name: string, icon: Assistant['icon'], colorIndex: number, instructions: string, starters: string[]): Assistant {
  return { id, name, emoji: null, icon, colorIndex, instructions, model: null, params: null, starters, builtin: true };
}

/**
 * The built-in assistants, with names and starter suggestions in the interface language (built
 * on first use, after the language has loaded). Their instructions go to models and stay English.
 */
function makeBuiltins(): Assistant[] {
  return [
    builtin(DEFAULT_ASSISTANT_ID, 'Facet', 'gem', 0, '', [
      t('Explain how HTTPS keeps a connection private'),
      t('Plan a 3-day trip to Lisbon on a modest budget'),
      t('Help me write a polite follow-up email'),
      t('What should I know before adopting a cat?'),
    ]),
    builtin(
      'builtin.code', t('Code'), 'code', 1,
      'You are a senior software engineer pairing with the user.\n' +
        'Write correct, idiomatic, production-quality code and keep explanations short and concrete.\n' +
        'Always use fenced code blocks with a language tag. When changing existing code, show only what changes unless asked for the full file.\n' +
        'Point out bugs, security issues, and edge cases you notice. If requirements are ambiguous, state your assumption briefly and proceed.',
      [t('Review this function for bugs'), t('Write a Kotlin coroutine that retries with backoff'), t('Explain the difference between a mutex and a semaphore'), t('Convert this Python script to TypeScript')],
    ),
    builtin(
      'builtin.writer', t('Writer'), 'writer', 2,
      'You are an experienced editor and writer.\n' +
        "Match the user's voice and audience. Prefer plain, specific language over filler. When editing, keep the meaning, tighten the prose, and briefly list the main changes.\n" +
        'When drafting, ask at most one clarifying question if the goal is unclear; otherwise write a strong first draft.',
      [t('Tighten this paragraph without changing its meaning'), t('Draft a short bio for a conference talk'), t('Make this message sound warmer but still professional'), t('Give me five title ideas for this article')],
    ),
    builtin(
      'builtin.tutor', t('Tutor'), 'tutor', 3,
      'You are a patient tutor. Teach for understanding, not just answers.\n' +
        'Start from what the learner knows, explain one idea at a time with a small example, and check understanding with a short question.\n' +
        'For exercises, guide with hints before giving the full solution unless the learner asks for it. Use LaTeX for math.',
      [t('Teach me derivatives from scratch'), t('Quiz me on Spanish past tense verbs'), t('Why does the moon have phases?'), t('Walk me through how a neural network learns')],
    ),
    builtin(
      'builtin.translator', t('Translator'), 'languages', 4,
      'You are a professional translator. Detect the source language automatically.\n' +
        'If the user names a target language, translate into it; otherwise translate into English, or from English into the language the user last asked for.\n' +
        'Preserve meaning, tone, formatting, and Markdown. Output only the translation unless the user asks for notes; add a brief note only when a phrase has no direct equivalent.',
      [t('Translate to Spanish: Where is the nearest train station?'), t('Translate this email into formal Japanese'), t('What does "saudade" mean?'), t('Translate to French and keep the formatting')],
    ),
    builtin(
      'builtin.analyst', t('Analyst'), 'analyst', 5,
      'You are a rigorous analyst. Structure answers: the conclusion first, then the reasoning and the evidence.\n' +
        'Show calculations, state assumptions and uncertainty explicitly, and use tables when comparing options. Distinguish facts from estimates.',
      [t('Compare renting vs buying with these numbers'), t('Summarize the key risks in this plan'), t('Build a simple unit economics model for a coffee shop'), t("What's the expected value of this decision?")],
    ),
  ];
}

let builtins: { locale: string; list: readonly Assistant[] } | null = null;

/** The built-in assistants (Facet first), localized. */
export function builtinAssistants(): readonly Assistant[] {
  if (!builtins || builtins.locale !== locale()) builtins = { locale: locale(), list: makeBuiltins() };
  return builtins.list;
}

export function builtinAssistant(id: string | null | undefined): Assistant | undefined {
  return builtinAssistants().find((a) => a.id === id);
}

export function toAssistant(e: AssistantEntity): Assistant {
  return {
    id: e.id, name: e.name, emoji: e.emoji, icon: null, colorIndex: e.colorIndex, instructions: e.instructions,
    model: e.providerId && e.modelId ? { providerId: e.providerId, modelId: e.modelId } : null,
    params: e.paramsJson ? parseParams(e.paramsJson) : null,
    starters: parseJson<string[]>(e.startersJson, []),
    builtin: false,
  };
}

export class AssistantRepository {
  constructor(private readonly onLocalChange: () => void = () => {}) {}

  async all(): Promise<Assistant[]> {
    const custom = await db().assistants.filter((a) => a.deleted === 0).toArray();
    custom.sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
    return [...builtinAssistants(), ...custom.map(toAssistant)];
  }

  async get(id: string | null | undefined): Promise<Assistant | undefined> {
    if (!id) return undefined;
    const b = builtinAssistant(id);
    if (b) return b;
    const e = await db().assistants.get(id);
    return e && !e.deleted ? toAssistant(e) : undefined;
  }

  async save(input: { id?: string | null; name: string; emoji: string; colorIndex: number; instructions: string; model: ModelRef | null; params: GenParams | null; starters: string[] }): Promise<string> {
    const now = Date.now();
    const existing = input.id ? await db().assistants.get(input.id) : undefined;
    const e: AssistantEntity = {
      id: existing?.id ?? newId(now),
      name: input.name.trim() || t('Assistant'),
      emoji: input.emoji.trim() || '✨',
      colorIndex: input.colorIndex,
      instructions: input.instructions.trim(),
      providerId: input.model?.providerId ?? null,
      modelId: input.model?.modelId ?? null,
      paramsJson: input.params ? toJson(input.params) : null,
      startersJson: JSON.stringify(input.starters.map((s) => s.trim()).filter(Boolean)),
      sort: existing?.sort ?? 100,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deleted: 0,
      dirty: 1,
    };
    await db().assistants.put(e);
    this.onLocalChange();
    return e.id;
  }

  async delete(id: string): Promise<void> {
    const e = await db().assistants.get(id);
    if (!e) return;
    await db().assistants.put({ ...e, deleted: 1, dirty: 1, instructions: '', updatedAt: Date.now() });
    this.onLocalChange();
  }
}

export class FolderRepository {
  constructor(private readonly onLocalChange: () => void = () => {}) {}

  async save(id: string | null, name: string, colorIndex: number): Promise<string> {
    const now = Date.now();
    const existing = id ? await db().folders.get(id) : undefined;
    const e = {
      id: existing?.id ?? newId(now), name: name.trim() || t('Folder'), colorIndex, sort: existing?.sort ?? 0,
      createdAt: existing?.createdAt ?? now, updatedAt: now, deleted: 0 as const, dirty: 1 as const,
    };
    await db().folders.put(e);
    this.onLocalChange();
    return e.id;
  }

  async delete(id: string): Promise<void> {
    const e = await db().folders.get(id);
    if (!e) return;
    await db().folders.put({ ...e, deleted: 1, dirty: 1, updatedAt: Date.now() });
    this.onLocalChange();
  }
}

export class PromptRepository {
  constructor(private readonly onLocalChange: () => void = () => {}) {}

  async save(id: string | null, title: string, body: string): Promise<string> {
    const now = Date.now();
    const existing = id ? await db().prompts.get(id) : undefined;
    const e = {
      id: existing?.id ?? newId(now), title: title.trim() || body.slice(0, 40), body,
      createdAt: existing?.createdAt ?? now, updatedAt: now, deleted: 0 as const, dirty: 1 as const,
    };
    await db().prompts.put(e);
    this.onLocalChange();
    return e.id;
  }

  async delete(id: string): Promise<void> {
    const e = await db().prompts.get(id);
    if (!e) return;
    await db().prompts.put({ ...e, deleted: 1, dirty: 1, body: '', updatedAt: Date.now() });
    this.onLocalChange();
  }
}
