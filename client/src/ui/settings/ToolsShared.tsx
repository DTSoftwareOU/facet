/** Small building blocks shared by the Tools and Computer access pages. Styles: screens.css ("Tools and Computer access"). */
import { ChevronRight, CircleCheck, Eye, EyeOff, Info, Plus, TriangleAlert, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Button, IconButton } from '../components/primitives';

/** The message of an error, or [fallback] when it has none. */
export function errorText(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return m.trim() || fallback;
}

/** [text] ending in a full stop, so another sentence can follow. */
export function sentence(text: string): string {
  const t = text.trim();
  return !t || /[.!?…]["”’)]?$/.test(t) ? t : t + '.';
}

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

/** The first sentence of a description, without Markdown backticks. */
export function firstSentence(text: string | null | undefined, max = 160): string {
  const t = (text ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.+?[.!?])(?=\s+[A-Z(]|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * A callback whose identity never changes but always calls the latest [fn]. Dialog re-runs its
 * focus effect when onClose changes, so dialogs get a stable one.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** A heading for a sub-page (the settings header keeps the page's own title). */
export function ToolsSubhead({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="tools-subhead">
      <div className="col grow gap-4">
        <h3 className="t-title-m" style={{ margin: 0 }}>{title}</h3>
        {subtitle && <p className="t-body c-2" style={{ margin: 0 }}>{subtitle}</p>}
      </div>
      {actions && <div className="tools-actions">{actions}</div>}
    </div>
  );
}

/** A result or problem shown in place: green when it worked, red when it didn't, amber for warnings. */
export function ToolsStatus({ tone, children, action }: { tone: 'ok' | 'error' | 'warning' | 'info'; children: ReactNode; action?: ReactNode }) {
  const icon =
    tone === 'ok' ? <CircleCheck size={18} /> : tone === 'info' ? <Info size={18} /> : <TriangleAlert size={18} />;
  return (
    <div className={'tools-status ' + tone} role={tone === 'error' ? 'alert' : 'status'}>
      {icon}
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

/**
 * A settings row whose main area is a button and whose trailing controls (switches, chips) sit
 * beside it, so the markup never nests buttons. [onClick] gets the event (for anchoring menus).
 */
export function ToolsRow({ icon, title, subtitle, onClick, trailing, chevron, tone, disabled, label }: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  trailing?: ReactNode;
  chevron?: boolean;
  tone?: 'primary' | 'danger';
  disabled?: boolean;
  /** Accessible name when [title] isn't plain text. */
  label?: string;
}) {
  const body = (
    <>
      {icon && <span className="srow-icon">{icon}</span>}
      <span className="srow-text">
        <span className="srow-title">{title}</span>
        {subtitle && <span className="srow-sub">{subtitle}</span>}
      </span>
      {(chevron ?? (!!onClick && !trailing)) && <ChevronRight size={18} className="srow-chevron" />}
    </>
  );
  return (
    <div className={'srow tools-row' + (tone ? ' ' + tone : '') + (onClick ? ' link' : '')}>
      {onClick ? (
        <button type="button" className="tools-row-main" onClick={onClick} disabled={disabled} aria-label={label}>
          {body}
        </button>
      ) : (
        <div className="tools-row-main">{body}</div>
      )}
      {trailing && <div className="tools-row-trailing">{trailing}</div>}
    </div>
  );
}

/** A small on/off chip, e.g. "Always allow" on a tool. */
export function ToolsToggleChip({ on, onChange, children, title, disabled, icon }: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** The label; on narrow pages chips with an icon show only the icon. */
  children: string;
  title?: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={'chip tools-chip' + (on ? ' on' : '')}
      aria-pressed={on}
      aria-label={children}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
    >
      {icon}
      <span className={icon ? 'tools-chip-text' : undefined}>{children}</span>
    </button>
  );
}

/** A password-style input with a show/hide button. */
export function ToolsSecretInput({ value, onChange, placeholder, label, autoFocus, onEnter }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="tools-secret">
      <input
        className="input mono"
        type={shown ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
      />
      <IconButton small label={shown ? 'Hide' : 'Show'} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff size={17} /> : <Eye size={17} />}
      </IconButton>
    </span>
  );
}

export interface KeyValue {
  key: string;
  value: string;
}

export const toPairs = (r: Record<string, string>): KeyValue[] => Object.entries(r).map(([key, value]) => ({ key, value }));

export function fromPairs(rows: KeyValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value.trim();
  return out;
}

/**
 * Edits secret name/value pairs (HTTP headers, environment variables). Values are hidden until
 * "Show values". Pasting "Name: value" (or NAME=value) lines into a name field splits them into rows.
 */
export function ToolsKeyValues({ rows, onChange, separator, keyPlaceholder, valuePlaceholder, addLabel, keyLabel, valueLabel }: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  /** How pasted lines separate name and value: ':' for headers, '=' for environment variables. */
  separator: ':' | '=';
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  keyLabel: string;
  valueLabel: string;
}) {
  const [shown, setShown] = useState(false);
  const set = (i: number, patch: Partial<KeyValue>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((l) => {
      const at = l.indexOf(separator);
      return at > 0 ? { key: l.slice(0, at).trim(), value: l.slice(at + 1).trim() } : null;
    });
    if (parsed.length === 0 || parsed.some((p) => !p || !p.key || /\s/.test(p.key))) return;
    e.preventDefault();
    const next = [...rows];
    next.splice(i, 1, ...(parsed as KeyValue[]));
    onChange(next);
  };
  return (
    <div className="tools-kv">
      {rows.map((r, i) => (
        <div className="tools-kv-row" key={i}>
          <input
            className="input mono"
            value={r.key}
            placeholder={keyPlaceholder}
            aria-label={`${keyLabel} ${i + 1}`}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set(i, { key: e.target.value })}
            onPaste={(e) => onPaste(i, e)}
          />
          <input
            className="input mono"
            type={shown ? 'text' : 'password'}
            value={r.value}
            placeholder={valuePlaceholder}
            aria-label={`${valueLabel} ${i + 1}`}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <IconButton small label={`Remove ${r.key.trim() || 'row'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X size={16} />
          </IconButton>
        </div>
      ))}
      <div className="row gap-8">
        <Button variant="text" small onClick={() => onChange([...rows, { key: '', value: '' }])}>
          <Plus size={15} /> {addLabel}
        </Button>
        {rows.some((r) => r.value) && (
          <Button variant="text" small onClick={() => setShown(!shown)}>
            {shown ? <EyeOff size={15} /> : <Eye size={15} />} {shown ? 'Hide values' : 'Show values'}
          </Button>
        )}
      </div>
    </div>
  );
}
