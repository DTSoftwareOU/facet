# App updates

Facet's Windows and Android apps update themselves from facet.dtsoftware.io. Both check when they
start, before you get to work, and again while they keep running.

## Windows

The Windows app uses electron-updater's generic feed: `https://facet.dtsoftware.io/download/windows/latest.yml`
plus `Facet-Setup-<version>.exe` and its `.blockmap`. electron-updater verifies the installer's
SHA-512 from `latest.yml` before running it.

- **At launch** (when you open Facet yourself, not when it starts hidden with Windows), a small
  window says "Checking for updates…" for at most a few seconds. If a newer version is available it
  downloads with a progress bar and restarts into the new version; otherwise, or when offline, Facet
  opens normally.
- **While running**, it checks every 6 hours and downloads updates in the background. When one is
  ready and the window is hidden (Facet is in the notification area) and nothing is running, it
  installs silently and restarts hidden. Otherwise Settings → About offers "Restart to update", and
  the update installs the next time Facet quits.

## Android

The Android app isn't on a store, so it reads a small manifest:

`GET https://facet.dtsoftware.io/download/android/latest.json` (served with `Cache-Control: no-cache`)

```json
{
  "versionCode": 2,
  "versionName": "1.1.0",
  "url": "https://facet.dtsoftware.io/download/android/facet-1.1.0.apk",
  "sha256": "<64 hex characters>",
  "size": 3712345,
  "notes": "What's new, one line per change."
}
```

- **At launch** the app keeps its splash screen up while it checks, for at most 1.5 seconds. When
  `versionCode` is higher than the installed one, an update screen shows the new version and its
  notes, with **Update** and **Not now**. Offline or slow networks never delay the app beyond that.
- It checks again when the app returns to the foreground at least 6 hours after the last check.
- **Update** downloads the APK into the app's cache with progress, checks its size and SHA-256 and
  that it is Facet (`io.dtsoftware.facet`) at the advertised `versionCode`, then hands it to
  Android's package installer. Android asks for confirmation (and, the first time, for permission
  to install apps from Facet); on Android 12 and later, once Facet installed the current version
  itself, later updates install without that confirmation. Android itself refuses an update that
  isn't signed with Facet's key.
- **Not now** hides the prompt for that version for 24 hours. Settings → About always shows the
  update state, a "Check for updates" action, and a switch to turn automatic checks off.
- Debug builds (`io.dtsoftware.facet.debug`) don't check.

## Publishing a release

1. Bump the version: `desktop/package.json` `version`, `android/app/build.gradle.kts`
   `versionCode` (always +1) and `versionName`.
2. Windows: `cd desktop && npm run dist`, then upload `Facet-Setup-<v>.exe`, its `.blockmap` and
   `latest.yml` to `/var/www/facet-downloads/windows/` and point the `Facet-Setup.exe` symlink at
   the new installer.
3. Android: `cd android && ./gradlew assembleRelease`, upload the APK as
   `/var/www/facet-downloads/android/facet-<v>.apk`, then write `latest.json` (size and SHA-256 of
   that file) last. Also replace `/var/www/facet-downloads/facet-latest.apk` and its `.sha256`, which
   the website's download button uses.
