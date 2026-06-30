# Marketing Email Unsubscribe

How HeidiFi gives every marketing email a working, compliant unsubscribe — and the
one environment variable that powers it.

## Why this exists

Marketing email must offer a working unsubscribe (GDPR, CAN‑SPAM, and the Gmail/Yahoo
bulk‑sender rules). We send all marketing through **Brevo's transactional API**
(`POST /v3/smtp/email`), and there is a catch:

- Brevo's built‑in `{{ unsubscribe }}` merge tag works **only for Brevo‑native
  campaigns**. In transactional API sends it throws a *"Template Render Error"*.
- Brevo auto‑adds a `List-Unsubscribe` header, but it points at **Brevo's** handler —
  not branded, and not under our control.

So HeidiFi owns the whole mechanism: the CMS guarantees an unsubscribe link is present
in every marketing body, and this server resolves it, hosts the opt‑out endpoint, and
sends the standards‑compliant headers.

## The environment variable

```bash
# Secret used to HMAC-sign per-recipient unsubscribe links (GET/POST /u/:token).
# Generate any strong random string:  openssl rand -hex 32
UNSUBSCRIBE_SIGNING_SECRET=your_unsubscribe_signing_secret
```

| Variable | Required | Purpose |
|---|---|---|
| `UNSUBSCRIBE_SIGNING_SECRET` | **Yes** (for marketing) | HMAC‑SHA256 key that signs each recipient's unsubscribe token so the public `/u/:token` endpoint can trust it without a session. |
| `SERVER_PUBLIC_URL` | **Yes** | Public base URL of this server; the unsubscribe link is `${SERVER_PUBLIC_URL}/u/<token>`. (Already used for open‑tracking.) |
| `BREVO_API_KEY` | Yes | Reused to blocklist the contact in Brevo on opt‑out. |

**If `UNSUBSCRIBE_SIGNING_SECRET` or `SERVER_PUBLIC_URL` is unset:** `buildUnsubscribeUrl()`
returns an empty string, so `{{unsubscribeUrl}}` resolves to empty (same as any unknown
token) and **no `List-Unsubscribe` header is sent**. Marketing email still goes out, but
without a working unsubscribe link — so **set this in every environment that sends
marketing.** Treat the secret like any other credential; rotating it invalidates all
previously‑issued links (recipients would just get a fresh link in the next email).

## How it works, end to end

```
CMS (authoring)                         captive-server (sending)              Recipient
───────────────                         ────────────────────────              ─────────
1. Every marketing body is              3. dispatchOne() builds a signed       6. Clicks "Unsubscribe"
   guaranteed to contain the               per-recipient URL and puts it          in the email, OR the
   {{unsubscribeUrl}} token               into ctx.unsubscribeUrl:                mail client uses the
   (lib/email-unsubscribe.js                 ${SERVER_PUBLIC_URL}/u/<token>       List-Unsubscribe button.
   auto-injects the footer            4. interpolate() replaces the
   server-side; the editor               {{unsubscribeUrl}} token in the      7. GET /u/:token → confirm
   also warns + offers a                 body with that URL.                     page → POST /u/:token
   one-click "Insert footer").        5. sendEmail() adds RFC 8058 headers:   8. Guest doc updated:
2. Campaign is stored and the             List-Unsubscribe: <url>                 unsubscribed = true
   /internal/campaigns/send              List-Unsubscribe-Post:                   (+ marketingOptIn=false).
   call hands it to this server.            List-Unsubscribe=One-Click         9. Brevo contact blocklisted
                                                                                   (best-effort).
                                       → Every future send re-checks
                                         isOptedIn(), which now excludes
                                         unsubscribed guests. Opt-out is
                                         permanent.
```

### The token

`/u/<token>` where the token is:

```
base64url( JSON({ g: guestId, v?: venueId, c?: campaignId }) ) + "." + base64url( HMAC_SHA256(secret, data) )
```

- Signed and tamper‑proof; verified in constant time.
- Carries **only the guest id** (plus venue/campaign for analytics) — **never the email**,
  so the link leaks nothing. The endpoint resolves the email from Firestore when it needs
  to blocklist the Brevo contact.
- Does **not** expire — people unsubscribe months later.

### The endpoint (`/u`, public, no internal secret)

| Method | Behavior |
|---|---|
| `GET /u/:token` | Verifies the token, renders a branded **confirm page** with a one‑click `POST` form. A GET never changes state, so email link‑prefetchers/scanners cannot unsubscribe a guest by accident. |
| `POST /u/:token` | Verifies the token and records the opt‑out. Also accepts the **RFC 8058 one‑click POST** (`List-Unsubscribe=One-Click`) that Gmail/Apple send with no user interaction — the signed token *is* the authorization. |

Invalid/tampered tokens return `400` with a friendly page.

### What an opt‑out does

On `CaptivePortal_Users/<guestId>`:

```jsonc
{
  "unsubscribed": true,
  "unsubscribedAt": <serverTimestamp>,
  "marketingOptIn": false,
  "marketingConsent": { "given": false }
}
```

`isOptedIn()` (services/campaigns.ts) returns `false` when `unsubscribed === true`, so
`materializeAudience()` excludes the guest from every future broadcast/automation. The
opt‑out is also mirrored to Brevo via `PUT /v3/contacts/{email}` `{ emailBlacklisted: true }`
(best‑effort — Firestore is the source of truth, so a `404`/failure there is non‑fatal).

## Files

| File | Role |
|---|---|
| `server/src/services/unsubscribe.ts` | Sign / verify token, `buildUnsubscribeUrl()`. |
| `server/src/routes/unsubscribe.ts` | Public `GET`/`POST /u/:token`. |
| `server/src/services/brevo.ts` | `List-Unsubscribe` headers on send + `blocklistContact()`. |
| `server/src/services/campaigns.ts` | `ctx.unsubscribeUrl` per recipient; `isOptedIn` excludes `unsubscribed`. |
| `server/src/types/captive.ts` | `unsubscribed` / `unsubscribedAt` on the guest doc. |

The CMS side (which guarantees the `{{unsubscribeUrl}}` token is in every body) lives in
the `cms` repo: `lib/email-unsubscribe.js` plus enforcement in the three marketing‑email
validators. The two halves share the exact same `{{unsubscribeUrl}}` token contract.

## Testing locally

```bash
# 1. Set the secret + public URL
export UNSUBSCRIBE_SIGNING_SECRET=$(openssl rand -hex 32)
export SERVER_PUBLIC_URL=http://localhost:4000

# 2. Send a test broadcast to a seed guest (via the CMS, or /internal/campaigns/send),
#    then inspect the received email's raw source:
#      - a visible "Unsubscribe" link → http://localhost:4000/u/<token>
#      - a "List-Unsubscribe" header with the same URL
#
# 3. Open the link → confirm page → submit. Then check Firestore:
#      CaptivePortal_Users/<guestId>.unsubscribed === true
#
# 4. Re-run the broadcast → that guest is no longer in the audience.
```
