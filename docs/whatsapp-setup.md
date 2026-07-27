# WhatsApp Setup Guide

End-to-end guide for how WhatsApp automation is wired up in HeidiFi — what's built, how it works, and how to set it up from scratch.

---

## How It Works

When a guest connects to WiFi, the captive portal server:

1. Looks up the access point → finds the venue ID
2. Reads the venue's marketing config from Firestore (`CaptivePortal_EntityMarketing`)
3. Checks if WhatsApp is enabled for the triggered event (`connect` or `reconnect`)
4. Sends one or more WhatsApp template messages to the guest's phone via Meta Cloud API
5. Saves a record to `CaptivePortal_Marketing` with the `wamid` (WhatsApp message ID)
6. As Meta delivers the message, delivery status updates arrive via webhook and are written back to that record

```
Guest connects
     │
     ▼
captive.ts: scheduleWhatsAppForEvent()
     │
     ├── Fetch AP doc → get venueId
     ├── Fetch CaptivePortal_EntityMarketing/venue_{venueId}
     ├── Read events.connect.whatsapp config
     │
     ▼
whatsapp.ts: sendWhatsAppTemplate()
     │
     └── POST graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages
              │
              └── returns wamid → saved to CaptivePortal_Marketing
                       │
                       ▼
              Meta POSTs delivery status to webhook
                       │
                       ▼
              whatsappWebhook.ts: updates deliveryStatus in Firestore
```

---

## Message Scheduling

Meta Cloud API has no native scheduling. The server uses `setTimeout` for short delays (configured as `delayMinutes` per message in the CMS). For production with long delays (e.g. 24 hours), this should be replaced with a job queue like Bull or GCP Cloud Tasks.

---

## Template Messages

WhatsApp only allows sending pre-approved **template messages** — you cannot send free-form text to a guest who hasn't messaged you first.

Templates must be created and approved in **Meta Business Suite → WhatsApp Manager → Message Templates** before they can be used.

Each template message in HeidiFi supports two variables injected automatically:
- `{{1}}` → guest's first name
- `{{2}}` → venue name

---

## Firestore Data

**Marketing config** (set via CMS):
```
CaptivePortal_EntityMarketing / venue_{venueId}
  └── events
        └── connect (or reconnect)
              └── whatsapp
                    ├── enabled: true
                    └── messages: [
                          {
                            templateName: "wifi_welcome",
                            languageCode: "en_US",
                            delayMinutes: 0
                          }
                        ]
```

**Sent message record:**
```
CaptivePortal_Marketing / {auto-id}
  ├── channel: "whatsapp"
  ├── wifiEvent: "connect"
  ├── wifiGuestId: "..."
  ├── accessPointId: "..."
  ├── to: "+41791234567"
  ├── wamid: "wamid.xxx"
  ├── templateName: "wifi_welcome"
  ├── languageCode: "en_US"
  ├── delayMinutes: 0
  ├── deliveryStatus: "sent" | "delivered" | "read" | "failed"
  └── statusUpdatedAt: <timestamp>
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID from Meta App dashboard |
| `WHATSAPP_ACCESS_TOKEN` | Permanent System User token from Meta Business Settings |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Secret string you choose — must match Meta webhook config |

If `WHATSAPP_PHONE_NUMBER_ID` or `WHATSAPP_ACCESS_TOKEN` are not set, the service skips silently with a warning log — no crashes.

---

## Meta App Setup (Step by Step)

### 1. Create a Meta App

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App**
2. Choose **Business** type
3. Add the **WhatsApp** product to the app

### 2. Get the Phone Number ID

1. In your app → **WhatsApp** → **API Setup**
2. Copy the **Phone Number ID** (not the phone number itself)
3. Set as `WHATSAPP_PHONE_NUMBER_ID`

### 3. Get a Permanent Access Token

The temporary token on the API Setup page expires — use a System User token instead:

1. Go to [business.facebook.com](https://business.facebook.com) → **Settings** → **Users** → **System Users**
2. Create or select a System User with **Admin** role
3. Click **Generate new token** → select your app
4. Grant permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the token and set as `WHATSAPP_ACCESS_TOKEN`

### 4. Configure the Webhook

1. In your Meta app → **WhatsApp** → **Configuration** → **Webhook** → **Edit**
2. Set **Callback URL**:
   ```
   https://api.heidifi.ai/webhook/whatsapp
   ```
3. Set **Verify Token** to the same value as `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (any secret string you choose)
4. Click **Verify and Save**
5. Under **Webhook Fields**, subscribe to **`messages`**

### 5. Create Message Templates

1. In Meta app → **WhatsApp** → **Message Templates** → **Create Template**
2. Category: **Marketing** or **Utility**
3. Add body text with `{{1}}` (guest name) and `{{2}}` (venue name) as variables
4. Submit for approval — typically takes a few minutes to a few hours
5. Once approved, use the template name in the CMS marketing config

---

## Webhook Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/webhook/whatsapp` | Meta verification handshake (one-time on setup) |
| `POST` | `/webhook/whatsapp` | Delivery status updates (sent/delivered/read/failed) |

---

## CMS Configuration

In the CMS, go to any venue's **Access Point** → **Marketing** → **WhatsApp** tab:

- Toggle WhatsApp **enabled**
- Click **Add WhatsApp** to add a message
- Enter the **template name** (must match an approved Meta template exactly)
- Enter the **language code** (e.g. `en_US`, `de_DE`)
- Set **delay** in minutes (0 = send immediately on connect)

---

## Troubleshooting

**Messages not sending:**
- Check server logs for `[WHATSAPP] Skipping:` warnings — they tell you exactly why
- Confirm `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` are set in Coolify
- Confirm the template is approved in Meta and the name matches exactly (case-sensitive)

**Webhook verification failing:**
- Confirm `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in Coolify matches what's entered in Meta webhook config
- Confirm the server is reachable at `https://api.heidifi.ai/webhook/whatsapp`

**Delivery status not updating:**
- Confirm the webhook is subscribed to the `messages` field in Meta
- Check server logs for `[WHATSAPP WEBHOOK]` entries

### Is the webhook actually delivering? (two checks)

Every WhatsApp send sits at `deliveryStatus: 'sent'` until Meta calls us back. If the whole estate is stuck there, work out **which half is broken** before touching anything — the answer changes the fix completely.

**1. Is our endpoint live?** Send a verification request with a deliberately wrong token:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://api.heidifi.ai/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=probe"
```

- **403** — the route is live, reachable, and rejecting bad tokens. Our side is fine; the problem is in the Meta dashboard.
- **404 / timeout** — the route isn't deployed or isn't exposed. Fix the deployment first.

**2. Has the webhook ever fired?** `statusUpdatedAt` is written only by the webhook handler, so its presence is proof of life:

```bash
node -e "
const admin=require('firebase-admin');
admin.initializeApp({credential:admin.credential.cert(require('./service-account.json'))});
admin.firestore().collection('CaptivePortal_Marketing').where('channel','==','whatsapp').get().then(s=>{
  let ran=0; s.forEach(d=>{ if(d.data().statusUpdatedAt) ran++; });
  console.log(\`\${ran} of \${s.size} whatsapp docs have statusUpdatedAt\`); process.exit(0);
});"
```

**0 of N, combined with a 403 from check 1, means Meta was never configured to call us** — the code is working and waiting. Go back to [Meta App Setup step 4](#4-configure-the-webhook): set the callback URL, complete verification with the matching token, and — most commonly missed — **subscribe to the `messages` webhook field**. Status events ride on that subscription; without it Meta accepts the URL and sends nothing.

A useful cross-check: inbound opt-outs (STOP replies) travel through the same webhook. If no `CaptivePortal_Users` doc has ever had `whatsappOptOut: true`, that's the same subscription gap showing up twice, not two separate faults.

*Observed 2026-07-27: 0 of 116 WhatsApp docs had `statusUpdatedAt`, 0 opt-outs recorded, endpoint returning 403 — i.e. the subscription had never been set up.*
