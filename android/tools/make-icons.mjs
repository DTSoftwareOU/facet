// Fetches selected Lucide icons (ISC license) and converts them to Android VectorDrawables.
// Usage: node tools/make-icons.mjs app/src/main/res/drawable
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '1.54.0';
const STROKE = '1.8';
const outDir = process.argv[2];
if (!outDir) throw new Error('outDir required');

// lucide name -> android resource suffix
const ICONS = {
  'menu': 'menu', 'square-pen': 'new_chat', 'chevron-down': 'chevron_down', 'chevron-up': 'chevron_up',
  'chevron-right': 'chevron_right', 'chevron-left': 'chevron_left', 'arrow-up': 'arrow_up', 'arrow-down': 'arrow_down',
  'arrow-left': 'arrow_left', 'plus': 'plus', 'x': 'close', 'check': 'check', 'copy': 'copy', 'refresh-cw': 'regenerate',
  'pencil': 'edit', 'trash-2': 'delete', 'share-2': 'share', 'volume-2': 'speak', 'volume-x': 'speak_off', 'mic': 'mic',
  'image': 'image', 'camera': 'camera', 'paperclip': 'attach', 'file-text': 'file_text', 'file': 'file', 'globe': 'globe',
  'brain': 'brain', 'zap': 'zap', 'settings': 'settings', 'search': 'search', 'pin': 'pin', 'pin-off': 'pin_off',
  'archive': 'archive', 'archive-restore': 'unarchive', 'folder': 'folder', 'folder-plus': 'folder_plus',
  'ellipsis-vertical': 'more', 'ellipsis': 'more_horiz', 'key-round': 'key', 'user-round': 'user', 'log-out': 'log_out',
  'log-in': 'log_in', 'shield-check': 'shield', 'lock': 'lock', 'lock-open': 'unlock', 'fingerprint-pattern': 'fingerprint',
  'smartphone': 'phone', 'cloud': 'cloud', 'cloud-off': 'cloud_off', 'cloud-check': 'cloud_check', 'refresh-ccw': 'sync',
  'download': 'download', 'upload': 'upload', 'external-link': 'external', 'info': 'info', 'circle-alert': 'alert',
  'triangle-alert': 'warning', 'sun': 'sun', 'moon': 'moon', 'sun-moon': 'theme', 'palette': 'palette', 'type': 'text_size',
  'message-square': 'message', 'messages-square': 'messages', 'bot': 'bot', 'library-big': 'library',
  'sliders-horizontal': 'sliders', 'eye': 'eye', 'eye-off': 'eye_off', 'star': 'star', 'git-branch': 'branch',
  'list': 'list', 'sparkles': 'sparkles', 'code-xml': 'code', 'languages': 'languages', 'graduation-cap': 'tutor',
  'pen-line': 'writer', 'chart-line': 'analyst', 'circle-help': 'help', 'audio-lines': 'audio', 'server': 'server',
  'link': 'link', 'clipboard': 'clipboard', 'mail': 'mail', 'history': 'history', 'rotate-ccw': 'undo',
  'text-select': 'select_text', 'square': 'square', 'circle-stop': 'stop', 'play': 'play', 'wrap-text': 'wrap',
  'scroll-text': 'transcript', 'hash': 'hash', 'gauge': 'gauge', 'coins': 'coins', 'wand-sparkles': 'wand',
  'scan-text': 'scan', 'circle-check': 'circle_check', 'circle-x': 'circle_x', 'grip-vertical': 'grip',
  'square-check': 'checkbox', 'layers': 'layers', 'atom': 'atom', 'feather': 'feather', 'heart': 'heart',
  'house': 'home', 'quote': 'quote', 'arrow-right': 'arrow_right', 'list-filter': 'filter', 'calendar': 'calendar',
  'square-terminal': 'terminal', 'activity': 'activity', 'mic-off': 'mic_off', 'file-up': 'file_up',
  'files': 'files', 'cpu': 'cpu', 'infinity': 'infinity', 'timer': 'timer', 'gem': 'gem', 'scale': 'scale', 'rocket': 'rocket', 'film': 'film', 'music': 'music', 'pause': 'pause',
};

const num = (s) => parseFloat(s);
const fmt = (n) => +n.toFixed(3);

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function circlePath(cx, cy, rx, ry) {
  return `M${fmt(cx - rx)},${fmt(cy)}a${fmt(rx)},${fmt(ry)} 0 1,0 ${fmt(2 * rx)},0a${fmt(rx)},${fmt(ry)} 0 1,0 ${fmt(-2 * rx)},0`;
}

function rectPath(a) {
  const x = num(a.x ?? 0), y = num(a.y ?? 0), w = num(a.width), h = num(a.height);
  let rx = a.rx !== undefined ? num(a.rx) : (a.ry !== undefined ? num(a.ry) : 0);
  let ry = a.ry !== undefined ? num(a.ry) : rx;
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
  if (!rx) return `M${x},${y}h${w}v${h}h${-w}z`;
  return `M${fmt(x + rx)},${y}h${fmt(w - 2 * rx)}a${rx},${ry} 0 0 1 ${rx},${ry}v${fmt(h - 2 * ry)}` +
    `a${rx},${ry} 0 0 1 ${-rx},${ry}h${fmt(-(w - 2 * rx))}a${rx},${ry} 0 0 1 ${-rx},${-ry}` +
    `v${fmt(-(h - 2 * ry))}a${rx},${ry} 0 0 1 ${rx},${-ry}z`;
}

function pointsPath(points, close) {
  const nums = points.trim().split(/[\s,]+/).map(Number);
  let d = '';
  for (let i = 0; i < nums.length; i += 2) d += (i === 0 ? 'M' : 'L') + nums[i] + ',' + nums[i + 1];
  return d + (close ? 'z' : '');
}

function convert(svg) {
  const paths = [];
  for (const m of svg.matchAll(/<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*)\/?>/g)) {
    const [_, tag, rest] = m; const a = attrs(rest);
    switch (tag) {
      case 'path': paths.push(a.d); break;
      case 'circle': paths.push(circlePath(num(a.cx), num(a.cy), num(a.r), num(a.r))); break;
      case 'ellipse': paths.push(circlePath(num(a.cx), num(a.cy), num(a.rx), num(a.ry))); break;
      case 'rect': paths.push(rectPath(a)); break;
      case 'line': paths.push(`M${a.x1},${a.y1}L${a.x2},${a.y2}`); break;
      case 'polyline': paths.push(pointsPath(a.points, false)); break;
      case 'polygon': paths.push(pointsPath(a.points, true)); break;
    }
  }
  const body = paths.map((d) =>
    `    <path\n        android:pathData="${d}"\n        android:fillColor="#00000000"\n        android:strokeColor="#FF000000"\n` +
    `        android:strokeWidth="${STROKE}"\n        android:strokeLineCap="round"\n        android:strokeLineJoin="round" />`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Lucide icon (ISC License, https://lucide.dev) -->\n` +
    `<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="24dp"\n    android:height="24dp"\n` +
    `    android:viewportWidth="24"\n    android:viewportHeight="24">\n${body}\n</vector>\n`;
}

fs.mkdirSync(outDir, { recursive: true });
const failed = [];
await Promise.all(Object.entries(ICONS).map(async ([name, res]) => {
  const url = `https://unpkg.com/lucide-static@${VERSION}/icons/${name}.svg`;
  const r = await fetch(url);
  if (!r.ok) { failed.push(name); return; }
  const svg = await r.text();
  fs.writeFileSync(path.join(outDir, `ic_${res}.xml`), convert(svg));
}));
console.log(`wrote ${Object.keys(ICONS).length - failed.length} icons; failed: ${failed.join(', ') || 'none'}`);
