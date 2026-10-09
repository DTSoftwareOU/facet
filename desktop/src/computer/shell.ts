/**
 * run_command and background processes. On Windows every call runs in a fresh PowerShell
 * (PowerShell 7 when `pwsh.exe` is installed, else Windows PowerShell 5.1); elsewhere in bash.
 * Output is streamed into bounded buffers so huge outputs never pile up in memory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { childEnv, cleanOutput, formatDuration, IS_WINDOWS, truncateMiddle } from './util';

export const MAX_OUTPUT_CHARS = 30000;

/** Keeps the first and last [limit] characters of a stream and counts what was dropped in between. */
export class OutputBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;
  constructor(private readonly limit = MAX_OUTPUT_CHARS / 2) {}

  push(chunk: string): void {
    if (!chunk) return;
    if (this.head.length < this.limit) {
      const room = this.limit - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    this.tail += chunk;
    if (this.tail.length > this.limit * 2) {
      const cut = this.tail.length - this.limit;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  get length(): number {
    return this.head.length + this.dropped + this.tail.length;
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n\n… [${this.dropped.toLocaleString('en-US')} characters omitted] …\n\n${this.tail}`;
  }
}

export interface ShellInfo {
  /** Executable. */
  file: string;
  kind: 'pwsh' | 'powershell' | 'bash' | 'sh';
}

let shellCache: ShellInfo | null = null;

function findOnPath(exe: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d.replace(/^"|"$/g, ''), exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The shell commands run in (detected once). */
export function shell(): ShellInfo {
  if (shellCache) return shellCache;
  if (IS_WINDOWS) {
    const pwsh =
      findOnPath('pwsh.exe') ??
      [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter(Boolean)
        .map((p) => path.join(p as string, 'PowerShell', '7', 'pwsh.exe'))
        .find((p) => existsSync(p)) ??
      null;
    if (pwsh) {
      shellCache = { file: pwsh, kind: 'pwsh' };
    } else {
      const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      shellCache = { file: existsSync(sys) ? sys : 'powershell.exe', kind: 'powershell' };
    }
  } else {
    shellCache = existsSync('/bin/bash') ? { file: '/bin/bash', kind: 'bash' } : { file: '/bin/sh', kind: 'sh' };
  }
  return shellCache;
}

let shellNamePromise: Promise<string> | null = null;

/** e.g. "PowerShell 7.4", "Windows PowerShell 5.1", "bash 5.2" (detected once). */
export function shellName(): Promise<string> {
  if (shellNamePromise) return shellNamePromise;
  const sh = shell();
  shellNamePromise = (async () => {
    const base = sh.kind === 'pwsh' ? 'PowerShell' : sh.kind === 'powershell' ? 'Windows PowerShell' : sh.kind;
    try {
      const r =
        sh.kind === 'pwsh' || sh.kind === 'powershell'
          ? await runCommand({
              command: "Write-Output ('{0}.{1}' -f $PSVersionTable.PSVersion.Major, $PSVersionTable.PSVersion.Minor)",
              cwd: os.homedir(),
              timeoutMs: 15000,
            })
          : await runCommand({ command: 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"', cwd: os.homedir(), timeoutMs: 15000 });
      const v = r.stdout.trim().split('\n')[0]?.trim();
      return v && /^\d+(\.\d+)?$/.test(v) ? `${base} ${v}` : base;
    } catch {
      return base;
    }
  })();
  return shellNamePromise;
}

// Runs before the command: UTF-8 output (PowerShell 5.1 defaults to the OEM code page), no progress bars.
const PS_PRELUDE =
  "$ProgressPreference='SilentlyContinue'; try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}; $OutputEncoding = [Text.UTF8Encoding]::new($false)";
// Exit with the last native program's exit code, or 1 when the command wrote an error.
const PS_EPILOGUE =
  '$__facetCode = $global:LASTEXITCODE\nif ($__facetCode) { exit $__facetCode }\nif ($Error.Count -gt $__facetErrors) { exit 1 }\nexit 0';

interface Invocation {
  file: string;
  args: string[];
  cleanup?: () => void;
}

async function invocation(command: string): Promise<Invocation> {
  const sh = shell();
  if (sh.kind === 'bash' || sh.kind === 'sh') return { file: sh.file, args: sh.kind === 'bash' ? ['-lc', command] : ['-c', command] };
  // Out-Default ends the command's pipeline before `exit`: PowerShell formats tables lazily, and
  // exiting first would drop output like `Get-ChildItem | Select-Object Name`.
  const script = `${PS_PRELUDE}; $global:LASTEXITCODE = 0; $__facetErrors = $Error.Count\n& {\n${command}\n} | Out-Default\n${PS_EPILOGUE}`;
  const base = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  // The Windows command line is limited to 32 767 characters; longer scripts go through a temp file.
  if (script.length < 28000) return { file: sh.file, args: [...base, '-Command', script] };
  const tmp = path.join(os.tmpdir(), `facet-cmd-${randomBytes(6).toString('hex')}.ps1`);
  // A BOM, or Windows PowerShell 5.1 reads the script in the ANSI code page.
  await fsp.writeFile(tmp, `\ufeff${script}`, 'utf8');
  return { file: sh.file, args: [...base, '-File', tmp], cleanup: () => void fsp.rm(tmp, { force: true }).catch(() => {}) };
}

/** Kills a process and all its children. */
export function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid == null || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  if (IS_WINDOWS) {
    return new Promise((resolve) => {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {
        try {
          child.kill();
        } catch {
          /* gone */
        }
        resolve();
      });
      k.on('exit', () => resolve());
    });
  }
  return new Promise((resolve) => {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
    const t = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* gone */
      }
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function spawnShell(inv: Invocation, cwd: string): ChildProcess {
  return spawn(inv.file, inv.args, {
    cwd,
    env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: own process group, so the whole tree can be killed.
    detached: !IS_WINDOWS,
  });
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs a command to completion (or timeout / cancellation). Never rejects for a failing command. */
export async function runCommand(opts: RunOptions): Promise<RunResult> {
  const inv = await invocation(opts.command);
  const started = Date.now();
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnShell(inv, opts.cwd);
    } catch (e) {
      inv.cleanup?.();
      reject(e);
      return;
    }
    const out = new OutputBuffer();
    const err = new OutputBuffer();
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    child.stdout!.on('data', (d: Buffer) => out.push(outDec.write(d)));
    child.stderr!.on('data', (d: Buffer) => err.push(errDec.write(d)));

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exitCode: number | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
    }, opts.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      void killTree(child);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      inv.cleanup?.();
      out.push(outDec.end());
      err.push(errDec.end());
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ stdout: out.toString(), stderr: err.toString(), exitCode, timedOut, cancelled, durationMs: Date.now() - started });
    };

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inv.cleanup?.();
      reject(e);
    });
    child.on('exit', (code) => {
      exitCode = code;
      // A program the command started in the background may keep the pipes open: don't wait for it.
      const grace = setTimeout(finish, 1500);
      child.once('close', () => {
        clearTimeout(grace);
        finish();
      });
    });
  });
}

/** The model-facing text of a finished command. */
export function formatRunResult(r: RunResult, timeoutMs: number): string {
  const stdout = cleanOutput(r.stdout).replace(/\s+$/, '');
  const stderr = cleanOutput(r.stderr).replace(/\s+$/, '');
  let body = '';
  if (stdout) body += stdout;
  if (stderr) body += `${body ? '\n' : ''}[stderr]\n${stderr}`;
  if (!body) body = '(no output)';
  body = truncateMiddle(body, MAX_OUTPUT_CHARS);
  const took = formatDuration(r.durationMs);
  let status: string;
  if (r.cancelled) status = `[cancelled by the user after ${took}]`;
  else if (r.timedOut)
    status = `[timed out after ${formatDuration(timeoutMs)}: the command and its child processes were stopped. For servers and watchers that keep running, use background: true]`;
  else status = `[exit code ${r.exitCode ?? 'unknown'} · ${took}]`;
  return `${body}\n${status}`;
}

// ---------------------------------------------------------------------------------------------
// Background processes (dev servers, watchers)

const UNREAD_LIMIT = 2 * 1024 * 1024;

export interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  unread: string;
  droppedChars: number;
  exitCode: number | null;
  exited: boolean;
  stoppedByUser: boolean;
}

export class BackgroundProcesses {
  private readonly procs = new Map<string, BackgroundProcess>();

  get(id: string): BackgroundProcess | undefined {
    return this.procs.get(id.trim());
  }

  list(): BackgroundProcess[] {
    return [...this.procs.values()];
  }

  async start(command: string, cwd: string): Promise<BackgroundProcess> {
    const inv = await invocation(command);
    const child = spawnShell(inv, cwd);
    let id: string;
    do id = `bg-${randomBytes(3).toString('hex')}`;
    while (this.procs.has(id));
    const p: BackgroundProcess = {
      id,
      command,
      cwd,
      child,
      startedAt: Date.now(),
      unread: '',
      droppedChars: 0,
      exitCode: null,
      exited: false,
      stoppedByUser: false,
    };
    const append = (s: string) => {
      if (!s) return;
      p.unread += s;
      if (p.unread.length > UNREAD_LIMIT) {
        const cut = p.unread.length - UNREAD_LIMIT;
        p.droppedChars += cut;
        p.unread = p.unread.slice(cut);
      }
    };
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    child.stdout!.on('data', (d: Buffer) => append(outDec.write(d)));
    child.stderr!.on('data', (d: Buffer) => append(errDec.write(d)));
    child.on('error', (e) => {
      append(`\n[failed to start: ${e.message}]\n`);
      p.exited = true;
      inv.cleanup?.();
    });
    child.on('exit', (code) => {
      p.exitCode = code;
      p.exited = true;
      append(outDec.end() + errDec.end());
      inv.cleanup?.();
    });
    this.procs.set(id, p);
    return p;
  }

  /** New output since the last read (cleaned and capped). */
  take(p: BackgroundProcess, tailLines?: number): { text: string; dropped: number } {
    let text = cleanOutput(p.unread);
    const dropped = p.droppedChars;
    p.unread = '';
    p.droppedChars = 0;
    if (tailLines && tailLines > 0) {
      const lines = text.replace(/\n+$/, '').split('\n');
      if (lines.length > tailLines) text = lines.slice(-tailLines).join('\n');
    }
    return { text: truncateMiddle(text.replace(/\s+$/, ''), MAX_OUTPUT_CHARS), dropped };
  }

  async stop(p: BackgroundProcess): Promise<void> {
    p.stoppedByUser = true;
    const exited = p.exited
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          p.child.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
    await killTree(p.child);
    await exited;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((p) => (p.exited ? undefined : killTree(p.child))));
  }

  /** Synchronous best-effort kill for app shutdown. */
  killAllSync(): void {
    for (const p of this.procs.values()) {
      if (p.exited || p.child.pid == null) continue;
      if (IS_WINDOWS) {
        try {
          spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
        } catch {
          /* ignore */
        }
      } else {
        try {
          process.kill(-p.child.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  }
}
