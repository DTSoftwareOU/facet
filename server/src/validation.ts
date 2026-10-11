import { z } from 'zod';
import { errors } from './errors.js';

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes standard base64 (padding optional, whitespace ignored). Returns null when malformed. */
export function decodeB64(input: string): Buffer | null {
  const s = input.replace(/\s+/g, '');
  if (!B64_RE.test(s)) return null;
  const unpadded = s.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  return Buffer.from(unpadded, 'base64');
}

export function b64(opts: { length?: number; min?: number; max?: number } = {}) {
  return z.string().transform((value, ctx) => {
    const bytes = decodeB64(value);
    if (!bytes) {
      ctx.addIssue({ code: 'custom', message: 'must be base64' });
      return z.NEVER;
    }
    if (opts.length !== undefined && bytes.length !== opts.length) {
      ctx.addIssue({ code: 'custom', message: `must decode to ${opts.length} bytes` });
      return z.NEVER;
    }
    if (opts.min !== undefined && bytes.length < opts.min) {
      ctx.addIssue({ code: 'custom', message: `must decode to at least ${opts.min} bytes` });
      return z.NEVER;
    }
    if (opts.max !== undefined && bytes.length > opts.max) {
      ctx.addIssue({ code: 'custom', message: `must decode to at most ${opts.max} bytes` });
      return z.NEVER;
    }
    return bytes;
  });
}

export const AUTH_HASH_BYTES = 32;
export const WRAPPED_KEY_BYTES = 61;
export const SALT_BYTES = 16;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .refine((v) => /^[^\s@]+@[^\s@]+$/.test(v), 'must be a valid email address');

export const authHashSchema = b64({ length: AUTH_HASH_BYTES });
export const wrappedKeySchema = b64({ length: WRAPPED_KEY_BYTES });

export const kdfSchema = z.object({
  algorithm: z.literal('pbkdf2-sha256'),
  iterations: z.number().int().min(100_000).max(5_000_000),
  salt: b64({ length: SALT_BYTES }),
});
export type KdfInput = z.infer<typeof kdfSchema>;

export const recoverySchema = z.object({
  authHash: authHashSchema,
  wrappedVaultKey: wrappedKeySchema,
});

const PLATFORMS = ['android', 'web', 'windows', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const deviceSchema = z
  .object({
    name: z.string().trim().max(80).optional(),
    platform: z.string().optional(),
  })
  .optional()
  .transform((d) => ({
    name: d?.name && d.name.length > 0 ? d.name : 'Unknown device',
    platform: (PLATFORMS as readonly string[]).includes(d?.platform ?? '') ? (d!.platform as Platform) : ('other' as Platform),
  }));
export type DeviceInput = z.infer<typeof deviceSchema>;

export const displayNameSchema = z
  .string()
  .trim()
  .max(80)
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

export const recordIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 chars of [A-Za-z0-9_-]');
export const recordTypeSchema = z.string().regex(/^[a-z_]{1,24}$/, 'must be 1-24 chars of [a-z_]');

export function parse<S extends z.ZodType>(schema: S, data: unknown, prefix?: string): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const segments = [...(prefix ? [prefix] : []), ...(issue?.path ?? []).map(String)];
    const where = segments.length > 0 ? segments.join('.') : 'body';
    throw errors.invalid(`${where}: ${issue?.message ?? 'is invalid'}`);
  }
  return result.data;
}
