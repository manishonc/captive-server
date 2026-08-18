# HeidiFi AP Adoption Helper

A desktop app for venue staff: plug in a new UniFi access point, click **Find
my device**, enter the account's **setup code**, pick the location and WiFi
name, and the access point is live in a couple of minutes. Nobody at HeidiFi has
to approve anything, and the person on site never touches a terminal, SSH, or
network settings.

Under the hood (see `../docs/ap-adoption-helper-prompt.md`):

1. **Discover** UniFi devices on the local network via the Ubiquiti discovery
   protocol — UDP probes (v1 + v2) to port `10001` broadcast from every active
   network interface, plus the factory fallback IP `192.168.1.20`. TLV replies
   are parsed for IP, MAC, hostname, model, and firmware.
2. **Send the adoption request** over SSH (`ubnt`/`ubnt`, legacy `ssh-rsa`
   algorithms): `mca-cli-op set-inform http://34.116.224.72:8085/inform`, with
   a bare `set-inform` fallback for older firmware.
3. **Claim it** against `https://api.heidifi.ai/adoption/*` using the setup
   code: the server creates the access point, adopts the device on the
   controller, and applies the venue's WiFi, while the app polls for progress.

The setup code alone is not enough to register hardware — the server only
accepts a claim for a device already informing our controller, so the caller has
to be physically on its network. A leaked code cannot be used remotely.

**Without a code** the app falls back to its original behaviour: send the
set-inform and let a HeidiFi admin adopt it. That path still works, so older
installed copies of this app keep functioning.

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
3. Open the app → **Find my device** → select the device → **Continue**.
4. Enter the **setup code** from the HeidiFi dashboard (under *Add access
   point*). It looks like `H7K2-M9QX`.
5. Choose the location, check the WiFi network name, and click **Set up my
   access point**. Wait one to two minutes — leave the app open and the access
   point plugged in — then ✅ done.

If the location already has a WiFi network, its name is shown but locked.
Changing it renames the network for the whole location and drops every guest
who is connected, so it takes an explicit **Change the name** click.

### Troubleshooting

| Symptom | Fix |
|---|---|
| "We couldn't find an access point" | Check PoE power and that both devices are on the same network; wait ~60 s after plugging in; on macOS check **System Settings → Privacy & Security → Local Network** is allowed for the app; on Windows allow the firewall prompt. Then **Scan again**. |
| "This access point may have been set up before" | The AP no longer accepts the factory password. Factory-reset it: hold the reset button ~10 s until the light flashes, let it reboot, scan again. Or enter the custom device password under **Advanced**. |
| "The access point didn't accept the request" | The firmware has neither `mca-cli-op set-inform` nor `set-inform`. Open **Advanced**, **Copy log**, and send it to the administrator; the AP likely needs a firmware update. |
| "Management server unreachable" chip in Advanced | This site can't reach the controller — check the venue's internet/firewall. The adoption request is still attempted (the AP, not this computer, ultimately connects). |
| App shows nothing / scan instantly empty | The OS blocked UDP broadcast — see the Local Network / Firewall notes above. |
| "We don't recognise that code" | Codes never contain the letters **I**, **L** or **O**, or the numbers **0** or **1** — a mis-read `O` for `Q` is the usual cause. Copy it from the dashboard rather than typing it. |
| "This access point is already in HeidiFi" | It is already registered to this account. If its WiFi never appeared, use **It's not working — set it up again**, which is safe to re-run. |
| "This access point belongs to another account" | Registered to a different HeidiFi account. Email `hello@heidifi.ai` to have it released. |
| "This is taking longer than usual" | Not a failure — the access point is registered and still provisioning. A firmware upgrade on first adoption can take 5–15 minutes. Leave it plugged in; it finishes on its own and the dashboard will show it. |
| "This app isn't set up safely" | The API address under **Advanced** is not `https://`. The setup code is a credential and the app refuses to send it in the clear. |

## Advanced panel

- **Controller inform URL** — point the app at a different/custom controller
  (persisted on this machine; leave empty to use the built-in default).
- **HeidiFi API address** — for staging or a self-hosted captive-server. Must be
  `https://` (localhost excepted for development). The setup code itself is
  never persisted, in this file or anywhere else.
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
- [ ] A valid setup code is accepted and lists the account's locations
- [ ] A code with a mis-read `O`/`0` is rejected with the mix-up hint
- [ ] **Set up my access point** creates the AP, adopts it, and the SSID is
      broadcasting — end to end, without anyone touching the controller
- [ ] A **second** AP at the same venue joins the existing WiFi, and the SSID
      field is locked until explicitly unlocked
- [ ] Re-scanning an already-registered AP shows "already in HeidiFi" rather
      than letting it be claimed twice
- [ ] Closing the app mid-provision still results in working WiFi within ~5
      minutes (the `reconcilePendingWifi` cron backstop)
- [ ] **I don't have a code** still sends a plain set-inform for admin approval
- [ ] Previously-adopted AP correctly triggers the factory-reset message
