import type { RateLimitRule } from './config.js';
import { errors } from './errors.js';

/** In-memory sliding-window limiter. Good enough for a single-node deployment. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /**
   * Records a hit for `key` and throws `rate_limited` when the rule is exceeded.
   */
  hit(key: string, rule: RateLimitRule): void {
    const retry = this.check(key, rule);
    if (retry > 0) throw errors.rateLimited(retry);
    this.record(key, rule);
  }

  /** Seconds until a new hit would be allowed (0 = allowed now). Doesn't record. */
  check(key: string, rule: RateLimitRule): number {
    const now = this.now();
    const list = this.prune(key, rule, now);
    if (list.length < rule.max) return 0;
    const oldest = list[0]!;
    return Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
  }

  record(key: string, rule: RateLimitRule): void {
    const now = this.now();
    const list = this.prune(key, rule, now);
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  close(): void {
    clearInterval(this.sweeper);
    this.hits.clear();
  }

  private prune(key: string, rule: RateLimitRule, now: number): number[] {
    const list = this.hits.get(key) ?? [];
    const cutoff = now - rule.windowMs;
    let i = 0;
    while (i < list.length && list[i]! <= cutoff) i++;
    return i > 0 ? list.slice(i) : list;
  }

  private sweep(): void {
    const now = this.now();
    const maxWindow = 60 * 60 * 1000;
    for (const [key, list] of this.hits) {
      const last = list[list.length - 1];
      if (last === undefined || last < now - maxWindow) this.hits.delete(key);
    }
  }
}
