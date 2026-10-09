import assert from 'node:assert/strict';
import { mkdtempSync, promises as fsp, rmSync, utimesSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { applyEdit, decodeText, detectEol, editTextFile, encodeText, formatRead, listDirectory, numberLine, readTextFile, splitLines, writeTextFile } from '../src/computer/files';
import { globFiles, globToRegex, splitGlobBase } from '../src/computer/glob';
import { compilePattern, fileFilter, grepSearch } from '../src/computer/grep';
import { ComputerService } from '../src/computer';
import { cleanOutput, displayPath, isBinaryPath, looksBinary, resolvePath, shorten, ToolError, truncateMiddle } from '../src/computer/util';
import { OutputBuffer, formatRunResult, runCommand } from '../src/computer/shell';

let tmp: string;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'facet-test-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function file(rel: string, content: string | Buffer, mtime?: Date): string {
  const p = path.join(tmp, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

// ---------------------------------------------------------------------------------------------

describe('edit_file replacement', () => {
  it('replaces a unique string', () => {
    const r = applyEdit('alpha\nbeta\ngamma\n', 'beta', 'BETA');
    assert.equal(r.text, 'alpha\nBETA\ngamma\n');
    assert.equal(r.replacements, 1);
    assert.match(r.diff, /^@@ -1,3 \+1,3 @@/);
    assert.match(r.diff, /\n-beta\n\+BETA\n/);
  });

  it('treats $ patterns in new_string literally', () => {
    assert.equal(applyEdit('a X b', 'X', '$& $1 $$').text, 'a $& $1 $$ b');
  });

  it('errors when old_string is missing, with a whitespace hint', () => {
    assert.throws(() => applyEdit('foo\n', 'bar', 'baz'), (e: unknown) => e instanceof ToolError && /not found/.test(e.message));
    assert.throws(() => applyEdit('  foo();\n', 'foo(); ', 'x'), /whitespace/);
  });

  it('errors when old_string is not unique unless replace_all', () => {
    assert.throws(() => applyEdit('x\nx\n', 'x', 'y'), /appears 2 times/);
    const r = applyEdit('x\nx\nx\nx\nx\n', 'x', 'y', true);
    assert.equal(r.text, 'y\ny\ny\ny\ny\n');
    assert.equal(r.replacements, 5);
    assert.match(r.diff, /and 2 more replacements/);
  });

  it('rejects empty and identical strings', () => {
    assert.throws(() => applyEdit('abc', '', 'x'), /empty/);
    assert.throws(() => applyEdit('abc', 'b', 'b'), /same/);
  });

  it('applies LF edits to a CRLF file and keeps CRLF', () => {
    const text = 'one\r\ntwo\r\nthree\r\n';
    assert.equal(detectEol(text), '\r\n');
    const r = applyEdit(text, 'one\ntwo\n', 'uno\ndos\ndos-bis\n');
    assert.equal(r.text, 'uno\r\ndos\r\ndos-bis\r\nthree\r\n');
    // A single-line match with multi-line LF replacement still gets CRLF.
    const r2 = applyEdit(text, 'two', 'zwei\ndrei');
    assert.equal(r2.text, 'one\r\nzwei\r\ndrei\r\nthree\r\n');
  });

  it('applies CRLF edits to an LF file and keeps LF', () => {
    const r = applyEdit('a\nb\nc\n', 'a\r\nb', 'A\r\nB');
    assert.equal(r.text, 'A\nB\nc\n');
  });

  it('shows deletions and insertions in the diff', () => {
    const del = applyEdit('a\nb\nc\nd\n', 'c\n', '');
    assert.equal(del.text, 'a\nb\nd\n');
    assert.match(del.diff, /\n-c\n d$/);
    assert.ok(!/^\+/m.test(del.diff));
    const ins = applyEdit('a\nb\n', 'a\n', 'a\nnew\n');
    assert.match(ins.diff, /\+new/);
    assert.ok(!/^-/m.test(ins.diff));
  });

  it('edits files on disk, keeping CRLF, BOM and UTF-16', async () => {
    const crlf = file('edit/crlf.txt', '\ufeffline 1\r\nline 2\r\n');
    await editTextFile(crlf, 'crlf.txt', 'line 2\n', 'line two\nline three\n', false);
    const buf = readFileSync(crlf);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(buf.subarray(3).toString('utf8'), 'line 1\r\nline two\r\nline three\r\n');

    const u16 = file('edit/utf16.txt', encodeText('hello wörld\r\n', 'utf16le'));
    await editTextFile(u16, 'utf16.txt', 'wörld', 'world', false);
    assert.deepEqual(decodeText(readFileSync(u16)), { text: 'hello world\r\n', encoding: 'utf16le' });
  });
});

// ---------------------------------------------------------------------------------------------

describe('read_file', () => {
  it('numbers lines like cat -n', () => {
    assert.equal(numberLine(1, 'hello'), '     1\thello');
    assert.equal(numberLine(123456, 'x'), '123456\tx');
    const long = numberLine(2, 'y'.repeat(2500));
    assert.ok(long.startsWith('     2\t' + 'y'.repeat(2000) + '…'));
    assert.match(long, /line truncated: 2,500 characters/);
  });

  it('splits lines without a phantom last line', () => {
    assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
    assert.deepEqual(splitLines('a\r\nb'), ['a', 'b']);
    assert.deepEqual(splitLines(''), []);
  });

  it('reads with offset and limit and says when there is more', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const p = file('read/thirty.txt', lines);
    const all = await readTextFile(p, 'thirty.txt');
    assert.ok(all.content.startsWith('     1\tline 1\n     2\tline 2'));
    assert.ok(!all.content.includes('Showing'));
    const part = await readTextFile(p, 'thirty.txt', 10, 5);
    assert.equal(part.content.split('\n')[0], '    10\tline 10');
    assert.match(part.content, /\[Showing lines 10-14 of 30 \(file size [\d.]+ B\)\. Use offset 15 to read on\.\]/);
    await assert.rejects(readTextFile(p, 'thirty.txt', 31), /only 30 lines/);
  });

  it('caps the total size of one read', () => {
    const lines = Array.from({ length: 100 }, () => 'z'.repeat(1000));
    const out = formatRead({ lines, totalLines: 100 }, 1, 100_000, 10_000);
    assert.ok(out.length < 11_000);
    assert.match(out, /Use offset \d+ to read on/);
  });

  it('handles empty files', async () => {
    assert.equal((await readTextFile(file('read/empty.txt', ''), 'empty.txt')).content, '(empty file)');
  });

  it('refuses binary files', async () => {
    const bin = await readTextFile(file('read/blob.dat2', Buffer.from([1, 2, 0, 3, 4])), 'blob.dat2');
    assert.equal(bin.refused, true);
    assert.match(bin.content, /binary/);
    const png = await readTextFile(file('read/x.png', 'not really a png'), 'x.png');
    assert.equal(png.refused, true);
    assert.ok(isBinaryPath('a/b/c.EXE'));
    assert.ok(!isBinaryPath('a/b/c.ts'));
    assert.ok(looksBinary(Buffer.from([0x41, 0x00, 0x42])));
    assert.ok(!looksBinary(Buffer.from([0xff, 0xfe, 0x41, 0x00])));
  });

  it('reads UTF-16 files (what Windows PowerShell 5.1 writes)', async () => {
    const p = file('read/ps.txt', encodeText('first\r\nsecond\r\n', 'utf16le'));
    const r = await readTextFile(p, 'ps.txt');
    assert.equal(r.content, '     1\tfirst\n     2\tsecond');
  });

  it('refuses folders', async () => {
    await assert.rejects(readTextFile(tmp, 'tmp'), /is a folder/);
  });
});

describe('write_file and list_directory', () => {
  it('creates parent folders and reports created vs overwritten', async () => {
    const p = path.join(tmp, 'write', 'deep', 'new.txt');
    assert.deepEqual(await writeTextFile(p, 'héllo'), { bytes: 6, created: true });
    assert.deepEqual(await writeTextFile(p, 'x'), { bytes: 1, created: false });
    assert.equal(readFileSync(p, 'utf8'), 'x');
  });

  it('lists folders first', async () => {
    file('list/b.txt', 'b');
    file('list/a.txt', 'aaa');
    mkdirSync(path.join(tmp, 'list', 'zdir'), { recursive: true });
    const out = await listDirectory(path.join(tmp, 'list'), 'list');
    const lines = out.split('\n');
    assert.match(lines[0], /\(1 folder, 2 files\)$/);
    assert.match(lines[1], /^dir .* zdir\/$/);
    assert.match(lines[2], /^file .*3 B  a\.txt$/);
    assert.match(lines[3], /b\.txt$/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('glob', () => {
  it('matches globstars, stars, braces, classes and ?', () => {
    const re = globToRegex('**/*.ts', false);
    assert.ok(re.test('a.ts'));
    assert.ok(re.test('src/deep/x.ts'));
    assert.ok(!re.test('a.tsx'));
    assert.ok(!globToRegex('*.ts', false).test('src/a.ts'));
    assert.ok(globToRegex('src/**/*.{js,jsx}', false).test('src/a/b/c.jsx'));
    assert.ok(globToRegex('src/**/*.{js,jsx}', false).test('src/c.js'));
    assert.ok(!globToRegex('src/**/*.{js,jsx}', false).test('lib/c.js'));
    assert.ok(globToRegex('file?.[ch]', false).test('file1.c'));
    assert.ok(!globToRegex('file?.[ch]', false).test('file12.c'));
    assert.ok(globToRegex('[!a]*', false).test('bcd'));
    assert.ok(!globToRegex('[!a]*', false).test('abc'));
    assert.ok(globToRegex('docs/**', false).test('docs/a/b.md'));
    assert.ok(globToRegex('a.(x)+', false).test('a.(x)+'));
    assert.ok(globToRegex('README.MD', true).test('readme.md'));
    assert.throws(() => globToRegex('{a,b', false), /unclosed/);
  });

  it('splits the literal base off a pattern', () => {
    assert.deepEqual(splitGlobBase('src/lib/**/*.ts'), { base: 'src/lib', rest: '**/*.ts' });
    assert.deepEqual(splitGlobBase('*.md'), { base: '', rest: '*.md' });
    assert.deepEqual(splitGlobBase('docs/readme.md'), { base: 'docs', rest: 'readme.md' });
  });

  it('finds files newest first and skips node_modules unless named', async () => {
    const t0 = new Date('2024-01-01T00:00:00Z');
    const t1 = new Date('2025-01-01T00:00:00Z');
    file('g/old.ts', 'x', t0);
    file('g/sub/new.ts', 'x', t1);
    file('g/sub/skip.js', 'x');
    file('g/node_modules/pkg/index.ts', 'x');
    file('g/.git/x.ts', 'x');
    const root = path.join(tmp, 'g');
    const r = await globFiles('**/*.ts', root);
    assert.deepEqual(
      r.matches.map((m) => path.relative(root, m.abs).split(path.sep).join('/')),
      ['sub/new.ts', 'old.ts'],
    );
    const nm = await globFiles('node_modules/**/*.ts', root);
    assert.equal(nm.matches.length, 1);
    const top = await globFiles('*.ts', root);
    assert.equal(top.matches.length, 1);
    const literal = await globFiles('sub/new.ts', root);
    assert.equal(literal.matches.length, 1);
    await assert.rejects(globFiles('**/*.ts', path.join(tmp, 'nope')), /doesn't exist/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('grep', () => {
  let root: string;
  before(() => {
    root = path.join(tmp, 'grep');
    file('grep/a.ts', 'const x = 1;\n// TODO: fix\nconst y = 2;\nconst z = 3;\n// todo lower\n', new Date('2025-01-01'));
    file('grep/b.md', 'nothing here\nTODO in markdown\n', new Date('2024-01-01'));
    file('grep/bin.dat2', Buffer.from('TODO\0binary'));
    file('grep/node_modules/m/index.js', 'TODO hidden\n');
    file('grep/big.txt', 'TODO\n' + 'x'.repeat(2 * 1024 * 1024 + 10));
  });

  it('lists matching files newest first, skipping binary, big and node_modules files', async () => {
    const r = await grepSearch({ pattern: 'TODO', root, cwd: root });
    assert.equal(r.isError, false);
    assert.equal(r.content.split('\n').slice(0, 3).join('\n'), 'Found 2 files:\na.ts\nb.md');
    assert.match(r.content, /Skipped 1 file over 2 MB/);
  });

  it('shows content with line numbers and context', async () => {
    const r = await grepSearch({ pattern: 'TODO', root, cwd: root, mode: 'content', glob: '*.ts', context: 1 });
    assert.equal(r.content, '1 matching line in 1 file:\na.ts-1-const x = 1;\na.ts:2:// TODO: fix\na.ts-3-const y = 2;');
  });

  it('counts, ignores case and applies head_limit', async () => {
    const c = await grepSearch({ pattern: 'todo', root, cwd: root, mode: 'count', ignoreCase: true, glob: '*.ts' });
    assert.equal(c.content, '2 matching lines in 1 file:\na.ts:2');
    const h = await grepSearch({ pattern: 'const', root, cwd: root, mode: 'content', headLimit: 2 });
    assert.match(h.content, /a\.ts:1:const x = 1;\na\.ts:3:const y = 2;/);
    assert.match(h.content, /Showing the first 2 matches/);
  });

  it('searches a single file and reports no matches', async () => {
    const r = await grepSearch({ pattern: 'markdown', root: path.join(root, 'b.md'), cwd: root, mode: 'content' });
    assert.match(r.content, /b\.md:2:TODO in markdown/);
    const none = await grepSearch({ pattern: 'zzz', root, cwd: root });
    assert.match(none.content, /^No matches for "zzz"/);
  });

  it('rejects invalid regular expressions', () => {
    assert.throws(() => compilePattern('foo('), (e: unknown) => e instanceof ToolError && /Invalid regular expression/.test(e.message));
  });

  it('filters by file name or path', () => {
    const byName = fileFilter('*.{ts,tsx}')!;
    assert.ok(byName('src/deep/a.tsx'));
    assert.ok(!byName('src/a.js'));
    const byPath = fileFilter('src/**/*.ts')!;
    assert.ok(byPath('src/x/a.ts'));
    assert.ok(!byPath('lib/a.ts'));
  });
});

// ---------------------------------------------------------------------------------------------

describe('output helpers', () => {
  it('truncates the middle and keeps head and tail', () => {
    const s = 'H'.repeat(20000) + 'M'.repeat(20000) + 'T'.repeat(20000);
    const t = truncateMiddle(s, 30000);
    assert.ok(t.length <= 30100);
    assert.ok(t.startsWith('HHH'));
    assert.ok(t.endsWith('TTT'));
    assert.match(t, /characters omitted/);
    assert.equal(truncateMiddle('short', 30000), 'short');
  });

  it('bounds streamed output', () => {
    const b = new OutputBuffer(100);
    for (let i = 0; i < 1000; i++) b.push('0123456789');
    const s = b.toString();
    assert.equal(b.length, 10000);
    assert.ok(s.length < 400);
    assert.ok(s.startsWith('0123456789'));
    assert.match(s, /characters omitted/);
  });

  it('cleans terminal output', () => {
    assert.equal(cleanOutput('\x1b[32mgreen\x1b[0m\r\n'), 'green\n');
    assert.equal(cleanOutput('10%\r50%\r100%\ndone'), '100%\ndone');
    assert.equal(cleanOutput('ab\bc'), 'ac');
    assert.equal(cleanOutput('\x1b]0;title\x07text'), 'text');
  });

  it('formats command results', () => {
    const out = formatRunResult({ stdout: 'out\n', stderr: 'warn\n', exitCode: 2, timedOut: false, cancelled: false, durationMs: 1500 }, 120000);
    assert.equal(out, 'out\n[stderr]\nwarn\n[exit code 2 · 1.5 s]');
    assert.match(formatRunResult({ stdout: '', stderr: '', exitCode: null, timedOut: true, cancelled: false, durationMs: 5000 }, 5000), /^\(no output\)\n\[timed out after 5\.0 s/);
  });

  it('resolves and displays paths', () => {
    const cwd = path.join(tmp, 'work');
    assert.equal(resolvePath('src/a.ts', cwd), path.join(cwd, 'src', 'a.ts'));
    assert.equal(resolvePath('', cwd), cwd);
    assert.equal(resolvePath('~', cwd), os.homedir());
    assert.equal(resolvePath('"quoted.txt"', cwd), path.join(cwd, 'quoted.txt'));
    if (process.platform === 'win32') assert.equal(resolvePath('/c/Windows', cwd), 'C:\\Windows');
    assert.equal(displayPath(path.join(cwd, 'src', 'a.ts'), cwd), 'src/a.ts');
    assert.equal(displayPath(cwd, cwd), '.');
    assert.equal(displayPath(path.join(tmp, 'other'), cwd), path.join(tmp, 'other'));
    assert.equal(shorten('x'.repeat(100), 10), 'xxxxxxxxx…');
  });
});

// ---------------------------------------------------------------------------------------------

describe('commands', () => {
  const ps = process.platform === 'win32';
  it('runs a command and reports the exit code', async () => {
    const r = await runCommand({ command: ps ? 'Write-Output "héllo"; exit 3' : 'echo héllo; exit 3', cwd: tmp, timeoutMs: 30000 });
    assert.equal(r.stdout.trim(), 'héllo');
    assert.equal(r.exitCode, 3);
  });

  it('keeps formatted table output', async () => {
    if (!ps) return;
    await fsp.writeFile(path.join(tmp, 'table-probe.txt'), 'x');
    const r = await runCommand({ command: 'Get-ChildItem | Select-Object -First 50 Name', cwd: tmp, timeoutMs: 30000 });
    assert.match(r.stdout, /Name/);
    assert.match(r.stdout, /table-probe\.txt/);
    assert.equal(r.exitCode, 0);
  });

  it('reports failed cmdlets with exit code 1', async () => {
    if (!ps) return;
    const r = await runCommand({ command: 'Get-Item ./definitely-missing-file', cwd: tmp, timeoutMs: 30000 });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /definitely-missing-file/);
  });

  it('passes native exit codes through and separates stderr', async () => {
    const r = await runCommand({ command: `node -e "console.error('oops'); process.exit(4)"`, cwd: tmp, timeoutMs: 30000 });
    assert.equal(r.exitCode, 4);
    assert.equal(r.stderr.trim(), 'oops');
  });

  it('stops commands that time out', async () => {
    const started = Date.now();
    const r = await runCommand({ command: ps ? 'Start-Sleep -Seconds 30' : 'sleep 30', cwd: tmp, timeoutMs: 1500 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 15000);
  });

  it('cancels a running command', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const r = await runCommand({ command: ps ? 'Start-Sleep -Seconds 30' : 'sleep 30', cwd: tmp, timeoutMs: 30000, signal: ac.signal });
    assert.equal(r.cancelled, true);
  });
});

describe('ComputerService', () => {
  const svc = new ComputerService({ openPath: async () => '', showItemInFolder: () => {}, grepWorkerFile: null });
  const ctx = () => ({ cwd: tmp, callId: 'c1' });

  it('describes its tools with JSON schemas', async () => {
    const tools = await svc.tools();
    assert.equal(tools.length, 10);
    for (const t of tools) {
      const schema = JSON.parse(t.inputSchemaJson);
      assert.equal(schema.type, 'object');
      assert.ok(t.description.length > 40, t.name);
    }
    assert.deepEqual(tools.filter((t) => t.readOnly).map((t) => t.name).sort(), ['glob', 'grep', 'list_directory', 'read_file', 'read_process_output']);
  });

  it('never throws and labels results', async () => {
    const bad = await svc.call('read_file', '{not json', ctx());
    assert.equal(bad.isError, true);
    const missing = await svc.call('read_file', JSON.stringify({ path: 'nope/missing.txt' }), ctx());
    assert.equal(missing.isError, true);
    assert.equal(missing.content, "nope/missing.txt doesn't exist.");
    assert.equal(missing.label, "Couldn't read nope/missing.txt");
    const unknown = await svc.call('format_disk', '{}', ctx());
    assert.equal(unknown.isError, true);
    const noArg = await svc.call('edit_file', JSON.stringify({ path: 'x' }), ctx());
    assert.match(noArg.content, /Missing required argument "old_string"/);
  });

  it('writes, edits and reads through call()', async () => {
    const w = await svc.call('write_file', JSON.stringify({ path: 'svc/hello.txt', content: 'Hello\nWorld\n' }), ctx());
    assert.equal(w.label, 'Wrote svc/hello.txt');
    const e = await svc.call('edit_file', JSON.stringify({ path: 'svc/hello.txt', old_string: 'World', new_string: 'Facet' }), ctx());
    assert.equal(e.isError, false);
    assert.equal(e.label, 'Edited svc/hello.txt');
    const r = await svc.call('read_file', JSON.stringify({ path: 'svc/hello.txt' }), ctx());
    assert.equal(r.content, '     1\tHello\n     2\tFacet');
    assert.equal(r.label, 'Read svc/hello.txt');
    const g = await svc.call('grep', JSON.stringify({ pattern: 'Fac', path: 'svc', output_mode: 'content' }), ctx());
    assert.equal(g.label, 'Searched for "Fac"');
    assert.match(g.content, /svc\/hello\.txt:2:Facet/);
  });

  it('runs background processes', async () => {
    const cmd = process.platform === 'win32'
      ? 'Write-Output started; Start-Sleep -Milliseconds 2500; Write-Output later; Start-Sleep -Seconds 30'
      : 'echo started; sleep 2.5; echo later; sleep 30';
    const start = await svc.call('run_command', JSON.stringify({ command: cmd, background: true }), ctx());
    assert.equal(start.isError, false, start.content);
    const id = /process (bg-[0-9a-f]+)/.exec(start.content)![1];
    assert.match(start.content, /started/);
    await new Promise((r) => setTimeout(r, 3000));
    const more = await svc.call('read_process_output', JSON.stringify({ id }), ctx());
    assert.match(more.content, /still running/);
    assert.match(more.content, /later/);
    const stop = await svc.call('stop_process', JSON.stringify({ id }), ctx());
    assert.equal(stop.isError, false);
    const after = await svc.call('read_process_output', JSON.stringify({ id }), ctx());
    assert.match(after.content, /was stopped/);
  });

  it('runs grep in a worker that a cancel can stop, even mid-regex', async () => {
    // dist/test/computer.test.js → dist/grep-worker.js (built by `npm test`).
    const worker = new ComputerService({ openPath: async () => '', showItemInFolder: () => {}, grepWorkerFile: path.join(__dirname, '..', 'grep-worker.js') });
    file('redos/evil.txt', `${'a'.repeat(40)}!\n`);
    const okRun = await worker.call('grep', JSON.stringify({ pattern: 'a+!', path: 'redos', output_mode: 'count' }), ctx());
    assert.equal(okRun.content, '1 matching line in 1 file:\nredos/evil.txt:1');
    const started = Date.now();
    const p = worker.call('grep', JSON.stringify({ pattern: '^(a+)+$', path: 'redos' }), { cwd: tmp, callId: 'redos' });
    setTimeout(() => worker.cancel('redos'), 500);
    const r = await p;
    assert.equal(r.isError, true);
    assert.equal(r.content, 'Cancelled.');
    assert.ok(Date.now() - started < 5000);
  });

  it('cancels a call by id', async () => {
    const p = svc.call('run_command', JSON.stringify({ command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30' }), { cwd: tmp, callId: 'cancel-me' });
    setTimeout(() => svc.cancel('cancel-me'), 800);
    const r = await p;
    assert.equal(r.isError, true);
    assert.match(r.content, /cancelled by the user/);
  });
});

// Keep fsp referenced for editors that flag unused imports.
void fsp;
