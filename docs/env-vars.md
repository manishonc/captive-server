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

## Guest verification (OTP)

Gates internet access on the guest confirming a code sent by email, SMS or WhatsApp.
See `docs/guest-verification.md`.

| Variable | Description |
|---|---|
| `GUEST_VERIFICATION_SIGNING_SECRET` | HMAC key for the proof-of-verification token. Required by the **server and the portal**. |
| `GUEST_OTP_PEPPER` | Peppers codes hashed at rest. Required by the server. |
| `PORTAL_SHARED_SECRET` | Lets the server trust the portal's `X-Forwarded-For`. Required by both containers. |
| `GUEST_OTP_DAILY_CAP_PER_VENUE` | Per-venue daily send ceiling. Optional, default 500. |

> **Provision these before any tenant switches verification on.** With the first two unset,
> `resolveVerification()` disables verification and guests connect **unverified** — safe, but
> silently not what the tenant asked for. The server logs this at boot.
>
> This failure mode has precedent: `UNSUBSCRIBE_SIGNING_SECRET` and `INTERNAL_API_SECRET` are
> both documented here and both absent from the deployed environment.

**Generating:** `openssl rand -hex 32` for each. `GUEST_VERIFICATION_SIGNING_SECRET` and
`PORTAL_SHARED_SECRET` must be **identical** in the `server` and `portal` containers.

**Rotation:** rotating `GUEST_OTP_PEPPER` invalidates codes in flight (≤10 min of impact).
Rotating `GUEST_VERIFICATION_SIGNING_SECRET` invalidates verification tokens in flight (≤15 min),
and must be done in both containers at once or the Aruba path rejects every token.

**Without `PORTAL_SHARED_SECRET`** the per-IP OTP rate limits are skipped entirely rather than
applied to a shared constant — every guest reaches the server via the portal container, so its IP
is identical for the whole estate and limiting on it would throttle all venues together. The
per-destination, per-AP and per-venue-daily limits still apply.

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

## Internal API (marketing test sends)

Used by the CMS to trigger immediate marketing "Send test" messages via
`POST /internal/test-send`.

| Variable | Description |
|---|---|
| `INTERNAL_API_SECRET` | Shared secret authenticating server-to-server calls from the CMS. Must equal the CMS's `CAPTIVE_SERVER_INTERNAL_SECRET`. Endpoint fails closed (401) if unset. |

**`INTERNAL_API_SECRET`:** Generate with `openssl rand -hex 32`.

> The CMS side needs two matching vars set in the **CMS** deployment (not here):
> `CAPTIVE_SERVER_URL` (this server's public URL, e.g. `https://api.heidifi.ai`) and
> `CAPTIVE_SERVER_INTERNAL_SECRET` (= `INTERNAL_API_SECRET`).

Sends reuse the existing Twilio / Brevo / WhatsApp credentials above — no new
provider keys needed.

See also: `docs/marketing-test-send.md`

---

## AI / MCP (campaign capability layer)

The MCP service (`mcp/`, port 4001) exposes tenant-scoped campaign tools. The
CMS AI mints short-lived tenant tokens via `POST /internal/mint-token`; the
MCP campaign write tools proxy lifecycle actions back to `server/`.

| Variable | Service | Description |
|---|---|---|
| `MCP_INTERNAL_SECRET` | mcp | Guards `POST /internal/mint-token`. Must equal the CMS's `MCP_INTERNAL_SECRET`. Fails closed if unset. |
| `CAPTIVE_API_URL` | mcp | Base URL of `server/` for proxied campaign actions (default `http://localhost:4000`). |
| `INTERNAL_API_SECRET` | mcp | Same secret as `server/`'s — the MCP service calls `server/`'s `/internal/campaigns/*`. |

> CMS-side vars (set in the **CMS** deployment): `AI_GATEWAY_API_KEY` (Vercel AI
> Gateway), `MCP_BASE_URL` (this MCP service's public URL), `MCP_INTERNAL_SECRET`
> (= above), and optional `AI_CHAT_MODEL` / `AI_DESIGN_MODEL` overrides.

---

## Billing quotas (Phase: track + soft-enforce)

| Variable | Service | Description |
|---|---|---|
| `ENFORCE_QUOTAS` | server + CMS | `true` flips soft quota warnings into hard blocks (sends stop at the plan limit with `skipped_quota` records). Leave unset while messaging is free. |

---

## SMS / WhatsApp opt-out (compliance)

Inbound STOP/START/HELP handling lives at `POST /webhook/twilio/inbound` (SMS)
and inside the existing WhatsApp webhook. Ops setup: point the Twilio
Messaging Service's **inbound request URL** at
`${SERVER_PUBLIC_URL}/webhook/twilio/inbound`.

| Variable | Service | Description |
|---|---|---|
| `TWILIO_ADVANCED_OPT_OUT` | server | Set `true` when the Messaging Service has Advanced Opt-Out enabled — Twilio then sends the confirmation replies and we only sync guest opt-out state (no double replies). |

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
