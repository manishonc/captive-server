# Meta template: `restaurant_feedback_request`

The registered source of truth lives in **WhatsApp Manager**, not in this repo. This file mirrors it
so the registration is reviewable and drift is catchable. **If you edit the template in Meta, update
this file in the same change.**

| Field | Value |
|---|---|
| Name | `restaurant_feedback_request` |
| Language | `en` |
| Category | Marketing |
| Referenced from | `cms/lib/marketing-builtin-templates.ts` → `WHATSAPP_FEEDBACK_TEMPLATE` |

## Body

Two variables, positional, supplied by the sender in this order:

| Placeholder | Value | Source |
|---|---|---|
| `{{1}}` | guest first name | `firstName \|\| 'Guest'` |
| `{{2}}` | venue name | `getVenueName(venueId) \|\| 'our venue'` |

## Buttons

One **dynamic URL** button ("Rate Us"), button index `0`.

```
URL field in WhatsApp Manager:  https://visit.askheidi.app/{{1}}
Example / sample value:         https://visit.askheidi.app/s/gkgq7j5z
Parameter the sender supplies:  s/<code>
Rendered:                       https://visit.askheidi.app/s/<code>
```

Type the `{{1}}` yourself — confirmed against this account's editor, which does **not** append it for
you. Omitting it greys out "Send for review": a Dynamic URL button with no variable fails validation.
The example/sample field is also required; leaving it empty greys out the button too.

The trailing `{{1}}` is **the button's own variable**, not the body's. Button variables are numbered
per-button and always start at `{{1}}`, however many variables the body uses. Meta requires it to be
the **last** thing in the URL, and for our short links there must be nothing between the host and it.

### Everything before `{{1}}` must stay bare — this is the whole point of this file

Meta **appends** the parameter where `{{1}}` sits; it does not substitute anywhere else in the
string. So there must be nothing between the host and `{{1}}` — no path segment, no second `{{n}}`.

This was wrong in production and broke every WhatsApp rate link ever sent. The URL field had been set
to `https://visit.askheidi.app/{{3}}/rate`, which rendered as:

```
URL field    https://visit.askheidi.app/{{3}}/rate
our parameter                                     s/gkgq7j5z
result       https://visit.askheidi.app/%7B%7B3%7D%7D/rates/gkgq7j5z   → 404
```

Two traps:

1. **`{{3}}` never fills.** A URL button's only variable is `{{1}}`, and it must be last. A `{{n}}`
   anywhere else is ordinary text and gets percent-encoded into the path — hence the `%7B%7B3%7D%7D`.
   Whoever entered it expected `{{3}}` to continue the *body's* `{{1}}`/`{{2}}` numbering and receive
   the venueId. Button variables are numbered independently, always starting at `{{1}}`.
2. **The trailing `/rate` collided with our parameter.** `/rate` + `s/<code>` splices into
   `/rates/<code>`, a path that does not exist.

Meta numbers button variables **per-button**, unlike Twilio's Content API which numbers them globally
across a message — that mismatch is the likeliest way this gets reintroduced.

The venueId does not belong in this URL at all. It lives on the `CaptivePortal_ShortLinks` doc and is
recovered by the resolver — which is exactly what makes per-send click attribution work.

### Senders that must agree with this registration

All of these pass the `s/<code>` suffix. If the base URL changes, every one of them breaks:

- `server/src/routes/captive.ts` — WiFi event automation
- `server/src/services/campaigns.ts` — Campaign Manager broadcast
- `server/src/routes/socialWifiWebhook.ts` — Social-WiFi webhook
- `server/src/routes/internal.ts` — CMS "Send test" (mints an `isTest` short link so the test
  renders the same URL a live send does)

Omitting the button component entirely makes Meta reject the send with **error 132000** (parameter
count mismatch), which is a silent, total failure of the channel.

## Compatibility shim

Messages already delivered with the malformed URL are permanent, so the CMS permanently serves
`/:anything/rates/:code` (`cms/app/captive-public/[venueId]/rates/[code]/route.js`) to rescue them.
See `cms/docs/short-links-and-funnel-tracking.md` → "Legacy URL shim". Do not delete it just because
the template is now correct.

## Verifying a change

After any edit to this template in WhatsApp Manager, wait for re-approval, then send one message and
confirm the button URL is `https://visit.askheidi.app/s/<code>` with no `%7B`, no `/rates/`, and no
venueId segment. Editing puts the template back in PENDING; sends continue on the previous version
until approved, and Meta enforces edit limits (roughly 1/24h, 10/30d).
