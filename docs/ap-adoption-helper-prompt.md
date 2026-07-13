# AP Adoption Helper — build prompt

> Hand this file to a coding agent (Claude Code, Cursor, etc.) to build a
> cross-platform desktop app that lets non-technical site staff send a UniFi
> **adoption request** to our central cloud controller with one click.
>
> It bakes in the setup-specific details that people always get wrong for our
> deployment: the **non-standard inform port `8085`** (our controller runs
> behind Coolify, where host `8080` is already taken), the `mca-cli-op
> set-inform` command used by current firmware, and the **legacy `ssh-rsa`
> algorithms** UniFi APs require. See also `docs/unifi-setup.md` and
> `docs/unifi-controller-explained.md`.

---

## Goal
A dead-simple desktop app that a **non-technical person at a remote site**
installs and runs after they plug in a new UniFi access point. With one click it
finds the AP on the local network and sends an **adoption request**
("set-inform") to our central cloud UniFi controller, so our admin can approve it
centrally. The end user never touches a terminal, SSH, or network settings.

## Users & scenario
- Venue staff / partners with **zero networking knowledge**.
- They receive a UniFi AP (e.g. U6-Pro), plug it into their router via a **PoE
  injector/switch**, and power on their laptop on the **same LAN**.
- They open this app → click **"Find my device"** → click **"Send adoption
  request"** → see ✅ → close the app. Done. Our team adopts it from the cloud
  controller.

## The exact adoption flow the app must automate
This is the proven recipe — implement it faithfully:

1. **Discover UniFi devices on the LAN** via the Ubiquiti discovery protocol:
   - Broadcast a UDP probe to port **10001** on `255.255.255.255` (and
     per-interface broadcast addresses) from **every** active network interface.
     Send both the v1 (`01 00 00 00`) and v2 (`02 08 00 00`) probe payloads.
   - Parse the **TLV** responses to extract: IP, MAC, hostname, model, firmware.
     A reply means a device is present at that IP.
   - Enumerate **all** local subnets/interfaces (a device may be on a secondary
     subnet). Do not assume 192.168.1.x.
   - Fallback: also probe the factory self-assigned IP **192.168.1.20**.
   - Identify Ubiquiti gear by OUI (first 3 MAC bytes), e.g. `74:fa:29`,
     `78:8a:20`, `f4:92:bf`, `24:5a:4c`, `e0:63:da`, `fc:ec:da`, `b4:fb:e4`,
     `d0:21:f9`, `80:2a:a8`, etc. (Ship a maintained OUI list; treat an unknown
     non-randomized MAC that answered the discovery probe as "UniFi device"
     anyway — the discovery reply is authoritative.)

2. **Send the adoption request** to the chosen device over SSH:
   - Connect: user **`ubnt`**, default password **`ubnt`**, port 22.
   - **Legacy algorithms required** — the SSH client MUST allow `ssh-rsa` for
     host key and public key (equivalent of OpenSSH `-o
     HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa`). For older
     firmware also allow legacy KEX/ciphers as a fallback.
   - Run: `mca-cli-op set-inform http://34.116.224.72:8085/inform`
   - **Fallback** for older firmware: if that returns "not found", run the bare
     `set-inform http://34.116.224.72:8085/inform`.
   - Success is the string: `Adoption request sent to '...'. Use UniFi Network to
     complete the adopt process.`

3. Show success and tell the user their administrator will approve it. The app
   does **not** need to complete the adopt itself (that happens on our
   controller).

## Configuration
- **Controller inform URL** default: `http://34.116.224.72:8085/inform` — note the
  **non-standard port 8085** (our controller runs behind Coolify where 8080 is
  taken; do NOT hardcode 8080).
- Make the URL overridable via (a) a bundled `config.json` set at build time, and
  (b) a hidden **Advanced** panel in the UI, so the same app can be
  rebranded/repointed for other deployments.
- Optional **custom AP password** field in Advanced (for APs that were previously
  managed and no longer accept `ubnt`/`ubnt`).

## UI / UX (keep it to essentially one screen)
- Big friendly title + short instruction: "Plug in your access point, make sure
  this computer is on the same network, then click below."
- **[ Find my device ]** button → spinner → results list showing each found
  device as a card: model + a friendly name + IP (hide the MAC unless Advanced).
  If exactly one is found, auto-select it.
- **[ Send adoption request ]** button (enabled once a device is selected) →
  progress → result:
  - ✅ **"Request sent! Your administrator will approve it shortly. You can close
    this app."**
  - ❌ Friendly, specific errors (see below).
- A subtle **Advanced** link revealing: controller URL, custom SSH password, raw
  device details, and a copyable log.
- Clean, branded, minimal. No jargon on the main screen.

## Error handling (map these real cases to friendly messages)
- **No device found** → "We couldn't find an access point. Check that it's
  powered (PoE) and plugged into this same network, wait ~60s for it to boot,
  then try again." Include a "Scan again" button.
- **SSH auth fails (`ubnt`/`ubnt` rejected)** → "This access point may have been
  set up before. Please factory-reset it: hold the reset button ~10 seconds until
  the lights flash, wait for it to reboot, then try again." (Offer the Advanced
  password field.)
- **`set-inform` command not found on both variants** → surface raw output in the
  log; suggest updating.
- **Can't reach controller** (optional pre-flight): before/after set-inform, test
  TCP connectivity to `34.116.224.72:8085`; if unreachable, warn "This site can't
  reach the management server — check the internet connection/firewall," but still
  attempt (the AP, not the laptop, ultimately connects).
- Never crash on a malformed discovery packet; skip and continue.

## Tech stack
- **Recommended: Electron + TypeScript** (the maintainers' stack is JS/TS). Use
  Node `dgram` for UDP discovery and the **`ssh2`** npm library for SSH (it
  supports per-connection `algorithms` overrides needed for `ssh-rsa`). React or
  plain HTML/CSS for the UI.
- Acceptable alternative: **Tauri v2** (Rust backend with `tokio` UDP +
  `russh`/`ssh2` crate) for a much smaller installer — pick this if binary size
  matters more than JS familiarity.
- No admin/root privileges should be required to run.

## Packaging & distribution
- Produce installers for both platforms: **macOS `.dmg` (universal / arm64 +
  x64)** and **Windows `.exe` (NSIS)**.
- **Code signing + notarization**: sign & notarize the macOS build (Developer ID)
  and sign the Windows build (Authenticode) so SmartScreen/Gatekeeper don't block
  non-technical users. Document the signing setup in the README.
- Auto-update is nice-to-have (electron-updater), not required for v1.
- Bundle a small **README / first-run tip** explaining the PoE + same-network
  prerequisite.

## Branding
- App name + icon configurable (default working name: "AP Adoption Helper"). Put
  brand strings/colors in one config file.

## Deliverables
1. Source repo with clear build scripts (`npm run dist:mac`, `npm run dist:win`).
2. Signed `.dmg` and `.exe`.
3. README covering: prerequisites, how to rebrand/repoint the controller,
   code-signing setup, and troubleshooting (mirrors the error cases above).
4. The discovery + set-inform logic isolated in a testable module with unit tests
   for the TLV parser and the set-inform command selection.

## Out of scope for v1
Completing the adopt (admin does that on the controller), device monitoring, and
controller API auth.

---

## Reference: the manual steps this app replaces
For maintainers — this is exactly what we do by hand today:

```bash
# 1. Discover the AP on the LAN (UDP 10001 broadcast, parse TLV)
#    → e.g. U6-Pro at 192.168.2.6, MAC 74:fa:29:xx:xx:xx

# 2. SSH in with legacy algos and send the adoption request
sshpass -p ubnt ssh \
  -o StrictHostKeyChecking=accept-new \
  -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa \
  ubnt@192.168.2.6 'mca-cli-op set-inform http://34.116.224.72:8085/inform'
# → "Adoption request sent to 'http://34.116.224.72:8085/inform'. Use UniFi
#    Network to complete the adopt process."

# 3. Admin clicks "Adopt" in the controller UI (https://34.116.224.72:8443).
```
