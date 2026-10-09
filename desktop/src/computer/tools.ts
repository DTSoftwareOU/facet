/** The tools the computer offers to models: names, model-facing descriptions and argument schemas. */
import type { ComputerToolInfo } from '../../../client/src/platform/platform';
import { IS_WINDOWS } from './util';

interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  readOnly: boolean;
}

function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'integer', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });

function runCommandDescription(shellName: string): string {
  const isPs = /powershell/i.test(shellName);
  const ps7 = /^PowerShell 7/i.test(shellName);
  const shellPart = IS_WINDOWS
    ? `Commands run in ${shellName} on Windows, so use PowerShell syntax: \`;\` to chain commands, \`$env:NAME\` for environment variables, cmdlets like Get-ChildItem, Get-Content, Select-String, Test-Path, Remove-Item, Copy-Item.${
        isPs && !ps7 ? ' `&&` and `||` are not available in this version: use `;` or `if ($?) { ... }`.' : ''
      } Native programs (git, node, npm, python, ...) work as usual.`
    : `Commands run in ${shellName}.`;
  return [
    "Runs a shell command on the user's computer and returns its output (stdout, then stderr), exit code and duration.",
    shellPart,
    "Each call starts a fresh shell in the chat's working folder: `cd` and variables don't carry over to the next call, so use paths relative to the working folder, or chain commands in one call (e.g. `cd web; npm test`).",
    'Commands get no input, so pass flags that skip prompts (e.g. `-y`, `--yes`, `-Force`).',
    'Output longer than 30,000 characters is cut in the middle. The default timeout is 120 seconds (max 600).',
    'For programs that keep running (dev servers, watchers), set background: true: the call returns a process id right away; use read_process_output to see its output and stop_process to stop it.',
    'Prefer read_file, edit_file, write_file, list_directory, glob and grep for reading, changing and searching files.',
  ].join(' ');
}

function defs(shellName: string): ToolDef[] {
  return [
    {
      name: 'run_command',
      description: runCommandDescription(shellName),
      readOnly: false,
      schema: obj(
        {
          command: str('The command to run.'),
          timeout_seconds: int('Seconds to wait before stopping the command (default 120, max 600). Ignored with background.', {
            minimum: 1,
            maximum: 600,
          }),
          background: bool('Start the command and return at once with a process id (for dev servers, watchers and other long-running programs).'),
          description: str('What the command does, in 5-10 words, shown to the user (e.g. "Run the unit tests").'),
        },
        ['command'],
      ),
    },
    {
      name: 'read_process_output',
      description:
        'Returns the output a background process (started by run_command with background: true) printed since the last read, and whether it is still running.',
      readOnly: true,
      schema: obj(
        {
          id: str('The process id run_command returned (e.g. "bg-1a2b3c").'),
          tail_lines: int('Only return the last N lines of the new output.', { minimum: 1 }),
        },
        ['id'],
      ),
    },
    {
      name: 'stop_process',
      description: 'Stops a background process started by run_command (and every process it started).',
      readOnly: false,
      schema: obj({ id: str('The process id run_command returned.') }, ['id']),
    },
    {
      name: 'read_file',
      description: [
        'Reads a text file and returns its lines numbered like `cat -n` (line number, a tab, then the line).',
        "Paths can be absolute or relative to the chat's working folder.",
        'Returns up to 2,000 lines starting at offset (a 1-based line number, default 1); for longer files, read further with offset and limit.',
        'Lines longer than 2,000 characters are cut. Binary files (images, archives, executables, ...) are refused.',
        'Read a file before editing it, and quote its text without the line-number prefix.',
      ].join(' '),
      readOnly: true,
      schema: obj(
        {
          path: str('The file to read.'),
          offset: int('The line to start at (1-based).', { minimum: 1 }),
          limit: int('How many lines to read (default 2000).', { minimum: 1 }),
        },
        ['path'],
      ),
    },
    {
      name: 'write_file',
      description:
        'Creates a file, or replaces all of an existing file, with the given content (UTF-8). Creates missing parent folders. To change part of an existing file, use edit_file instead (and read the file first).',
      readOnly: false,
      schema: obj(
        {
          path: str("The file to write (absolute or relative to the chat's working folder)."),
          content: str('The complete new content of the file.'),
        },
        ['path', 'content'],
      ),
    },
    {
      name: 'edit_file',
      description: [
        'Changes a file by replacing exact text: old_string must match the current file exactly, including whitespace and indentation (without the line-number prefixes read_file shows),',
        'and must occur only once in the file unless replace_all is true. Include enough surrounding lines to make it unique.',
        "For several separate changes, call edit_file once per change. The file's line endings (CRLF or LF) and encoding are kept.",
        'Returns a diff of the change. Read the file first.',
      ].join(' '),
      readOnly: false,
      schema: obj(
        {
          path: str('The file to change.'),
          old_string: str('The exact text to replace.'),
          new_string: str('The text to put in its place (may be empty to delete old_string).'),
          replace_all: bool('Replace every occurrence of old_string instead of requiring exactly one (default false).'),
        },
        ['path', 'old_string', 'new_string'],
      ),
    },
    {
      name: 'list_directory',
      description:
        "Lists a folder's contents (folders first) with each entry's type, last-modified time and size. Defaults to the chat's working folder. Shows up to 500 entries.",
      readOnly: true,
      schema: obj({ path: str("The folder to list (default: the chat's working folder).") }),
    },
    {
      name: 'glob',
      description: [
        'Finds files whose paths match a glob pattern and lists them newest first (by modification time).',
        "The pattern is relative to path (default: the chat's working folder) or absolute.",
        '`*` matches within one file or folder name, `**` matches any number of folders, `?` one character, `{a,b}` either alternative, `[abc]` one of the characters.',
        'Examples: `**/*.ts`, `src/**/*.{js,jsx}`, `**/README.md`, `*.json` (only the top folder).',
        'Skips .git and node_modules folders unless the pattern names them. Returns up to 1,000 paths.',
      ].join(' '),
      readOnly: true,
      schema: obj(
        {
          pattern: str('The glob pattern, e.g. "**/*.py".'),
          path: str("The folder to search in (default: the chat's working folder)."),
        },
        ['pattern'],
      ),
    },
    {
      name: 'grep',
      description: [
        'Searches inside files for a regular expression (JavaScript syntax, matched line by line), recursively from path: a folder or a single file (default: the chat\'s working folder).',
        'Skips .git and node_modules folders, binary files and files over 2 MB.',
        'glob limits which files are searched (e.g. `*.ts` or `*.{ts,tsx}` match file names; `src/**/*.ts` matches paths).',
        'output_mode: "files_with_matches" (default) lists the files that match, newest first; "content" shows matching lines as `path:line:text` (with `context` lines around each match, as `path-line-text`); "count" shows the number of matching lines per file.',
        'head_limit caps the number of files or lines returned (default 300).',
        'Escape regex special characters to search for them literally (e.g. `foo\\(` or `\\.env`).',
      ].join(' '),
      readOnly: true,
      schema: obj(
        {
          pattern: str('The regular expression to search for.'),
          path: str("The folder or file to search (default: the chat's working folder)."),
          glob: str('Only search files matching this glob, e.g. "*.js" or "**/*.{ts,tsx}".'),
          ignore_case: bool('Case-insensitive search (default false).'),
          output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'What to return (default "files_with_matches").' },
          context: int('Lines of context to show before and after each match (content mode only, max 20).', { minimum: 0, maximum: 20 }),
          head_limit: int('Return at most this many files or lines.', { minimum: 1 }),
        },
        ['pattern'],
      ),
    },
    {
      name: 'open_path',
      description:
        "Opens a file or folder on the user's computer with its default app (e.g. an HTML file in the browser, an image in the photo viewer, a folder in File Explorer), or with reveal: true shows it selected in File Explorer. Use it when the user wants to see a result.",
      readOnly: false,
      schema: obj(
        {
          path: str('The file or folder to open.'),
          reveal: bool('Show the item in File Explorer instead of opening it (default false).'),
        },
        ['path'],
      ),
    },
  ];
}

export function toolInfos(shellName: string): ComputerToolInfo[] {
  return defs(shellName).map((d) => ({
    name: d.name,
    description: d.description,
    inputSchemaJson: JSON.stringify(d.schema),
    readOnly: d.readOnly,
  }));
}

export const TOOL_NAMES = [
  'run_command',
  'read_process_output',
  'stop_process',
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'glob',
  'grep',
  'open_path',
] as const;
