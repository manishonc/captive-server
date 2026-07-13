# HeidiFi AP Adoption Helper

A one-click desktop app for venue staff: plug in a new UniFi access point,
click **Find my device**, click **Send adoption request**, done. The HeidiFi
team then approves ("adopts") the access point centrally on the UniFi
controller — the person on site never touches a terminal, SSH, or network
settings.

Under the hood it automates the proven manual recipe (see
`../docs/ap-adoption-helper-prompt.md`):

1. **Discover** UniFi devices on the local network via the Ubiquiti discovery
   protocol — UDP probes (v1 + v2) to port `10001` broadcast from every active
   network interface, plus the factory fallback IP `192.168.1.20`. TLV replies
   are parsed for IP, MAC, hostname, model, and firmware.
2. **Send the adoption request** over SSH (`ubnt`/`ubnt`, legacy `ssh-rsa`
   algorithms): `mca-cli-op set-inform http://34.116.224.72:8085/inform`, with
   a bare `set-inform` fallback for older firmware.

> **Note the non-standard inform port `8085`** — our controller runs behind
> Coolify where host port 8080 is taken. Do not "fix" it to 8080.

## Download & install

Grab the latest installers from
[GitHub Releases](https://github.com/manishonc/captive-server/releases)
(tags named `ap-adoption-helper-v*`).

The installers are currently **unsigned** (no Apple/Microsoft certificates),
so both OSes will warn on first launch:

### macOS (`.dmg`)

1. Open the `.dmg` and drag **HeidiFi AP Adoption Helper** into
   **Applications**.
2. Double-click the app. macOS will block it the first time.
3. Open **System Settings → Privacy & Security**, scroll down, and click
   **"Open Anyway"** next to the app name, then confirm.
   (On older macOS versions: right-click the app → **Open** → **Open**.)
4. If macOS still reports the app as "damaged", run this once in Terminal:
   `xattr -cr "/Applications/HeidiFi AP Adoption Helper.app"`
5. When asked, **allow the app to find devices on the local network** — the
   scan cannot work without it.

### Windows (`.exe`)

1. Run the installer. If SmartScreen appears, click **More info → Run anyway**.
2. If the Windows Firewall prompt appears on first scan, click **Allow**
   (private networks).

## Using the app

1. Plug the access point into power and network through its **PoE
   injector/switch**, on the **same network** as your computer.
2. Wait about a minute for the access point to start (steady light).
3. Open the app → **Find my device** → select the device → **Send adoption
   request** → ✅ done. The HeidiFi team approves it from the controller.

### Troubleshooting

| Symptom | Fix |
|---|---|
| "We couldn't find an access point" | Check PoE power and that both devices are on the same network; wait ~60 s after plugging in; on macOS check **System Settings → Privacy & Security → Local Network** is allowed for the app; on Windows allow the firewall prompt. Then **Scan again**. |
| "This access point may have been set up before" | The AP no longer accepts the factory password. Factory-reset it: hold the reset button ~10 s until the light flashes, let it reboot, scan again. Or enter the custom device password under **Advanced**. |
| "The access point didn't accept the request" | The firmware has neither `mca-cli-op set-inform` nor `set-inform`. Open **Advanced**, **Copy log**, and send it to the administrator; the AP likely needs a firmware update. |
| "Management server unreachable" chip in Advanced | This site can't reach the controller — check the venue's internet/firewall. The adoption request is still attempted (the AP, not this computer, ultimately connects). |
| App shows nothing / scan instantly empty | The OS blocked UDP broadcast — see the Local Network / Firewall notes above. |

## Advanced panel

- **Controller inform URL** — point the app at a different/custom controller
  (persisted on this machine; leave empty to use the built-in default).
- **AP SSH password** — for APs that were previously managed and no longer
  accept `ubnt`. Stored in plain text in the app's user-data folder; the
  default `ubnt` is public anyway, so only set this if you must.
- Raw device details (MAC, firmware, discovery payload) and a copyable log.

## Rebranding / repointing

All branding and defaults live in one file: [`config.json`](./config.json)
(`appName`, `informUrl`, `homeUrl`, `brand` colors). Edit it, replace
`assets/heidifi-logo.png`, run `npm run icons`, rebuild — nothing else to
touch.

## Development

```bash
npm install          # Node 22+; macOS needed for the mac build
npm test             # unit tests (TLV parser, set-inform commands, net utils)
npm start            # build + launch the app
```

Layout: `src/main` (Electron main process; all UDP/SSH work),
`src/main/lib` (testable pure modules: `tlv.ts`, `adopt-command.ts`,
`net-util.ts`, plus `discovery.ts`/`adopt.ts`), `src/preload` (contextBridge
API), `src/renderer` (single-screen UI, plain HTML/CSS/TS, no framework),
`src/shared/types.d.ts` (ambient shared types).

## Building installers

```bash
npm run dist:mac     # → release/HeidiFi-AP-Adoption-Helper-<v>-mac-universal.dmg
npm run dist:win     # → release/HeidiFi-AP-Adoption-Helper-<v>-win-x64.exe (NSIS)
```

Both build on a Mac (the Windows NSIS target needs no Wine with
electron-builder ≥ 26). The mac app is **ad-hoc signed** in an `afterPack`
hook (`scripts/adhoc-sign.js`) — required for Apple Silicon to launch it at
all.

### Publishing a release

```bash
gh release create ap-adoption-helper-v1.0.0 \
  release/*.dmg release/*.exe \
  --title "HeidiFi AP Adoption Helper v1.0.0" \
  --notes "See ap-adoption-helper/README.md for install steps."
```

### Adding real code signing later

- **macOS**: set `mac.identity` to your Developer ID (or export
  `CSC_LINK`/`CSC_KEY_PASSWORD`), add `hardenedRuntime: true` and
  `notarize: { teamId: "..." }` plus `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`
  env vars, and remove the `afterPack` ad-hoc hook.
- **Windows**: configure Authenticode via `win.certificateFile`/
  `certificatePassword` or a cloud signing provider.

## Field validation checklist (real AP)

- [ ] Factory-reset AP on the venue LAN is found by **Find my device**
- [ ] **Send adoption request** returns success
- [ ] AP appears as "Pending adoption" on the controller
      (`https://34.116.224.72:8443`) and can be adopted
- [ ] Previously-adopted AP correctly triggers the factory-reset message
