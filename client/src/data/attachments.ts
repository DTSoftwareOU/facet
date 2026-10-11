/**
 * Imports, stores and loads attachments (port of AttachmentStore.kt). File bytes live in the
 * `files` table; the attachment row says whether this device has them (`hasFile`). Images are
 * downscaled (longest edge ≤ 1600 px) and re-encoded before they're stored, which also strips
 * EXIF/location data; orientation is applied first.
 */
import { newId } from '../core/ids';
import { t } from '../i18n';
import { db } from './db';
import { attachmentRef, type AttachmentEntity, type AttachmentRef } from './entities';

export class AttachmentError extends Error {}

export const MAX_EDGE = 1600;
export const MAX_GENERATED_EDGE = 2048;
export const COMPACT_IMAGE_BYTES = 150_000;
export const MAX_PDF = 32 * 1024 * 1024;
export const MAX_TEXT = 2 * 1024 * 1024;

export const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
  'kt', 'kts', 'java', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'swift', 'rb', 'php', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'html', 'htm', 'css', 'scss', 'dart', 'lua', 'r', 'm',
  'gradle', 'properties', 'env', 'tex', 'srt', 'vtt', 'bat', 'cmd', 'vue', 'svelte',
]);
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/x-yaml', 'application/javascript', 'application/x-sh']);

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
  'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/webm': 'webm',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType.toLowerCase()] ?? 'bin';
}

export function kindFor(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/')) return 'text';
  return 'file';
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * True when a file carries C2PA content credentials: a JUMBF box labelled "c2pa" (JPEG APP11,
 * WebP, AVIF, MP4) or a PNG "caBX" chunk. Generated media with credentials is stored as received.
 */
export function hasContentCredentials(bytes: Uint8Array): boolean {
  const n = bytes.length - 3;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0x63 /* c */) {
      if (bytes[i + 1] === 0x32 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x61) return true; // "c2pa"
      if (bytes[i + 1] === 0x61 && bytes[i + 2] === 0x42 && bytes[i + 3] === 0x58) return true; // "caBX"
    }
  }
  return false;
}

async function canvasFor(width: number, height: number): Promise<OffscreenCanvas | HTMLCanvasElement> {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function encode(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new AttachmentError(t('Couldn’t encode the image.')))), type, quality),
  );
}

/** Draws [bitmap] scaled to fit [maxEdge]; returns the canvas and whether any pixel is transparent. */
async function draw(bitmap: ImageBitmap, maxEdge: number, checkAlpha: boolean) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = await canvasFor(w, h);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new AttachmentError(t('Couldn’t read that image.'));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  let alpha = false;
  if (checkAlpha) {
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < 255) {
        alpha = true;
        break;
      }
    }
  }
  return { canvas, w, h, alpha };
}

export type ChangeListener = () => void;

export class AttachmentStore {
  private urls = new Map<string, string>();

  constructor(private readonly onLocalChange: ChangeListener = () => {}) {}

  static ref(a: AttachmentEntity): AttachmentRef {
    return attachmentRef(a);
  }

  /** Imports a file the user picked, dropped or pasted, as a draft (not yet in a chat). */
  async import(file: File): Promise<AttachmentEntity> {
    const name = file.name || 'file';
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    const mime = file.type || (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : ext === 'pdf' ? 'application/pdf' : 'application/octet-stream');
    if (mime.startsWith('image/') && mime !== 'image/svg+xml') return this.importImage(file, name, mime);
    if (mime === 'application/pdf') return this.importRaw(file, name, mime, 'pdf', MAX_PDF);
    if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext) || TEXT_MIMES.has(mime)) return this.importRaw(file, name, 'text/plain', 'text', MAX_TEXT);
    throw new AttachmentError(t('Facet can attach images, PDFs and text files. “{name}” isn’t one of those.', { name }));
  }

  private async importImage(file: Blob, name: string, mime: string): Promise<AttachmentEntity> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new AttachmentError(t('That image couldn’t be read.'));
    }
    try {
      const mayHaveAlpha = mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif';
      const { canvas, w, h, alpha } = await draw(bitmap, MAX_EDGE, mayHaveAlpha);
      const png = alpha;
      const blob = await encode(canvas, png ? 'image/png' : 'image/jpeg', png ? undefined : 0.85);
      const now = Date.now();
      const entity: AttachmentEntity = {
        id: newId(now), conversationId: null, kind: 'image', mimeType: png ? 'image/png' : 'image/jpeg',
        name: baseName(name) + (png ? '.png' : '.jpg'), sizeBytes: blob.size, width: w, height: h,
        hasFile: 1, uploaded: false, localOnly: false, createdAt: now, updatedAt: now, deleted: 0, dirty: 0,
      };
      await db().transaction('rw', db().attachments, db().files, async () => {
        await db().files.put({ id: entity.id, data: blob });
        await db().attachments.put(entity);
      });
      return entity;
    } finally {
      bitmap.close();
    }
  }

  private async importRaw(file: Blob, name: string, mime: string, kind: string, max: number): Promise<AttachmentEntity> {
    if (file.size > max) throw new AttachmentError(t('“{name}” is larger than {size} MB.', { name, size: Math.round(max / (1024 * 1024)) }));
    const now = Date.now();
    const data = new Blob([await file.arrayBuffer()], { type: mime });
    const entity: AttachmentEntity = {
      id: newId(now), conversationId: null, kind, mimeType: mime, name, sizeBytes: data.size,
      hasFile: 1, uploaded: false, localOnly: false, createdAt: now, updatedAt: now, deleted: 0, dirty: 0,
    };
    await db().transaction('rw', db().attachments, db().files, async () => {
      await db().files.put({ id: entity.id, data });
      await db().attachments.put(entity);
    });
    return entity;
  }

  /** Links draft attachments to the conversation they were sent in and queues them for sync. */
  async commit(ids: string[], conversationId: string): Promise<void> {
    const now = Date.now();
    await db().transaction('rw', db().attachments, async () => {
      for (const a of await db().attachments.bulkGet(ids)) {
        if (a) await db().attachments.put({ ...a, conversationId, updatedAt: now, dirty: 1 });
      }
    });
    this.onLocalChange();
  }

  async discardDraft(id: string): Promise<void> {
    const a = await db().attachments.get(id);
    if (a && !a.conversationId) {
      await db().transaction('rw', db().attachments, db().files, async () => {
        await db().files.delete(id);
        await db().attachments.delete(id);
      });
      this.revoke(id);
    }
  }

  get(id: string): Promise<AttachmentEntity | undefined> {
    return db().attachments.get(id);
  }

  async blob(id: string): Promise<Blob | null> {
    return (await db().files.get(id))?.data ?? null;
  }

  async bytes(id: string): Promise<Uint8Array | null> {
    const b = await this.blob(id);
    return b ? new Uint8Array(await b.arrayBuffer()) : null;
  }

  /** An object URL for showing the file (kept until the attachment goes away). */
  async url(id: string): Promise<string | null> {
    const cached = this.urls.get(id);
    if (cached) return cached;
    const b = await this.blob(id);
    if (!b) return null;
    const url = URL.createObjectURL(b);
    this.urls.set(id, url);
    return url;
  }

  private revoke(id: string) {
    const u = this.urls.get(id);
    if (u) {
      URL.revokeObjectURL(u);
      this.urls.delete(id);
    }
  }

  /**
   * Saves a generated image, video or audio file as a conversation attachment, queued for
   * end-to-end encrypted sync like any other attachment. Large renders are stored as WebP.
   */
  async storeGenerated(original: Uint8Array, originalMime: string, requestedName: string, conversationId: string): Promise<AttachmentEntity> {
    let data = new Blob([original.slice()], { type: originalMime });
    let mimeType = originalMime;
    let width: number | null = null;
    let height: number | null = null;
    if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
      try {
        const bitmap = await createImageBitmap(data);
        try {
          width = bitmap.width;
          height = bitmap.height;
          // Images that carry content credentials (C2PA) stay untouched: re-encoding would strip the
          // provider's machine-readable "made by AI" marking (EU AI Act Art. 50(2)).
          if (mimeType !== 'image/gif' && data.size > COMPACT_IMAGE_BYTES && !hasContentCredentials(original)) {
            const { canvas, w, h } = await draw(bitmap, MAX_GENERATED_EDGE, false);
            const webp = await encode(canvas, 'image/webp', 0.9);
            // Browsers without a WebP encoder return PNG; keep the original then.
            if (webp.type === 'image/webp' && webp.size < data.size * 0.85) {
              data = webp;
              mimeType = 'image/webp';
              width = w;
              height = h;
            }
          }
        } finally {
          bitmap.close();
        }
      } catch {
        // Dimensions are best effort: an unreadable header only costs the layout hint.
      }
    } else if (mimeType.startsWith('video/')) {
      const dims = await videoSize(data).catch(() => null);
      if (dims) [width, height] = dims;
    }
    const name = mimeType === originalMime ? requestedName : `${baseName(requestedName)}.${extensionFor(mimeType)}`;
    const now = Date.now();
    const entity: AttachmentEntity = {
      id: newId(now), conversationId, kind: kindFor(mimeType), mimeType, name, sizeBytes: data.size, width, height,
      hasFile: 1, uploaded: false, localOnly: false, createdAt: now, updatedAt: now, deleted: 0, dirty: 1,
    };
    await db().transaction('rw', db().attachments, db().files, async () => {
      await db().files.put({ id: entity.id, data });
      await db().attachments.put(entity);
    });
    this.onLocalChange();
    return entity;
  }

  /** Stores bytes downloaded from the sync server for an attachment record. */
  async storeDownloaded(a: AttachmentEntity, bytes: Uint8Array): Promise<void> {
    await db().transaction('rw', db().attachments, db().files, async () => {
      await db().files.put({ id: a.id, data: new Blob([bytes.slice()], { type: a.mimeType }) });
      await db().attachments.update(a.id, { hasFile: 1 });
    });
  }

  /** Removes this device's copy of the file (the record stays). */
  async deleteFile(id: string): Promise<void> {
    await db().files.delete(id);
    this.revoke(id);
  }

  async clearAll(): Promise<void> {
    await db().files.clear();
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }
}

function videoSize(blob: Blob): Promise<[number, number] | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = (r: [number, number] | null) => {
      URL.revokeObjectURL(url);
      resolve(r);
    };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(v.videoWidth ? [v.videoWidth, v.videoHeight] : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}
