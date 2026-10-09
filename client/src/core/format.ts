/** Number, size and date formatting (mirrors Format/Dates on Android). */

export const Format = {
  tokens(n: number): string {
    if (n < 1_000) return String(n);
    if (n < 100_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1_000_000) return Math.floor(n / 1_000) + 'k';
    return (n / 1_000_000).toFixed(2) + 'M';
  },
  cost(usd: number): string {
    if (usd <= 0) return '$0';
    if (usd < 0.0001) return '<$0.0001';
    if (usd < 0.01) return '$' + usd.toFixed(4);
    if (usd < 1) return '$' + usd.toFixed(3);
    return '$' + usd.toFixed(2);
  },
  bytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  },
  seconds(ms: number): string {
    const s = Math.max(1, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  },
  contextWindow(tokens: number): string {
    if (tokens >= 1_000_000) return `${Math.floor(tokens / 1_000_000)}M`;
    if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}K`;
    return String(tokens);
  },
};

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysBetween(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

export const Dates = {
  /** Section label for a conversation list grouped by recency. */
  bucketLabel(ms: number, now = Date.now()): string {
    const days = daysBetween(ms, now);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'Previous 7 days';
    if (days < 30) return 'Previous 30 days';
    return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  },
  short(ms: number, now = Date.now()): string {
    if (daysBetween(ms, now) === 0) return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  },
  relative(ms: number, now = Date.now()): string {
    const min = Math.floor(Math.max(0, now - ms) / 60_000);
    if (min < 1) return 'Just now';
    if (min < 60) return `${min} min ago`;
    if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
    return Dates.short(ms, now);
  },
  isoDate(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
};
