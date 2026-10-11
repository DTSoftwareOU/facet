# facet.dtsoftware.io

Static site served by Caddy at `/` (the sync API shares the host under `/v1/*`; release APKs
are expected at `/download/facet-latest.apk`). No build step, no frameworks, no third-party
requests: fonts are self-hosted under `fonts/` (SIL OFL 1.1, licenses alongside).

| File | Purpose |
|---|---|
| `index.html` | Landing page. The hero phone is an HTML/CSS stand-in marked `PRODUCT MOCKUP`; swap it for a real screenshot when available. |
| `privacy.html`, `terms.html` | Privacy policy and terms of service. |
| `self-host.html` | Short self-hosting guide; links to `docs/DEPLOY.md` in the repository. |
| `404.html` | Not-found page (configure Caddy's `handle_errors` to serve it). |
| `styles.css` | All styles. Tokens at the top mirror `docs/DESIGN.md`; light theme via `prefers-color-scheme`. |
| `site.js` | Progressive enhancement: repository links and the hero gem animation. |
| `assets/` | Logo SVGs copied from `brand/`, favicon, touch/manifest icons, `og.png` social card. |

## Before launch

- Set the real repository URL in `site.js` (`REPO_URL`). Links marked `data-repo-path`
  are rewritten from it; without JavaScript they fall back to `self-host.html`.
- Contact address used on the legal pages: `help@dtsoftware.io`. Company details live in `legal.html`.
- Have the privacy policy and terms reviewed before publishing.
