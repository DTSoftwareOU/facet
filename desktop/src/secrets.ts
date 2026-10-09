/**
 * Local secrets at rest. "d1:" = Electron safeStorage (Windows DPAPI, bound to the Windows user).
 * When OS encryption isn't available, "d0:" = AES-256-GCM with a random key kept in the app's
 * data folder, so the app still works (weaker: anyone who can read the folder can decrypt).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class Secrets {
  private keyPromise: Promise<Buffer> | null = null;

  constructor(
    private readonly safe: SafeStorageLike,
    private readonly dataDir: string,
  ) {}

  private fallbackKey(): Promise<Buffer> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const file = path.join(this.dataDir, 'local-secret.key');
        try {
          const k = Buffer.from((await fsp.readFile(file, 'utf8')).trim(), 'base64');
          if (k.length === 32) return k;
        } catch {
          /* create */
        }
        const k = randomBytes(32);
        await fsp.mkdir(this.dataDir, { recursive: true });
        await fsp.writeFile(file, k.toString('base64'), { mode: 0o600 });
        return k;
      })().catch((e: unknown) => {
        this.keyPromise = null;
        throw e;
      });
    }
    return this.keyPromise;
  }

  async seal(plainB64: string): Promise<string> {
    if (typeof plainB64 !== 'string') throw new Error('seal expects base64 text.');
    if (this.safe.isEncryptionAvailable()) {
      return `d1:${this.safe.encryptString(plainB64).toString('base64')}`;
    }
    const key = await this.fallbackKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plainB64, 'utf8'), cipher.final()]);
    return `d0:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
  }

  async open(sealed: string): Promise<string> {
    if (typeof sealed !== 'string') throw new Error('Not a sealed secret.');
    if (sealed.startsWith('d1:')) {
      if (!this.safe.isEncryptionAvailable()) throw new Error("Windows can't decrypt this secret right now (DPAPI unavailable).");
      return this.safe.decryptString(Buffer.from(sealed.slice(3), 'base64'));
    }
    if (sealed.startsWith('d0:')) {
      const raw = Buffer.from(sealed.slice(3), 'base64');
      if (raw.length < 28) throw new Error('The sealed secret is damaged.');
      const key = await this.fallbackKey();
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    }
    throw new Error('Unknown secret format.');
  }
}
