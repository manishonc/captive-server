---
name: publish-helper
description: Build the AP Adoption Helper installers (mac + win) and publish them to the Bunny CDN stable URLs. Use when the user says "publish the helper", "release the helper", "build and upload the helper/installers", or wants a new helper version live on the dashboard download buttons.
---

# Publish the AP Adoption Helper

Ships the desktop helper to the permanent CDN URLs the dashboard links:

- `https://askheidi.b-cdn.net/heidifi/HeidiFi-AP-Adoption-Helper-mac.dmg`
- `https://askheidi.b-cdn.net/heidifi/HeidiFi-AP-Adoption-Helper-win.exe`

## Steps

1. **Version check.** Read `ap-adoption-helper/package.json` `version`. If the code changed since the last published version, bump it (patch for fixes, minor for features) and commit. Never republish a changed build under an unchanged version.
2. **Publish.** Run from the repo root:
   ```bash
   ap-adoption-helper/scripts/publish-local.sh
   ```
   It runs the test suite, builds the mac DMG and win EXE, uploads versioned + stable-alias names to Bunny storage, purges the alias cache (if `BUNNY_API_KEY` is set), and verifies both URLs return 200. Credentials come from the environment (`BUNNY_STORAGE_ZONE` / `BUNNY_STORAGE_KEY`) or fall back to `../cms/.env.local`.
   - `--skip-build` uploads whatever is already in `release/` (use only if the build just ran).
   - `--dry-run` shows what would upload.
3. **Push the code.** Make sure the helper changes are merged/pushed to `main` — the CI twin (`.github/workflows/ap-adoption-helper-publish.yml`) will rebuild and republish the same names, which is fine (idempotent).
4. **Local install (usually wanted too).** Quit the running app, replace `/Applications/HeidiFi AP Adoption Helper.app` from the fresh DMG in `ap-adoption-helper/release/`, launch **by full path** (`open "/Applications/HeidiFi AP Adoption Helper.app"`). Delete any unpacked `release/mac-universal*`/`release/win-unpacked` staging dirs afterwards — macOS registers them as a confusing second install.
5. **Report** the version published, both stable URLs with their HTTP status, and whether the cache was purged (if not, note the aliases update when the CDN cache expires).

## Notes

- No CMS change is ever needed for a release — the dashboard buttons point at the stable aliases.
- Docs: `docs/self-serve-ap-adoption.md` → "Installer distribution".
- The GitHub release flow (tag `ap-adoption-helper-v<version>`) is separate and optional: `ap-adoption-helper-release.yml`.
