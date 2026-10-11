/**
 * The short lines the chat shows for tool calls ("Searched “rent prices”", "Ran `npm test`"), in
 * the interface language. They're stored with the reply, so they stay in the language they were
 * made in. What the model sees (tool results) stays English.
 */
import { parseJson } from '../core/json';
import { t } from '../i18n';
import type { ModelOutput } from '../llm/types';

function argString(args: string, key: string): string {
  const obj = parseJson<Record<string, unknown> | null>(args, null);
  const v = obj?.[key];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

/** Labels for the Windows app's computer tools while they run; the bridge supplies the final label. */
export function computerLabel(tool: string, args: string, done: boolean): string {
  const path = shortPath(argString(args, 'path'));
  switch (tool) {
    case 'run_command': {
      const cmd = argString(args, 'command').split('\n')[0];
      if (!cmd) return done ? t('Ran a command') : t('Running a command');
      const command = '`' + (cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd) + '`';
      return done ? t('Ran {command}', { command }) : t('Running {command}', { command });
    }
    case 'read_file':
      if (!path) return done ? t('Read a file') : t('Reading a file');
      return done ? t('Read {path}', { path }) : t('Reading {path}', { path });
    case 'write_file':
      if (!path) return done ? t('Wrote a file') : t('Writing a file');
      return done ? t('Wrote {path}', { path }) : t('Writing {path}', { path });
    case 'edit_file':
      if (!path) return done ? t('Edited a file') : t('Editing a file');
      return done ? t('Edited {path}', { path }) : t('Editing {path}', { path });
    case 'list_directory':
      if (!path) return done ? t('Listed the folder') : t('Listing the folder');
      return done ? t('Listed {path}', { path }) : t('Listing {path}', { path });
    case 'glob': {
      const pattern = argString(args, 'pattern') || '…';
      return done ? t('Found files matching {pattern}', { pattern }) : t('Finding files matching {pattern}', { pattern });
    }
    case 'grep': {
      const pattern = `“${argString(args, 'pattern').slice(0, 40)}”`;
      return done ? t('Searched for {pattern}', { pattern }) : t('Searching for {pattern}', { pattern });
    }
    default:
      return tool.replace(/_/g, ' ');
  }
}

/**
 * The Windows app's bridge labels its finished computer tool calls in English
 * (desktop/src/computer); this puts the known ones into the interface language. Anything else
 * passes through unchanged.
 */
export function localizeComputerLabel(label: string): string {
  const fixed: Record<string, () => string> = {
    "Couldn't run a command": () => t("Couldn't run a command"),
    "Couldn't read a file": () => t("Couldn't read a file"),
    "Couldn't write a file": () => t("Couldn't write a file"),
    "Couldn't edit a file": () => t("Couldn't edit a file"),
    "Couldn't list the folder": () => t("Couldn't list the folder"),
    "Couldn't search for files": () => t("Couldn't search for files"),
    "Couldn't search for text": () => t("Couldn't search for text"),
    "Couldn't open the path": () => t("Couldn't open the path"),
    "Couldn't find process": () => t("Couldn't find process"),
  };
  if (fixed[label]) return fixed[label]();
  const patterns: [RegExp, (x: string) => string][] = [
    [/^Couldn't run (.+)$/s, (command) => t("Couldn't run {command}", { command })],
    [/^Couldn't read (.+)$/s, (path) => t("Couldn't read {path}", { path })],
    [/^Couldn't write (.+)$/s, (path) => t("Couldn't write {path}", { path })],
    [/^Couldn't edit (.+)$/s, (path) => t("Couldn't edit {path}", { path })],
    [/^Couldn't list (.+)$/s, (path) => t("Couldn't list {path}", { path })],
    [/^Couldn't search for (.+)$/s, (pattern) => t("Couldn't search for {pattern}", { pattern })],
    [/^Couldn't open (.+)$/s, (path) => t("Couldn't open {path}", { path })],
    [/^Couldn't find process (.+)$/s, (id) => t("Couldn't find process {id}", { id })],
    [/^Unknown tool (.+)$/s, (name) => t('Unknown tool {name}', { name })],
    [/^Timed out: (.+)$/s, (command) => t('Timed out: {command}', { command })],
    [/^Ran (.+)$/s, (command) => t('Ran {command}', { command })],
    [/^Started (.+)$/s, (command) => t('Started {command}', { command })],
    [/^Stopped (.+)$/s, (command) => t('Stopped {command}', { command })],
    [/^Checked (.+)$/s, (command) => t('Checked {command}', { command })],
    [/^Read (.+)$/s, (path) => t('Read {path}', { path })],
    [/^Wrote (.+)$/s, (path) => t('Wrote {path}', { path })],
    [/^Edited (.+)$/s, (path) => t('Edited {path}', { path })],
    [/^Listed (.+)$/s, (path) => t('Listed {path}', { path })],
    [/^Found files matching (.+)$/s, (pattern) => t('Found files matching {pattern}', { pattern })],
    [/^Searched for (.+)$/s, (pattern) => t('Searched for {pattern}', { pattern })],
    [/^Revealed (.+)$/s, (path) => t('Revealed {path}', { path })],
    [/^Opened (.+)$/s, (path) => t('Opened {path}', { path })],
  ];
  for (const [re, make] of patterns) {
    const m = re.exec(label);
    if (m) return make(m[1]);
  }
  return label;
}

/** "Created image with {model}" for a finished media tool call. */
export function createdWithLabel(output: ModelOutput, model: string): string {
  switch (output) {
    case 'IMAGE': return t('Created image with {model}', { model });
    case 'VIDEO': return t('Created video with {model}', { model });
    case 'SPEECH': return t('Created audio clip with {model}', { model });
    case 'MUSIC': return t('Created track with {model}', { model });
    default: return t('Created media with {model}', { model });
  }
}

/** A media tool call while it runs, or once done (before the tool's own label arrives). */
export function mediaLabel(output: ModelOutput | null | undefined, done: boolean): string {
  switch (output) {
    case 'IMAGE': return done ? t('Created an image') : t('Creating an image');
    case 'VIDEO': return done ? t('Created a video') : t('Creating a video');
    case 'SPEECH': return done ? t('Created speech') : t('Creating speech');
    case 'MUSIC': return done ? t('Created music') : t('Creating music');
    default: return done ? t('Created media') : t('Creating media');
  }
}

/** A web search, fetch or skill call, while it runs or once done. */
export function searchLabel(query: string, done: boolean): string {
  return done ? t('Searched “{query}”', { query }) : t('Searching “{query}”', { query });
}

export function fetchLabel(host: string | null, done: boolean): string {
  if (!host) return done ? t('Read a page') : t('Reading a page');
  return done ? t('Read {host}', { host }) : t('Reading {host}', { host });
}

export function skillLabel(name: string, path: string, done: boolean): string {
  if (name) return done ? t('Used skill {name}', { name }) : t('Using skill {name}', { name });
  return done ? t('Read {path}', { path }) : t('Reading {path}', { path });
}
