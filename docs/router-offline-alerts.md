# Router Offline Alerts — Setup Guide

When a router (access point) stops checking in, HeidiFi automatically emails the tenant with the router name, venue, and troubleshooting steps. A recovery email is sent when the router comes back online.

---

## How It Works

```
AP / monitoring script
  → POST https://api.heidifi.ai/ap-heartbeat   (every 60s)
  → captive-server writes lastSeen to Firestore AP doc

captive-server cron (every 5 min)
  → scan CaptivePortal_AccessPoints
  → lastSeen older than threshold AND status != 'offline'
      → mark offline + send alert email (max 1 per 12 hours)
  → lastSeen within 5 min AND status == 'offline'
      → mark online + send recovery email
```

**Secondary signal (no config needed):** `lastSeen` is also updated on every guest `/create-user` and `/radius/authorize` call — so active venues are covered automatically.

---

## Step 1 — Add Env Vars in Coolify

Open Coolify → **captive-server (api.heidifi.ai)** → **Environment Variables** and add:

| Variable | Value | Notes |
|----------|-------|-------|
| `AP_HEARTBEAT_SECRET` | `<random-string>` | Generate with `openssl rand -hex 32`. Copy it — you'll need it for the heartbeat script. |
| `CMS_DASHBOARD_URL` | `https://portal.heidifi.ai` | Linked in alert emails as the "View Dashboard" button. The CMS is served from `portal.heidifi.ai`; `cms.heidifi.ai` does not resolve to it, so a stale value here ships a dead link to every tenant. |
| `BREVO_API_KEY` | *(already set)* | Shared with marketing emails — no change needed if already set. |
| `BREVO_SENDER_EMAIL` | *(already set)* | Same. |

After saving, **redeploy** the server container so the new vars are picked up.

---

## Step 2 — Set Up the Heartbeat

The heartbeat is a simple HTTP POST that tells the server "this AP is alive." You need something on each property network to call it every ~60 seconds.

### Option A — Script on any always-on device at the property (Recommended)

Any device that stays on (router itself if it supports cron, a Raspberry Pi, NUC, etc.) can run:

```bash
# /usr/local/bin/heidifi-heartbeat.sh
#!/bin/bash
MAC="aa:bb:cc:dd:ee:ff"          # replace with this AP's MAC address (lowercase)
SECRET="your_ap_heartbeat_secret" # same value as AP_HEARTBEAT_SECRET in Coolify

curl -s -X POST https://api.heidifi.ai/ap-heartbeat \
  -H "Content-Type: application/json" \
  -d "{\"mac\":\"$MAC\",\"secret\":\"$SECRET\"}" \
  > /dev/null
```

Add to crontab (`crontab -e`):
```
* * * * * /usr/local/bin/heidifi-heartbeat.sh
```

### Option B — OpenWRT router (if the property router runs OpenWRT)

```
# /etc/cron.d/heidifi-heartbeat
* * * * * root curl -s -X POST https://api.heidifi.ai/ap-heartbeat \
  -H "Content-Type: application/json" \
  -d '{"mac":"aa:bb:cc:dd:ee:ff","secret":"your_ap_heartbeat_secret"}' > /dev/null
```

### Option C — No heartbeat script (guest-activity proxy)

If you can't install a script, skip this step. The server still updates `lastSeen` on every guest Wi-Fi connection. The downside: an empty property (no guests) won't update `lastSeen`, so you may get false offline alerts overnight.

**Workaround:** Set `offlineThresholdMinutes` to `1440` (24 hours) for low-traffic properties via the CMS Access Point edit form.

---

## Step 3 — Verify It's Working

### Test the heartbeat endpoint

```bash
curl -X POST https://api.heidifi.ai/ap-heartbeat \
  -H "Content-Type: application/json" \
  -d '{"mac":"aa:bb:cc:dd:ee:ff","secret":"your_ap_heartbeat_secret"}'

# Expected: {"success":true}
```

**Error responses:**
- `401 Unauthorized` → wrong secret or `AP_HEARTBEAT_SECRET` not set in Coolify
- `404` → MAC address not found in `CaptivePortal_AccessPoints` — check the MAC matches exactly (lowercase, colon-separated)

### Check Firestore

In Firebase Console → Firestore → `CaptivePortal_AccessPoints` → open an AP doc:
- `lastSeen` should be a recent Timestamp
- `status` should be `online` (after first heartbeat) or `unknown` (never received one)

### Trigger a test alert

1. In Firestore, manually set `offlineThresholdMinutes` to `1` on a test AP
2. Stop the heartbeat script (or wait 2 minutes without one)
3. Within 5 minutes the cron will mark it offline and send the alert email
4. Restart the heartbeat script — within 5 minutes a recovery email is sent
5. Reset `offlineThresholdMinutes` back to your preferred value

---

## Alert Behaviour Summary

| Situation | Email sent? |
|-----------|-------------|
| AP offline for longer than `offlineThresholdMinutes` | ✅ Offline alert |
| AP still offline — cron runs again | ❌ No (12-hour cooldown) |
| AP offline → online → offline within 12 hours | ❌ No duplicate (cooldown) |
| AP offline → online → offline after 12 hours | ✅ New alert |
| AP comes back online | ✅ Recovery email |
| `alertsEnabled: false` on AP doc | ❌ Never |

---

## Tenant Controls (CMS)

Tenants can manage alerts per router in the CMS at **Captive Dashboard → Access Points → Edit**:

- **Offline Alerts toggle** — enable/disable alerts for this specific router
- **Alert threshold** — 15 min / 30 min / 1 hour / 6 hours / 24 hours

The `offlineThresholdMinutes` and `alertsEnabled` fields are also directly editable in Firestore if you need to bulk-update.

---

## Firestore Fields Reference

These fields are added to every `CaptivePortal_AccessPoints` document:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `lastSeen` | Timestamp | `null` | Last heartbeat or guest connection |
| `status` | string | `'unknown'` | `'online'` / `'offline'` / `'unknown'` |
| `lastOfflineAt` | Timestamp | `null` | When status last flipped to offline |
| `lastAlertSentAt` | Timestamp | `null` | When the last offline alert email was sent (used for 12h cooldown) |
| `venueName` | string | `''` | Denormalized from venue at AP create time — used in emails |
| `alertsEnabled` | boolean | `true` | Toggle per AP |
| `offlineThresholdMinutes` | number | `60` | Minutes of silence before alerting |

---

## Code Locations

| What | File |
|------|------|
| Heartbeat endpoint | `server/src/routes/captive.ts` → `POST /ap-heartbeat` |
| `lastSeen` update on guest connect | `server/src/routes/captive.ts` → `/create-user` |
| `lastSeen` update on RADIUS auth | `server/src/routes/captive.ts` → `/radius/authorize` |
| Offline detection cron | `server/src/jobs/apMonitor.ts` |
| Email templates | `server/src/services/brevo.ts` → `sendApOfflineAlert`, `sendApRecoveryAlert` |
| CMS AP create (stamps defaults) | `cms/app/api/captive-portal/access-points/route.js` |
| CMS AP update (alert settings) | `cms/app/api/captive-portal/access-points/[id]/route.js` |
| CMS status badge + alert UI | `cms/app/components/captive-tenant/TenantAccessPoints.tsx` |
