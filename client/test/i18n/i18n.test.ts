import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Dates, Format } from '../../src/core/format';
import {
  LOCALES,
  direction,
  format,
  isLocale,
  loadCatalog,
  locale,
  matchLocale,
  msg,
  resolveLocale,
  sentences,
  setLocale,
  t,
  tm,
  tn,
} from '../../src/i18n';
import { tRich } from '../../src/i18n/rich';
import { RemoteError, remoteError } from '../../src/remote/protocol';

afterEach(() => setLocale('en'));

describe('t', () => {
  it('returns the English source without a catalog', () => {
    expect(t('Delete chat')).toBe('Delete chat');
  });

  it('uses the catalog and falls back to English for missing or empty entries', () => {
    setLocale('de', { 'Delete chat': 'Chat löschen', Empty: '' });
    expect(t('Delete chat')).toBe('Chat löschen');
    expect(t('Not translated yet')).toBe('Not translated yet');
    expect(t('Empty')).toBe('Empty');
  });

  it('fills placeholders, also when the translation reorders them', () => {
    expect(t('Rename {name}', { name: 'Work' })).toBe('Rename Work');
    setLocale('ja', { '{a} then {b}': '{b}の後に{a}' });
    expect(t('{a} then {b}', { a: 'x', b: 'y' })).toBe('yの後にx');
  });

  it('leaves unknown placeholders alone and formats numbers for the locale', () => {
    expect(format('{x} and {y}', { x: 1 })).toBe('1 and {y}');
    expect(t('{n} files', { n: 12345 })).toBe('12,345 files');
    setLocale('de');
    expect(t('{n} files', { n: 12345 })).toBe('12.345 files');
  });

  it('isolates inserted text in right-to-left languages', () => {
    setLocale('ar', { 'Open {path}?': 'فتح {path}؟' });
    expect(t('Open {path}?', { path: 'C:\\notes.txt' })).toBe('فتح \u2068C:\\notes.txt\u2069؟');
    setLocale('de', { 'Open {path}?': '{path} öffnen?' });
    expect(t('Open {path}?', { path: 'a.txt' })).toBe('a.txt öffnen?');
  });
});

describe('tn', () => {
  it('picks the English form by count', () => {
    expect(tn('{count} tool', '{count} tools', 1)).toBe('1 tool');
    expect(tn('{count} tool', '{count} tools', 0)).toBe('0 tools');
    expect(tn('{count} tool', '{count} tools', 3)).toBe('3 tools');
  });

  it('uses the plural category of the active locale', () => {
    setLocale('ru', { '{count} tools': { one: '{count} инструмент', few: '{count} инструмента', many: '{count} инструментов', other: '{count} инструмента' } });
    expect(tn('{count} tool', '{count} tools', 1)).toBe('1 инструмент');
    expect(tn('{count} tool', '{count} tools', 3)).toBe('3 инструмента');
    expect(tn('{count} tool', '{count} tools', 5)).toBe('5 инструментов');
    expect(tn('{count} tool', '{count} tools', 21)).toBe('21 инструмент');
  });

  it('handles Arabic zero/two and forms without the number', () => {
    setLocale('ar', { '{count} tools': { zero: 'لا أدوات', one: 'أداة واحدة', two: 'أداتان', few: '{count} أدوات', many: '{count} أداة', other: '{count} أداة' } });
    expect(tn('{count} tool', '{count} tools', 0)).toBe('لا أدوات');
    expect(tn('{count} tool', '{count} tools', 2)).toBe('أداتان');
    expect(tn('{count} tool', '{count} tools', 3)).toBe('٣ أدوات'.replace('٣', new Intl.NumberFormat('ar').format(3)));
  });

  it('falls back to "other", then to English', () => {
    setLocale('ja', { '{count} tools': { other: '{count} 個のツール' } });
    expect(tn('{count} tool', '{count} tools', 1)).toBe('1 個のツール');
    setLocale('fr', {});
    expect(tn('{count} tool', '{count} tools', 1)).toBe('1 tool');
  });

  it('fills other placeholders too', () => {
    expect(tn('{count} skill in {name}', '{count} skills in {name}', 2, { name: 'Docs' })).toBe('2 skills in Docs');
  });
});

describe('msg and tm', () => {
  it('marks text now and translates it later', () => {
    const label = msg('Square');
    expect(label).toBe('Square');
    setLocale('fr', { Square: 'Carré' });
    expect(tm(label)).toBe('Carré');
  });
});

describe('errors between devices', () => {
  it('keep English for the wire and models, and show the interface language', () => {
    setLocale('de', { '{pc} didn’t answer in time.': '{pc} hat nicht rechtzeitig geantwortet.', 'That PC is offline.': 'Dieser PC ist offline.' });
    const e = remoteError('timeout', msg('{pc} didn’t answer in time.'), { pc: 'OFFICE' });
    expect(e.english).toBe('OFFICE didn’t answer in time.');
    expect(e.message).toBe('OFFICE hat nicht rechtzeitig geantwortet.');
    // An English message from another device is translated where Facet knows it.
    expect(RemoteError.from('offline', 'That PC is offline.').message).toBe('Dieser PC ist offline.');
    expect(RemoteError.from('failed', 'ENOENT: no such file').message).toBe('ENOENT: no such file');
  });
});

describe('tRich', () => {
  it('puts elements into placeholders', () => {
    setLocale('de', { 'Read the {terms} first.': 'Lies zuerst die {terms}.' });
    const html = renderToStaticMarkup(createElement('p', null, tRich('Read the {terms} first.', { terms: createElement('a', { href: '#t' }, 'Bedingungen') })));
    expect(html).toBe('<p>Lies zuerst die <a href="#t">Bedingungen</a>.</p>');
  });
});

describe('locale matching', () => {
  it('matches exactly, then by language', () => {
    expect(matchLocale(['de-AT', 'en'])).toBe('de');
    expect(matchLocale(['pt-PT'])).toBe('pt-BR');
    expect(matchLocale(['pt'])).toBe('pt-BR');
    expect(matchLocale(['zh'])).toBe('zh-CN');
    expect(matchLocale(['zh-TW'])).toBe('zh-CN');
    expect(matchLocale(['zh-cn'])).toBe('zh-CN');
    expect(matchLocale(['en-GB', 'fr'])).toBe('en');
    expect(matchLocale(['ar-EG'])).toBe('ar');
  });

  it('skips unsupported languages and defaults to English', () => {
    expect(matchLocale(['nl-NL', 'ja-JP'])).toBe('ja');
    expect(matchLocale(['nl', 'sv'])).toBe('en');
    expect(matchLocale([])).toBe('en');
    expect(matchLocale(undefined)).toBe('en');
  });

  it('resolves a stored preference', () => {
    expect(resolveLocale('auto', ['ko-KR'])).toBe('ko');
    expect(resolveLocale('it', ['ko-KR'])).toBe('it');
    expect(resolveLocale('xx', ['es-MX'])).toBe('es');
    expect(resolveLocale(undefined, [])).toBe('en');
  });

  it('knows each language and its direction', () => {
    expect(LOCALES).toHaveLength(20);
    expect(isLocale('ur')).toBe(true);
    expect(isLocale('pt')).toBe(false);
    expect(LOCALES.filter((l) => direction(l.code) === 'rtl').map((l) => l.code)).toEqual(['ar', 'ur']);
  });

  it('loads a catalog lazily, and none for English', async () => {
    expect(await loadCatalog('en')).toEqual({});
    const de = await loadCatalog('de');
    expect(typeof de['Delete chat']).toBe('string');
  });
});

describe('formatting in the interface language', () => {
  it('joins sentences without spaces in Chinese and Japanese', () => {
    expect(sentences('A.', 'B.')).toBe('A. B.');
    setLocale('ja');
    expect(sentences('キーが無効です。', 'プロバイダーで確認してください。')).toBe('キーが無効です。プロバイダーで確認してください。');
  });

  it('formats dates and durations for the active locale', () => {
    const now = new Date(2026, 9, 11, 12, 0).getTime();
    expect(Dates.bucketLabel(now, now)).toBe('Today');
    expect(Dates.relative(now - 5 * 60_000, now)).toBe(new Intl.RelativeTimeFormat('en', { style: 'short' }).format(-5, 'minute'));
    setLocale('de', { Today: 'Heute' });
    expect(locale()).toBe('de');
    expect(Dates.bucketLabel(now, now)).toBe('Heute');
    expect(Dates.relative(now - 5 * 60_000, now)).toBe('vor 5 Min.');
    expect(Format.seconds(5_000)).toBe(new Intl.NumberFormat('de', { style: 'unit', unit: 'second', unitDisplay: 'narrow' }).format(5));
  });
});
