# Facet for Windows

The Electron shell of the Windows app. The chat UI, sync and encryption are the shared web app in
[`../client`](../client), built into `renderer/` and served from the private `facet://app/` origin.
The shell adds what a browser can't do, exposed to the page as `window.facetDesktop`
(contract: `client/src/platform/desktop.ts`):

- **Computer tools** for models (`src/computer/`): `run_command` (PowerShell, with background
  processes), `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `grep`, `open_path`.
- **Local MCP servers** over stdio (`src/stdio.ts`), **OAuth** loopback redirects on
  `http://127.0.0.1:33418/callback` (or `:33419`) (`src/oauth.ts`).
- **Secrets** sealed with Windows DPAPI via `safeStorage` (`src/secrets.ts`), notifications, file
  saving, and **auto-updates** from `https://facet.dtsoftware.io/download/windows/` (`src/updates.ts`).

The window runs with `webSecurity: false` so provider APIs without CORS headers work with the
user's own keys; everything else is locked down (sandboxed preload, no navigation away from
`facet://app`, external links open in the browser, CSP, IPC sender checks, minimal permissions).

## Develop

```sh
npm install
npm start                # builds ../client into renderer/, bundles src/ with esbuild, opens the app
```

- `FACET_DEV_URL=http://localhost:5173/app/ npm start` loads the Vite dev server instead (hot reload).
- `FACET_RENDERER_DIR=<folder> npm start` serves another folder as the renderer.
- `npx electron . --facet-selftest=out.json` checks the window, protocol and preload API and quits.
- `npx electron . --facet-script=steps.json` (development builds only) runs scripted UI steps:
  a JSON list of `{ "js": "…", "wait": ms, "shot": "name" }`, saving `steps-<name>.png` and
  `steps.log` next to the file. With `FACET_DEV_URL` pointing at the Vite dev server, the page
  exposes `window.facetApp` for setting up test data.
- Development data lives in `%APPDATA%\Facet Dev`, apart from the installed app's `%APPDATA%\Facet`.

```sh
npm test            # unit tests (node --test) for the computer tools, protocol, secrets, stdio, OAuth
npm run typecheck   # tsc --noEmit
npm run icons       # regenerates build/icon.png and build/icon.ico from ../brand/facet-icon.svg
```

## Build the installer

```sh
npm run dist
```

Builds the renderer and the shell, then `electron-builder --win nsis`. Output in `release/`:

- `Facet-Setup-<version>.exe`: one-click installer, per user (no admin prompt), installs to
  `%LOCALAPPDATA%\Programs\Facet`.
- `Facet-Setup-<version>.exe.blockmap`: lets the next update download only what changed.
- `latest.yml`: the update manifest (version, file name, sha512) that installed apps check.

The app isn't code-signed: Windows SmartScreen shows "Windows protected your PC" on first run
(More info → Run anyway). Updates still verify the installer's sha512 from `latest.yml`; no
`publisherName` is configured, so electron-updater doesn't require a signature.

Bump `version` in `package.json` before each release (updates compare versions).

## Publish

Upload the installer, its blockmap and `latest.yml` (last, so clients never see a manifest for a
file that isn't there yet) to the downloads folder nginx serves at `/download/`:

```sh
V=1.0.0
ssh you@server 'mkdir -p /var/www/facet-downloads/windows'
scp release/Facet-Setup-$V.exe release/Facet-Setup-$V.exe.blockmap you@server:/var/www/facet-downloads/windows/
scp release/latest.yml you@server:/var/www/facet-downloads/windows/
ssh you@server "cd /var/www/facet-downloads/windows && cp Facet-Setup-$V.exe Facet-Setup-latest.exe"
```

Installed apps check `https://facet.dtsoftware.io/download/windows/latest.yml` 15 seconds after
start and every 6 hours, download the update in the background and install it on quit (or right
away from the app's update prompt). Keep older blockmaps on the server for differential updates.
The website's download button can point at `/download/windows/Facet-Setup-latest.exe`.
