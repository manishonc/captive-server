---
name: project-unifi-integration
description: UniFi captive portal integration — architecture, files changed, what's done and what's pending
metadata:
  type: project
---

UniFi support added alongside existing Aruba Instant On. Both vendors now work end-to-end.

**Why:** User has Ubiquiti U6-Pro and wants same captive portal + marketing flow as Aruba.

**Architecture difference:** Aruba uses FreeRADIUS + browser swarm.cgi POST. UniFi uses server-side API call to self-hosted UniFi Network Application controller — no RADIUS needed.

## Files created/changed

**captive-server:**
- `docker-compose.unifi.yml` — self-hosted UniFi Network Application + MongoDB stack
- `unifi/init-mongo.js` — MongoDB user init script (password must match compose env vars)
- `docs/unifi-setup.md` — full architecture doc + setup guide
- `server/src/services/unifi.ts` — UniFi API client (login, session cache, authorize-guest)
- `server/src/types/captive.ts` — added UnifiConfig, UnifiAuthorizeRequestBody types
- `server/src/routes/captive.ts` — added POST /unifi/authorize route

**cms:**
- `types/captive-portal.ts` — added ApVendor, UnifiControllerType, UnifiConfig, vendor+unifiConfig fields to AccessPoint
- `lib/captive-portal-status.js` — serializeAP now strips unifiConfig.password from responses
- `app/api/captive-portal/access-points/route.js` — POST handles vendor + unifiConfig
- `app/api/captive-portal/access-points/[id]/route.js` — PUT merges unifiConfig (keeps existing password if not sent)
- `app/components/captive-tenant/TenantAccessPoints.tsx` — vendor selection (Aruba/UniFi), conditional Step 2 guide, UniFi controller config fields in Step 3 and edit mode, vendor badge in table

## What's pending (Phase 2)

- **Portal changes** (`portal/server.js`): detect UniFi redirect params (`ap`, `id` vs Aruba `apmac`, `mac`), add `/unifi-submit` handler, pass clientMac/apMac/vendor into templates
- **Portal templates**: hidden fields for clientMac, apMac, vendor; conditional form action
- **AP monitoring for UniFi**: poll UniFi controller API instead of heartbeat script (APs don't support custom scripts)

## Key design decisions

- Per-AP unifiConfig stored in Firestore (future: per-venue option)
- Password never returned in API responses (stripped in serializeAP)
- Edit modal: empty password = keep existing
- Session cache in-memory (Map keyed by controllerUrl), 55 min TTL, auto re-login on 401
- rejectUnauthorized: false hardcoded for self-hosted (self-signed cert); improve later with per-AP flag
- controllerType: 'classic' | 'udm' — changes login path and API prefix for Dream Machine

**How to apply:** When user asks about captive portal, UniFi, or AP management, use this context.
