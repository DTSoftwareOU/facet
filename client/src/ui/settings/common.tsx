/** Small pieces shared by the Providers, Assistants, Prompt library and Media models pages. */
import { Check, ChevronRight, CircleAlert, CircleCheck, Eye, EyeOff, Info, Search, TriangleAlert, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { msg, t, tm } from '../../i18n';
import type { ProviderKind } from '../../llm/providers';
import { platform } from '../../platform';
import { IconButton } from '../components/primitives';

/**
 * A callback whose identity never changes but always runs the latest [fn]. Dialog re-runs its
 * focus effect whenever onClose changes, so dialogs with their own state need a stable one.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** On the website: this provider refuses requests from web pages, so only the apps can use it. */
export function browserBlocked(kind: ProviderKind): boolean {
  return platform().corsLimited && !kind.browserOk;
}

export const BLOCKED_HINT = msg('This provider doesn’t accept requests from web browsers. It works in the Facet app for Windows and Android.');

/** BLOCKED_HINT in the interface language. */
export function blockedHint(): string {
  return tm(BLOCKED_HINT);
}

export function BlockedBadge() {
  return (
    <span className="badge warning" title={blockedHint()} style={{ flex: 'none' }}>
      {t('Windows and Android only')}
    </span>
  );
}

/** A user-facing message from a thrown value. Inside Providers, "Check it in Providers." is noise. */
export function errorText(e: unknown, fallback: string): string {
  const text = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim() || fallback;
  const hint = t('Check it in Providers.');
  return text.endsWith(hint) ? text.slice(0, -hint.length).trim() : text;
}

export function Notice({ tone = 'info', children }: { tone?: 'ok' | 'error' | 'warn' | 'info'; children: ReactNode }) {
  const icon =
    tone === 'ok' ? <CircleCheck size={18} />
      : tone === 'error' ? <CircleAlert size={18} />
        : tone === 'warn' ? <TriangleAlert size={18} />
          : <Info size={18} />;
  return (
    <div className={'notice settings-notice ' + tone} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice-icon" aria-hidden>{icon}</span>
      <span className="grow">{children}</span>
    </div>
  );
}

/** A small caption above a control that isn't a text field (segmented buttons, chips). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="field-label section-label">{children}</span>;
}

/** A divider indented to line up with row text after a leading element of [inset] px. */
export function Sep({ inset = 56 }: { inset?: number }) {
  return <div className="group-divider" style={{ marginInlineStart: inset }} />;
}

/** A group drawn as an outline, for use inside dialogs (whose background is already the surface color). */
export function OutlinedGroup({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section>
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group outlined">{children}</div>
    </section>
  );
}

/**
 * A settings row. With [trailing] buttons, the row body is one button and the trailing actions
 * are separate buttons beside it (never nested). [aside] is non-interactive content (badges).
 */
export function ActionRow({ leading, icon, title, subtitle, subLines = 'wrap', onClick, trailing, aside, chevron, compact, dim, disabled }: {
  leading?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  subLines?: 1 | 2 | 'wrap';
  onClick?: () => void;
  trailing?: ReactNode;
  aside?: ReactNode;
  chevron?: boolean;
  compact?: boolean;
  dim?: boolean;
  disabled?: boolean;
}) {
  const cls = ['srow', compact && 'compact', dim && 'dim'].filter(Boolean).join(' ');
  const subCls = 'srow-sub' + (subLines === 1 ? ' ellipsis' : subLines === 2 ? ' clamp-2' : '');
  const body = (
    <>
      {leading ?? (icon ? <span className="srow-icon">{icon}</span> : null)}
      <span className="srow-text">
        <span className="srow-title ellipsis">{title}</span>
        {subtitle ? <span className={subCls}>{subtitle}</span> : null}
      </span>
      {aside}
      {chevron && <ChevronRight size={18} className="srow-chevron flip-rtl" />}
    </>
  );
  if (!onClick) {
    return (
      <div className={cls}>
        {body}
        {trailing}
      </div>
    );
  }
  if (!trailing) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled}>
        {body}
      </button>
    );
  }
  return (
    <div className={cls + ' split'}>
      <button type="button" className="srow-main" onClick={onClick} disabled={disabled}>
        {body}
      </button>
      <span className="srow-trailing">{trailing}</span>
    </div>
  );
}

/** One option in a pick-one list (media models, voices). */
export function ChoiceRow({ leading, title, subtitle, checked, disabled, hint, onClick }: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={'srow choice' + (checked ? ' selected' : '')}
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-current={checked ? 'true' : undefined}
      // Dialog focuses the first [data-autofocus] element: start on the current choice.
      data-autofocus={checked ? '' : undefined}
    >
      {leading}
      <span className="srow-text">
        <span className="srow-title ellipsis">{title}</span>
        {subtitle ? <span className="srow-sub ellipsis">{subtitle}</span> : null}
      </span>
      {checked && (
        <>
          <Check size={20} className="c-primary" aria-hidden style={{ flex: 'none' }} />
          <span className="sr-only">{t('Selected')}</span>
        </>
      )}
    </button>
  );
}

/** Pick one of a few options, drawn as chips that wrap on narrow screens. */
export function ChipChoice<T>({ options, selected, label, onSelect, ariaLabel }: {
  options: readonly T[];
  selected: T;
  label: (t: T) => string;
  onSelect: (t: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="pill-list" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o, i) => (
        <button key={i} type="button" role="radio" aria-checked={o === selected} className={'chip' + (o === selected ? ' on' : '')} onClick={() => onSelect(o)}>
          {label(o)}
        </button>
      ))}
    </div>
  );
}

export function FilterBox({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <div className="row search-box filter-box">
      <Search size={17} className="c-3" aria-hidden style={{ flex: 'none' }} />
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        onKeyDown={(e) => {
          // Escape clears the filter first instead of closing the dialog.
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <IconButton small label={t('Clear')} onClick={() => onChange('')}>
          <X size={16} />
        </IconButton>
      )}
    </div>
  );
}

/** A password-style field with a show/hide toggle (for API keys). */
export function SecretInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-wrap">
      <input
        className="input mono"
        dir="ltr"
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
      />
      <IconButton small label={shown ? t('Hide key') : t('Show key')} onClick={() => setShown((s) => !s)}>
        {shown ? <EyeOff size={17} /> : <Eye size={17} />}
      </IconButton>
    </div>
  );
}
