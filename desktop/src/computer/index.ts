/**
 * The computer bridge: runs the model's tool calls (commands, files, search) in the main process.
 * Never throws: every failure becomes `{ isError: true, content: <helpful message> }`.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ComputerCallResult, ComputerInfo, ComputerToolInfo } from '../../../client/src/platform/platform';
import { editTextFile, listDirectory, readTextFile, writeTextFile } from './files';
import { globFiles, GLOB_MAX_RESULTS } from './glob';
import { grepSearch, type GrepMode, type GrepOptions, type GrepOutput } from './grep';
import { BackgroundProcesses, formatRunResult, runCommand, shellName } from './shell';
import { toolInfos } from './tools';
import { displayPath, formatDuration, fsErrorMessage, IS_WINDOWS, resolvePath, shorten, ToolError, truncateMiddle } from './util';

/** What the computer needs from Electron (injected so the tools stay testable in plain Node). */
export interface ComputerHost {
  openPath(p: string): Promise<string>;
  showItemInFolder(p: string): void;
  /** File of the bundled grep worker, or null to search in-process. */
  grepWorkerFile: string | null;
}

type Args = Record<string, unknown>;

function argString(args: Args, key: string, required: true): string;
function argString(args: Args, key: string, required?: false): string | undefined;
function argString(args: Args, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`Missing required argument "${key}".`);
    return undefined;
  }
  if (typeof v !== 'string') {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw new ToolError(`Argument "${key}" must be a string.`);
  }
  return v;
}

function argNumber(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`Argument "${key}" must be a number.`);
  return n;
}

function argBool(args: Args, key: string): boolean {
  const v = args[key];
  return v === true || v === 'true' || v === 1;
}

function quoteLabel(s: string, max = 40): string {
  return `"${shorten(s, max)}"`;
}

function ok(content: string, label: string): ComputerCallResult {
  return { content, isError: false, label };
}

function fail(content: string, label: string): ComputerCallResult {
  return { content, isError: true, label };
}

const GREP_TIMEOUT_MS = 120_000;

export class ComputerService {
  readonly background = new BackgroundProcesses();
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly host: ComputerHost) {}

  async info(): Promise<ComputerInfo> {
    return {
      os: osName(),
      shell: await shellName(),
      home: os.homedir(),
      user: os.userInfo().username,
      hostname: os.hostname(),
    };
  }

  async tools(): Promise<ComputerToolInfo[]> {
    return toolInfos(await shellName());
  }

  defaultWorkspace(): string {
    return os.homedir();
  }

  cancel(callId: string): void {
    this.running.get(callId)?.abort();
  }

  async call(name: string, argumentsJson: string, ctx: { cwd: string; callId: string }): Promise<ComputerCallResult> {
    let args: Args;
    try {
      const parsed: unknown = argumentsJson && argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      args = parsed as Args;
    } catch {
      return fail('The arguments are not a valid JSON object.', `Couldn't run ${name}`);
    }
    const cwd = ctx?.cwd && typeof ctx.cwd === 'string' ? path.resolve(ctx.cwd) : this.defaultWorkspace();
    const controller = new AbortController();
    const callId = ctx?.callId ? String(ctx.callId) : '';
    if (callId) this.running.set(callId, controller);
    try {
      return await this.dispatch(name, args, cwd, controller.signal);
    } catch (e) {
      const message = e instanceof ToolError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      return fail(message, failLabel(name, args, cwd));
    } finally {
      if (callId && this.running.get(callId) === controller) this.running.delete(callId);
    }
  }

  private async dispatch(name: string, args: Args, cwd: string, signal: AbortSignal): Promise<ComputerCallResult> {
    switch (name) {
      case 'run_command':
        return this.runCommand(args, cwd, signal);
      case 'read_process_output':
        return this.readProcessOutput(args);
      case 'stop_process':
        return this.stopProcess(args);
      case 'read_file':
        return this.readFile(args, cwd, signal);
      case 'write_file':
        return this.writeFile(args, cwd);
      case 'edit_file':
        return this.editFile(args, cwd);
      case 'list_directory':
        return this.listDirectory(args, cwd);
      case 'glob':
        return this.glob(args, cwd, signal);
      case 'grep':
        return this.grep(args, cwd, signal);
      case 'open_path':
        return this.openPath(args, cwd);
      default:
        return fail(`Unknown tool "${name}".`, `Unknown tool ${name}`);
    }
  }

  private async ensureCwd(cwd: string): Promise<void> {
    try {
      if ((await fsp.stat(cwd)).isDirectory()) return;
    } catch {
      /* fall through */
    }
    throw new ToolError(`The working folder ${cwd} doesn't exist. Ask the user to pick another working folder.`);
  }

  // --- commands --------------------------------------------------------------------------------

  private async runCommand(args: Args, cwd: string, signal: AbortSignal): Promise<ComputerCallResult> {
    const command = argString(args, 'command', true);
    if (!command.trim()) throw new ToolError('The command is empty.');
    await this.ensureCwd(cwd);
    const shown = `\`${shorten(command, 50)}\``;
    if (argBool(args, 'background')) {
      const p = await this.background.start(command, cwd);
      // A moment for early output and immediate failures (command not found, port in use).
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        p.child.once('exit', () => {
          clearTimeout(t);
          setTimeout(resolve, 100);
        });
      });
      const { text } = this.background.take(p);
      if (p.exited) {
        return {
          content: `The command exited right away with code ${p.exitCode ?? 'unknown'}.\n${text || '(no output)'}`,
          isError: p.exitCode !== 0,
          label: `Ran ${shown}`,
        };
      }
      return ok(
        `Started in the background as process ${p.id} (pid ${p.child.pid ?? '?'}).` +
          ` Use read_process_output with id "${p.id}" to see new output and stop_process to stop it.\n` +
          (text ? `Output so far:\n${text}` : 'No output yet.'),
        `Started ${shown}`,
      );
    }
    const timeoutSec = Math.min(600, Math.max(1, argNumber(args, 'timeout_seconds') ?? 120));
    const r = await runCommand({ command, cwd, timeoutMs: timeoutSec * 1000, signal });
    const content = formatRunResult(r, timeoutSec * 1000);
    if (r.cancelled) return fail(content, `Stopped ${shown}`);
    if (r.timedOut) return fail(content, `Timed out: ${shown}`);
    return { content, isError: r.exitCode !== 0, label: `Ran ${shown}` };
  }

  private processOrThrow(args: Args) {
    const id = argString(args, 'id', true);
    const p = this.background.get(id);
    if (!p) {
      const known = this.background.list().map((x) => x.id);
      throw new ToolError(`There's no background process "${id}".${known.length ? ` Known processes: ${known.join(', ')}.` : ''}`);
    }
    return p;
  }

  private readProcessOutput(args: Args): ComputerCallResult {
    const p = this.processOrThrow(args);
    const tail = argNumber(args, 'tail_lines');
    const { text, dropped } = this.background.take(p, tail);
    const runtime = formatDuration(Date.now() - p.startedAt);
    const status = p.exited
      ? `Process ${p.id} (\`${shorten(p.command, 80)}\`) ${p.stoppedByUser ? 'was stopped' : `exited with code ${p.exitCode ?? 'unknown'}`}.`
      : `Process ${p.id} (\`${shorten(p.command, 80)}\`) is still running (for ${runtime}).`;
    const droppedNote = dropped > 0 ? `\n[${dropped.toLocaleString('en-US')} older characters were dropped]` : '';
    return ok(`${status}${droppedNote}\n${text ? `New output:\n${text}` : 'No new output.'}`, `Checked \`${shorten(p.command, 50)}\``);
  }

  private async stopProcess(args: Args): Promise<ComputerCallResult> {
    const p = this.processOrThrow(args);
    const label = `Stopped \`${shorten(p.command, 50)}\``;
    if (p.exited) return ok(`Process ${p.id} had already exited (code ${p.exitCode ?? 'unknown'}).`, label);
    await this.background.stop(p);
    const { text } = this.background.take(p, 40);
    return ok(`Stopped process ${p.id}.${text ? `\nLast output:\n${text}` : ''}`, label);
  }

  // --- files -----------------------------------------------------------------------------------

  private async readFile(args: Args, cwd: string, signal: AbortSignal): Promise<ComputerCallResult> {
    const file = resolvePath(argString(args, 'path', true), cwd);
    const shown = displayPath(file, cwd);
    try {
      const r = await readTextFile(file, shown, argNumber(args, 'offset'), argNumber(args, 'limit'), signal);
      return ok(r.content, `Read ${shorten(shown, 60)}`);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(fsErrorMessage(e, shown));
    }
  }

  private async writeFile(args: Args, cwd: string): Promise<ComputerCallResult> {
    const file = resolvePath(argString(args, 'path', true), cwd);
    const content = argString(args, 'content') ?? '';
    const shown = displayPath(file, cwd);
    try {
      const r = await writeTextFile(file, content);
      const lines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      return ok(
        `${r.created ? 'Created' : 'Overwrote'} ${file} (${r.bytes.toLocaleString('en-US')} bytes, ${lines.toLocaleString('en-US')} line${lines === 1 ? '' : 's'}).`,
        `Wrote ${shorten(shown, 60)}`,
      );
    } catch (e) {
      if (e instanceof ToolError) throw new ToolError(`${shown}: ${e.message}`);
      throw new ToolError(fsErrorMessage(e, shown));
    }
  }

  private async editFile(args: Args, cwd: string): Promise<ComputerCallResult> {
    const file = resolvePath(argString(args, 'path', true), cwd);
    const oldString = argString(args, 'old_string', true);
    const newString = argString(args, 'new_string') ?? '';
    const shown = displayPath(file, cwd);
    try {
      const r = await editTextFile(file, shown, oldString, newString, argBool(args, 'replace_all'));
      const n = r.replacements;
      return ok(`Edited ${shown} (${n} replacement${n === 1 ? '' : 's'}).\n${r.diff}`, `Edited ${shorten(shown, 60)}`);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      const hint = (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? ' To create a new file, use write_file.' : '';
      throw new ToolError(fsErrorMessage(e, shown) + hint);
    }
  }

  private async listDirectory(args: Args, cwd: string): Promise<ComputerCallResult> {
    const dir = resolvePath(argString(args, 'path'), cwd);
    const shown = displayPath(dir, cwd);
    try {
      // The working folder itself shows as "." to the model; the label names it.
      return ok(await listDirectory(dir, shown), `Listed ${shorten(shown === '.' ? path.basename(dir) || dir : shown, 60)}`);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(fsErrorMessage(e, shown));
    }
  }

  // --- search ----------------------------------------------------------------------------------

  private async glob(args: Args, cwd: string, signal: AbortSignal): Promise<ComputerCallResult> {
    const pattern = argString(args, 'pattern', true);
    const root = resolvePath(argString(args, 'path'), cwd);
    const label = `Found files matching ${quoteLabel(pattern)}`;
    const r = await globFiles(pattern, root, signal);
    const notes: string[] = [];
    if (r.total > r.matches.length) notes.push(`Showing the ${GLOB_MAX_RESULTS.toLocaleString('en-US')} newest of ${r.total.toLocaleString('en-US')} matches; use a more specific pattern or path.`);
    if (r.capped) notes.push('Stopped scanning early because the folder is very large; search a narrower path for complete results.');
    if (r.matches.length === 0) {
      return ok([`No files match ${pattern} in ${displayPath(root, cwd)}.`, ...notes].join('\n'), label);
    }
    const list = r.matches.map((m) => displayPath(m.abs, cwd)).join('\n');
    const head = `${r.total.toLocaleString('en-US')} file${r.total === 1 ? '' : 's'} (newest first):`;
    return ok(truncateMiddle(`${head}\n${list}${notes.length ? `\n\n${notes.join('\n')}` : ''}`, 60000), label);
  }

  private async grep(args: Args, cwd: string, signal: AbortSignal): Promise<ComputerCallResult> {
    const pattern = argString(args, 'pattern', true);
    const modeArg = argString(args, 'output_mode');
    if (modeArg && !['files_with_matches', 'content', 'count'].includes(modeArg)) {
      throw new ToolError('output_mode must be "files_with_matches", "content" or "count".');
    }
    const opts: GrepOptions = {
      pattern,
      root: resolvePath(argString(args, 'path'), cwd),
      cwd,
      glob: argString(args, 'glob'),
      ignoreCase: argBool(args, 'ignore_case'),
      mode: (modeArg as GrepMode | undefined) ?? 'files_with_matches',
      context: argNumber(args, 'context'),
      headLimit: argNumber(args, 'head_limit'),
    };
    const label = `Searched for ${quoteLabel(pattern)}`;
    const r = await this.runGrep(opts, signal);
    return { content: r.content, isError: r.isError, label };
  }

  /** Runs grep in a worker thread (with a timeout), so a slow regex can't block the main process. */
  private async runGrep(opts: GrepOptions, signal: AbortSignal): Promise<GrepOutput> {
    let src: string | null = null;
    if (this.host.grepWorkerFile) {
      try {
        src = await fsp.readFile(this.host.grepWorkerFile, 'utf8');
      } catch {
        src = null;
      }
    }
    if (!src) return grepSearch(opts, signal);
    return new Promise<GrepOutput>((resolve, reject) => {
      // eval: the worker's source is read through Electron's asar-aware fs, then run from memory.
      const worker = new Worker(src!, { eval: true, workerData: opts });
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new ToolError(
                `The search timed out after ${GREP_TIMEOUT_MS / 1000} s. Try a simpler pattern, a narrower path, or a glob filter.`,
              ),
            ),
          ),
        GREP_TIMEOUT_MS,
      );
      const onAbort = () => finish(() => reject(new ToolError('Cancelled.')));
      signal.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (m: { ok: boolean; result?: GrepOutput; expected?: boolean; message?: string }) => {
        finish(() => {
          if (m.ok && m.result) resolve(m.result);
          else reject(m.expected ? new ToolError(m.message ?? 'Search failed.') : new Error(m.message ?? 'Search failed.'));
        });
      });
      worker.on('error', (e) => finish(() => reject(e)));
      worker.on('exit', () => finish(() => reject(new Error('The search stopped unexpectedly.'))));
    });
  }

  // --- open ------------------------------------------------------------------------------------

  private async openPath(args: Args, cwd: string): Promise<ComputerCallResult> {
    const target = resolvePath(argString(args, 'path', true), cwd);
    const shown = displayPath(target, cwd);
    const reveal = argBool(args, 'reveal');
    try {
      await fsp.stat(target);
    } catch (e) {
      throw new ToolError(fsErrorMessage(e, shown));
    }
    if (reveal) {
      this.host.showItemInFolder(target);
      return ok(`Showed ${target} in ${IS_WINDOWS ? 'File Explorer' : 'the file manager'}.`, `Revealed ${shorten(shown, 60)}`);
    }
    const err = await this.host.openPath(target);
    if (err) throw new ToolError(`Couldn't open ${shown}: ${err}`);
    return ok(`Opened ${target} with its default app.`, `Opened ${shorten(shown, 60)}`);
  }

  // --- lifecycle -------------------------------------------------------------------------------

  shutdown(): void {
    for (const c of this.running.values()) c.abort();
    this.background.killAllSync();
  }
}

function failLabel(name: string, args: Args, cwd: string): string {
  const p = typeof args.path === 'string' ? shorten(displayPath(resolvePath(args.path, cwd), cwd), 60) : '';
  switch (name) {
    case 'run_command':
      return typeof args.command === 'string' ? `Couldn't run \`${shorten(args.command, 46)}\`` : "Couldn't run a command";
    case 'read_file':
      return `Couldn't read ${p || 'a file'}`;
    case 'write_file':
      return `Couldn't write ${p || 'a file'}`;
    case 'edit_file':
      return `Couldn't edit ${p || 'a file'}`;
    case 'list_directory':
      return `Couldn't list ${p || 'the folder'}`;
    case 'glob':
      return `Couldn't search for ${typeof args.pattern === 'string' ? quoteLabel(args.pattern) : 'files'}`;
    case 'grep':
      return `Couldn't search for ${typeof args.pattern === 'string' ? quoteLabel(args.pattern) : 'text'}`;
    case 'open_path':
      return `Couldn't open ${p || 'the path'}`;
    case 'read_process_output':
    case 'stop_process':
      return `Couldn't find process ${typeof args.id === 'string' ? args.id : ''}`.trim();
    default:
      return `Couldn't run ${name}`;
  }
}

/** e.g. "Windows 11 (10.0.26200)". */
export function osName(): string {
  const release = os.release();
  if (process.platform === 'win32') {
    const build = Number(release.split('.')[2] ?? 0);
    return `${build >= 22000 ? 'Windows 11' : 'Windows 10'} (${release})`;
  }
  if (process.platform === 'darwin') return `macOS (Darwin ${release})`;
  return `${os.type()} ${release}`;
}

