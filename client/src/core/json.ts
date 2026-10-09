/** Tolerant JSON helpers: stored JSON comes from other app versions and other platforms. */

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    const v = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * JSON.stringify that omits null/undefined object fields, like the Android app's
 * `explicitNulls = false`, so records keep the same shape across platforms.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (isObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) out[k] = x;
      return out;
    }
    return v;
  });
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
