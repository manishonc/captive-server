# UniFi Integration — How It Works & Setup Guide

## Architecture Overview

### How Aruba Works (existing)
```
Guest → connects to SSID → Aruba redirects to portal
Portal form submit → browser POSTs to swarm.cgi → Aruba grants access
FreeRADIUS (port 1812) → validates AP is registered → Accept/Reject
```

### How UniFi Works (new)
```
Guest → connects to SSID → UniFi controller redirects to portal
Portal form submit → portal calls our server → server calls UniFi API → UniFi grants access
No RADIUS needed — the controller API handles everything
```

The key difference: **Aruba uses the browser to send auth back**. UniFi uses a **server-side API call** from our captive-server to the UniFi Network Application controller.

---

## Component Diagram

```
[Guest Device]
    │  1. connects to guest SSID
    ▼
[UniFi U6-Pro AP]
    │  2. redirects HTTP to UniFi controller
    ▼
[UniFi Network Application (Docker, port 8443)]
    │  3. controller redirects browser to:
    │     https://p.heidifi.ai/?ap=<AP_MAC>&id=<CLIENT_MAC>&t=<TS>&url=<ORIG>&ssid=<SSID>
    ▼
[Portal Container (port 3000)]
    │  4. serves branded splash page
    │  5. guest fills form → POSTs /unifi-submit
    ▼
[Server Container (port 4000)]
    │  6. POST /unifi/authorize → looks up AP in Firestore
    │  7. calls UniFi API: POST /api/s/default/cmd/stamgr
    │     { cmd: "authorize-guest", mac: <CLIENT_MAC>, minutes: 600 }
    ▼
[UniFi Network Application]
    │  8. pushes auth to AP over inform channel
    ▼
[UniFi U6-Pro AP]
    │  9. moves client from "pending" to "authorized"
    ▼
[Guest Device] ← has internet access
```

---

## URL Parameters from UniFi

When UniFi redirects a guest to your portal, the URL looks like:
```
https://p.heidifi.ai/?ap=94:2a:6f:d0:30:57&id=1c:71:25:63:e4:24&t=1742398732&url=http://example.com/&ssid=FREE-WIFI
```

| Param | Meaning | Used for |
|-------|---------|---------|
| `ap` | AP MAC address | Lookup AP config in Firestore |
| `id` | Guest device MAC | Passed to UniFi authorize API |
| `t` | Timestamp (UNIX) | Informational |
| `url` | Original destination URL | Redirect after auth |
| `ssid` | SSID name | Display / logging |

**Aruba uses**: `apmac`, `mac`, `ip`, `post`, `cmd`, `url`
**UniFi uses**: `ap`, `id`, `t`, `url`, `ssid`

The portal detects which vendor sent the redirect based on which params are present.

---

## Part 1: Deploy Self-Hosted UniFi Network Application

### Prerequisites
- Coolify instance with Docker
- A public IP or domain for the server (APs need to reach port 8080)
- Ports 8080, 8443, 3478/udp open in your firewall

### Step 1: Configure Passwords

Edit `unifi/init-mongo.js` — change `changeme_unifi` to a strong password.

Set these environment variables in Coolify for the `docker-compose.unifi.yml` deployment:

| Variable | Description | Example |
|----------|-------------|---------|
| `UNIFI_MONGO_ROOT_USER` | MongoDB root username | `root` |
| `UNIFI_MONGO_ROOT_PASS` | MongoDB root password | `strong_root_pass` |
| `UNIFI_MONGO_USER` | UniFi DB username | `unifi` |
| `UNIFI_MONGO_PASS` | UniFi DB password (must match init-mongo.js) | `strong_unifi_pass` |

### Step 2: Deploy via Coolify

In Coolify, create a new service using `docker-compose.unifi.yml`. After deploying:

- UniFi controller UI: `https://<your-server-ip>:8443`
- AP inform URL: `http://<your-server-ip>:8080/inform`

### Step 3: Initial Controller Setup

1. Open `https://<your-server-ip>:8443` in a browser (accept the self-signed cert warning)
2. Follow the setup wizard:
   - Create a local account (NOT a Ubiquiti cloud account — keeps it self-contained)
   - Set the server IP/hostname to your public server IP
3. Create a dedicated admin for the captive portal API:
   - **Settings → Admins → Add Admin**
   - Username: `captive-service`
   - Role: Read/Write (or create a limited role)
   - Note down the password — this goes into the CMS AP config

---

## Part 2: Adopt the U6-Pro

UniFi APs must be "adopted" by the controller before they can be managed.

### Option A: Factory Reset + Auto-Adopt
1. Factory reset the U6-Pro (hold reset button 10 seconds)
2. Connect it to the same LAN as the controller (if possible) — it auto-discovers
3. OR: SSH to the AP and set the inform URL manually:

```bash
ssh ubnt@<AP_IP>
# default password: ubnt (change after adoption)
set-inform http://<your-server-ip>:8080/inform
```

### Option B: Set Inform URL via UBNT Discovery
Use the UniFi mobile app or the controller's **Devices → Adopt** flow to adopt APs.

### After Adoption
The AP appears under **Devices** in the controller with status "Connected". Note down the AP's MAC address (shown under Devices — this is what goes into the CMS "MAC Address" field).

---

## Part 3: Configure Guest Network in UniFi

### Create Guest SSID
1. **Settings → WiFi → Create New WiFi**
2. Name: `FREE-WIFI` (or your venue name)
3. Security: Open (no password)
4. Under **Advanced**:
   - Enable **Guest Network** (client isolation from LAN)

### Configure Guest Portal
1. **Settings → Profiles → Guest Control** → or directly under the WiFi's **Advanced** settings
2. Enable **Guest Portal**
3. Set **Authentication** to **External Portal Server**
4. Enter Portal URL: `https://p.heidifi.ai`
5. Under **Pre-Authorization Access** (Walled Garden), add:
   - `p.heidifi.ai` — your portal domain
   - `api.heidifi.ai` — your API domain (if different)

### Session Duration
In UniFi you can set guest session duration in the controller, but our system overrides it per AP (set in CMS → Session Duration field). The CMS value is passed as `minutes` to the authorize API call.

---

## Part 4: Add AP in CMS

In the CMS → Captive Portal → Access Points → Add Access Point:

1. **Step 1**: Select **UniFi** hardware
2. **Step 2**: Read the setup guide (what you're doing now)
3. **Step 3**: Fill in:

| Field | Value | Where to find it |
|-------|-------|-----------------|
| Name | Friendly name, e.g. "Lobby U6-Pro" | You choose |
| MAC Address | AP's MAC address | UniFi controller → Devices → select AP → Details |
| Venue | Select venue | CMS |
| Session Duration | How long before re-auth | You choose |
| Controller URL | `https://<server-ip>:8443` | Your Coolify server |
| Controller Type | Classic (standard controller) | Use "Classic" for self-hosted |
| Site | `default` | UniFi controller → site name in URL |
| Admin Username | `captive-service` | Created in Step 3 above |
| Admin Password | The password you set | Created in Step 3 above |

---

## AP Heartbeat & Monitoring

Unlike Aruba (which runs a custom heartbeat cron script), UniFi APs don't support arbitrary scripts. Instead:

- **Primary**: The server calls the UniFi API on each guest authorization — if the AP is offline, auth fails and you know immediately.
- **Monitoring**: The AP monitor job (`apMonitor.ts`) uses the existing `lastSeen` field updated on each `/unifi/authorize` call. If no guest connects within the `offlineThresholdMinutes` window, the alert fires.

Future improvement: Poll the UniFi controller API (`GET /api/s/default/stat/device-basic`) to get AP uptime directly, without waiting for a guest connection.

---

## Security Notes

- **Controller credentials** (username + password) are stored in Firestore, accessible only via authenticated server-side API routes. They are never returned to the browser (password is stripped from all API responses).
- **Self-signed certificate**: The controller uses a self-signed TLS cert by default. The server-to-controller API calls accept this (`rejectUnauthorized: false`). To use a valid cert, put the controller behind a Coolify reverse proxy domain — then you can set `rejectUnauthorized: true`.
- **Network isolation**: The captive-server and UniFi controller containers share the `coolify` Docker network, so API calls stay internal. The controller's port 8443 only needs to be exposed publicly if you want to access the UI from outside the server.

---

## Troubleshooting

### AP not adopting
- Make sure port 8080 is open and reachable from the AP's network
- Run `set-inform http://<server-ip>:8080/inform` via SSH on the AP
- Check controller logs: Coolify → unifi container → logs

### Guest not getting internet after form submit
- Check server logs for `[UNIFI AUTH]` entries
- Confirm `controllerUrl` is reachable from the server container: `docker exec server curl -k https://unifi:8443`
- Confirm credentials are correct by testing login manually

### "No access point found for apMac" in server logs
- The AP MAC in Firestore must match the `ap` param UniFi sends exactly (lowercase, colon-separated)
- Verify the MAC address in Firestore matches what UniFi shows under Devices

### Certificate errors
- For self-hosted controller, `rejectUnauthorized` defaults to `false` (self-signed accepted)
- If using a Coolify-proxied domain with Let's Encrypt, the cert is valid — set `rejectUnauthorized: true` for extra security
