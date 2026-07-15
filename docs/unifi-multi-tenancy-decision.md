# UniFi Multi-Tenancy: Single Shared Site (Decision Record)

**Status:** Accepted · 2026-07-15
**Decision:** All tenants' access points are adopted into **one controller site (`default`)**. Tenant/venue isolation is implemented one level down, via per-venue AP groups and per-venue WLANs — not via controller sites.

---

## Context

HeidiFi runs a multi-tenant captive-portal SaaS:

1. A tenant registers an account in the CMS.
2. The tenant (or a super admin) registers their access point(s) by MAC address.
3. We adopt the AP into **our** shared UniFi Network Application controller (self-hosted on the Coolify VPS).
4. The captive-server orchestrates the venue's guest WLAN and authorizes guests via the controller API.

UniFi offers two multi-tenancy models: one **site per tenant** (the classic MSP pattern) or **one site with per-venue grouping**. We chose the latter.

## The hierarchy

Sites are a *tenant*-level concept; AP count per venue is handled by AP groups regardless of the site model.

```
Controller  (https://unifi:8443 internally, https://34.116.224.72:8443 publicly)
└── Site "default"                ← shared by ALL tenants
    └── AP group  (one per VENUE) ← holds all of that venue's APs (1..n, wired or meshed)
        └── WLAN  (one per VENUE) ← the venue's SSID; broadcasts ONLY on that AP group
```

- Venue → AP group + WLAN linkage is stored on the venue doc: `unifiApGroupId`, `unifiWlanId`, `wifiSsid` (`CaptivePortal_Venues`).
- Controller credentials are stamped onto each AP doc (`unifiConfig` on `CaptivePortal_AccessPoints`) by the CMS at AP creation, from the CMS deployment's `UNIFI_*` env vars. The stored `unifiConfig.site` field already exists — this is what keeps a future site-per-tenant migration cheap.
- captive-server resolves credentials from the AP's stored config, with `UNIFI_*` env as fallback; env `UNIFI_CONTROLLER_URL` always overrides the stored (public) URL because captive-server must dial the controller's internal Docker address (`server/src/services/unifi.ts` → `effectiveControllerUrl`).

## Why one shared site (and not site-per-tenant)

| Concern | How the shared site handles it |
|---|---|
| Tenant A seeing tenant B's WiFi | Impossible — each SSID broadcasts only on its venue's AP group. |
| Guest data isolation | Enforced in Firestore (`venueId` / `tenantUserId` scoping), not in the controller. Portal identifies the venue by **AP MAC**, never by SSID. |
| Adoption "mix-ups" in a shared pending-device list | All flows are keyed by MAC entered in the CMS; automation can't grab the wrong tenant's AP. The shared pending list is only confusing for a human clicking in the controller UI — which is not our operating model. |
| Mesh per venue | Works automatically: a venue's cabled AP + cable-free APs mesh because they're in the same site. Sites are NOT required for mesh; APs in different sites can never mesh. |
| Ops complexity | One site = one `captive-service` site-admin credential, one adoption flow, no create-site / move-device automation. |

Site-per-tenant was rejected **for now** because it makes every workflow two-hop: create site on registration, adopt into `default`, then move-device to the tenant site; credentials must be controller super-admin instead of one scoped site admin; diagnostics and device status must iterate sites.

## Known limitations of the shared site (accepted trade-offs)

1. **Guest authorization is site-wide.** `authorize-guest` authorizes a client MAC for the whole site. A guest authorized at venue A whose phone auto-joins an identically-named SSID at venue B skips venue B's splash page until the session expires. Acceptable today; becomes a migration trigger if a tenant complains.
2. **Site-wide settings are shared** — wireless meshing on/off, country/regulatory domain, guest-control policy. All tenants get the same values. A tenant in a different regulatory country cannot be served from this site.
3. **SSID names are globally unique across the controller** — enforced in code, not by UniFi: `ensureWlan` rejects any SSID already used by another WLAN (`server/src/services/unifi.ts:371-372`, error: *"The WiFi name … is already in use on this controller."*). Consequence: **two venues currently cannot share the same WiFi name**, even for the same tenant. UniFi itself would allow duplicate names on disjoint AP groups, so if "one brand SSID across all my venues" becomes a requested feature, the decision is to relax this check to *"reject only if the clash is with a different tenant's venue"* — do not remove it entirely (cross-tenant SSID spoofing/confusion). Note the site-wide auth behavior in (1) then applies across those venues.
4. **Blast radius.** One compromised `captive-service` credential or one bad site-level change touches all tenants.

## Rename / lifecycle handling

How each rename or lifecycle event propagates today, and the procedure where propagation is not automatic:

| Event | What happens | Procedure / gap |
|---|---|---|
| **Change venue WiFi name (SSID)** | CMS → `POST /internal/unifi/apply-wifi` → `ensureWlan` PUTs the existing WLAN with the new name. Instant, id-stable (`unifiWlanId` unchanged). | Self-serve in CMS. Fails if the new name clashes with any existing WLAN (see limitation 3). |
| **Rename a venue** | AP group name is derived from `venue_name` at apply time (`applyVenueWifi` → `ensureApGroup` PUTs `name`). It does **not** update on venue rename alone. | Cosmetic only (group name is internal bookkeeping). To sync: re-save the venue's WiFi name in the CMS, which re-runs apply-wifi. Future nicety: have the CMS call apply-wifi after a venue rename. |
| **Rename an AP in the CMS** | CMS-only label in Firestore. The controller's device alias is untouched, and nothing depends on it. | No action needed. |
| **Add an AP to a venue** | AP doc created (credentials stamped from CMS env, ownership inherited from venue), MAC uniqueness enforced globally. Next apply-wifi syncs the AP group's `device_macs`. | Adopt the device (Adoption Helper for wired; controller-adopt for pending mesh units), then set/re-save the WiFi name if the group didn't pick it up. |
| **Remove an AP from a venue** | `detachApFromVenueWifi`: MAC removed from the AP group. If it was the **last** AP: WLAN and AP group are deleted (best-effort) and the venue's `unifiApGroupId` / `unifiWlanId` / `wifiSsid` are cleared. | Automatic. The device itself stays adopted in the site; forget it in the controller if it is leaving the fleet. |
| **Move an AP between venues** | No single operation — it is a detach from venue A + registration under venue B. | Delete the AP in the CMS, re-add under the new venue, re-save both venues' WiFi names. |
| **Tenant offboarding** | Removing all the tenant's APs venue-by-venue tears down their WLANs/groups via the last-AP path above. | Then forget the devices in the controller so the hardware can be reset/re-sold. |
| **Controller credential rotation** | New password on the `captive-service` user must be updated in: CMS deployment env (Vercel), captive-server env (Coolify, if fallback vars are set), and **every AP doc's stored `unifiConfig.password`** (stamped at creation). | Until a rotation script exists, rotate by updating both envs and running a one-off Firestore update over `CaptivePortal_AccessPoints` where `vendor == 'unifi'`. |

## Env / credential matrix

Same variable names, different values per deployment — because of where each app sits relative to the controller:

| Variable | CMS (Vercel) | captive-server (Coolify) |
|---|---|---|
| `UNIFI_CONTROLLER_URL` | `https://34.116.224.72:8443` (public — Vercel reaches it over the internet) | `https://unifi:8443` (internal — same Docker network; a container cannot NAT-hairpin to its host's public IP) |
| `UNIFI_SITE` | `default` | `default` (also the code fallback) |
| `UNIFI_USERNAME` | `captive-service` | `captive-service` (fallback only; per-AP stored config normally wins) |
| `UNIFI_PASSWORD` | required — its absence is the "credentials are not configured on this server" error at AP creation | recommended fallback |

The `captive-service` controller account must be a **local** account (not Ubiquiti SSO/MFA), role Site Administrator on `default`, with "Show pending devices" enabled (needed to adopt mesh units).

## Triggers to revisit → site-per-tenant

Migrate a tenant to their own site when the first of these occurs:

1. A tenant requires controller UI access to their own devices.
2. A tenant needs different site-wide settings (country/regulatory domain, meshing policy, guest control).
3. Cross-venue guest-session bleed (limitation 1) becomes a real complaint.
4. Scale/blast-radius: hundreds of tenants, or a security requirement to scope credentials per tenant.

### Migration sketch (per tenant, no big bang)

The data model already supports hybrid operation — most tenants in `default`, specific tenants in their own site:

1. Create the site via API (`cmd/sitemgr` `add-site`); note its internal short name.
2. Move the tenant's devices to the new site (`move-device`).
3. Update the tenant's AP docs: `unifiConfig.site` = new site name (and site-scoped credentials if used).
4. Re-run apply-wifi per venue to recreate AP group + WLAN in the new site; clear stale `unifiApGroupId`/`unifiWlanId` first.
5. Credentials: either keep one super-admin service account, or one site-admin account per site (preferred for blast radius).

### Engineering rule (in force now)

**Never hardcode the site.** Every new controller call must resolve its config through the AP's stored `unifiConfig` (via `resolveConfig` / `resolveVenueController` in `server/src/services/unifiWlan.ts`). This one discipline is what keeps the migration above a data change instead of a rewrite.
