const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Time-sortable 22-char id: 10 chars of millisecond time + 12 random chars (base32), as on Android.
 * Sorting ids lexicographically sorts by creation time, which keeps branches ordered.
 */
export function newId(now = Date.now()): string {
  let t = now;
  const time: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = ALPHABET[t % 32];
    t = Math.floor(t / 32);
  }
  const rnd = new Uint8Array(12);
  crypto.getRandomValues(rnd);
  let out = time.join('');
  for (const b of rnd) out += ALPHABET[b & 31];
  return out;
}

export const now = (): number => Date.now();
