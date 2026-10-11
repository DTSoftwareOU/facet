import { memo, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from 'react';
import { onRendererLoaded, renderMarkdown, rendererVersion } from './render';

const COPY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const WRAP_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 16-2 2 2 2"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="M3 18h7"/><path d="M3 6h18"/></svg>';

function decorate(root: HTMLElement) {
  for (const b of root.querySelectorAll<HTMLButtonElement>('button[data-md]')) {
    if (b.dataset.ready) continue;
    b.dataset.ready = '1';
    b.innerHTML = b.dataset.md === 'copy' ? COPY_ICON : WRAP_ICON;
  }
}

/** A rendered reply. Code blocks get copy and wrap buttons (event delegation keeps the HTML static). */
export const Markdown = memo(function Markdown({ text, streaming = false, className }: { text: string; streaming?: boolean; className?: string }) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => onRendererLoaded(rerender), []);
  const v = rendererVersion();
  const html = useMemo(() => renderMarkdown(text, streaming), [text, streaming, v]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) decorate(ref.current);
  }, [html]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-md]');
    if (!btn) return;
    const block = btn.closest('.md-code');
    const code = block?.querySelector('code')?.textContent ?? '';
    if (btn.dataset.md === 'copy') {
      void navigator.clipboard.writeText(code).then(() => {
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => (btn.innerHTML = COPY_ICON), 1400);
      });
    } else {
      block?.classList.toggle('wrap');
    }
  };

  // dir="auto": a reply follows its own language's direction (an English reply in an Arabic interface reads left to right).
  return <div ref={ref} dir="auto" className={'md' + (className ? ' ' + className : '')} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * Reveals streamed text at a steady, adaptive cadence (40–400 chars/s) instead of in network
 * bursts, so long answers never stutter. Returns the full text as soon as streaming ends.
 */
export function useSmoothedText(target: string, streaming: boolean, reduced = false): string {
  const [shown, setShown] = useState(target);
  const state = useRef({ shown: target.length, last: 0, target });
  state.current.target = target;
  useEffect(() => {
    if (!streaming || reduced) {
      state.current.shown = target.length;
      setShown(target);
      return;
    }
    let frame = 0;
    const tick = (t: number) => {
      const s = state.current;
      const dt = s.last ? Math.min(100, t - s.last) : 16;
      s.last = t;
      const backlog = s.target.length - s.shown;
      if (backlog > 0) {
        // Faster when far behind, slower near the end, so the cursor never waits long.
        const rate = Math.min(400, Math.max(40, backlog * 4));
        s.shown = Math.min(s.target.length, s.shown + Math.max(1, Math.round((rate * dt) / 1000)));
        // Don't stop in the middle of a surrogate pair.
        const code = s.target.charCodeAt(s.shown - 1);
        if (code >= 0xd800 && code <= 0xdbff) s.shown++;
        setShown(s.target.slice(0, s.shown));
      } else if (s.shown > s.target.length) {
        s.shown = s.target.length;
        setShown(s.target);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [streaming, reduced]);
  return streaming && !reduced ? shown : target;
}
