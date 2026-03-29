# Twilio Setup

## Webhook URL

```
https://api.heidifi.ai/webhook/twilio/sms-status
```

This endpoint receives SMS delivery status callbacks from Twilio and updates the `deliveryStatus` field in Firestore (`CaptivePortal_Marketing` collection).

## Environment Variables

Set these in your `.env` (or Coolify environment config for the `server` app):

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Account SID from [Twilio Console](https://console.twilio.com) |
| `TWILIO_AUTH_TOKEN` | Auth token from Twilio Console |
| `TWILIO_MESSAGING_SERVICE_SID` | Messaging Service SID (starts with `MG`) — required for scheduled SMS |
| `TWILIO_PHONE_NUMBER` | Fallback sender number in E.164 format (e.g. `+14155551234`) — used for immediate sends when no Messaging Service is set |
| `SERVER_PUBLIC_URL` | Public base URL of this server, no trailing slash (e.g. `https://api.heidifi.ai`) — used to validate Twilio webhook signatures |

## Configuring the Webhook in Twilio

### Option A — Twilio Console (UI)

1. Go to [Messaging Services](https://console.twilio.com/us1/develop/sms/services)
2. Open your Messaging Service (`MG3f13462...`)
3. Click **Integration**
4. Under **Status Callback URL**, paste:
   ```
   https://api.heidifi.ai/webhook/twilio/sms-status
   ```
5. Save.

### Option B — REST API (already applied)

```bash
curl -X POST "https://messaging.twilio.com/v1/Services/<MESSAGING_SERVICE_SID>" \
  -u "<ACCOUNT_SID>:<AUTH_TOKEN>" \
  --data-urlencode "StatusCallback=https://api.heidifi.ai/webhook/twilio/sms-status"
```

## Signature Validation

When `SERVER_PUBLIC_URL` is set, the server validates the `X-Twilio-Signature` header on every incoming webhook request. Requests with an invalid signature are rejected with `403 Forbidden`.

Make sure `SERVER_PUBLIC_URL` is set to exactly `https://api.heidifi.ai` (no trailing slash) in the Coolify environment for the `server` app.
