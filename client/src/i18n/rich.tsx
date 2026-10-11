import { Fragment, type ReactNode } from 'react';
import { format, lookup, type Vars } from './index';

/**
 * Translates [source] and puts elements into its {placeholders}, so a sentence with a link or
 * bold text stays one translatable string:
 *   tRich('Read the {terms} first.', { terms: <a href={…}>{t('terms of use')}</a> })
 * Placeholders with plain strings or numbers are filled as t() does.
 */
export function tRich(source: string, vars: Record<string, ReactNode>): ReactNode {
  const text = lookup(source);
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    const name = m[1];
    if (!(name in vars)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    const v = vars[name];
    out.push(typeof v === 'string' || typeof v === 'number' ? format(`{${name}}`, { [name]: v } as Vars) : <Fragment key={key++}>{v}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
