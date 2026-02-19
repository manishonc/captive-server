# SMS Analytics & Twilio Delivery Webhook

## Overview

When a user opts into marketing at the captive portal, the server schedules SMS messages via Twilio and writes an analytics record to Firestore. Twilio then posts delivery status updates back to a webhook endpoint, keeping those records current.

```
User opts in
    │
    ▼
scheduleSmsForUser()
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

## Firestore Collection: `CaptivePortal_Marketing`

One document is created per scheduled SMS.

| Field | Type | Description |
|---|---|---|
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

## Environment Variables

Add to your `.env`:

```env
# Required for Twilio SMS
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional — enables webhook signature validation
# No trailing slash
SERVER_PUBLIC_URL=https://your-server.example.com:4000
```

---

## Twilio Console Setup

1. Go to **Messaging → Services** in the [Twilio Console](https://console.twilio.com)
2. Select your Messaging Service
3. Under **Integration**, set the **Status Callback URL** to:
   ```
   https://your-server.example.com:4000/webhook/twilio/sms-status
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

### 2. Simulate a Twilio status callback

```bash
curl -X POST http://localhost:4000/webhook/twilio/sms-status \
  -d "MessageSid=SM123&MessageStatus=delivered"
```

Confirm the matching document's `deliveryStatus` updates to `"delivered"`.

### 3. Test signature validation rejection

```bash
curl -X POST http://localhost:4000/webhook/twilio/sms-status \
  -H "X-Twilio-Signature: invalidsignature" \
  -d "MessageSid=SM123&MessageStatus=delivered"
# Expected: 403 Forbidden (only when SERVER_PUBLIC_URL is set)
```
