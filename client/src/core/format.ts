/** Number, size and date formatting (mirrors Format/Dates on Android), in the interface language. */
import { formatNumber, locale, t } from '../i18n';

function unit(n: number, unit: 'second' | 'minute' | 'hour'): string {
  return formatNumber(n, { style: 'unit', unit, unitDisplay: 'narrow' });
}

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
  /** A duration such as "5s" or "1m 5s" (in the interface language's units). */
  seconds(ms: number): string {
    const s = Math.max(1, Math.floor(ms / 1000));
    return s < 60 ? unit(s, 'second') : `${unit(Math.floor(s / 60), 'minute')} ${unit(s % 60, 'second')}`;
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
    if (days <= 0) return t('Today');
    if (days === 1) return t('Yesterday');
    if (days < 7) return t('Previous 7 days');
    if (days < 30) return t('Previous 30 days');
    return new Date(ms).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
  },
  short(ms: number, now = Date.now()): string {
    if (daysBetween(ms, now) === 0) return new Date(ms).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
    return new Date(ms).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
  },
  /**
   * Under a minute ago: Dates.relative() says "Just now". In a sentence, use a whole sentence for
   * this case instead: justNow(ms) ? t('Synced just now') : t('Synced {time}', { time: Dates.relative(ms) }).
   */
  justNow(ms: number, now = Date.now()): boolean {
    return now - ms < 60_000;
  },
  /** "Just now", "5 min. ago", "3 hr. ago" (in the interface language), then a short date. */
  relative(ms: number, now = Date.now()): string {
    const min = Math.floor(Math.max(0, now - ms) / 60_000);
    if (min < 1) return t('Just now');
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'always', style: 'short' });
    if (min < 60) return rtf.format(-min, 'minute');
    if (min < 24 * 60) return rtf.format(-Math.floor(min / 60), 'hour');
    return Dates.short(ms, now);
  },
  /** A full date and time, e.g. for "last synced" details. */
  dateTime(ms: number): string {
    return new Date(ms).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  },
  /** A date without time. */
  date(ms: number): string {
    return new Date(ms).toLocaleDateString(locale(), { dateStyle: 'medium' });
  },
  isoDate(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
};
