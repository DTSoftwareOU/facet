/**
 * Every locale catalog has exactly the keys the source uses (scripts/i18n-keys.mjs), keeps each
 * key's {placeholders}, and gives every plural form its language needs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractKeys } from '../../scripts/i18n-keys.mjs';
import { LOCALES, type Catalog } from '../../src/i18n';

const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'src', 'i18n', 'locales');
const { keys, problems } = extractKeys(ROOT);
const translated = LOCALES.filter((l) => l.code !== 'en');

function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

function read(code: string): Catalog {
  return JSON.parse(readFileSync(join(DIR, `${code}.json`), 'utf8')) as Catalog;
}

describe('source keys', () => {
  it('are all string literals, each used one way', () => {
    expect(problems).toEqual([]);
  });

  it('were found', () => {
    expect(keys.size).toBeGreaterThan(500);
    expect(keys.has('Delete chat')).toBe(true);
  });
});

describe('locale files', () => {
  it('exist for every language but English, and only for them', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
    expect(files).toEqual(translated.map((l) => l.code).sort());
  });
});

describe.each(translated.map((l) => l.code))('%s', (code) => {
  const cat = read(code);
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

  it('has exactly the source keys', () => {
    const missing = [...keys.keys()].filter((k) => !(k in cat));
    const extra = Object.keys(cat).filter((k) => !keys.has(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('keeps every placeholder and translates every entry', () => {
    const bad: string[] = [];
    for (const [key, info] of keys) {
      const v = cat[key];
      if (v === undefined) continue;
      if (!info.plural) {
        if (typeof v !== 'string' || !v.trim()) bad.push(`${key}: not a non-empty string`);
        else if (placeholders(v).join() !== placeholders(key).join()) bad.push(`${key}: {${placeholders(v)}} instead of {${placeholders(key)}}`);
        continue;
      }
      if (typeof v !== 'object' || v === null) {
        bad.push(`${key}: plural key needs an object of forms`);
        continue;
      }
      // Each form keeps the other placeholders; {count} may be left out ("one tool", "no tools").
      const english = placeholders(info.plural.one + info.plural.other);
      const needed = english.filter((p) => p !== 'count');
      for (const [form, text] of Object.entries(v)) {
        if (typeof text !== 'string' || !text.trim()) bad.push(`${key} [${form}]: empty`);
        else {
          const got = placeholders(text);
          if (got.some((p) => !english.includes(p)) || needed.some((p) => !got.includes(p))) bad.push(`${key} [${form}]: {${got}} instead of {${english}}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('has the plural forms the language needs', () => {
    const bad: string[] = [];
    for (const [key, info] of keys) {
      const v = cat[key];
      if (!info.plural || typeof v !== 'object' || v === null) continue;
      const missing = categories.filter((c) => !(c in v));
      const unknown = Object.keys(v).filter((c) => !(categories as string[]).includes(c));
      if (missing.length || unknown.length) bad.push(`${key}: missing [${missing}], not used [${unknown}]`);
    }
    expect(bad).toEqual([]);
  });
});
