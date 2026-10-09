/** Small, shared UI building blocks. Styles live in ui/styles/base.css. */
import { ChevronRight, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type BtnStyle = 'primary' | 'tonal' | 'outline' | 'text' | 'danger';

export function Button({ variant = 'primary', small, block, busy, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnStyle;
  small?: boolean;
  block?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={['btn', `btn-${variant}`, small && 'btn-sm', block && 'btn-block', className].filter(Boolean).join(' ')}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function IconButton({ label, small, active, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  small?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={['icon-btn', small && 'sm', active && 'active', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function Group({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section>
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group">{children}</div>
      {footer && <p className="field-hint" style={{ margin: '8px 6px 0' }}>{footer}</p>}
    </section>
  );
}

export function Divider({ full }: { full?: boolean }) {
  return <div className={'group-divider' + (full ? ' full' : '')} />;
}

/** A settings row: icon, title, subtitle, and a chevron or trailing control. */
export function Row({ icon, title, subtitle, onClick, trailing, chevron, danger, disabled }: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  onClick?: () => void;
  trailing?: ReactNode;
  chevron?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const content = (
    <>
      {icon && <span className="srow-icon" style={danger ? { color: 'var(--error)' } : undefined}>{icon}</span>}
      <span className="srow-text">
        <span className="srow-title" style={danger ? { color: 'var(--error)' } : undefined}>{title}</span>
        {subtitle && <span className="srow-sub">{subtitle}</span>}
      </span>
      {trailing}
      {(chevron ?? (onClick && !trailing)) && <ChevronRight size={18} className="srow-chevron" />}
    </>
  );
  if (onClick && trailing) {
    // Trailing controls are often buttons themselves, and buttons can't nest.
    return (
      <div
        className={'srow' + (disabled ? '' : ' clickable')}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && onClick()}
        onKeyDown={(e) => {
          if (disabled || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          onClick();
        }}
      >
        {content}
      </div>
    );
  }
  if (onClick) {
    return (
      <button type="button" className="srow" onClick={onClick} disabled={disabled}>
        {content}
      </button>
    );
  }
  return <div className="srow">{content}</div>;
}

export function SwitchRow({ icon, title, subtitle, checked, onChange, disabled }: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={'srow' + (disabled ? '' : ' clickable')} onClick={() => !disabled && onChange(!checked)}>
      {icon && <span className="srow-icon">{icon}</span>}
      <span className="srow-text">
        <span className="srow-title">{title}</span>
        {subtitle && <span className="srow-sub">{subtitle}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={typeof title === 'string' ? title : undefined} />
    </div>
  );
}

export function Field({ label, hint, error, children }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

// ---- Dialog ----

export function Dialog({ title, onClose, children, footer, size, labelledBy, closeOnScrim = true }: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'wide' | 'narrow';
  labelledBy?: string;
  closeOnScrim?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers often pass a new onClose each render; the effect must run once, or focus would jump.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, [data-autofocus]');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Only the topmost layer closes, and an open menu closes before its dialog.
      const scrims = document.querySelectorAll('.scrim');
      if (scrims[scrims.length - 1] !== ref.current?.parentElement || document.querySelector('.menu')) return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => closeOnScrim && e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={'dialog' + (size ? ' ' + size : '')} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        {title !== undefined && (
          <div className="dialog-head">
            <div className="dialog-title">{title}</div>
            <IconButton label="Close" onClick={onClose}>
              <X size={20} />
            </IconButton>
          </div>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A yes/no question. */
export function Confirm({ title, body, confirm, danger, onConfirm, onClose }: {
  title: string;
  body?: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {body && <div className="t-body c-2">{body}</div>}
    </Dialog>
  );
}

/** Asks for one line of text (window.prompt doesn't exist in the Windows app). */
export function TextPrompt({ title, label, initial = '', confirm, onSubmit, onClose }: {
  title: string;
  label?: string;
  initial?: string;
  confirm: string;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = async () => {
    if (!value.trim()) return;
    await onSubmit(value.trim());
    onClose();
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!value.trim()}>{confirm}</Button>
        </>
      }
    >
      <Field label={label}>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
    </Dialog>
  );
}

// ---- Menu ----

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

/** A popup menu anchored to an element or a point. */
export function Menu({ anchor, items, onClose, align = 'start' }: {
  anchor: HTMLElement | { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
  align?: 'start' | 'end';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left: number;
    let top: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      left = align === 'end' ? r.right - w : r.left;
      top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    } else {
      left = anchor.x;
      top = anchor.y;
      if (top + h > window.innerHeight - 8) top = anchor.y - h;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, top);
    setPos({ left, top });
    el.querySelector<HTMLElement>('.menu-item')?.focus();
  }, [anchor, align]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('.menu-item') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={pos ? pos : { left: -9999, top: -9999 }}>
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="menu-sep" />}
          <button
            type="button"
            role="menuitem"
            className={'menu-item' + (item.danger ? ' danger' : '')}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Menu state for a trigger button: `open(e)` anchors to the clicked element. */
export function useMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | { x: number; y: number } | null>(null);
  const open = useCallback((e: { currentTarget: EventTarget }) => setAnchor(e.currentTarget as HTMLElement), []);
  const openAt = useCallback((x: number, y: number) => setAnchor({ x, y }), []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open, openAt, close };
}

// ---- Toasts ----

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(text: string, action?: Toast['action']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 6000 : 3800);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {createPortal(
        <div className="toast-host" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <span>{t.text}</span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action!.run();
                    setToasts((all) => all.filter((x) => x.id !== t.id));
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/** Shows a short notice at the bottom of the window, optionally with an action ("Undo"). */
export function useToast() {
  return useContext(ToastContext);
}
