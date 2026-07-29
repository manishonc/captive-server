# Meta template: `heidifi_verification_code`

The registered source of truth lives in **WhatsApp Manager**, not in this repo. This file mirrors it
so the registration is reviewable and drift is catchable. **If you edit the template in Meta, update
this file in the same change.**

| Field | Value |
|---|---|
| Name | `heidifi_verification_code` |
| Language | `en` |
| Category | **Authentication** |
| Referenced from | `server/src/services/otpMessages.ts` → `OTP_WHATSAPP_TEMPLATE` |

## The body is not ours to write

Authentication-category templates have a **locked body**. Meta renders exactly:

```
<CODE> is your verification code.
For your security, do not share this code.     ← "Add security recommendation"
This code expires in 10 minutes.               ← footer, "Add expiration time for code"
[ Copy code ]                                  ← OTP button, copy-code type
```

There is **one** variable and it is the code. **The venue name cannot appear in this message** — not
in the body, not in a header, not as a variable. There is no field for it. Guests see the message
coming from the HeidiFi WhatsApp Business display name, not the venue's.

This is why the CMS shows tenants an explicit warning when they enable WhatsApp verification
(`SplashVerificationPanel.tsx`), and why the venue name is carried by the SMS body and the email
instead, where the text is ours (`otpMessages.ts`).

Do not "fix" this by re-registering as a Utility template with custom wording. Meta requires
authentication traffic to use authentication templates; a Utility template carrying an OTP risks
rejection or a later pause, which would break wifi onboarding at every venue using it.

## The 10 minutes is a promise

`code_expiration_minutes` is baked into the footer, so it must equal `OTP_TTL_MS` in
`server/src/services/guestOtp.ts` (600000 ms). If they drift the message lies to the guest.

## Sending

The button is registered as type **OTP**, but Meta converts it to a **URL** button on creation — so
the send-time `sub_type` is `url`, not `copy_code`:

```jsonc
{
  "messaging_product": "whatsapp",
  "to": "+41791234567",
  "type": "template",
  "template": {
    "name": "heidifi_verification_code",
    "language": { "code": "en" },
    "components": [
      { "type": "body",   "parameters": [{ "type": "text", "text": "482913" }] },
      { "type": "button", "sub_type": "url", "index": 0,
        "parameters": [{ "type": "text", "text": "482913" }] }
    ]
  }
}
```

The code appears **twice and must be identical**: the body parameter fills the placeholder, the
button parameter is what "Copy code" puts on the clipboard.

**Omitting the button component is error 132000** (parameter count mismatch) — a silent, total
failure of the channel, the same trap documented for `restaurant_feedback_request`.

## Language is `en`, not `en_US`

Matching `restaurant_feedback_request`. A mismatch is Meta error **132001** ("template does not
exist"), which presents as a total channel outage rather than a configuration error.

Note `server/src/services/campaigns.ts` defaults the *marketing* WhatsApp path to `en_US`, which
disagrees with the registered marketing template. That is a pre-existing inconsistency; the OTP path
hardcodes `en` in `otpMessages.ts` and does not go through it.

## Error codes the sender maps

`server/src/services/otpMessages.ts` classifies Meta failures so `/verify/send` can respond usefully:

| Codes | Treated as | Guest sees |
|---|---|---|
| 131026, 131047, 131051, 131052 | `undeliverable` (422) | "We could not reach you there" + other channels |
| 132000, 132001, 132005, 132007, 132012, 132015, 132016 | `template` (503) | "That method is unavailable right now" |
| anything else | `error` (502) | "We could not send your code" |

After **3 consecutive** template-level failures a process-level breaker disables WhatsApp for 10
minutes, so guests are not queued behind an API call that cannot succeed — the state between
enabling the channel and Meta approving the template.

## Honest limitation

Meta frequently returns **200 + a wamid** and only reports the real failure later via the status
webhook. A guest whose number has no WhatsApp can therefore sit waiting for a message that will
never arrive, with no error to show them. The portal mitigates this by offering the other enabled
channels after ~20 seconds regardless of any provider signal. There is no automatic channel
fallback — it would double the cost and risk double-sending.

## Verifying a change

After any edit in WhatsApp Manager, wait for re-approval, then send one real code and confirm:

- the body reads `<code> is your verification code.`
- the security line and the 10-minute footer are both present
- there is exactly one button, "Copy code", and it copies **the same digits shown in the body**

Editing puts the template back in PENDING; sends continue on the previous version until approved,
and Meta enforces edit limits (roughly 1/24h, 10/30d).
