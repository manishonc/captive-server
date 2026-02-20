# SMS Analytics & Twilio Delivery Webhook

## Overview

When a user opts into marketing at the captive portal, the server detects whether they are a new or returning visitor, schedules SMS messages via Twilio for the appropriate WiFi event, and writes analytics records to Firestore. Twilio then posts delivery status updates back to a webhook endpoint, keeping those records current.

```
User submits form
    │
    ├─► Reconnect detection query (email + accessPointId)
    │         │
    │         ├─ first visit  → wifiEvent: "onConnect"   → create CaptivePortal_Users doc
    │         └─ returning    → wifiEvent: "onReconnect" → increment connectionCount
    │
    ├─► CaptivePortal_Sessions doc written (every visit)
    │
    └─► scheduleSmsForEvent(wifiEvent)   [if marketingOptIn]
              │
              ├─► reads events.[wifiEvent].sms from AP config
              │
              ├─► scheduleSms() ──► Twilio (message scheduled)
              │         │
              │         └─► messageSid returned
              │
              └─► CaptivePortal_Marketing doc written
                        deliveryStatus: "scheduled"

Later...

Twilio POST /webhook/twilio/sms-status
    │
    └─► CaptivePortal_Marketing doc updated
              deliveryStatus: "delivered" (or failed, etc.)
```

---

## WiFi Events

SMS scheduling is driven by the `wifiEvent` detected at form submission time.

| Event | When triggered | AP config key |
|---|---|---|
| `onConnect` | User's email not seen at this AP before | `events.onConnect.sms` |
| `onReconnect` | User's email already exists for this AP | `events.onReconnect.sms` |

Each event reads its own independent SMS config from the Access Point document. You can configure different messages, delays, or enable/disable each event independently.

### Access Point SMS config shape

```json
{
  "events": {
    "onConnect": {
      "sms": {
        "enabled": true,
        "messages": [
          { "content": "Welcome! Here's 10% off your first visit.", "delayMinutes": 0 }
        ]
      }
    },
    "onReconnect": {
      "sms": {
        "enabled": true,
        "messages": [
          { "content": "Welcome back! Show this for a free coffee.", "delayMinutes": 5 }
        ]
      }
    }
  }
}
```

If a key is absent or `enabled: false`, no SMS is sent for that event.

---

## Firestore Collection: `CaptivePortal_Sessions`

One document is written per connection event (new and returning). Acts as a connection history log.

| Field | Type | Description |
|---|---|---|
| `wifiEvent` | `"onConnect"` \| `"onReconnect"` | Event type for this session |
| `userId` | string | Ref to `CaptivePortal_Users` doc |
| `accessPointId` | string | Firestore doc ID of the access point |
| `mac` | string | Client MAC address at time of this session |
| `ip` | string | Client IP address at time of this session |
| `timestamp` | string | ISO 8601 — form submission time |
| `createdAt` | Timestamp | Firestore server timestamp |

This write is fire-and-forget — a failure does not affect the HTTP response.

---

## Firestore Collection: `CaptivePortal_Marketing`

One document is created per scheduled SMS.

| Field | Type | Description |
|---|---|---|
| `wifiEvent` | `"onConnect"` \| `"onReconnect"` | Event that triggered this SMS |
| `channel` | `"sms"` | Always `"sms"` for this flow |
| `accessPointId` | string | Firestore doc ID of the access point |
| `userId` | string | Firestore doc ID of the `CaptivePortal_Users` record |
| `messageSid` | string | Twilio message SID — used for webhook correlation |
| `to` | string | E.164 recipient phone number |
| `content` | string | SMS message body |
| `messageIndex` | number | 0-based index in the AP's `sms.messages` array |
| `delayMinutes` | number | Scheduled delay from opt-in time |
| `sendAt` | string | ISO 8601 calculated delivery time |
| `scheduledAt` | Timestamp | Server timestamp when the record was created |
| `deliveryStatus` | string | Current delivery state (see below) |
| `statusUpdatedAt` | Timestamp | Set when status changes via webhook |

### Delivery Status Progression

```
scheduled → queued → sending → sent → delivered
                                    ↘ failed / undelivered
```

---

## Webhook Endpoint

**`POST /webhook/twilio/sms-status`**

Twilio calls this endpoint after each status change for a scheduled message.

- Accepts `application/x-www-form-urlencoded` (Twilio's default format)
- Extracts `MessageSid` and `MessageStatus` from the body
- Finds the matching `CaptivePortal_Marketing` document and updates `deliveryStatus`
- Always responds HTTP 200 to prevent Twilio from retrying

### Signature Validation (optional)

If `SERVER_PUBLIC_URL` is set in the environment, every incoming request is validated against `X-Twilio-Signature` using `twilio.validateRequest()`. Requests with an invalid or missing signature are rejected with **403**.

If `SERVER_PUBLIC_URL` is not set, signature validation is silently skipped (useful for local development).

---

## Deployment URLs (current server)

The portal and API server are two separate services on the same host:

| Service | Container | External URL |
|---|---|---|
| Portal (Next.js) | `portal` | `http://167.71.229.249.nip.io` (port 80) |
| API server (Express) | `server` | `http://167.71.229.249.nip.io:4000` (port 4000) |

`SERVER_PUBLIC_URL` must point to the **API server**, not the portal:

```
SERVER_PUBLIC_URL=http://167.71.229.249.nip.io:4000
```

The full Twilio callback URL is therefore:

```
http://167.71.229.249.nip.io:4000/webhook/twilio/sms-status
```

### Note on HTTP vs HTTPS

Twilio strongly prefers HTTPS for webhook URLs and will warn if the URL is plain HTTP. Options:

- **HTTP (current)** — works and is fine for testing; Twilio logs a warning but still delivers callbacks.
- **Add nginx with TLS** — put a reverse proxy in front of the `server` container on port 443; `SERVER_PUBLIC_URL` then becomes `https://167.71.229.249.nip.io` with no port.
- **Cloudflare Tunnel / ngrok** — gets you HTTPS without managing certificates, useful if a full nginx setup is too much overhead right now.

---

## Environment Variables

Add to your `.env`:

```env
# Required for Twilio SMS
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional — enables webhook signature validation
# No trailing slash
SERVER_PUBLIC_URL=http://167.71.229.249.nip.io:4000
```

---

## Twilio Console Setup

1. Go to **Messaging → Services** in the [Twilio Console](https://console.twilio.com)
2. Select your Messaging Service
3. Under **Integration**, set the **Status Callback URL** to:
   ```
   http://167.71.229.249.nip.io:4000/webhook/twilio/sms-status
   ```
4. Save. Twilio will POST to this URL for every status transition.

---

## Firestore Index

The webhook queries `CaptivePortal_Marketing` by `messageSid`. For small collections Firestore handles this automatically. If the collection grows large, add a **single-field index** on `messageSid` in the Firebase Console:

**Firebase Console → Firestore → Indexes → Single field → Add**

- Collection: `CaptivePortal_Marketing`
- Field: `messageSid`
- Scope: Collection

---

## Testing

### 1. Verify a record is created on opt-in

```bash
curl -X POST http://localhost:4000/create-user \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "User",
    "phone": "5551234567",
    "phoneCountryCode": "1",
    "apmac": "<your-ap-mac>",
    "marketingConsent": { "given": true, "timestamp": "2024-01-01T00:00:00Z", "version": "1.0" }
  }'
```

Check Firestore → `CaptivePortal_Marketing` for a new document with `deliveryStatus: "scheduled"`.

### 2. Trigger a reconnect

Submit the same email + apmac a second time. Expect:
- No new `CaptivePortal_Users` doc
- `connectionCount` incremented on the existing doc
- A new `CaptivePortal_Sessions` doc with `wifiEvent: "onReconnect"`
- An onReconnect SMS scheduled (if `events.onReconnect.sms` is configured and enabled)

```bash
curl -X POST http://localhost:4000/create-user \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Test",
    "lastName": "User",
    "email": "test@example.com",
    "phone": "5551234567",
    "phoneCountryCode": "1",
    "apmac": "<your-ap-mac>",
    "marketingConsent": { "given": true, "timestamp": "2024-01-01T00:00:00Z", "version": "1.0" }
  }'
```

### 3. Simulate a Twilio status callback

```bash
curl -X POST http://localhost:4000/webhook/twilio/sms-status \
  -d "MessageSid=SM123&MessageStatus=delivered"
```

Confirm the matching document's `deliveryStatus` updates to `"delivered"`.

### 4. Test signature validation rejection

```bash
curl -X POST http://localhost:4000/webhook/twilio/sms-status \
  -H "X-Twilio-Signature: invalidsignature" \
  -d "MessageSid=SM123&MessageStatus=delivered"
# Expected: 403 Forbidden (only when SERVER_PUBLIC_URL is set)
```
