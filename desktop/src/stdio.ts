/**
 * Local MCP servers over stdin/stdout: newline-delimited JSON-RPC. On Windows commands go through
 * cmd.exe (`shell: true`) so `npx`, `uvx` and other .cmd shims resolve; arguments are escaped for
 * cmd.exe the way cross-spawn does it, so paths with spaces and JSON arguments arrive intact.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { killTree } from './computer/shell';
import { childEnv, IS_WINDOWS } from './computer/util';

export interface StdioSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string | null;
}

export interface StdioEvents {
  message(handle: string, message: string): void;
  exit(handle: string, code: number | null, stderr: string): void;
}

const STDERR_KEEP = 8 * 1024;
/** A single message longer than this (without a newline) is dropped. */
const MAX_LINE = 64 * 1024 * 1024;

// cmd.exe metacharacters (cross-spawn's list).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escapes a command name for cmd.exe. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

/** Quotes and escapes one argument for cmd.exe and the program's own (MSVCRT) argument parsing. */
export function escapeCmdArgument(arg: string, doubleEscape = false): string {
  let a = `${arg}`;
  // Backslashes before a quote are doubled and the quote escaped; trailing backslashes doubled.
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(CMD_META, '^$1');
  // node_modules/.bin shims re-parse their arguments once more.
  if (doubleEscape) a = a.replace(CMD_META, '^$1');
  return a;
}

/** The command line passed to cmd.exe for [spec] on Windows. */
export function windowsCommandLine(spec: { command: string; args: string[] }): string {
  const command = spec.command.trim();
  // A whole command line typed into the command field ("npx -y some-server"): pass it as is.
  if (spec.args.length === 0 && /\s/.test(command) && !/^"[^"]*"$/.test(command)) return command;
  const unquoted = command.replace(/^"(.*)"$/, '$1');
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+$/i.test(unquoted);
  // cmd.exe doesn't accept caret-escaped spaces in the program name: quote paths like C:\Program Files\...
  const program = /[\s&()<>|^]/.test(unquoted) ? `"${unquoted}"` : escapeCmdCommand(unquoted);
  return [program, ...spec.args.map((a) => escapeCmdArgument(a, doubleEscape))].join(' ');
}

interface Proc {
  child: ChildProcess;
  ownerId: number;
  stderr: string;
  exited: boolean;
}

export class StdioServers {
  private readonly procs = new Map<string, Proc>();

  constructor(private readonly events: (ownerId: number) => StdioEvents | null) {}

  spawn(spec: StdioSpec, ownerId: number): string {
    if (!spec || typeof spec.command !== 'string' || !spec.command.trim()) throw new Error('The server command is empty.');
    const args = Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [];
    const env = childEnv(spec.env && typeof spec.env === 'object' ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) : undefined);
    const cwd = spec.cwd && typeof spec.cwd === 'string' ? spec.cwd : undefined;
    let child: ChildProcess;
    if (IS_WINDOWS) {
      child = spawn(windowsCommandLine({ command: spec.command, args }), [], {
        shell: true,
        env,
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      // A whole command line in the command field goes through the shell; otherwise exec directly.
      const asLine = args.length === 0 && /\s/.test(spec.command.trim());
      child = asLine
        ? spawn(spec.command, [], { shell: true, env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
        : spawn(spec.command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    }
    let handle: string;
    do handle = randomBytes(12).toString('hex');
    while (this.procs.has(handle));
    const proc: Proc = { child, ownerId, stderr: '', exited: false };
    this.procs.set(handle, proc);

    const decoder = new StringDecoder('utf8');
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      // Only scan the new text for newlines (big messages arrive in many chunks).
      const from = buf.length;
      buf += decoder.write(d);
      let nl = buf.indexOf('\n', from);
      while (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) this.events(ownerId)?.message(handle, line);
        nl = buf.indexOf('\n');
      }
      if (buf.length > MAX_LINE) {
        proc.stderr = keepTail(`${proc.stderr}\n[Facet: dropped a ${buf.length}-character message without a newline]\n`);
        buf = '';
      }
    });
    const errDecoder = new StringDecoder('utf8');
    child.stderr!.on('data', (d: Buffer) => {
      proc.stderr = keepTail(proc.stderr + errDecoder.write(d));
    });
    child.stdin!.on('error', () => {
      /* EPIPE after the server exited: reported through exit */
    });
    const onExit = (code: number | null, extra?: string) => {
      if (proc.exited) return;
      proc.exited = true;
      const rest = buf.trim();
      if (rest) this.events(ownerId)?.message(handle, rest);
      buf = '';
      if (extra) proc.stderr = keepTail(`${proc.stderr}${proc.stderr ? '\n' : ''}${extra}`);
      this.procs.delete(handle);
      this.events(ownerId)?.exit(handle, code, proc.stderr);
    };
    child.on('error', (e) => onExit(null, `Couldn't start ${spec.command}: ${e.message}`));
    child.on('exit', (code) => {
      // Normally 'close' follows once the pipes drain; don't wait forever if a grandchild holds them.
      const grace = setTimeout(() => onExit(code), 2000);
      child.once('close', () => {
        clearTimeout(grace);
        onExit(code);
      });
    });
    return handle;
  }

  send(handle: string, message: string): void {
    const p = this.procs.get(handle);
    if (!p || p.exited) throw new Error('The server is not running.');
    const line = String(message).replace(/\r?\n/g, ' ');
    p.child.stdin!.write(`${line}\n`);
  }

  async kill(handle: string): Promise<void> {
    const p = this.procs.get(handle);
    if (!p) return;
    try {
      p.child.stdin?.end();
    } catch {
      /* ignore */
    }
    await killTree(p.child);
  }

  /** Kills the servers a window started (it reloaded or closed). */
  killOwnedBy(ownerId: number): void {
    for (const [h, p] of this.procs) if (p.ownerId === ownerId) void this.kill(h);
  }

  killAllSync(): void {
    for (const p of this.procs.values()) {
      if (p.exited || p.child.pid == null) continue;
      try {
        if (IS_WINDOWS) {
          spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
        } else {
          process.kill(-p.child.pid, 'SIGKILL');
        }
      } catch {
        /* ignore */
      }
    }
  }
}

function keepTail(s: string): string {
  return s.length > STDERR_KEEP ? s.slice(s.length - STDERR_KEEP) : s;
}
