# Brevo Email Service

Transactional emails are sent via [Brevo](https://brevo.com) when a WiFi user connects (or reconnects) and has opted into marketing. This mirrors the SMS/Twilio flow.

---

## How It Works

### 1. User connects to WiFi

`POST /create-user` is called by the captive portal with the user's details and consent flags.

### 2. Marketing opt-in check

If `marketingConsent.given === true` and an access point was matched, the server fires two async jobs (fire-and-forget):

- `scheduleSmsForEvent()` — handles SMS via Twilio
- `scheduleEmailForEvent()` — handles email via Brevo

### 3. Config lookup

`scheduleEmailForEvent()` resolves the marketing config from Firestore:

```
CaptivePortal_AccessPoints / <accessPointId>
  └── venueId  →  CaptivePortal_EntityMarketing / venue_<venueId>
                    └── events.<wifiEvent>.email
                          ├── enabled: boolean
                          └── messages: [{ subject, body, delayMinutes }]
```

If `email.enabled` is `false` or `messages` is empty, it exits silently.

### 4. Email send

For each message in the array, `sendEmail()` calls Brevo's transactional email API:

- If `delayMinutes >= 1` → sets `scheduledAt` on the API request (Brevo schedules the send)
- If `delayMinutes < 1` → sends immediately

### 5. Analytics record

On a successful send, a document is written to `CaptivePortal_Marketing`:

```json
{
  "channel": "email",
  "wifiEvent": "onConnect",
  "userId": "...",
  "accessPointId": "...",
  "to": "user@example.com",
  "subject": "Welcome!",
  "body": "<html>...",
  "messageId": "<brevo-message-id>",
  "messageIndex": 0,
  "delayMinutes": 15,
  "sendAt": "2024-01-01T00:15:00.000Z",
  "scheduledAt": "<server-timestamp>",
  "deliveryStatus": "scheduled"
}
```

---

## WiFi Events

| Event | Triggered when |
|---|---|
| `onConnect` | User connects for the first time (no existing user doc for this AP) |
| `onReconnect` | User connects again (existing user doc found for same email + AP) |
| `onDisconnect` | Not yet implemented |

---

## Environment Variables

Set these in `.env` (or Coolify environment config for the `server` app):

| Variable | Required | Description |
|---|---|---|
| `BREVO_API_KEY` | Yes | API key from [Brevo → Settings → API Keys](https://app.brevo.com/settings/keys/api) |
| `BREVO_SENDER_EMAIL` | Yes | Verified sender address (must be verified in Brevo) |
| `BREVO_SENDER_NAME` | No | Display name shown to recipients. Defaults to `WiFi Portal` |

```env
BREVO_API_KEY=xkeysib-...
BREVO_SENDER_EMAIL=noreply@yourdomain.com
BREVO_SENDER_NAME=WiFi Portal
```

If `BREVO_API_KEY` or `BREVO_SENDER_EMAIL` is missing, email sends are skipped with a warning log and no error is thrown.

---

## Brevo Account Requirements

1. **Verify your sender domain or address** — Brevo requires the sender email to be verified before transactional emails can be sent. Go to [Senders & Domains](https://app.brevo.com/senders) to add and verify.

2. **Transactional email must be enabled** — Brevo separates marketing and transactional sending. Ensure your plan includes transactional email.

3. **Scheduling** — Brevo supports `scheduledAt` on transactional emails. The `delayMinutes` value set in the CMS is converted to an absolute ISO 8601 timestamp at send time. There is no enforced minimum like Twilio's 15-minute rule.

---

## Direct Send Endpoint

You can trigger an email directly without going through the WiFi event flow:

```
POST /schedule-email
```

**Request body:**

```json
{
  "to": "recipient@example.com",
  "subject": "Hello",
  "body": "<p>Welcome to our WiFi!</p>",
  "delayMinutes": 0
}
```

**Response:**

```json
{ "success": true, "messageId": "<brevo-message-id>" }
```

**Error responses:**

| Status | Reason |
|---|---|
| `400` | Missing or invalid `to`, `subject`, or `body` |
| `503` | Brevo credentials not configured |
| `500` | Brevo API error |

---

## CMS Configuration

Marketing email messages are configured per venue in the CMS under **Marketing** tab:

1. Open `/captive-dashboard/<venueId>` → Marketing
2. Select the WiFi event tab (On Connect / On Reconnect / On Disconnect)
3. Select the **Email** channel tab
4. Toggle **Enabled**
5. Click **Add Email** and fill in:
   - **Subject** (max 200 characters)
   - **Body** — HTML is supported (max 50,000 characters)
   - **Send after** — delay in minutes (minimum 15, maximum 30 days / 43,200 minutes)
6. Click **Save Changes**

Multiple messages can be added per event. They will all be scheduled in sequence when the event fires.

---

## Firestore Collections

| Collection | Purpose |
|---|---|
| `CaptivePortal_EntityMarketing` | Stores email config per venue (doc ID: `venue_<venueId>`) |
| `CaptivePortal_Marketing` | Delivery log — one doc per message sent, `channel: "email"` |

---

## Relevant Source Files

| File | Purpose |
|---|---|
| `server/src/services/brevo.ts` | Core `sendEmail()` function |
| `server/src/routes/email.ts` | `POST /schedule-email` direct-send endpoint |
| `server/src/routes/captive.ts` | `scheduleEmailForEvent()` — triggered on user connect/reconnect |
| `server/src/types/captive.ts` | `MarketingEmailMessage` type, `CaptivePortalMarketingDocument` |
