/** Media file helpers: format sniffing, base64 and data URLs, PCM → WAV, and TTS text chunks. */
import { concat, unb64 } from '../../core/bytes';
import { extensionFor } from '../../data/attachments';

/** A finished image, video or audio file. */
export interface MediaFile {
  bytes: Uint8Array;
  mimeType: string;
}

/** File extension for a MIME type ("audio/webm;codecs=opus" → "webm"). */
export function mediaExtension(mimeType: string): string {
  return extensionFor(mimeType.split(';')[0].trim());
}

/** Recognizes common image, audio and video formats from their first bytes. */
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => b.length > i + v.length && v.every((x, j) => b[i + j] === x);
  const ascii = (i: number, s: string) => {
    if (b.length < i + s.length) return false;
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) return false;
    return true;
  };
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'GIF8')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  if (ascii(0, 'ID3') || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'fLaC')) return 'audio/flac';
  if (ascii(4, 'ftyp')) return ascii(8, 'M4A') ? 'audio/mp4' : 'video/mp4';
  if (ascii(0, '\x1aE\xdf\xa3')) return 'video/webm';
  return null;
}

const isRawPcm = (mime: string) => {
  const m = mime.toLowerCase();
  return m.includes('l16') || m.includes('pcm');
};

/** Decodes base64 media; raw PCM keeps its full MIME type (with the rate) for normalizeAudio. */
export function fileFromBase64(data: string, mime: string | null): MediaFile {
  const bytes = unb64(data);
  if (mime != null && isRawPcm(mime)) return { bytes, mimeType: mime };
  const declared = mime?.split(';')[0].trim();
  return { bytes, mimeType: sniff(bytes) ?? (declared || 'application/octet-stream') };
}

export function fileFromDataUrl(url: string): MediaFile {
  const afterScheme = url.slice(url.indexOf('data:') + 5);
  const mime = afterScheme.split(';')[0];
  const comma = url.indexOf('base64,');
  return fileFromBase64(comma >= 0 ? url.slice(comma + 7) : url, mime);
}

/** Raw PCM (audio/l16 or audio/pcm) gets a WAV header so browsers and phones can play it. */
export function normalizeAudio(f: MediaFile): MediaFile {
  if (!isRawPcm(f.mimeType)) return f;
  const rate = Number(/rate=(\d+)/.exec(f.mimeType.toLowerCase())?.[1]) || 24_000;
  return { bytes: wav(f.bytes, rate), mimeType: 'audio/wav' };
}

/** A 16-bit PCM WAV file around [pcm]. */
export function wav(pcm: Uint8Array, sampleRate: number, channels = 1, bits = 16): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const tag = (offset: number, s: string) => {
    for (let i = 0; i < 4; i++) out[offset + i] = s.charCodeAt(i);
  };
  const byteRate = (sampleRate * channels * bits) / 8;
  tag(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, (channels * bits) / 8, true);
  v.setUint16(34, bits, true);
  tag(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

const CUTS = ['\n\n', '. ', '! ', '? ', '\n', '; ', ', ', ' '];

/** Splits long text at sentence or paragraph ends so each part fits a TTS request. */
export function chunks(text: string, max: number): string[] {
  const t = text.trim();
  if (t.length <= max) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = CUTS.map((sep) => {
      const i = window.lastIndexOf(sep);
      return i < 0 ? -1 : i + sep.length;
    }).find((i) => i > Math.floor(max / 2)) ?? max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Runs [one] for each part in order and joins the audio (MP3 frames concatenate cleanly). */
export async function concatParts(parts: string[], one: (part: string) => Promise<MediaFile>): Promise<MediaFile> {
  if (parts.length === 1) return one(parts[0]);
  const files: Uint8Array[] = [];
  let mimeType = 'audio/mpeg';
  for (const p of parts) {
    const f = await one(p);
    mimeType = f.mimeType;
    files.push(f.bytes);
  }
  return { bytes: concat(...files), mimeType };
}
