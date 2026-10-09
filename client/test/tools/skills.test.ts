import { zipSync, strToU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { FacetDb, setDb } from '../../src/data/db';
import { SkillImportException, SkillParser, SkillRepository } from '../../src/tools/skills';
import { empty, FakeNet, installPlatform } from '../mcp/fakes';

let net: FakeNet;
let changes: number;
let skills: SkillRepository;

beforeEach(() => {
  setDb(new FacetDb('test-' + Math.random()));
  net = new FakeNet();
  installPlatform(net);
  changes = 0;
  skills = new SkillRepository(() => changes++);
});

describe('SkillParser', () => {
  it('parses frontmatter with a folded description', () => {
    const md = [
      '---',
      'name: PDF Tools',
      'description: >',
      '  Extract text from PDFs.',
      '  Use when the user shares a PDF.',
      'license: MIT',
      '---',
      '# PDF tools',
      '',
      'Step one.',
    ].join('\n');
    const p = SkillParser.parse(md);
    expect(p.name).toBe('pdf-tools');
    expect(p.description).toBe('Extract text from PDFs. Use when the user shares a PDF.');
    expect(p.body.startsWith('# PDF tools')).toBe(true);
  });

  it('uses the heading and first line without frontmatter', () => {
    const p = SkillParser.parse('# Weekly Report\n\nSummarize the week in five bullets.');
    expect(p.name).toBe('weekly-report');
    expect(p.description).toBe('Summarize the week in five bullets.');
  });

  it('handles CRLF, a BOM, quoted values and literal blocks', () => {
    const p = SkillParser.parse('\uFEFF---\r\nname: "Data \\"Wrangler\\""\r\ndescription: |\r\n  Line one\r\n  Line two\r\n---\r\nDo it.');
    expect(p.name).toBe('data-wrangler');
    expect(p.description).toBe('Line one\nLine two');
    expect(p.body).toBe('Do it.');
    expect(SkillParser.parseFrontmatter("a: 'x'\nb: \"\nc:")).toEqual({ a: 'x', b: '"', c: '' });
  });

  it('falls back to a default description and refuses empty skills', () => {
    expect(SkillParser.parse('# Only heading').description).toBe('Use when the task matches only-heading.');
    expect(() => SkillParser.parse('---\nname: x\n---\n   ')).toThrow(SkillImportException);
  });

  it('makes valid slugs', () => {
    expect(SkillParser.slug('  Hello, World! ')).toBe('hello-world');
    expect(SkillParser.slug('Ünïcode only')).toBe('n-code-only');
    expect(SkillParser.slug('!!!')).toBe('skill');
    expect(SkillParser.slug('a'.repeat(80))).toHaveLength(64);
  });
});

describe('SkillRepository', () => {
  it('saves with unique names and keeps the source link on edit', async () => {
    const a = await skills.save({ name: 'Meeting Notes', description: ' Notes. ', instructions: ' Do. ', sourceUrl: 'https://x.test/SKILL.md' });
    expect(a).toMatchObject({ name: 'meeting-notes', description: 'Notes.', instructions: 'Do.', enabled: true, alwaysOn: false, dirty: 1, deleted: 0 });
    const b = await skills.save({ name: 'meeting notes', description: 'd', instructions: 'i' });
    expect(b.name).toBe('meeting-notes-2');
    const edited = await skills.save({ id: a.id, name: 'meeting-notes', description: 'New', instructions: 'i', alwaysOn: true });
    expect(edited.id).toBe(a.id);
    expect(edited.name).toBe('meeting-notes');
    expect(edited.sourceUrl).toBe('https://x.test/SKILL.md');
    expect(edited.createdAt).toBe(a.createdAt);
    expect((await skills.all()).map((s) => s.name)).toEqual(['meeting-notes', 'meeting-notes-2']);
    expect(changes).toBe(3);
  });

  it('toggles and soft-deletes', async () => {
    const s = await skills.save({ name: 'x', description: 'd', instructions: 'i', resources: [{ path: 'a.md', content: 'A' }] });
    await skills.setEnabled(s.id, false);
    await skills.setAlwaysOn(s.id, true);
    expect(await skills.get(s.id)).toMatchObject({ enabled: false, alwaysOn: true });
    expect(skills.resources((await skills.get(s.id))!)).toEqual([{ path: 'a.md', content: 'A' }]);
    await skills.delete(s.id);
    expect(await skills.get(s.id)).toMatchObject({ deleted: 1, dirty: 1, instructions: '', resourcesJson: '[]' });
    expect(await skills.all()).toEqual([]);
  });

  it('imports a zip with SKILL.md in a folder and its text files', async () => {
    const zip = zipSync({
      'my-skill/SKILL.md': strToU8('---\nname: Zipped\ndescription: From a zip.\n---\nUse references/guide.md.'),
      'my-skill/references/guide.md': strToU8('# Guide'),
      'my-skill/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'my-skill/data.bin': new Uint8Array([1, 0, 2]),
      'my-skill/.hidden/secret.md': strToU8('no'),
      '__MACOSX/my-skill/._SKILL.md': strToU8('junk'),
      'other/notes.md': strToU8('outside the skill folder'),
      'my-skill/big.md': strToU8('x'.repeat(SkillRepository.MAX_FILE + 1)),
    });
    const s = await skills.importZip(zip, 'https://x.test/skill.zip');
    expect(s.name).toBe('zipped');
    expect(s.description).toBe('From a zip.');
    expect(s.sourceUrl).toBe('https://x.test/skill.zip');
    expect(skills.resources(s)).toEqual([{ path: 'references/guide.md', content: '# Guide' }]);
  });

  it('names a zipped skill after its folder and rejects archives without SKILL.md', async () => {
    const s = await skills.importZip(zipSync({ 'travel-helper/skill.md': strToU8('Plan trips well.') }));
    expect(s.name).toBe('travel-helper');
    await expect(skills.importZip(zipSync({ 'README.md': strToU8('hi') }))).rejects.toThrow('No SKILL.md found in that archive.');
    await expect(skills.importZip(new Uint8Array([0x50, 0x4b, 1, 2, 3]))).rejects.toThrow(SkillImportException);
  });

  it('imports picked files by name or content', async () => {
    expect((await skills.importFile('C:\\Downloads\\Release Notes.md', strToU8('Write release notes.'))).name).toBe('release-notes');
    expect((await skills.importFile('download', zipSync({ 'SKILL.md': strToU8('# Root Skill\n\nBody.') }))).name).toBe('root-skill');
  });

  it('imports from links, converting GitHub blob URLs to raw', async () => {
    net.handler = (req) => {
      if (req.url === 'https://raw.githubusercontent.com/acme/skills/main/pdf-tools/SKILL.md') return new Response('Read PDFs carefully.');
      return empty(404);
    };
    const s = await skills.importUrl('https://github.com/acme/skills/blob/main/pdf-tools/SKILL.md');
    expect(s.name).toBe('pdf-tools');
    expect(s.sourceUrl).toBe('https://github.com/acme/skills/blob/main/pdf-tools/SKILL.md');
    expect(net.requests[0].headers.get('User-Agent')).toBe('Facet');
    await expect(skills.importUrl('https://x.test/missing.md')).rejects.toThrow("Couldn't download the skill (HTTP 404).");
  });

  it('explains blocked downloads on the website', async () => {
    installPlatform(net, { corsLimited: true, kind: 'web' });
    net.handler = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(skills.importUrl('https://x.test/SKILL.md')).rejects.toThrow('The site may not allow downloads from web browsers');
  });

  it('offers three starter skills that parse as skills', () => {
    expect(SkillRepository.EXAMPLES.map((e) => e.name)).toEqual(['meeting-notes', 'code-review', 'trip-planner']);
    for (const e of SkillRepository.EXAMPLES) expect(e.body.startsWith('# ')).toBe(true);
  });
});
