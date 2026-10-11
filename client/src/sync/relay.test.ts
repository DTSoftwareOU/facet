import { describe, expect, it } from 'vitest';
import { b64, unb64 } from '../core/bytes';
import { DecryptionError } from '../core/crypto';
import { openRelay, relayKey, ReplayGuard, sealRelay } from './relay';

// Shared with the Android tests (docs/REMOTE.md): vault key = bytes 0..31, nonce = twelve 0x07 bytes.
const VAULT = new Uint8Array(32).map((_, i) => i);
const NONCE = new Uint8Array(12).fill(7);
const SMALL_JSON = '{"v":1,"id":"msg-0001-abcdefgh","ts":1760000000000,"type":"hello"}';
const SMALL = 'AQAHBwcHBwcHBwcHBwco5etj3MZ1O0AcAYo6sg/2ELJhqlNKT/V8JWweomY3ddGCWQ6K2Dn7CCxx06k3ySjLkqvv6vzL1T0QUn+wsi0+XeSV3sIe45wvWXrITrhvlBJQ';
const BIG =
  'AQEHBwcHBwcHBwcHBwe+DKxPJMdVX8jD38My+nCxRGVHtsMSZdNX0eosh1v6l/Xqqv3fEbh6WRlEZK2GCXAwQjryknSB/iMFRy+93cSCruZ5ZiATT4coRQlPofP7bYINaThOj42w3awQsPui/0pbvUQwLLjrxVPTOAGOzvH9bLFpGwAm9KkZfEr5BhC5pdGilLSDVTQkbM4=';

describe('relay envelope', () => {
  it('matches the shared vectors', async () => {
    const key = await relayKey(VAULT);
    expect(b64(await sealRelay(key, 'sessA', 'sessB', SMALL_JSON, NONCE))).toBe(SMALL);
    expect(await openRelay(key, 'sessA', 'sessB', unb64(SMALL))).toBe(SMALL_JSON);
    const big = JSON.parse(await openRelay(key, 'sessA', 'sessB', unb64(BIG)));
    expect(big.type).toBe('result');
    expect(big.value.content).toBe('line\n'.repeat(400));
  });

  it('compresses large bodies and round-trips', async () => {
    const key = await relayKey(VAULT);
    const json = JSON.stringify({ text: 'abc '.repeat(5000) });
    const sealed = await sealRelay(key, 'a', 'b', json);
    expect(sealed[1] & 1).toBe(1);
    expect(sealed.length).toBeLessThan(json.length / 4);
    expect(await openRelay(key, 'a', 'b', sealed)).toBe(json);
  });

  it('rejects a message relabeled with another sender or recipient', async () => {
    const key = await relayKey(VAULT);
    const sealed = await sealRelay(key, 'sessA', 'sessB', SMALL_JSON);
    await expect(openRelay(key, 'sessC', 'sessB', sealed)).rejects.toBeInstanceOf(DecryptionError);
    await expect(openRelay(key, 'sessA', 'sessC', sealed)).rejects.toBeInstanceOf(DecryptionError);
    await expect(openRelay(await relayKey(new Uint8Array(32)), 'sessA', 'sessB', sealed)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe('ReplayGuard', () => {
  it('drops repeats and stale messages', () => {
    const g = new ReplayGuard();
    const now = 1_760_000_000_000;
    expect(g.accept('id-00000001', now, now)).toBe(true);
    expect(g.accept('id-00000001', now, now + 1000)).toBe(false);
    expect(g.accept('id-00000002', now - 11 * 60_000, now)).toBe(false);
    expect(g.accept('id-00000003', now + 11 * 60_000, now)).toBe(false);
    expect(g.accept('short', now, now)).toBe(false);
    expect(g.accept('id-00000004', 'x', now)).toBe(false);
  });

  it('forgets old ids', () => {
    const g = new ReplayGuard(10 * 60_000, 60_000);
    const now = 1_760_000_000_000;
    expect(g.accept('id-00000001', now, now)).toBe(true);
    expect(g.accept('id-00000002', now + 120_000, now + 120_000)).toBe(true);
    expect(g.accept('id-00000001', now + 120_000, now + 120_000)).toBe(true);
  });
});
