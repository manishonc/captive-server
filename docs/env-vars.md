# Environment Variables — Migration Guide

Complete reference for every env var used by `captive-server`. Use this when setting up a new server or migrating to a new host.

**Current deployment:** Coolify at `coolify.heidifi.ai`
**Server app UUID:** `gf2b7yzehmsjosbontvc0jl5` (context: `HeidiFi-Coolify`)

---

## Quick Start

```bash
cp .env.example .env
# fill in values using this guide
```

For Coolify, add each var via:
```bash
coolify app env create <app-uuid> --context HeidiFi-Coolify --key KEY --value VALUE
```

---

## Firebase / Firestore

Used by the `server` container to read/write all app data.

| Variable | Description |
|---|---|
| `FIREBASE_PROJECT_ID` | Project ID from Firebase Console |
| `FIREBASE_CLIENT_EMAIL` | Service account email |
| `FIREBASE_PRIVATE_KEY` | Private key from service account JSON |

**Where to get:**
1. Firebase Console → Project Settings → Service Accounts
2. Click **Generate new private key** → download JSON
3. `FIREBASE_PROJECT_ID` = `project_id` field
4. `FIREBASE_CLIENT_EMAIL` = `client_email` field
5. `FIREBASE_PRIVATE_KEY` = `private_key` field — in Docker/Coolify, the value must be wrapped in single quotes so the literal `\n` characters are preserved:
   ```
   '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n'
   ```

---

## Twilio SMS

Used to send and schedule SMS messages to guests.

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Account SID — starts with `AC` |
| `TWILIO_AUTH_TOKEN` | Auth token |
| `TWILIO_MESSAGING_SERVICE_SID` | Messaging Service SID — starts with `MG` |
| `TWILIO_PHONE_NUMBER` | Fallback sender number in E.164 format (optional) |

**Where to get:**
1. [console.twilio.com](https://console.twilio.com) → Account Info (homepage)
2. `TWILIO_MESSAGING_SERVICE_SID`: Messaging → Services → create or copy existing

See also: `docs/twilio-setup.md`

---

## Brevo (Email)

Used for marketing emails and router offline/recovery alert emails.

| Variable | Description |
|---|---|
| `BREVO_API_KEY` | API key from Brevo dashboard |
| `BREVO_SENDER_EMAIL` | Verified sender address (e.g. `promo@heidifi.ai`) |
| `BREVO_SENDER_NAME` | Display name shown in emails |

**Where to get:**
1. [app.brevo.com](https://app.brevo.com) → Settings → API Keys → Generate
2. Sender must be verified under Senders & IP → Senders

See also: `docs/brevo-email-setup.md`

---

## WhatsApp (Meta Cloud API)

Used to send WhatsApp template messages to guests after login.

| Variable | Description |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID from Meta App dashboard |
| `WHATSAPP_ACCESS_TOKEN` | Permanent System User token from Meta Business Settings |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Secret string you choose — must match what's entered in Meta webhook config |

**Where to get:**

**`WHATSAPP_PHONE_NUMBER_ID`**
- [developers.facebook.com](https://developers.facebook.com) → your app → WhatsApp → API Setup → Phone Number ID

**`WHATSAPP_ACCESS_TOKEN`**
- [business.facebook.com](https://business.facebook.com) → Settings → Users → System Users
- Select/create a System User with Admin role → Generate new token
- Grant permissions: `whatsapp_business_messaging`, `whatsapp_business_management`
- Use this permanent token, NOT the temporary one shown on the API Setup page

**`WHATSAPP_WEBHOOK_VERIFY_TOKEN`**
- Pick any secret string (e.g. `heidifi-wa-2026`)
- Set it here AND enter the same string in Meta App → WhatsApp → Configuration → Webhook → Verify Token
- Set Webhook URL to: `https://api.heidifi.ai/webhook/whatsapp`
- Subscribe to the `messages` webhook field

---

## Server

| Variable | Description |
|---|---|
| `SERVER_PUBLIC_URL` | Public HTTPS URL of the API server — used for Twilio webhook signature validation |

**Value:** `https://api.heidifi.ai`

---

## Portal

| Variable | Description |
|---|---|
| `PORTAL_DOMAIN` | Public domain of the portal (used for redirect URLs) |

**Value:** `p.heidifi.ai` (or the VPS IP with `.nip.io` for local dev)

---

## Router Offline Alerts

| Variable | Description |
|---|---|
| `AP_HEARTBEAT_SECRET` | Secret used to authenticate AP heartbeat requests to `POST /ap-heartbeat` |
| `CMS_DASHBOARD_URL` | CMS URL included in alert emails as a "View Dashboard" link |

**`AP_HEARTBEAT_SECRET`:** Generate with `openssl rand -hex 32`. Must match what's flashed onto each AP.

See also: `docs/router-offline-alerts.md`

---

## RADIUS (optional)

| Variable | Description |
|---|---|
| `RADIUS_SECRET` | Shared secret between AP and FreeRADIUS |

Only needed when running the `freeradius` container for MAC-based auth.

---

## Coolify CLI Reference

```bash
# List all env vars for server app
coolify app env list gf2b7yzehmsjosbontvc0jl5 --context HeidiFi-Coolify -s

# Add a new var
coolify app env create gf2b7yzehmsjosbontvc0jl5 --context HeidiFi-Coolify --key KEY --value VALUE

# Update an existing var (use the var's UUID from the list command)
coolify app env update <var-uuid> --context HeidiFi-Coolify --value NEW_VALUE

# Trigger redeploy after env changes
coolify deploy gf2b7yzehmsjosbontvc0jl5 --context HeidiFi-Coolify
```
