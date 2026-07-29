# Guest contact verification (OTP)

Withholds internet access until the guest confirms a code sent to the email address or phone number
they typed. Tenant-configurable per venue, off by default.

Before this, guest contact details were never checked — `loginPage.fields.phone` shipped as
`{ enabled: true, required: false }` with the comment *"phone is always shown, never validated"*, so
the marketing audience was full of unverifiable contacts.

## Guest flow

```
login form → consent → VERIFY → authorize onto the network
```

Verification sits **after** consent so a code is never sent to someone who then declines. A guest who
declines *marketing* still verifies — this is about the contact being real, not about permission to
market to them.

## Configuration

Stored on `CaptivePortal_SplashScreenConfig/venue_{venueId}.verificationPage`, edited in the CMS under
**Splash screen → Verification**.

| Key | Meaning |
|---|---|
| `enabled` | Master switch. **Defaults false** — every venue predating this key must keep working. |
| `channels.{email,sms,whatsapp}.enabled` | Which methods the tenant switched on. |
| `defaultChannel` | Pre-selected method; always one of the enabled set after validation. |
| `allowGuestChoice` | Whether the guest picks the method. |
| `requirement` | `any` (one contact point) or `all` (every enabled target). |
| `heading` … `resendLabel` | Tenant-editable copy. |
| `rememberDays` | Skip re-verification on the same device for N days. 0 = every visit. Max 90. |

Deliberately **not** configurable: code length, TTL, attempt cap, and resend cooldown. Those are
abuse controls on an endpoint any passer-by can reach, they must be enforced server-side regardless,
and a tenant knob would read as configurable while being unenforceable. Error copy is also fixed —
it is state-revealing, and a tenant should not be able to write misleading text on a security control.

## Resolution: what actually applies

`services/verificationConfig.ts` → `resolveVerification()` is the single authority. Both
`GET /splash-config` (what the portal renders) and the grant gate call it, so they cannot disagree.
It subtracts:

- channels whose **provider env is unset** (Brevo / Twilio / Meta)
- channels whose **login field is hidden** — you cannot send a code to a box the guest never saw
- **everything**, if the signing secret or pepper is missing

### Fail-open, and why

| When | What happens |
|---|---|
| Config-time — no usable channel, secret unset | Verification switches **off**. Guest gets wifi **unverified**. Loud log. |
| Request-time — provider throws or returns null, Firestore write fails, token invalid | 4xx/5xx, no token, **access refused**. |

A misconfigured provider must never become a wifi outage for a whole venue; that is a support
emergency, and the strict alternative buys little. The safety property preserved throughout: nothing
is ever *labelled* verified. `emailVerified` / `phoneVerified` stay false, so no downstream consumer
can mistake a degraded guest for a checked one.

If you want a venue to fail closed instead, that is a per-venue `failClosed` flag — not a default.

## How a guest cannot skip it

`/verify/check` mints an HMAC token; every path that grants access refuses without it.

```
hv1.<base64url(payload)>.<base64url(hmac)>
payload: { c: channel, d: destination, s: scopeKey, m: mac, iat, exp: iat+900, n: nonce, b?: 1 }
```

Validated in order: version prefix → HMAC (timing-safe) → expiry → **venue scope** → channel still
enabled → **destination equals the one in THIS request body** → MAC. The destination check is the
point of the whole mechanism: verify `attacker@x.com`, submit `victim@y.com`, refused.

**All three grant paths are gated**, because `/create-user` only writes Firestore:

| Path | Vendor | Gate location |
|---|---|---|
| `POST /create-user` | both | `routes/captive.ts`, before any write |
| `POST /unifi/authorize` | UniFi | `routes/captive.ts`, **before** `unifiAuthorizeGuest` — after it the device is already online |
| `POST /submit` → swarm.cgi | Aruba | `portal/server.js`, validated locally with pure crypto (no round trip on the critical path) |

The token is deliberately **not single-use**: one guest flow presents it to `/create-user` and then
to `/unifi/authorize`. Single-use would break UniFi outright. It is bounded by the 15-minute expiry
and by binding to scope, channel, destination and device.

`b: 1` marks a **waiver** — the server decided verification could not happen (daily budget spent). It
authorizes the connect but writes no verified flags.

## Abuse limits

| Limit | Value | Where |
|---|---|---|
| Resend cooldown | 60 s | Firestore, transactional |
| Sends per live code | 3 | Firestore |
| Attempts per code | 5 | Firestore |
| Per destination, send | 5 / 30 min | in-memory |
| Per destination, check | 20 / 10 min | in-memory |
| Per AP, send | 60 / 10 min | in-memory |
| Per IP | 15 / 10 min send, 60 / 10 min check | in-memory, **needs `PORTAL_SHARED_SECRET`** |
| Per venue, per day | 500 (`GUEST_OTP_DAILY_CAP_PER_VENUE`) | Firestore |

The in-memory tier is correct while captive-server runs as one container (docker-compose declares no
replicas), matching the existing `connectedFormRateLimited` precedent. **If this is ever scaled
horizontally, `dest_send` must move to Firestore.** The daily cap already lives there.

Without `PORTAL_SHARED_SECRET` the per-IP limits are **skipped**, not applied to a constant — see
`services/clientIp.ts`.

## Codes at rest

`CaptivePortal_GuestVerifications`, doc id `sha256(channel:destination:scopeKey)`. Codes are stored as
`sha256(code:channel:destination:scopeKey:GUEST_OTP_PEPPER)` — never in plaintext.

Two consequences worth knowing:

- **A resend mints a new code**, because re-sending the old digits is impossible from a hash. The
  previous hash stays valid until the doc expires, so a guest who types the code from the first
  message after tapping resend still succeeds.
- **A successful check marks `consumed` with a 120 s grace** instead of deleting. Captive-portal
  mini-browsers drop responses constantly; a hard delete turns one dropped response into a dead end.

Set a Firestore **TTL policy on `ttlAt`** (console or `gcloud firestore fields ttls update`) — this is
not expressible in `firestore.indexes.json`. Without it, spent code docs simply accumulate; nothing
breaks.

**No composite index is needed.** The remembered-device lookup filters
`phoneE164 == …` + `captivePortalAccessPointId == …` with no `orderBy` or range, and Firestore serves
equality-only queries by merging the single-field indexes it maintains automatically. The same shape
already runs in production for reconnect detection (`email` + `captivePortalAccessPointId`) with no
composite index deployed.

## The preview never sends

1. `form-logic.js` short-circuits on `PREVIEW_MODE` — no network call at all, a hard-coded fake
   masked destination, and a "Preview only — no code is sent" note. **This is the real protection.**
2. `/verify/send` and `/verify/check` refuse any request carrying a `preview` flag.

Be clear-eyed about layer 2: the flag is client-asserted, and the portal never sets it (the POST
carries no query string). It catches an explicit preview request and documents intent, but it does
**not** stop someone who edits layer 1 out in devtools — they would strip the flag too. What actually
bounds that case is the per-destination, per-AP and per-venue-daily rate limiting, which applies to
every caller.

Sending a `preview` flag is not a bypass: it produces a 400, not a grant.

## The 33 templates were not touched

`renderVerifyStep()` in `portal/public/js/config.js` builds `#stepVerify` from the class vocabulary
every template shares — the same approach `renderConnectedView` already uses, whose comment records
that cloning `#step1` proved fragile. Zero template edits.

## Testing

```bash
cd server && npx tsx tests/verification.test.ts     # 28 assertions, no credentials needed
```

Live checks against a running server (needs a real registered AP MAC):

```bash
curl -s localhost:4000/verify/send -H 'content-type: application/json' \
  -d '{"channel":"email","apmac":"<ap-mac>","email":"you@example.com"}'
```

Then confirm the taxonomy: wrong code → 400 + `attemptsLeft`; six wrong codes → 429; past the TTL →
410; immediate resend → 429 + `Retry-After`; unregistered apmac → 403.

**The security check that matters:** verify `a@x.com`, then POST `/create-user` with that token and
`email: b@y.com`. Must be 403. Replay the same token against a different venue's apmac — also 403.

## Related

- `docs/whatsapp-templates/heidifi_verification_code.md` — the Meta template, and why the venue name
  cannot appear in a WhatsApp code
- `docs/env-vars.md` → Guest verification (OTP)
