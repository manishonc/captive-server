# Marketing "Send test" — immediate test sends

Admins can send themselves a single copy of any configured Email / SMS / WhatsApp
marketing message straight from the CMS, to preview how it looks in a real inbox or
phone. The test is delivered **immediately** — it is never scheduled, and it creates
**no analytics doc and no short-link** (so test clicks don't pollute stats).

## How it works

```
CMS marketing UI  ──(Firebase auth)──▶  CMS Next.js route                ──(shared secret)──▶  captive-server
"Send test" button                       /api/captive-portal/marketing/test-send                POST /internal/test-send
                                          (verifies role + venue ownership)                     (sends now via Twilio / Brevo / Meta)
```

- **CMS** authenticates the admin/tenant (Firebase token + role + venue ownership), then
  proxies the request server-to-server. The browser never calls captive-server directly.
- **captive-server** exposes `POST /internal/test-send`, guarded by the `x-internal-secret`
  header (same shared-secret pattern as `/ap-heartbeat`). It sends one message with delay `0`:
  - `sms`   → `scheduleSms(phone, content, 0)` (Twilio sends immediately for delay < 15 min)
  - `email` → `sendEmail(to, subject, body, 0)` (Brevo sends immediately for delay < 1 min)
  - `whatsapp` → resolves `venueName` from `CaptivePortal_EntityMarketing/venue_{venueId}`,
    builds the body (`firstName="Test"`, `venueName`) and a **direct** `{venueId}/rate`
    URL button (no short-link), then `sendWhatsAppTemplate(...)`.

Relevant code:
- captive-server: `server/src/routes/internal.ts`, mounted in `server/src/server.ts` at `/internal`.
- CMS: `app/api/captive-portal/marketing/test-send/route.js`, `lib/captive-portal-api.js`
  (`marketing.testSend`), `app/components/captive-portal/TestSendModal.tsx`, and the
  "Send test" button in `AccessPointMarketingSection.tsx`.

## Required environment variables

The feature needs a **shared secret** on both sides and the captive-server URL on the CMS side.

### captive-server (this repo)

| Variable | Description |
|---|---|
| `INTERNAL_API_SECRET` | Secret that authenticates internal server-to-server calls to `POST /internal/test-send`. Generate with `openssl rand -hex 32`. **Must equal** the CMS's `CAPTIVE_SERVER_INTERNAL_SECRET`. If unset, the endpoint fails closed (401). |

Sending also reuses the **existing** provider credentials already documented in
[`docs/env-vars.md`](./env-vars.md): Twilio (`TWILIO_*`), Brevo (`BREVO_*`), and
WhatsApp (`WHATSAPP_*`). No new provider credentials are needed.

### CMS repo (`cms`)

These go in the **CMS** deployment (Vercel), not in captive-server:

| Variable | Description |
|---|---|
| `CAPTIVE_SERVER_URL` | Public base URL of this captive-server, e.g. `https://api.heidifi.ai` (no trailing slash needed — it's trimmed). Server-only. |
| `CAPTIVE_SERVER_INTERNAL_SECRET` | Must equal captive-server's `INTERNAL_API_SECRET`. Server-only. |

> Generate one secret and set it in both places:
> ```bash
> openssl rand -hex 32
> # → INTERNAL_API_SECRET (captive-server)  AND  CAPTIVE_SERVER_INTERNAL_SECRET (CMS)
> ```

For Coolify, add the captive-server var via:
```bash
coolify app env create gf2b7yzehmsjosbontvc0jl5 --context HeidiFi-Coolify --key INTERNAL_API_SECRET --value <secret>
coolify deploy gf2b7yzehmsjosbontvc0jl5 --context HeidiFi-Coolify
```

## How to test

### From the UI (end-to-end)
1. Set the env vars above on both deployments (and locally if testing locally).
2. In the CMS, open a venue → Marketing → pick a WiFi event tab (e.g. On Connect).
3. On any Email / SMS / WhatsApp message card, click **Send test**.
4. Enter a recipient — an email for email, a phone in full international format
   (e.g. `+41791234567`) for SMS/WhatsApp — and click **Send test now**.
5. Confirm it arrives within a few seconds (not after the configured delay).
6. Confirm **no** `CaptivePortal_Marketing` doc and **no** `CaptivePortal_ShortLinks`
   doc were created for the test. For WhatsApp, the "Rate Us" button should point to
   `https://visit.askheidi.app/{venueId}/rate`.

### Direct endpoint check (curl)
```bash
# SMS
curl -X POST "$CAPTIVE_SERVER_URL/internal/test-send" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_API_SECRET" \
  -d '{"venueId":"<venueId>","channel":"sms","recipient":"+41791234567","message":{"content":"Test from HeidiFi 👋"}}'

# Email
curl -X POST "$CAPTIVE_SERVER_URL/internal/test-send" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_API_SECRET" \
  -d '{"venueId":"<venueId>","channel":"email","recipient":"you@example.com","message":{"subject":"Test","body":"Hello from HeidiFi"}}'

# WhatsApp (must be an approved template)
curl -X POST "$CAPTIVE_SERVER_URL/internal/test-send" \
  -H "Content-Type: application/json" \
  -H "x-internal-secret: $INTERNAL_API_SECRET" \
  -d '{"venueId":"<venueId>","channel":"whatsapp","recipient":"+41791234567","message":{"templateName":"restaurant_feedback_request","languageCode":"en"}}'
```

Expected: `200 { "ok": true, "id": "<provider message id>" }`.

### Auth checks
- A missing or wrong `x-internal-secret` → `401 { "ok": false, "error": "Unauthorized" }`.
- In the CMS, a tenant testing a venue they don't own → `403`.

## Notes & limitations
- A provider that isn't configured returns `503` (e.g. `SMS service is not configured`).
- Phone numbers are normalized to E.164 (digits only, re-prefixed with `+`); numbers with
  fewer than 8 digits are rejected.
- WhatsApp still requires an **approved** Meta template; the test sends the real template
  with `firstName="Test"` and the live venue name.
