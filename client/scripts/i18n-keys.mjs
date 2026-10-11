#!/usr/bin/env node
/**
 * Lists the interface's translation keys: the English text passed to t(), tn(), msg() and tRich()
 * in src/ (see src/i18n/index.ts). The English key set is generated from the source, never kept
 * by hand; test/i18n/catalogs.test.ts compares every locale catalog against it.
 *
 *   node scripts/i18n-keys.mjs                 all keys as JSON (key → English, or { one, other } for plurals)
 *   node scripts/i18n-keys.mjs --locations     key → files that use it
 *   node scripts/i18n-keys.mjs --missing de    keys the de catalog lacks, as JSON (to hand to a translator)
 *   node scripts/i18n-keys.mjs --stale de      keys in the de catalog that the source no longer uses
 *
 * Exits with status 1 and lists the problems when a call's text isn't a string literal (the key
 * can't be known) or a key is used both as plain text and as a plural.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CALLS = new Set(['t', 'tn', 'msg', 'tRich']);

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The text of a string literal or a template literal without expressions; null otherwise. */
function literal(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
  return null;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const k in node) {
    if (k === 'start' || k === 'end') continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, visit);
  }
}

function lineOf(code, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i++) if (code.charCodeAt(i) === 10) line++;
  return line;
}

/** Only files that import the i18n module are scanned, so a local `t` elsewhere isn't mistaken for it. */
function importsI18n(ast) {
  return ast.body.some((s) => s.type === 'ImportDeclaration' && /(^|\/)i18n(\/index|\/rich)?$|^\.\/(index|rich)$/.test(s.source.value));
}

/**
 * Scans src/ and returns { keys, problems }: keys maps each key to { plural: null | { one, other },
 * files: string[] } in first-seen order.
 */
export function extractKeys(root = ROOT) {
  const src = join(root, 'src');
  const keys = new Map();
  const problems = [];
  const add = (key, plural, where) => {
    const file = where.slice(0, where.lastIndexOf(':'));
    const prev = keys.get(key);
    if (!prev) {
      keys.set(key, { plural, files: [file] });
      return;
    }
    if (!!prev.plural !== !!plural) problems.push(`${where}: "${key}" is used both as plain text and as a plural`);
    else if (plural && prev.plural.one !== plural.one) problems.push(`${where}: plural "${key}" has two different singular forms`);
    if (!prev.files.includes(file)) prev.files.push(file);
  };
  for (const file of sourceFiles(src).sort()) {
    const rel = relative(root, file).replace(/\\/g, '/');
    if (rel === 'src/i18n/index.ts' || rel === 'src/i18n/rich.tsx') continue;
    const code = readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parseAst(code, { lang: file.endsWith('x') ? 'tsx' : 'ts' }, file);
    } catch (e) {
      problems.push(`${rel}: can't parse (${e.message})`);
      continue;
    }
    if (!importsI18n(ast)) continue;
    walk(ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !CALLS.has(node.callee.name)) return;
      const name = node.callee.name;
      const where = `${rel}:${lineOf(code, node.start)}`;
      if (name === 'tn') {
        const one = literal(node.arguments[0]);
        const other = literal(node.arguments[1]);
        if (one === null || other === null) problems.push(`${where}: tn() needs string literals for both English forms`);
        else add(other, { one, other }, where);
        return;
      }
      const text = literal(node.arguments[0]);
      if (text === null) problems.push(`${where}: ${name}() needs a string literal (use msg() + tm() for text chosen at run time)`);
      else if (text.trim() === '') problems.push(`${where}: ${name}() with empty text`);
      else add(text, null, where);
    });
  }
  return { keys, problems };
}

/** Keys as an English catalog: key → text, or { one, other } for plurals. */
export function englishCatalog(keys) {
  const out = {};
  for (const [k, v] of keys) out[k] = v.plural ? { one: v.plural.one, other: v.plural.other } : k;
  return out;
}

function readCatalog(code) {
  return JSON.parse(readFileSync(join(ROOT, 'src', 'i18n', 'locales', `${code}.json`), 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const { keys, problems } = extractKeys();
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s).`);
    process.exit(1);
  }
  let out;
  if (args[0] === '--locations') {
    out = Object.fromEntries([...keys].map(([k, v]) => [k, v.files]));
  } else if (args[0] === '--missing' && args[1]) {
    const cat = readCatalog(args[1]);
    out = Object.fromEntries(Object.entries(englishCatalog(keys)).filter(([k]) => !(k in cat)));
  } else if (args[0] === '--stale' && args[1]) {
    const cat = readCatalog(args[1]);
    out = Object.keys(cat).filter((k) => !keys.has(k));
  } else {
    out = englishCatalog(keys);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
