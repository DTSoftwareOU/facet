/** The small window shown while Facet checks for and installs an update at launch (docs/UPDATES.md). */
import { BrowserWindow } from 'electron';
import type { UpdateState } from '../../client/src/platform/platform';
import type { ShellText } from './shell-text';

const GEM =
  '<svg viewBox="0 0 100 100" width="44" height="44" aria-hidden="true"><g stroke-width="1" stroke-linejoin="round">' +
  '<polygon points="4,50 50,4 50,32 32,50" fill="#F2C66D" stroke="#F2C66D"/><polygon points="50,4 96,50 68,50 50,32" fill="#6E9BFF" stroke="#6E9BFF"/>' +
  '<polygon points="96,50 50,96 50,68 68,50" fill="#3A5BD9" stroke="#3A5BD9"/><polygon points="50,96 4,50 32,50 50,68" fill="#49D3C1" stroke="#49D3C1"/>' +
  '<polygon points="50,32 68,50 50,68 32,50" fill="#F4F7FB" stroke="#F4F7FB"/></g></svg>';

const page = (text: ShellText) => `<!doctype html><html><head><meta charset="utf-8"><title>Facet AI</title><style>
html,body{margin:0;height:100%;background:#11151B;color:#E8ECF2;font:14px/1.4 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;user-select:none;-webkit-app-region:drag}
main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:0 28px;box-sizing:border-box;text-align:center}
svg{animation:turn 2.4s ease-in-out infinite}@keyframes turn{50%{transform:rotate(90deg) scale(.92)}}
@media (prefers-reduced-motion:reduce){svg{animation:none}}
h1{font-size:16px;font-weight:600;margin:8px 0 0}p{margin:0;color:#9AA4B2;font-size:13px;min-height:18px}
.bar{width:220px;height:4px;border-radius:2px;background:#232A35;overflow:hidden;visibility:hidden}.bar i{display:block;height:100%;width:0;background:#49D3C1;transition:width .2s}
button{-webkit-app-region:no-drag;margin-top:6px;border:0;background:none;color:#49D3C1;font:inherit;font-size:13px;cursor:pointer;padding:6px 10px;border-radius:8px;visibility:hidden}
button:hover,button:focus-visible{background:#1C222C;outline:none}
</style></head><body><main>${GEM}<h1 id="t">${esc(text.checking)}</h1><p id="s"></p><div class="bar" id="b"><i id="f"></i></div>
<button id="k" onclick="location.hash='skip'">${esc(text.openNow)}</button></main><script>
var T=${JSON.stringify(text).replace(/</g, '\\u003c')};
function show(s){var t=document.getElementById('t'),p=document.getElementById('s'),b=document.getElementById('b'),f=document.getElementById('f'),k=document.getElementById('k');
if(s.status==='available'||s.status==='downloading'){t.textContent=T.updating+(s.version?' ('+s.version+')':'');p.textContent=s.status==='downloading'?T.downloading.replace('{progress}',(s.progress||0)+'%'):T.starting;b.style.visibility='visible';f.style.width=(s.progress||0)+'%';k.style.visibility='visible'}
else if(s.status==='ready'){t.textContent=T.installing;p.textContent=T.reopening;b.style.visibility='visible';f.style.width='100%';k.style.visibility='hidden'}}
</script></body></html>`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class UpdateSplash {
  private readonly win: BrowserWindow;
  private skipped = false;

  constructor(icon: string | undefined, text: ShellText, onSkip: () => void) {
    this.win = new BrowserWindow({
      width: 380,
      height: 230,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      center: true,
      show: false,
      title: 'Facet AI',
      backgroundColor: '#11151B',
      icon,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.on('did-navigate-in-page', (_e, url) => {
      if (url.endsWith('#skip') && !this.skipped) {
        this.skipped = true;
        onSkip();
      }
    });
    this.win.once('ready-to-show', () => this.win.show());
    void this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(text)));
  }

  update(state: UpdateState): void {
    if (this.win.isDestroyed()) return;
    void this.win.webContents.executeJavaScript(`show(${JSON.stringify(state)})`).catch(() => {});
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}
