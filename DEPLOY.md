# Captive Portal — Deployment Guide

Complete reference for deploying, configuring, and maintaining the captive portal stack.

---

## Architecture Overview

Three independent services, each deployed as a separate app on **HeidiFi Coolify** (GCP VM):

```
WiFi Device
    │
    ▼
Aruba Instant AP
    │
    ├── Captive Portal redirect ──► portal (https://p.heidifi.ai)
    │                                   │
    │                                   └── proxies API calls ──► server (https://api.heidifi.ai)
    │                                                                   │
    │                                                                   └── Firebase / Twilio
    │
    └── RADIUS auth ──────────────► freeradius (34.116.237.182 UDP 1812/1813)
```

| Service | Technology | Domain | Internal Port |
|---------|-----------|--------|---------------|
| Portal | Node.js (Express) | `https://p.heidifi.ai` | 3000 |
| Server | Node.js + TypeScript (Express) | `https://api.heidifi.ai` | 4000 |
| FreeRADIUS | FreeRADIUS 3.2 Alpine | — (IP only) | UDP 1812, 1813 |

**Traefik** (Coolify's built-in proxy) handles HTTPS + Let's Encrypt SSL for portal and server.
FreeRADIUS uses UDP and bypasses Traefik — ports are mapped directly to the host.

**Current server IP:** `34.116.237.182` (GCP `us-central1`, e2-micro)

---

## Service 1: Portal

### What it does
Serves the WiFi login splash page to guests. Collects name/email/phone, proxies API requests to the server, and submits authentication to the Aruba switch via `swarm.cgi`.

### Files
- `portal/Dockerfile`
- `portal/server.js`
- `docker-compose.portal.yml` (standalone deploy reference)

### Coolify Settings
| Setting | Value |
|---------|-------|
| Buildpack | `dockerfile` |
| Base directory | `/portal` |
| ports_exposes | `3000` |
| Domain | `https://p.heidifi.ai` |

### Environment Variables
| Variable | Value | Required | Notes |
|----------|-------|----------|-------|
| `NODE_ENV` | `production` | Yes | |
| `PORTAL_DOMAIN` | `p.heidifi.ai` | Yes | Used in redirect URLs after Aruba auth |
| `SERVER_HOST` | `api.heidifi.ai` | Yes | Hostname of backend server |
| `SERVER_PORT` | `80` | Yes | Use 80 — Traefik handles HTTP internally, SSL terminates at the edge |

### Routes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Main portal splash page (Aruba redirects here) |
| POST | `/submit` | Receives guest form, triggers Aruba `swarm.cgi` auth |
| GET | `/success` | Post-auth success page |
| GET | `/api/privacy-policy` | Proxies to server `/privacy-policy` |
| GET | `/api/terms` | Proxies to server `/terms` |
| POST | `/api/create-user` | Proxies to server `/create-user` |
| GET | `/health` | Health check → `{"status":"ok"}` |

---

## Service 2: Server (Backend API)

### What it does
Backend API that persists guest data to Firestore, schedules/sends SMS via Twilio, handles Twilio delivery webhooks, and serves dynamic splash screen configuration per access point.

### Files
- `server/Dockerfile`
- `server/src/server.ts`
- `server/src/firebase.ts`
- `server/src/routes/captive.ts`
- `server/src/routes/sms.ts`
- `server/src/routes/twilioWebhook.ts`
- `server/src/services/twilio.ts`
- `docker-compose.server.yml` (standalone deploy reference)

### Coolify Settings
| Setting | Value |
|---------|-------|
| Buildpack | `dockerfile` |
| Base directory | `/server` |
| ports_exposes | `4000` |
| Domain | `https://api.heidifi.ai` |

### Environment Variables
| Variable | Required | Notes |
|----------|----------|-------|
| `FIREBASE_PROJECT_ID` | Yes | GCP project ID (e.g. `web-app-inhouse`) |
| `FIREBASE_CLIENT_EMAIL` | Yes | Service account email from Firebase Console |
| `FIREBASE_PRIVATE_KEY` | Yes | Full private key — newlines as `\n`. Set `is_multiline: true` in Coolify |
| `TWILIO_ACCOUNT_SID` | Yes | Starts with `AC` — from Twilio Console |
| `TWILIO_AUTH_TOKEN` | Yes | From Twilio Console |
| `TWILIO_MESSAGING_SERVICE_SID` | Yes | Starts with `MG` — required for scheduled SMS |
| `TWILIO_PHONE_NUMBER` | No | E.164 format (e.g. `+18777804236`) — fallback for immediate SMS |
| `SERVER_PUBLIC_URL` | Yes | `https://api.heidifi.ai` — used to validate Twilio webhook signatures |

### Routes
| Method | Path | Description |
|--------|------|-------------|
| POST | `/create-user` | Create/reconnect guest in Firestore + schedule SMS |
| GET | `/splash-config?apmac=<mac>` | Splash screen config for an AP |
| GET | `/privacy-policy` | Published privacy policy document |
| GET | `/terms` | Published terms of service document |
| POST | `/schedule-sms` | Schedule an SMS message |
| POST | `/webhook/twilio/sms-status` | Twilio delivery status webhook |
| GET | `/health` | Health check → `{"status":"ok"}` |

### Firestore Collections
| Collection | Description |
|-----------|-------------|
| `CaptivePortal_Users` | Guest records (name, email, phone, MAC, connection count) |
| `CaptivePortal_AccessPoints` | AP configs (MAC → entityType, entityId, SMS events) |
| `CaptivePortal_Sessions` | Per-connection events (`onConnect`, `onReconnect`) |
| `CaptivePortal_Marketing` | SMS delivery tracking (SID, status, delay) |
| `CaptivePortal_Documents` | Privacy policy + terms of service content |
| `CaptivePortal_SplashScreenConfig` | Per-location splash screen branding |

### Firebase Private Key Format
When setting `FIREBASE_PRIVATE_KEY`, replace actual newlines with the literal string `\n`:
```
"-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
```
In Coolify, mark this variable as **multiline** so it is stored correctly.

---

## Service 3: FreeRADIUS

### What it does
RADIUS authentication server. The Aruba AP sends authentication requests here. All users are accepted by default — the captive portal handles identity collection, RADIUS just grants WiFi access.

### Files
- `freeradius/Dockerfile`
- `freeradius/clients.conf` — RADIUS clients + shared secret
- `freeradius/users` — per-AP session timeout rules
- `docker-compose.freeradius.yml` (standalone deploy reference)

### Coolify Settings
| Setting | Value |
|---------|-------|
| Buildpack | `dockercompose` |
| Compose file | `/docker-compose.freeradius.yml` |
| Domain | None — accessed by IP only |

### Ports (mapped directly to host)
| Port | Protocol | Purpose |
|------|----------|---------|
| `1812` | UDP | RADIUS Authentication |
| `1813` | UDP | RADIUS Accounting |

### No Environment Variables
All configuration is baked into the Docker image via config files.

### clients.conf
```
client anywhere {
    ipaddr = 0.0.0.0/0
    secret = testing123
    shortname = all
}
```
> **Change `testing123` to a strong secret in production.** The same secret must be entered in the Aruba AP RADIUS settings.

### users
```
# Per-AP session timeout rules (auto-generated by generate-users.js)
DEFAULT Called-Station-Id =~ "54.f0.b1.c8.7f.00", Auth-Type := Accept
    Session-Timeout = 36000

# Fallback — accept everyone, 10-hour session
DEFAULT Auth-Type := Accept
    Session-Timeout = 36000
```
To add AP-specific rules, edit `freeradius/users` and redeploy.

---

## DNS Records

All three subdomains point to the same GCP VM IP:

| Subdomain | Type | Value |
|-----------|------|-------|
| `p.heidifi.ai` | A | `34.116.237.182` |
| `api.heidifi.ai` | A | `34.116.237.182` |
| `coolify.heidifi.ai` | A | `34.116.237.182` |

When redeploying to a new server, update all three A records to the new IP.

---

## GCP Firewall Rules

All rules are **Ingress**, **Priority 1000**, applied globally.

| Rule Name | Protocol | Port(s) | Purpose |
|-----------|----------|---------|---------|
| `allow-coolify-ssh` | TCP | `22` | SSH access + Coolify management |
| `allow-http-80` | TCP | `80` | HTTP traffic + Traefik |
| `allow-https-443` | TCP | `443` | HTTPS + Let's Encrypt SSL |
| `allow-radius-udp` | UDP | `1812, 1813` | RADIUS auth + accounting from Aruba AP |

> `allow-radius-udp` can be restricted to your AP's IP range for tighter security.

---

## Coolify Configuration (HeidiFi Instance)

| Setting | Value |
|---------|-------|
| Coolify URL | `https://coolify.heidifi.ai` |
| CLI context name | `HeidiFi-Coolify` |
| GCP VM IP | `34.116.237.182` |
| Project name | `Captive Portal` |
| Project UUID | `cdkhfl8yzj5silhksybwkx7l` |
| Server name | `Main Server` |
| Server UUID | `hjazfdxt9e7das4g190cfdso` |
| Deploy key name | `captive-server-deployment` |
| Deploy key UUID | `c6pguv4i1r73okj7tismnu8u` |
| GitHub repo | `git@github.com:manishonc/captive-server.git` |

### App UUIDs (current deployment)
| App | UUID |
|-----|------|
| portal | `stvst6bp6i7r4bo1li9lbumk` |
| server | `gf2b7yzehmsjosbontvc0jl5` |
| freeradius | `wnch66p3swcqzhcpffpj7ivm` |

---

## Aruba Instant AP Configuration

| Setting | Value |
|---------|-------|
| Captive Portal Type | External |
| External Portal URL | `https://p.heidifi.ai` |
| RADIUS Auth Server IP | `34.116.237.182` |
| RADIUS Auth Port | `1812` |
| RADIUS Shared Secret | `testing123` |
| RADIUS Accounting Port | `1813` |

---

## Full Redeploy from Scratch

Use this when migrating to a new server or setting up in a new environment.

### Step 1 — Provision GCP VM
- Machine type: `e2-micro` (free tier eligible in `us-central1`, `us-east1`, `us-west1`)
- OS: Ubuntu 22.04 LTS
- Disk: 30 GB standard
- Enable HTTP and HTTPS traffic during creation

### Step 2 — GCP Firewall
Create these rules in **VPC Network → Firewall**:
- TCP `22` ingress (SSH)
- TCP `80` ingress (HTTP)
- TCP `443` ingress (HTTPS)
- UDP `1812,1813` ingress (RADIUS)

### Step 3 — DNS
Point all subdomains to the new VM's external IP (A records).
Wait for DNS propagation before configuring SSL.

### Step 4 — Install Coolify
SSH into the VM and run:
```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```
Access Coolify at `http://<vm-ip>:8000` and complete setup.
Add TCP `8000` to GCP firewall temporarily during setup, then remove it.

### Step 5 — Configure Coolify CLI locally
```bash
coolify context add --name HeidiFi-Coolify \
  --fqdn https://coolify.<yourdomain> \
  --token <api-token>
```

### Step 6 — Add SSH Deploy Key in Coolify
1. In Coolify UI → **Keys & Tokens → Private Keys** → Create new key
2. Copy the public key
3. Add it to GitHub repo: **Settings → Deploy Keys → Add deploy key** (read-only)

### Step 7 — Create Project
```bash
coolify project create --name "Captive Portal" --context HeidiFi-Coolify
```

### Step 8 — Deploy FreeRADIUS
```bash
coolify app create deploy-key \
  --context HeidiFi-Coolify \
  --server-uuid <server-uuid> \
  --project-uuid <project-uuid> \
  --environment-name production \
  --private-key-uuid <key-uuid> \
  --git-repository "git@github.com:manishonc/captive-server.git" \
  --git-branch main \
  --build-pack dockercompose \
  --name freeradius \
  --ports-exposes "1812"

# Set compose file (CLI does not support this flag — use API)
curl -X PATCH "https://coolify.<domain>/api/v1/applications/<uuid>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"docker_compose_location": "/docker-compose.freeradius.yml"}'

coolify deploy uuid <uuid> --context HeidiFi-Coolify
```

### Step 9 — Deploy Server
```bash
coolify app create deploy-key \
  --context HeidiFi-Coolify \
  --server-uuid <server-uuid> \
  --project-uuid <project-uuid> \
  --environment-name production \
  --private-key-uuid <key-uuid> \
  --git-repository "git@github.com:manishonc/captive-server.git" \
  --git-branch main \
  --build-pack dockerfile \
  --base-directory /server \
  --name server \
  --ports-exposes "4000"

# Set domain
curl -X PATCH "https://coolify.<domain>/api/v1/applications/<uuid>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"domains": "https://api.<yourdomain>"}'

# Set env vars
coolify app env create <uuid> --context HeidiFi-Coolify --key FIREBASE_PROJECT_ID --value "..."
coolify app env create <uuid> --context HeidiFi-Coolify --key FIREBASE_CLIENT_EMAIL --value "..."
coolify app env create <uuid> --context HeidiFi-Coolify --key TWILIO_ACCOUNT_SID --value "..."
coolify app env create <uuid> --context HeidiFi-Coolify --key TWILIO_AUTH_TOKEN --value "..."
coolify app env create <uuid> --context HeidiFi-Coolify --key TWILIO_MESSAGING_SERVICE_SID --value "..."
coolify app env create <uuid> --context HeidiFi-Coolify --key TWILIO_PHONE_NUMBER --value "..."
coolify app env create <uuid> --context HeidiFi-Coolify --key SERVER_PUBLIC_URL --value "https://api.<yourdomain>"

# FIREBASE_PRIVATE_KEY — must be set via API with is_multiline flag
curl -X POST "https://coolify.<domain>/api/v1/applications/<uuid>/envs" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"key": "FIREBASE_PRIVATE_KEY", "value": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n", "is_multiline": true}'

coolify deploy uuid <uuid> --context HeidiFi-Coolify
```

### Step 10 — Deploy Portal
```bash
coolify app create deploy-key \
  --context HeidiFi-Coolify \
  --server-uuid <server-uuid> \
  --project-uuid <project-uuid> \
  --environment-name production \
  --private-key-uuid <key-uuid> \
  --git-repository "git@github.com:manishonc/captive-server.git" \
  --git-branch main \
  --build-pack dockerfile \
  --base-directory /portal \
  --name portal \
  --ports-exposes "3000"

# Set domain and fix ports_exposes (CLI defaults to 80)
curl -X PATCH "https://coolify.<domain>/api/v1/applications/<uuid>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"domains": "https://p.<yourdomain>", "ports_exposes": "3000"}'

# Set env vars
coolify app env create <uuid> --context HeidiFi-Coolify --key NODE_ENV --value production
coolify app env create <uuid> --context HeidiFi-Coolify --key PORTAL_DOMAIN --value "p.<yourdomain>"
coolify app env create <uuid> --context HeidiFi-Coolify --key SERVER_HOST --value "api.<yourdomain>"
coolify app env create <uuid> --context HeidiFi-Coolify --key SERVER_PORT --value "80"

coolify deploy uuid <uuid> --context HeidiFi-Coolify
```

### Step 11 — Update Aruba AP
Change the RADIUS Server IP and Portal URL to the new server's values.

---

## Testing Checklist

Run these after every deployment or migration:

```bash
# 1. Server health
curl https://api.heidifi.ai/health
# Expected: {"status":"ok"}

# 2. Portal health
curl https://p.heidifi.ai/health
# Expected: {"status":"ok"}

# 3. Portal → Server proxy (confirms Firestore connection)
curl https://p.heidifi.ai/api/privacy-policy
# Expected: {"success":true,...} or {"success":false} (false = no doc in Firestore yet, connection is fine)

# 4. RADIUS test (requires freeradius-utils)
radtest testuser testpass 34.116.237.182 1812 testing123
# Expected: Received Access-Accept

# 5. End-to-end
# Connect a device to the WiFi SSID
# → should redirect to https://p.heidifi.ai
# Fill in the form and submit
# → should authenticate and grant internet access
# → check Firestore CaptivePortal_Users for new document
```

---

## Twilio Webhook Setup

After deploying, configure Twilio to send SMS delivery callbacks:

1. Go to **Twilio Console → Messaging → Services → [your service]**
2. Set **Status Callback URL** to:
   ```
   https://api.heidifi.ai/webhook/twilio/sms-status
   ```
3. Ensure `SERVER_PUBLIC_URL` env var matches exactly (used for signature validation)

---

## Adding a New Access Point

1. Edit `freeradius/users` — add a rule for the AP's MAC address:
   ```
   DEFAULT Called-Station-Id =~ "aa.bb.cc.dd.ee.ff", Auth-Type := Accept
       Session-Timeout = 36000
   ```
2. Alternatively, run `node generate-users.js` if APs are configured in `portal/restaurants.json`
3. Commit, push, and redeploy FreeRADIUS in Coolify

---

## Environment Quick Reference

### Portal
```
NODE_ENV=production
PORTAL_DOMAIN=p.heidifi.ai
SERVER_HOST=api.heidifi.ai
SERVER_PORT=80
```

### Server
```
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_MESSAGING_SERVICE_SID=...
TWILIO_PHONE_NUMBER=...
SERVER_PUBLIC_URL=https://api.heidifi.ai
```

### FreeRADIUS
No environment variables. Configuration is in:
- `freeradius/clients.conf` — shared secret
- `freeradius/users` — AP rules and session timeouts
