/**
 * Markdown → HTML for replies: GitHub-flavored Markdown (tables, task lists, strikethrough,
 * autolinks), LaTeX math ($…$, $$…$$, \(…\), \[…\]) and highlighted code blocks. Raw HTML in
 * model output is escaped, never rendered. KaTeX and highlight.js load on first use; until then
 * math and code render as plain text, and listeners re-render once they arrive.
 */
import markdownIt, { type MarkdownIt, type StateBlock, type StateInline, type Token } from 'markdown-it';

type Katex = typeof import('katex').default;
type Hljs = typeof import('highlight.js').default;

let katex: Katex | null = null;
let hljs: Hljs | null = null;
let katexLoading: Promise<void> | null = null;
let hljsLoading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Bumps whenever a lazy renderer arrives, so cached HTML is rebuilt. */
let version = 0;

export function rendererVersion(): number {
  return version;
}

export function onRendererLoaded(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function loaded() {
  version++;
  cache.clear();
  for (const l of listeners) l();
}

function needKatex() {
  if (katex || katexLoading) return;
  katexLoading = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => {
    katex = m.default;
    loaded();
  });
}

function needHljs() {
  if (hljs || hljsLoading) return;
  hljsLoading = import('highlight.js/lib/common').then((m) => {
    hljs = m.default;
    loaded();
  });
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderMath(tex: string, display: boolean): string {
  if (!katex) {
    needKatex();
    return `<span class="${display ? 'math-block' : 'math-inline'} math-pending">${escapeHtml(display ? tex : tex)}</span>`;
  }
  try {
    const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'htmlAndMathml', trust: false });
    return display ? `<div class="math-block">${html}</div>` : `<span class="math-inline">${html}</span>`;
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

// ---- math rules ----

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  let open = '';
  let close = '';
  if (src.startsWith('\\(', start)) {
    open = '\\(';
    close = '\\)';
  } else if (src.startsWith('$$', start)) {
    open = '$$';
    close = '$$';
  } else if (src[start] === '$') {
    open = '$';
    close = '$';
  } else return false;
  const from = start + open.length;
  if (open === '$') {
    // "$5 and $10" is money, not math: the content can't start or end with a space.
    const next = src[from];
    if (!next || next === ' ' || next === '\t' || next === '\n') return false;
  }
  let end = from;
  for (;;) {
    end = src.indexOf(close, end);
    if (end < 0) return false;
    if (src[end - 1] === '\\') {
      end += 1;
      continue;
    }
    break;
  }
  const content = src.slice(from, end);
  if (!content.trim()) return false;
  if (open === '$') {
    if (/\s$/.test(content)) return false;
    // A digit right after the closing $ means it was a price ("$5 or 6$7").
    if (/\d/.test(src[end + 1] ?? '')) return false;
    if (content.includes('\n\n')) return false;
  }
  if (!silent) {
    const token = state.push(open === '$$' ? 'math_block_inline' : 'math_inline', 'math', 0);
    token.content = content;
  }
  state.pos = end + close.length;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  const line = state.src.slice(pos, max);
  let open = '';
  let close = '';
  if (line.startsWith('$$')) {
    open = '$$';
    close = '$$';
  } else if (line.startsWith('\\[')) {
    open = '\\[';
    close = '\\]';
  } else return false;
  if (silent) return true;
  let content = '';
  let next = startLine;
  let found = false;
  const firstRest = line.slice(open.length);
  const sameLineEnd = firstRest.indexOf(close);
  if (sameLineEnd >= 0) {
    content = firstRest.slice(0, sameLineEnd);
    found = true;
  } else {
    const lines = [firstRest];
    for (next = startLine + 1; next < endLine; next++) {
      pos = state.bMarks[next] + state.tShift[next];
      max = state.eMarks[next];
      const l = state.src.slice(pos, max);
      const idx = l.indexOf(close);
      if (idx >= 0) {
        lines.push(l.slice(0, idx));
        found = true;
        break;
      }
      lines.push(l);
    }
    content = lines.join('\n');
  }
  if (!found) return false;
  state.line = next + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content;
  token.map = [startLine, state.line];
  return true;
}

// ---- task lists: "- [ ] todo" / "- [x] done" ----

function taskLists(md: MarkdownIt) {
  md.core.ruler.after('inline', 'task_lists', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\]\s/.exec(t.content);
      if (!m || !t.children?.length) continue;
      const first = t.children[0];
      if (first.type !== 'text') continue;
      first.content = first.content.replace(/^\[[ xX]\]\s/, '');
      const box = new state.Token('html_inline', '', 0);
      box.content = `<span class="md-task${m[1] === ' ' ? '' : ' done'}" aria-hidden="true"></span>`;
      t.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'md-task-item');
    }
  });
}

function createMd(): MarkdownIt {
  const md = markdownIt({ html: false, linkify: true, breaks: false, typographer: false });
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.after('blockquote', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx].content, false);
  md.renderer.rules.math_block_inline = (tokens: Token[], idx: number) => renderMath(tokens[idx].content, true);
  md.renderer.rules.math_block = (tokens: Token[], idx: number) => renderMath(tokens[idx].content, true);
  taskLists(md);

  md.renderer.rules.fence = (tokens: Token[], idx: number) => {
    const t = tokens[idx];
    const lang = (t.info || '').trim().split(/\s+/)[0] || '';
    const code = t.content.replace(/\n$/, '');
    let body: string;
    if (lang && hljs?.getLanguage(lang)) {
      try {
        body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        body = escapeHtml(code);
      }
    } else {
      if (lang && !hljs) needHljs();
      body = escapeHtml(code);
    }
    const label = escapeHtml(lang || 'text');
    return (
      `<div class="md-code"><div class="md-code-head"><span class="md-code-lang">${label}</span>` +
      `<button type="button" class="md-code-btn" data-md="wrap" title="Wrap lines" aria-label="Wrap lines"></button>` +
      `<button type="button" class="md-code-btn" data-md="copy" title="Copy code" aria-label="Copy code"></button></div>` +
      `<pre><code class="hljs">${body}</code></pre></div>`
    );
  };
  md.renderer.rules.code_block = (tokens: Token[], idx: number) =>
    `<div class="md-code"><pre><code>${escapeHtml(tokens[idx].content.replace(/\n$/, ''))}</code></pre></div>`;

  const defaultTableOpen = md.renderer.rules.table_open ?? ((tokens: Token[], idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_open = (tokens: Token[], idx: number, options: any, env: any, self: any) =>
    '<div class="md-table">' + defaultTableOpen(tokens, idx, options, env, self);
  const defaultTableClose = md.renderer.rules.table_close ?? ((tokens: Token[], idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_close = (tokens: Token[], idx: number, options: any, env: any, self: any) =>
    defaultTableClose(tokens, idx, options, env, self) + '</div>';

  const defaultLink = md.renderer.rules.link_open ?? ((tokens: Token[], idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens: Token[], idx: number, options: any, env: any, self: any) => {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer nofollow');
    return defaultLink(tokens, idx, options, env, self);
  };
  return md;
}

const md = createMd();
const cache = new Map<string, string>();
const CURSOR = '⁣';

function renderCached(src: string): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = md.render(src);
  if (cache.size > 400) cache.delete(cache.keys().next().value as string);
  cache.set(src, html);
  return html;
}

/** Splits at blank lines outside fenced code, so a streaming reply only re-renders its last block. */
function splitBlocks(src: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let mathOpen = false;
  let cur: string[] = [];
  for (const line of src.split('\n')) {
    const trimmed = line.trimStart();
    const f = /^(```+|~~~+)/.exec(trimmed);
    if (f) {
      if (!fence) fence = f[1];
      else if (trimmed.startsWith(fence)) fence = null;
    } else if (!fence && /^\$\$/.test(trimmed) && !/^\$\$.*\$\$\s*$/.test(trimmed)) {
      mathOpen = !mathOpen;
    }
    if (!fence && !mathOpen && line.trim() === '' && cur.length) {
      out.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/**
 * Renders a reply. While [streaming], blocks are rendered separately (only the last one changes)
 * and a gem cursor follows the text.
 */
export function renderMarkdown(src: string, streaming = false): string {
  if (!streaming) return renderCached(src);
  const blocks = splitBlocks(src + CURSOR);
  return blocks
    .map((b) => renderCached(b))
    .join('')
    .replace(CURSOR, '<span class="md-cursor" aria-hidden="true"></span>');
}

/** Plain text for copying and reading aloud: Markdown syntax removed. */
export function markdownToPlain(src: string): string {
  return src
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .trim();
}
