# Self-Serve AP Adoption — Setup Codes

**Status:** Accepted · 2026-08-14

How a venue installs a UniFi access point without a HeidiFi admin approving anything, and
what has to be configured for it to work.

---

## The problem it solves

Before this, adding an access point took two people who were never in the same place:

1. Someone on site ran the Adoption Helper, which SSHed into the AP and sent `set-inform`.
2. The device appeared as **pending** on the shared controller and stopped there.
3. A HeidiFi admin (or the tenant, in the CMS) created the AccessPoint document.
4. Only then could the 5-minute cron adopt it — `adoptRegisteredPendingDevices` deliberately
   only ever touches MACs that already have a registered `vendor:'unifi'` document.
5. Someone re-saved the venue's WiFi name so the new AP joined the AP group.

The installer was blocked on an admin, the tenant was blocked on the installer reading a MAC
address off a sticker, and step 5 was silently skipped often enough that "the SSID never
appeared" was a routine support ticket.

Now the tenant gets a **setup code**. The installer types it into the helper, picks the
location and WiFi name, and the server does steps 3 to 5 itself.

---

## The flow

```
Adoption Helper (venue laptop)                    captive-server
──────────────────────────────                    ──────────────
scan LAN (UDP 10001)
  │
  ├─ POST /adoption/session   {code}          →   venues for this tenant (id + name only)
  ├─ POST /adoption/precheck  {code, macs[]}  →   per-MAC: unknown | pending |
  │                                               adopted_unregistered |
  │                                               already_registered_here |
  │                                               registered_elsewhere
  │
  ├─ SSH set-inform ──────────────────────────→   (AP starts informing the controller)
  │
  ├─ POST /adoption/claim  {code, mac,        →   create AccessPoint doc (transactional)
  │                         venueId, ssid}        adopt the pending device
  │                                               ⚠ WiFi NOT applied yet — see below
  │
  └─ POST /adoption/status {code, mac}  ×N    →   waiting_for_device → pending →
                                                  adopting → connected
                                                  ...then applyVenueWifi()
```

Once the device reports `connected`, two things happen together: the venue's WiFi is applied,
and the device is given a **controller-side alias** so it stops showing as its bare model.

Backstop: `reconcilePendingWifi()` runs on the existing 5-minute `apMonitor` cron and finishes
the WiFi step for any self-serve AP that reached `connected` without it — which is what covers
the installer closing their laptop mid-provision.

### Why the WiFi step is deferred

`ensureApGroup` writes `device_macs` with no adoption check. Against a MAC the controller has
not adopted yet, it may store it, **silently drop it**, or reject the call. The silent-drop
case is the dangerous one: a venue's *first* access point would end up in an empty AP group
with a WLAN bound to it — `wifiSsid` set on the venue, an SSID broadcasting nowhere, and
nothing logged anywhere.

So the WiFi is applied only once the device reports `state === 1`. The cron backstop is what
makes that safe rather than merely optimistic.

### Device naming on the controller

Every adopted access point otherwise displays in the controller's Devices list as its model —
a shared site full of rows all reading "U6 Pro", across every tenant, with no way to tell whose
hardware is whose. Tolerable when a human adopted each device and already knew; not once
tenants adopt their own.

So on `connected` the device gets the alias:

```
Cafe Rosa · Main access point (Wy5nKl)
```

`Venue · AP name (venueId prefix)`. The tag is not decoration: venue display names are **not**
unique across tenants — two tenants may both have "The Coffee House" — and it matches the
`venue-<venueId>` AP group, so an admin can get from a device row to the right group and WLAN
without a database lookup. When the label is too long the label is trimmed, never the tag.

Best-effort and never throws: nothing in the product reads this alias, and an adoption must
not fail because a rename did. It is skipped when already correct, so the cron does not rewrite
the same value every five minutes. Renaming an access point in the CMS still does **not** push
to the controller — that remains Firestore-only, as recorded in the multi-tenancy decision.

### Why a leaked code is not enough

`claim` **requires the MAC to be genuinely pending (or already adopted) on our controller**.
An attacker with the code but no physical access has nothing to claim: they would need to be
on the device's LAN with SSH access to make it inform us in the first place.

This is deliberate and load-bearing. It also stops a mistyped or guessed MAC from permanently
squatting someone else's hardware under global MAC uniqueness.

---

## Configuration

### Required — captive-server (Coolify → `server` app)

Both are required. Without them the server logs a warning at boot, `/adoption/health` reports
`{"enabled": false}`, and the CMS shows the tenant "Setup codes aren't switched on yet."
Nothing else changes — the old admin-approval path keeps working.

| Variable | Generate with | What it protects |
|---|---|---|
| `ADOPTION_CODE_PEPPER` | `openssl rand -hex 32` | The code → Firestore document id hash |
| `ADOPTION_CODE_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | The displayable copy on the user document (AES-256-GCM) |

**Neither rotates cleanly once codes exist. Back them up.**

- Changing the **pepper** orphans every existing code: they hash to document ids that no
  longer exist, so every tenant silently stops being able to set up hardware and must be
  re-issued a code.
- Changing the **encryption key** makes existing codes unreadable *for display*. The lookup
  path still works, so installers mid-job are unaffected, but each tenant must rotate before
  they can see theirs again. `ensureAccountCode` fails loudly rather than minting a second
  code, precisely so this does not orphan the live one.

### Optional

| Variable | Default | Notes |
|---|---|---|
| `ADOPTION_SELF_SERVE_ENABLED` | enabled | Set to `false` to kill the feature without a deploy |
| `ADOPTION_DAILY_CLAIM_CAP` | `20` | Per-tenant per-UTC-day claim cap. The durable spend bound on a compromised code |
| `UNIFI_PUBLIC_CONTROLLER_URL` | falls back to `UNIFI_CONTROLLER_URL` | Cosmetic only — the public URL stamped onto new AP documents so the CMS displays something sensible. Nothing dials it |

### Required — the Adoption Helper (`ap-adoption-helper/config.json`)

| Key | Value | Notes |
|---|---|---|
| `apiBaseUrl` | `https://api.heidifi.ai` | **Must be https.** The app refuses to send a setup code over plain HTTP — installers work on café and hotel WiFi. `localhost` is exempt for development |
| `dashboardUrl` | `https://portal.heidifi.ai/captive-venue` | The "Continue on your dashboard" target. The CMS is served from **portal**.heidifi.ai; `cms.heidifi.ai` does not resolve, so a stale value here ships a dead button |

Both are overridable per machine under **Advanced** (`apiBaseUrl` only) and persist to
`settings.json` in the app's user-data folder.

### Nothing is required in the CMS

The CMS proxies to captive-server via the existing `CAPTIVE_SERVER_URL` and
`CAPTIVE_SERVER_INTERNAL_SECRET`. No new variables.

---

## A note on local development

`captive-server` has **no `dotenv` dependency** — it never reads a `.env` file itself.
Environment comes from `docker-compose.server.yml` (which interpolates from the shell or
Coolify) or from the shell directly:

```bash
ADOPTION_CODE_PEPPER=... ADOPTION_CODE_ENCRYPTION_KEY=... npx tsx src/server.ts
```

**Local dev shares production Firestore.** That means the local values must MATCH production,
or `ensureAccountCode` will fail to decrypt a production-stored code and throw. Use the same
values, and keep them somewhere that is not the repository.

> ⚠️ `.env` in this repository is **tracked by git**, and the repository is public. Do not put
> these keys — or any others — in it. See the security note at the end of this document.

---

## Where the tenant sees their code

| Place | Form | Who |
|---|---|---|
| Add Access Point wizard, step 2 | Shown in the clear, with a copy button | Anyone with `accesspoint.create` |
| Integrations | Masked behind a Show toggle, plus **Reset code** | Same; rotation additionally needs ADMIN/owner |

The wizard shows it in the clear on purpose — the person is there to read it off one screen
and type it into another, and masking would be pure friction. Integrations masks it because
that page stays open all day and gets screen-shared.

Rotation marks the old code revoked **24 hours** in the future rather than deleting it, so an
installer part-way through a site visit finishes their job instead of hitting an inscrutable
failure halfway through.

---

## Data model

| Collection | Document id | Contents |
|---|---|---|
| `CaptivePortal_AccountCodes` | `sha256(pepper + ':' + CODE)` | `{ tenantUserId, createdAt, revokedAt, lastUsedAt }` |
| `Users/{tenantUserId}` | — | `captivePortalAccountCode` (AES-256-GCM sealed), `captivePortalAccountCodeAt` |
| `CaptivePortal_AdoptionEvents` | auto | Audit trail: one row per claim |
| `CaptivePortal_AdoptionCounters` | `{tenantUserId}_{YYYY-MM-DD}` | Daily claim cap |

The code is **never** stored in plaintext and is never a document id. A Firestore leak yields
neither usable codes nor a reversible lookup table.

New fields on `CaptivePortal_AccessPoints` (self-serve only): `adoptionState`,
`adoptionSource: 'self_serve'`, `adoptionRequestedAt`, `wifiAppliedAt`, `adoptionLastError`.

One composite index is required — `adoptionSource` + `wifiAppliedAt`, in
`firestore.indexes.json` — for the reconcile sweep.

---

## Abuse controls

**There are no per-IP limits, deliberately.** The helper is a desktop app dialling
captive-server directly, so it sends no `x-portal-secret` and `clientIpOf` falls through to
`req.ip` — which, because `app.set('trust proxy')` is never called, is the Coolify proxy's
address, identical for every installer on earth. A per-IP limiter here would be a *global*
limiter one attacker could saturate to lock out the entire fleet. Revisit only if `trust
proxy` is ever configured correctly.

Limits are keyed on the **hashed** code, and failed resolutions are counted separately from
successful ones. That separation is what stops the limiter being weaponised: codes get shared
in installer group chats, and if a wrong guess and a correct use drew from the same budget,
anyone could disable a tenant's setup by spamming bad codes at it.

| Kind | Max | Window |
|---|---|---|
| `code_fail` (failed resolutions, per submitted code) | 10 | 10 min |
| `unknown_code_global` (failures, fleet-wide) | 60 | 5 min |
| `session` / `precheck` | 30 / 60 | 10 min |
| `status` (per code + MAC) | 120 | 10 min |
| `claim` (per code / per MAC) | 10 / 5 | 60 min |
| `claim_daily` (per tenant, Firestore) | 20 | 24h UTC |

### Pausing the limits

Ten wrong codes in ten minutes blocks further attempts, which is the right default and the
wrong one when you are testing, or on a call talking someone through their first install and
they mistype the code twice.

A **super admin** can pause them from the CMS — the "Code limits" button beside the other
UniFi tools on the Access Points tab. It is a countdown, not a toggle:

- capped at **120 minutes** server-side, whatever duration is requested;
- expires on its own, so there is no "off" state to forget;
- the button turns amber and shows the remaining time while active;
- every bypass is logged (throttled to once a minute) and `GET /adoption/health` reports it,
  so "are the limits on right now" is answerable without database access;
- writes an admin-log entry, which is the only record of who paused them and when.

The **per-tenant daily claim cap is never paused.** That one is the durable bound on what a
compromised code can actually do, and no amount of testing convenience justifies removing it.

For local development there is also `ADOPTION_RATE_LIMIT_DISABLED=true`, which does not expire
and must not be set in production. When it is set the CMS panel says so and refuses to manage
the pause, since the env var overrides it.

State lives on `CaptivePortal_Settings/global.adoptionRateLimitPausedUntil`, cached for 15
seconds so pausing and resuming take effect while the admin is still looking at the screen.
An unreadable settings document fails **closed** — limits stay enforced.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| CMS: "Setup codes aren't switched on yet" | One of the two keys is unset. Check `GET https://api.heidifi.ai/adoption/health` — it reports `enabled` without needing auth |
| Helper: "This app isn't set up safely" | `apiBaseUrl` is not https. The app refuses to send the code in the clear |
| Helper: "We don't recognise that code" | Codes never contain **I, L, O, 0, 1**. A mis-read `O` for `Q` is the usual cause — copy it rather than typing |
| Helper: "This access point hasn't checked in yet" | `set-inform` landed but the device has not informed the controller yet. Normal for 2–10s, budget 45s |
| Helper: "This is taking longer than usual" (3 min) | Not a failure. The AP is registered; a firmware upgrade on first adoption can take 5–15 min. The cron finishes the WiFi step |
| AP adopted but no SSID broadcasting | The deferred WiFi step has not run. Check `wifiAppliedAt` on the AP document; the cron retries every 5 minutes. Look for `[AP RECONCILE]` in the logs |
| "The stored account code could not be read" | `ADOPTION_CODE_ENCRYPTION_KEY` changed. The tenant must rotate |

Useful log prefixes: `[ADOPTION]`, `[ADOPTION CODE]`, `[AP CLAIM]`, `[AP RECONCILE]`,
`[AP ADOPT]`.

---

## Related

- [`unifi-multi-tenancy-decision.md`](./unifi-multi-tenancy-decision.md) — the shared-site
  model, and the 2026-08-14 revision removing SSID uniqueness (which this feature depends on:
  two tenants may now both use "Free WiFi")
- [`unifi-setup.md`](./unifi-setup.md) — controller deployment and the `UNIFI_*` matrix
- [`ap-adoption-helper/README.md`](../ap-adoption-helper/README.md) — the app itself, install
  steps, and the field validation checklist

---

## ⚠️ Security note, unrelated to this feature but blocking safe use of it

At the time of writing, **`.env` is tracked by git in this repository, and the repository is
public.** It contains real values including `FIREBASE_PRIVATE_KEY` (a full service-account key
granting admin access to all Firestore data), `TWILIO_AUTH_TOKEN`, `AP_HEARTBEAT_SECRET` and
`RADIUS_SECRET`.

Do not add the adoption keys — or any other secret — to that file until it is untracked and
gitignored, and the exposed credentials have been rotated. Public-repository secrets are
scraped by automated crawlers within minutes of a push; treat everything in that file as
compromised regardless of observed misuse.
