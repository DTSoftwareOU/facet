/**
 * Skills (port of Skills.kt): reusable instructions in the Agent Skills format, stored locally,
 * synced end-to-end encrypted and loaded by models on demand.
 */
import { unzipSync } from 'fflate';
import { newId } from '../core/ids';
import { isObject, parseJson } from '../core/json';
import { db } from '../data/db';
import type { SkillEntity } from '../data/entities';
import { platform } from '../platform';
import type { SkillResource } from './types';

export class SkillImportException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillImportException';
  }
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Reads skills in the Agent Skills format: a SKILL.md with YAML frontmatter (`name`, `description`)
 * followed by Markdown instructions, optionally bundled in a .zip with reference files.
 */
export const SkillParser = {
  parse(markdown: string, fallbackName = 'skill'): ParsedSkill {
    const text = markdown.replace(/\r\n/g, '\n').replace(/^﻿+/, '');
    const fm = /^---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
    const front = fm ? fm[1] : '';
    const body = fm ? fm[2] : text;
    const fields = SkillParser.parseFrontmatter(front);
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const name = SkillParser.slug(fields.name ?? heading ?? fallbackName);
    const firstLine = body.split(/\r\n|\r|\n/).find((l) => l.trim() !== '' && !l.startsWith('#')) ?? '';
    const description = (fields.description ?? firstLine).trim().slice(0, 1024);
    if (!body.trim()) throw new SkillImportException('The skill has no instructions.');
    return { name, description: description.trim() ? description : `Use when the task matches ${name}.`, body: body.trim() };
  },

  /** Minimal YAML for frontmatter: `key: value`, quoted values, and `>` / `|` block scalars. */
  parseFrontmatter(front: string): Record<string, string> {
    const out: Record<string, string> = {};
    const lines = front.split(/\r\n|\r|\n/);
    let i = 0;
    while (i < lines.length) {
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
      if (!m) {
        i++;
        continue;
      }
      const key = m[1];
      let value = m[2].trim();
      if (value === '>' || value === '|' || value === '>-' || value === '|-') {
        const folded = value.startsWith('>');
        const block: string[] = [];
        i++;
        while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('\t') || lines[i].trim() === '')) {
          block.push(lines[i].trim());
          i++;
        }
        out[key] = folded ? block.join(' ').trim() : block.join('\n').trim();
        continue;
      }
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1).replace(/\\"/g, '"');
      }
      out[key] = value;
      i++;
    }
    return out;
  },

  slug(name: string): string {
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    return NAME_PATTERN.test(s) ? s : 'skill';
  },
};

/** What the skill editor saves. Omitted fields keep their defaults (or the existing skill's source link). */
export interface SkillInput {
  id?: string | null;
  name: string;
  description: string;
  instructions: string;
  resources?: SkillResource[];
  enabled?: boolean;
  alwaysOn?: boolean;
  sourceUrl?: string | null;
}

const BINARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'ttf', 'otf', 'woff', 'woff2', 'zip', 'gz', 'jar', 'so', 'bin', 'exe']);

const afterLast = (s: string, c: string, missing = s) => (s.lastIndexOf(c) >= 0 ? s.slice(s.lastIndexOf(c) + 1) : missing);
const beforeLast = (s: string, c: string, missing = s) => (s.lastIndexOf(c) >= 0 ? s.slice(0, s.lastIndexOf(c)) : missing);

function isText(path: string, data: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(afterLast(path, '.', '').toLowerCase())) return false;
  const n = Math.min(data.length, 4096);
  for (let i = 0; i < n; i++) if (data[i] === 0) return false;
  return true;
}

const isZip = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

/** User skills: stored locally, synced end-to-end encrypted, loaded by models on demand. */
export class SkillRepository {
  static readonly MAX_FILE = 200 * 1024;
  static readonly MAX_TOTAL = 1024 * 1024;

  /** Starter skills users can add with one tap. */
  static readonly EXAMPLES: readonly ParsedSkill[] = [
    {
      name: 'meeting-notes',
      description:
        'Turn rough notes or a transcript into clear meeting notes with decisions and action items. Use when the user shares meeting notes, a call transcript, or asks for a recap.',
      body: `# Meeting notes

Produce notes with these sections, in this order:

1. **Summary**: two or three sentences on what the meeting was for and what came out of it.
2. **Decisions**: a bulleted list. Each decision in one line, in the past tense.
3. **Action items**: a table with columns Owner, Task, Due. Use "Unassigned" or "No date" when the notes don't say.
4. **Open questions**: anything raised but not resolved.

Keep the participants' wording for decisions. Don't invent owners or dates. If the notes are too thin for a section, write "None recorded."`,
    },
    {
      name: 'code-review',
      description:
        'Review code changes for bugs, security issues and maintainability, with concrete fixes. Use when the user shares a diff, a pull request, or asks for a code review.',
      body: `# Code review

Review in this order and stop to flag anything severe first:

1. **Correctness**: logic errors, off-by-one, null handling, concurrency, error paths.
2. **Security**: injection, secrets in code, unsafe deserialization, missing authorization checks.
3. **Performance**: unnecessary work in loops, N+1 queries, unbounded memory.
4. **Readability**: naming, dead code, comments that contradict the code.

For each finding give: severity (High/Medium/Low), the file and line if known, why it matters, and a corrected snippet. End with a one-line verdict. Don't pad the review with praise.`,
    },
    {
      name: 'trip-planner',
      description:
        'Plan trips day by day with realistic travel times, budgets and booking tips. Use when the user asks for an itinerary, a travel plan, or what to do in a place.',
      body: `# Trip planner

Ask at most one question if the dates, budget or interests are missing; otherwise assume sensible defaults and say what you assumed.

Plan by neighborhood to minimize transit. For each day give morning, afternoon and evening, with walking or transit time between stops. Include one food recommendation per day, typical prices in local currency, and anything that needs booking ahead. Finish with a short packing list for the season.`,
    },
  ];

  /** [onLocalChange] runs after every user change, so the sync engine can push it. */
  constructor(private readonly onLocalChange: () => void = () => {}) {}

  /** Skills sorted by name (a Dexie query only, so it works inside liveQuery/useLiveQuery). */
  async all(): Promise<SkillEntity[]> {
    const rows = await db().skills.toArray();
    return rows.filter((s) => !s.deleted).sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  async get(id: string): Promise<SkillEntity | undefined> {
    return db().skills.get(id);
  }

  async save(input: SkillInput): Promise<SkillEntity> {
    const now = Date.now();
    const existing = input.id ? await db().skills.get(input.id) : undefined;
    const taken = new Set((await this.all()).filter((s) => s.id !== existing?.id).map((s) => s.name));
    const base = SkillParser.slug(input.name);
    let slug = base;
    let n = 2;
    while (taken.has(slug)) slug = base.slice(0, 60) + '-' + n++;
    const e: SkillEntity = {
      id: existing?.id ?? newId(now),
      name: slug,
      description: input.description.trim().slice(0, 1024),
      instructions: input.instructions.trim(),
      resourcesJson: JSON.stringify(input.resources ?? []),
      enabled: input.enabled ?? true,
      alwaysOn: input.alwaysOn ?? false,
      sourceUrl: input.sourceUrl ?? existing?.sourceUrl ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deleted: 0,
      dirty: 1,
    };
    await db().skills.put(e);
    this.onLocalChange();
    return e;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.mutate(id, () => ({ enabled }));
  }

  async setAlwaysOn(id: string, alwaysOn: boolean): Promise<void> {
    await this.mutate(id, () => ({ alwaysOn }));
  }

  async delete(id: string): Promise<void> {
    await this.mutate(id, () => ({ deleted: 1, instructions: '', resourcesJson: '[]' }));
  }

  private async mutate(id: string, transform: (e: SkillEntity) => Partial<SkillEntity>): Promise<void> {
    let changed = false;
    await db().transaction('rw', db().skills, async () => {
      const e = await db().skills.get(id);
      if (!e) return;
      await db().skills.put({ ...e, ...transform(e), updatedAt: Date.now(), dirty: 1 });
      changed = true;
    });
    if (changed) this.onLocalChange();
  }

  resources(e: SkillEntity): SkillResource[] {
    const raw = parseJson<unknown>(e.resourcesJson, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is SkillResource => isObject(r) && typeof r.path === 'string' && typeof r.content === 'string');
  }

  async importMarkdown(markdown: string, sourceUrl: string | null = null, fallbackName = 'skill'): Promise<SkillEntity> {
    const p = SkillParser.parse(markdown, fallbackName);
    return this.save({ name: p.name, description: p.description, instructions: p.body, sourceUrl });
  }

  /** Imports a .zip containing SKILL.md (at the root or in one folder) plus text reference files. */
  async importZip(bytes: Uint8Array, sourceUrl: string | null = null): Promise<SkillEntity> {
    const accept = (name: string) => {
      const path = name.replace(/\\/g, '/').replace(/^\/+/, '');
      return !name.endsWith('/') && !path.includes('..') && !path.startsWith('__MACOSX') && !path.split('/').some((s) => s.startsWith('.'));
    };
    let entries: Record<string, Uint8Array>;
    try {
      // Skips large entries before inflating them, so a zip bomb can't exhaust memory.
      entries = unzipSync(bytes, { filter: (f) => accept(f.name) && f.originalSize <= SkillRepository.MAX_FILE });
    } catch {
      throw new SkillImportException("That file isn't a valid .zip archive.");
    }
    const files = new Map<string, string>();
    const decoder = new TextDecoder();
    let total = 0;
    for (const [name, data] of Object.entries(entries)) {
      const path = name.replace(/\\/g, '/').replace(/^\/+/, '');
      if (data.length > SkillRepository.MAX_FILE || !isText(path, data)) continue;
      total += data.length;
      if (total > SkillRepository.MAX_TOTAL) throw new SkillImportException(`The skill is larger than ${SkillRepository.MAX_TOTAL / 1024} KB of text.`);
      files.set(path, decoder.decode(data));
    }
    let skillPath: string | null = null;
    for (const k of files.keys()) {
      if (afterLast(k, '/').toLowerCase() !== 'skill.md') continue;
      if (skillPath == null || depth(k) < depth(skillPath)) skillPath = k;
    }
    if (skillPath == null) throw new SkillImportException('No SKILL.md found in that archive.');
    const root = beforeLast(skillPath, '/', '');
    const prefix = root ? `${root}/` : '';
    const p = SkillParser.parse(files.get(skillPath)!, afterLast(root, '/').trim() || 'skill');
    const resources: SkillResource[] = [];
    for (const [k, v] of files) if (k !== skillPath && k.startsWith(prefix)) resources.push({ path: k.slice(prefix.length), content: v });
    return this.save({ name: p.name, description: p.description, instructions: p.body, resources, sourceUrl });
  }

  /** Imports a file the user picked: a .zip (by name or content) or a Markdown SKILL.md. */
  async importFile(fileName: string, bytes: Uint8Array): Promise<SkillEntity> {
    if (fileName.toLowerCase().endsWith('.zip') || isZip(bytes)) return this.importZip(bytes);
    const base = afterLast(fileName.replace(/\\/g, '/'), '/');
    return this.importMarkdown(new TextDecoder().decode(bytes), null, beforeLast(base, '.'));
  }

  /** Imports from a URL to a SKILL.md / .md file or a .zip. GitHub "blob" links are converted to raw. */
  async importUrl(url: string): Promise<SkillEntity> {
    const raw = toRaw(url.trim());
    let response: Response;
    try {
      response = await platform().fetch(raw, { headers: platform().corsLimited ? {} : { 'User-Agent': 'Facet' } });
    } catch {
      throw new SkillImportException(
        platform().corsLimited
          ? "Couldn't download the skill. The site may not allow downloads from web browsers; download the file and import it from your computer instead."
          : "Couldn't download the skill. Check the link and your connection.",
      );
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw new SkillImportException(`Couldn't download the skill (HTTP ${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > SkillRepository.MAX_TOTAL * 4) throw new SkillImportException('That file is too large to be a skill.');
    if (raw.toLowerCase().endsWith('.zip') || isZip(bytes)) return this.importZip(bytes, url);
    const fileBase = beforeLast(afterLast(raw, '/'), '.');
    const name = fileBase.toLowerCase() !== 'skill' ? fileBase : afterLast(beforeLast(raw, '/'), '/');
    return this.importMarkdown(new TextDecoder().decode(bytes), url, name);
  }
}

function depth(path: string): number {
  let n = 0;
  for (const c of path) if (c === '/') n++;
  return n;
}

function toRaw(url: string): string {
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url);
  return gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}` : url;
}
