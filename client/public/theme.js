// Picks the theme before the first paint, so there's no flash (a file, not inline: the CSP forbids inline scripts).
try {
  var p = JSON.parse(localStorage.getItem('facet.local.v1') || '{}');
  var t = p.theme || 'SYSTEM';
  var dark = t === 'DARK' || t === 'BLACK' || (t === 'SYSTEM' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = t === 'BLACK' ? 'black' : dark ? 'dark' : 'light';
} catch (e) {}
