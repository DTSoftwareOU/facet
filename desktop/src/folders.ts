/**
 * Folder listings for choosing a chat's working folder from another device (docs/REMOTE.md:
 * files.list), and for the same browser in the app. Folders only; nothing is read from files.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FolderEntry, FolderListing } from '../../client/src/platform/platform';

const MAX_FOLDERS = 2000;
/** Hidden and system folders nobody picks as a working folder. */
const SKIP = new Set(['$recycle.bin', 'system volume information', 'recovery', 'config.msi', '$windows.~bt', '$windows.~ws', '$sysreset', 'msocache']);

export interface PlaceFolders {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
}

async function isFolder(p: string, timeoutMs = 400): Promise<boolean> {
  // Disconnected network drives can take seconds to answer: don't wait for them.
  const check = fsp.stat(p).then((s) => s.isDirectory(), () => false);
  return Promise.race([check, new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
}

/** Absolute local paths only (drive or UNC on Windows). */
export function absolute(p: string): boolean {
  return process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p) : path.isAbsolute(p);
}

export async function listFolders(target: string | null, recent: string[], places: PlaceFolders): Promise<FolderListing> {
  if (target == null) {
    const out: FolderEntry[] = [];
    const add = async (name: string, p: string) => {
      if (p && !out.some((e) => e.path.toLowerCase() === p.toLowerCase()) && (await isFolder(p))) out.push({ name, path: p });
    };
    for (const r of recent.slice(0, 8)) await add(path.basename(r) || r, r);
    await add('Home', places.home);
    await add('Desktop', places.desktop);
    await add('Documents', places.documents);
    await add('Downloads', places.downloads);
    if (process.platform === 'win32') {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      const found = await Promise.all(letters.map(async (l) => ((await isFolder(`${l}:\\`)) ? l : null)));
      for (const l of found) if (l) out.push({ name: `${l}:`, path: `${l}:\\` });
    } else {
      out.push({ name: '/', path: '/' });
    }
    return { path: null, parent: null, folders: [], places: out };
  }

  if (!absolute(target)) throw new Error('A full folder path is needed.');
  const dir = path.resolve(target);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('That folder doesn’t exist.');
    if (code === 'EACCES' || code === 'EPERM') throw new Error('Facet can’t open that folder (permission denied).');
    throw new Error('Couldn’t open that folder.');
  }
  const folders = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name.toLowerCase()))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
    .slice(0, MAX_FOLDERS);
  const up = path.dirname(dir);
  return { path: dir, parent: up === dir ? null : up, folders, places: [] };
}
