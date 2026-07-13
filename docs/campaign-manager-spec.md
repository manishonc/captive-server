# Campaign Manager — Technical Specification

> **Status:** Draft v1 for review
> **Owner:** HeidiFi / Captive Portal
> **Target service:** `captive-server` (Express + TypeScript + Firestore)
> **Audience:** Engineering, product. Written to be implementable by a human or an AI coding agent.

---

## 1. Summary

Today the captive portal sends **event-triggered** messages: when a guest connects to Wi-Fi (`onConnect` / `onReconnect`), the server reads a per-venue marketing config and fires SMS / email / WhatsApp with a delay. That is a *transactional, per-guest, per-venue* engine.

This spec adds a **tenant-level Campaign Manager** — a "Campaign Monitor, simplified" — that lets a tenant:

1. Build an **audience** from the guests captured across their venues (all guests, or a filtered/segmented subset, or hand-picked recipients).
2. **Compose** a campaign for one or more channels (email, SMS, WhatsApp).
3. **Send now** or **schedule** for a future date/time.
4. **Track** delivery, opens, clicks, unsubscribes and conversions — per recipient and in aggregate.
5. Stay **compliant** (consent, unsubscribe, suppression) and **API-first** so the same surface can later back an **MCP server** for AI agents.

It is **broadcast**, not event-triggered. The two systems share infrastructure (providers, short-links, contact data) but are separate features.

### 1.1 In scope (confirmed)

- One-off broadcast campaigns (send now).
- Scheduled campaigns (send at a future time).
- Audiences & segments over captured guests (tenant-wide, per-venue, or explicit recipient lists).
- Engagement tracking: email opens (Brevo webhooks), per-recipient event log, unsubscribe + suppression, campaign-level analytics.
- API-first design + MCP-readiness.

### 1.2 Out of scope (v1)

- Multi-step automation journeys / drip sequences (the existing event engine already covers triggered sends; revisit later).
- Visual drag-and-drop email designer (use stored HTML templates + variables; a designer is a CMS-frontend concern).
- A/B testing, send-time optimization, click-maps (listed in §4 as a future menu).

---

## 2. How this differs from the existing event marketing

| | Existing event marketing | **New Campaign Manager** |
|---|---|---|
| Trigger | Wi-Fi event (`onConnect`/`onReconnect`) | Manual **send now** or **scheduled** |
| Scope | Per **venue** / per **access point** | Per **tenant** (across all their venues) |
| Audience | The single guest who just connected | A **selected set** of contacts (all, segmented, or hand-picked) |
| Config home | `CaptivePortal_EntityMarketing` (`venue_{venueId}`) | New `Campaign_*` collections |
| Volume | 1 message per event | Batch fan-out to thousands |
| Scheduling | Provider delay from event time | Campaign `scheduledAt` + queued fan-out |

The two engines reuse: the provider services (`twilio.ts`, `brevo.ts`, `whatsapp.ts`), the short-link service (`shortlinks.ts`), the guest data in `CaptivePortal_Users`, and the same delivery webhooks.

---

## 3. Reference feature menu — Campaign Monitor & StayFi

You asked for a list of what Campaign Monitor offers so you can choose what we build. Below is the menu, mapped to a recommendation for v1. (Sources at the end of this doc.)

### 3.1 Campaign Monitor — campaign & audience features

| Feature | What it is | v1 recommendation |
|---|---|---|
| Draft → recipients → send | Create campaign, pick recipients, send, then read reports | ✅ Core |
| Lists | Named groups of subscribers | ✅ Core (our "audiences") |
| Segments | Rule-based membership: `RuleGroups` joined by AND, rules inside a group joined by OR | ✅ Core (simplified rule set) |
| Subscribers + custom fields | Contact records with name, email, custom fields, subscribe date | ✅ Core (our unified Contact) |
| Subscriber history | Per-subscriber timeline of every campaign/automation they received and every action (open/click) with date + IP | ✅ Core (per-recipient event log) |
| Automation journeys | Timed multi-email sequences triggered by rules | ⏸ Defer (event engine covers triggered sends) |
| Transactional API | One-off transactional sends | ➖ Already have `/internal/test-send` + event sends |
| Webhooks | Subscribe/unsubscribe/bounce/spam callbacks | ✅ Core (provider webhooks → our events) |

### 3.2 Campaign Monitor — reporting / tracking features (the "Insights" dashboard)

| Metric / feature | Description | v1 recommendation |
|---|---|---|
| Open rate | Unique + total opens (pixel) | ✅ Yes (Brevo open webhook) |
| Click-through rate | Unique + total link clicks | ✅ Yes (already have short-link clicks) |
| Delivery rate | Delivered vs. sent | ✅ Yes (provider delivery webhooks) |
| Bounces | Hard / soft bounces | ✅ Yes (provider webhooks → suppression) |
| Unsubscribes | Opt-outs per campaign | ✅ Yes (unsubscribe link / STOP keyword) |
| Spam complaints | Marked-as-spam count | ✅ Yes (Brevo `spam` event → suppression) |
| Conversions | Downstream action (visit / rating) | ✅ Yes (reuse existing funnel: visit → rating) |
| Per-recipient activity | Who opened/clicked, when, IP | ✅ Yes (per-recipient event log) |
| Bounce list per list | Bounced subscribers grouped by list | ✅ Yes (derive from suppression) |
| Geographic location | Opens/clicks by country | ⏸ Optional (IP geo on click/open) — easy add |
| Device / email client | Opens by device & client | ⏸ Optional (parse user-agent) — easy add |
| Click maps | Visual heat map of link clicks in the email | ⏸ Defer (frontend-heavy) |
| Non-human click filtering | Filter bot/prefetch clicks | ⏸ Defer (nice-to-have; note for accuracy) |
| 30-day comparison | Compare vs. previous period | ⏸ Defer (derive later from stored events) |
| A/B testing | Subject/content variants | ⏸ Defer |

> **Decision needed from you:** the ⏸ rows. Recommended for v1: keep them out except geo + device, which are cheap because we already capture IP + user-agent on clicks. Everything marked ✅ is included in this spec.

### 3.3 StayFi (closest competitor, hospitality-specific) — what they emphasise

- Capture **every guest's** email + phone at Wi-Fi login (not just the booker) → this is our `CaptivePortal_Users`.
- **Unlimited** email sends to the guest list; visual automation + template library.
- **SMS** for welcome, **5-star review screening**, and direct-booking pushes.
- Automated lifecycle: welcome email, SMS rate/review request, stay-anniversary emails.

Implication for us: our differentiator (Google-rating short-link funnel, multi-channel incl. WhatsApp) is already strong; the Campaign Manager closes the "broadcast to my whole guest list" gap StayFi has and we don't.

---

## 4. Architecture overview

```
                       ┌─────────────────────────────────────────────┐
   Tenant dashboard    │                 CMS (Next.js)               │
   (CAPTIVE_PORTAL_    │  Firebase-auth UI. Proxies to captive-server │
    TENANT)            │  with x-internal-secret + x-tenant-id.       │
                       └───────────────┬─────────────────────────────┘
                                       │  REST (API-first)
   AI agent / MCP ──────(API key)──────┤
                                       ▼
                       ┌─────────────────────────────────────────────┐
                       │              captive-server (Express)        │
                       │                                              │
                       │  /campaigns  /audiences  /contacts  ...      │
                       │  Auth: x-internal-secret(+tenant) OR API key │
                       │                                              │
                       │  Campaign service ── enqueues ──► Cloud Tasks│
                       │                                      │       │
                       │  Dispatch worker (/internal/dispatch)◄┘      │
                       │     ├─ twilio.ts     (SMS)                   │
                       │     ├─ brevo.ts      (email)                 │
                       │     ├─ whatsapp.ts   (WhatsApp)              │
                       │     └─ shortlinks.ts (click tracking)        │
                       │                                              │
                       │  Webhooks: /webhook/brevo  /webhook/twilio   │
                       │            /webhook/whatsapp  /u/{token}      │
                       └───────────────┬─────────────────────────────┘
                                       ▼
                                  Firestore
   Campaigns · CampaignRecipients · Audiences · Contacts ·
   Suppression · CampaignEvents (+ existing CaptivePortal_*)
```

### 4.1 Where campaign logic lives

Campaign CRUD, audience resolution, scheduling and dispatch all live in **captive-server** (not the CMS). This is deliberate: it makes the campaign surface a clean REST API that the CMS *and* a future MCP server both consume. The CMS becomes a thin authenticated proxy + UI.

---

## 5. Scheduling & dispatch design (no cron on our server)

**Requirement:** scheduling without running a cron loop on our box, and without losing jobs on restart (the current WhatsApp `setTimeout` is not durable).

**Recommended backbone: Google Cloud Tasks.**

Why it fits:
- Native `scheduleTime` per task → it triggers *us* at the right moment; **no cron process, no `setTimeout`** on our server.
- Built-in retries with backoff + dead-lettering → durable, survives restarts/crashes.
- Each task is just an authenticated HTTP POST back to an internal endpoint we own.
- Per-queue rate caps → built-in throttling to respect provider limits.

> The existing `node-cron` AP-monitor job is unrelated and stays as-is; the Campaign Manager introduces **no new cron**.

### 5.1 Flow

1. **Schedule a campaign** → create one Cloud Task targeting `POST /internal/campaigns/{id}/launch` with `scheduleTime = campaign.scheduledAt` (or "now" for send-now).
2. **Launch (fan-out)** → resolve the audience, write a `CampaignRecipients` row per contact (status `queued`), then enqueue **one dispatch task per recipient** (or per batch of N) on a rate-limited queue. Fan-out itself is paginated/idempotent so a large audience can't time out a single request.
3. **Dispatch** → Cloud Task calls `POST /internal/campaigns/{id}/recipients/{rid}/dispatch`. The worker: checks suppression/consent, renders the message, swaps short-links, calls the channel provider, stores the provider message id, sets recipient status `sent`.
4. **Track** → provider webhooks update recipient status (`delivered`/`opened`/`clicked`/`bounced`/...) and append to `CampaignEvents`; counters roll up to the campaign.

### 5.2 Provider-native scheduling (optimization)

For the **send moment** we can additionally hand the provider its own delay where supported:
- **Twilio** — scheduled messages via Messaging Service (15 min–35 days).
- **Brevo** — `scheduledAt` on the email.
- **WhatsApp (Meta)** — *no* native scheduling → must go through Cloud Tasks (this is exactly the gap that removes the fragile `setTimeout`).

For campaigns, prefer Cloud Tasks for orchestration (uniform across channels, gives us per-recipient state); use provider-native scheduling only if you want to reduce task volume for a single huge timed blast.

### 5.3 Alternative if Cloud Tasks is undesirable

If you'd rather not add GCP Cloud Tasks, the fallback that still avoids cron is a **Firestore-backed job collection drained by an external trigger** (e.g., Cloud Scheduler → HTTP, or Pub/Sub push). The trade-off: you rebuild retries/backoff/rate-limiting yourself. **Recommendation: Cloud Tasks.** (Flagged as an open decision in §15.)

---

## 6. Data models (Firestore)

New collections are prefixed `Campaign_`. All documents carry `tenantUserId` for isolation. Times are Firestore `Timestamp`.

### 6.1 `Campaign_Contacts` — unified contact (the "subscriber")

A tenant-level rollup of guests captured across that tenant's venues. Built/maintained from `CaptivePortal_Users` (dedupe by email and/or phone within a tenant).

```ts
interface CampaignContact {
  id: string;                       // doc id
  tenantUserId: string;             // owner (isolation)
  email?: string;                   // normalized lowercase
  phone?: string;                   // E.164
  firstName?: string;
  lastName?: string;
  venueIds: string[];               // venues where this person was seen
  sourceUserIds: string[];          // CaptivePortal_Users docs merged into this contact
  marketingOptIn: boolean;          // consent to marketing
  consent: {                        // mirror of ConsentRecord captured at portal
    marketing?: ConsentRecord;
    privacyPolicy?: ConsentRecord;
    terms?: ConsentRecord;
  };
  emailStatus: 'subscribed' | 'unsubscribed' | 'bounced' | 'complained';
  smsStatus:   'subscribed' | 'unsubscribed';
  whatsappStatus: 'subscribed' | 'unsubscribed';
  customFields?: Record<string, string | number | boolean>;
  lastSeenAt?: Timestamp;
  firstSeenAt?: Timestamp;
  connectionCount?: number;
  lastRating?: number;              // from funnel, if any
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

> **Build strategy:** start by *projecting* `CaptivePortal_Users` into `Campaign_Contacts` (a backfill + an upsert on each new guest write). Channel status fields are the source of truth for suppression.

### 6.2 `Campaign_Audiences` — saved list / segment

```ts
interface CampaignAudience {
  id: string;
  tenantUserId: string;
  name: string;
  type: 'static' | 'dynamic';
  // static: explicit members
  memberContactIds?: string[];      // for hand-picked lists (small)
  // dynamic: rule-based segment, evaluated at send time
  filter?: AudienceFilter;
  estimatedSize?: number;           // cached, recomputed on edit
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface AudienceFilter {           // RuleGroups AND-ed; rules within a group OR-ed
  match: 'all';                      // groups joined by AND
  groups: Array<{
    match: 'any';                    // rules joined by OR
    rules: AudienceRule[];
  }>;
}

interface AudienceRule {
  field: 'venueId' | 'marketingOptIn' | 'lastSeenAt' | 'lastRating'
       | 'connectionCount' | 'emailStatus' | 'smsStatus' | 'customField';
  op: 'eq' | 'neq' | 'in' | 'gt' | 'lt' | 'gte' | 'lte' | 'before' | 'after' | 'exists';
  value: string | number | boolean | string[];
  customKey?: string;               // when field = 'customField'
}
```

Examples expressible: "all guests of venues A & B who opted in and were seen in the last 90 days and rated ≥ 4."

### 6.3 `Campaign_Campaigns` — the campaign

```ts
interface Campaign {
  id: string;
  tenantUserId: string;
  name: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'paused' | 'cancelled' | 'failed';
  channels: Array<'email' | 'sms' | 'whatsapp'>;  // one campaign may span channels

  // Audience selection (one of)
  audienceId?: string;              // saved audience
  inlineFilter?: AudienceFilter;    // ad-hoc segment
  explicitContactIds?: string[];    // hand-picked "select specific users"
  venueIds?: string[];              // convenience: "all guests of these venues"

  // Per-channel content
  content: {
    email?: { subject: string; html: string; fromName?: string; preheader?: string };
    sms?:   { body: string };
    whatsapp?: { templateName: string; languageCode: string; variables?: VariableMap };
  };

  // Scheduling
  scheduleType: 'now' | 'scheduled';
  scheduledAt?: Timestamp;
  timezone?: string;                // for display + quiet-hours

  // Lifecycle
  launchedAt?: Timestamp;
  completedAt?: Timestamp;
  cloudTaskName?: string;           // the scheduling task (for cancel)

  // Rollup counters (denormalized from CampaignRecipients/CampaignEvents)
  stats: CampaignStats;

  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface CampaignStats {
  audienceSize: number;
  queued: number; sent: number; delivered: number; failed: number;
  opened: number; clicked: number;
  bounced: number; unsubscribed: number; complained: number;
  // conversions (reuse existing funnel)
  visited: number; rated: number;
  // unique vs total
  uniqueOpens: number; uniqueClicks: number;
  updatedAt: Timestamp;
}
```

### 6.4 `Campaign_Recipients` — per-recipient send record

Stored as a subcollection: `Campaign_Campaigns/{campaignId}/recipients/{recipientId}`. One row per contact per channel.

```ts
interface CampaignRecipient {
  id: string;
  campaignId: string;
  tenantUserId: string;
  contactId: string;
  channel: 'email' | 'sms' | 'whatsapp';
  to: string;                       // resolved email/phone at send time
  status: 'queued' | 'skipped' | 'sent' | 'delivered'
        | 'opened' | 'clicked' | 'bounced' | 'failed' | 'unsubscribed';
  skipReason?: 'suppressed' | 'no_consent' | 'no_address' | 'invalid';
  providerMessageId?: string;       // Twilio sid / Brevo messageId / WhatsApp wamid
  shortCodes?: string[];            // for click attribution
  // engagement timestamps (latest)
  sentAt?: Timestamp; deliveredAt?: Timestamp;
  firstOpenedAt?: Timestamp; lastOpenedAt?: Timestamp; openCount?: number;
  firstClickedAt?: Timestamp; lastClickedAt?: Timestamp; clickCount?: number;
  bouncedAt?: Timestamp; failedAt?: Timestamp; error?: string;
  // conversion (reuse funnel)
  visitedAt?: Timestamp; ratedAt?: Timestamp; rating?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 6.5 `Campaign_Events` — immutable per-recipient event log

Append-only timeline (Campaign Monitor "subscriber history"). One doc per event; powers per-contact and per-campaign reporting.

```ts
interface CampaignEvent {
  id: string;
  tenantUserId: string;
  campaignId: string;
  recipientId: string;
  contactId: string;
  channel: 'email' | 'sms' | 'whatsapp';
  type: 'queued' | 'sent' | 'delivered' | 'open' | 'click'
      | 'bounce' | 'spam' | 'unsubscribe' | 'failed' | 'visit' | 'rating';
  at: Timestamp;
  meta?: {
    url?: string;                   // for click
    ipHash?: string;                // hashed IP (privacy)
    userAgent?: string;             // for device/client (optional geo/device parsing)
    country?: string;               // optional geo
    device?: string;                // optional parsed
    bounceType?: 'hard' | 'soft';
    providerEvent?: string;         // raw provider event name
  };
}
```

### 6.6 `Campaign_Suppression` — global opt-out / do-not-contact

Checked **before every send**. Per tenant.

```ts
interface SuppressionEntry {
  id: string;                       // hash(tenantUserId + channel + address)
  tenantUserId: string;
  channel: 'email' | 'sms' | 'whatsapp' | 'all';
  address: string;                  // email or E.164
  reason: 'unsubscribe' | 'bounce' | 'complaint' | 'manual' | 'invalid';
  campaignId?: string;              // where it originated
  createdAt: Timestamp;
}
```

### 6.7 `Campaign_ApiKeys` — tenant API keys (for direct API / MCP)

```ts
interface CampaignApiKey {
  id: string;                       // public key id (prefix)
  tenantUserId: string;
  name: string;
  hashedSecret: string;             // store hash only
  scopes: string[];                 // e.g. ['campaigns:read','campaigns:send','contacts:read']
  lastUsedAt?: Timestamp;
  revoked: boolean;
  createdAt: Timestamp;
}
```

### 6.8 Reuse of existing collections

- `CaptivePortal_Users` → source for `Campaign_Contacts`.
- `CaptivePortal_ShortLinks` / `swapVenueRatingUrl` / `swapTrackedLinks` → click tracking (extend with `campaignId` + `recipientId` in short-link docs).
- `CaptivePortal_Marketing` (funnel: visit/rating) → conversion attribution; we can write campaign conversions either here or directly onto `Campaign_Recipients`.

---

## 7. API design (API-first)

Base path: `/api/v1` on captive-server. All responses follow the existing `{ ok: boolean, ... }` convention.

### 7.1 Authentication & multi-tenancy

Two accepted auth modes, both resolving to a **tenant context**:

1. **CMS proxy** — headers `x-internal-secret: <INTERNAL_API_SECRET>` **and** `x-tenant-id: <tenantUserId>`. The CMS has already done Firebase auth + role/venue checks; captive-server trusts the secret and scopes to the tenant id.
2. **API key** (for direct API / MCP / agents) — header `Authorization: Bearer <campaign_api_key>`. Resolved via `Campaign_ApiKeys` (hash compare), yields `tenantUserId` + scopes.

Every handler **must** scope all queries by the resolved `tenantUserId`. No cross-tenant reads/writes. `SUPER_ADMIN` may pass an explicit `x-tenant-id` to act on any tenant (admin tooling).

Standard error shape: `{ ok: false, error: string, code?: string }`. Validation 400, auth 401, forbidden 403, not found 404, rate limit 429, provider/server 5xx.

### 7.2 Contacts

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/contacts` | List/search contacts (filters: `venueId`, `optIn`, `q`, `status`, pagination `cursor`/`limit`) |
| GET | `/api/v1/contacts/{id}` | Get a contact + channel statuses |
| GET | `/api/v1/contacts/{id}/history` | Per-contact event timeline (from `Campaign_Events`) |
| POST | `/api/v1/contacts` | Create/import a contact (manual add) |
| PATCH | `/api/v1/contacts/{id}` | Update fields / custom fields |
| POST | `/api/v1/contacts/import` | Bulk import (CSV/JSON array) — dedupe by email/phone |
| POST | `/api/v1/contacts/sync` | Trigger re-projection from `CaptivePortal_Users` |

### 7.3 Audiences / segments

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/audiences` | List saved audiences |
| POST | `/api/v1/audiences` | Create static list or dynamic segment |
| GET | `/api/v1/audiences/{id}` | Get audience definition |
| PATCH | `/api/v1/audiences/{id}` | Update |
| DELETE | `/api/v1/audiences/{id}` | Delete |
| POST | `/api/v1/audiences/preview` | Evaluate a filter and return **count + sample** (no save) |
| GET | `/api/v1/audiences/{id}/members` | Paginated resolved members |

### 7.4 Campaigns

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/campaigns` | List campaigns (filter by `status`) |
| POST | `/api/v1/campaigns` | Create draft |
| GET | `/api/v1/campaigns/{id}` | Get campaign + stats |
| PATCH | `/api/v1/campaigns/{id}` | Edit draft (content, audience, schedule) |
| DELETE | `/api/v1/campaigns/{id}` | Delete draft |
| POST | `/api/v1/campaigns/{id}/test` | Send a test to given recipient(s) (reuses `/internal/test-send` logic) |
| POST | `/api/v1/campaigns/{id}/estimate` | Resolve audience size + per-channel reach (after suppression) |
| POST | `/api/v1/campaigns/{id}/schedule` | Set `scheduledAt`, create Cloud Task, status → `scheduled` |
| POST | `/api/v1/campaigns/{id}/send` | Send now (launch immediately) |
| POST | `/api/v1/campaigns/{id}/cancel` | Cancel scheduled/sending (deletes pending tasks) |
| POST | `/api/v1/campaigns/{id}/pause` | Pause an in-flight send |
| POST | `/api/v1/campaigns/{id}/resume` | Resume |
| GET | `/api/v1/campaigns/{id}/recipients` | Paginated per-recipient status |
| GET | `/api/v1/campaigns/{id}/report` | Aggregate report (stats + rates + breakdowns) |
| GET | `/api/v1/campaigns/{id}/events` | Raw events (filter by `type`) |

### 7.5 Suppression / unsubscribe

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/suppression` | List suppression entries (filter by channel) |
| POST | `/api/v1/suppression` | Manually suppress an address |
| DELETE | `/api/v1/suppression/{id}` | Remove (re-subscribe) — audit logged |
| GET | `/u/{token}` | **Public** unsubscribe landing (no auth) — one-click + preference page |
| POST | `/u/{token}` | **Public** apply unsubscribe choice |

### 7.6 Internal (Cloud Tasks callbacks — `x-internal-secret` only)

| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/campaigns/{id}/launch` | Fan-out: resolve audience, write recipients, enqueue dispatch tasks |
| POST | `/internal/campaigns/{id}/recipients/{rid}/dispatch` | Send one recipient's message |

### 7.7 Webhooks (provider callbacks — provider-specific auth)

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhook/brevo` | Brevo events: `delivered`, `opened`, `click`, `hard_bounce`, `soft_bounce`, `spam`, `unsubscribed` |
| POST | `/webhook/twilio/sms-status` | *(exists)* extend to update `Campaign_Recipients` when `campaignId` present |
| POST | `/webhook/whatsapp` | *(exists)* extend for campaign recipients (`sent`/`delivered`/`read`/`failed`) |

### 7.8 API keys (tenant self-service / super-admin)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/api-keys` | List keys (no secrets) |
| POST | `/api/v1/api-keys` | Create key (returns secret **once**) |
| DELETE | `/api/v1/api-keys/{id}` | Revoke |

### 7.9 Example payloads

**Create + send-now campaign**
```http
POST /api/v1/campaigns
{
  "name": "June Google-review push",
  "channels": ["email", "sms"],
  "venueIds": ["venueA", "venueB"],
  "inlineFilter": {
    "match": "all",
    "groups": [
      { "match": "any", "rules": [
        { "field": "marketingOptIn", "op": "eq", "value": true } ] },
      { "match": "any", "rules": [
        { "field": "lastSeenAt", "op": "after", "value": "2026-03-01" } ] }
    ]
  },
  "content": {
    "email": { "subject": "How was your stay?", "html": "<h1>...</h1> {VISITOR_BASE_URL}/{venueId}/rate" },
    "sms":   { "body": "Thanks for staying! Rate us: {VISITOR_BASE_URL}/{venueId}/rate" }
  },
  "scheduleType": "now"
}
→ 200 { "ok": true, "campaign": { "id": "cmp_123", "status": "sending", "stats": { "audienceSize": 842, ... } } }
```

**Audience preview**
```http
POST /api/v1/audiences/preview
{ "filter": { ... } }
→ 200 { "ok": true, "count": 842, "sample": [ { "id":"c1","email":"...","venueIds":[...] }, ... ] }
```

---

## 8. Sending pipeline (detail)

1. **Launch** (`/internal/campaigns/{id}/launch`)
   - Idempotent: guarded by `status` transition `scheduled|draft → sending` in a transaction.
   - Resolve audience → contact ids (paginate; for huge audiences process in pages and re-enqueue a continuation task).
   - For each contact × each channel: create a `Campaign_Recipients` row (`queued`), then enqueue a dispatch task. Skip immediately (status `skipped`, reason) if suppressed / no consent / no address.
2. **Dispatch** (`/internal/campaigns/{id}/recipients/{rid}/dispatch`)
   - Re-check suppression (state may have changed).
   - Render content: variable interpolation (`{firstName}`, `{venueName}`, etc.).
   - Inject tracking: append/encode an **unsubscribe link** (email + SMS), swap rating + tracked links via `shortlinks.ts` (stamp `campaignId`+`recipientId` onto the short-link doc), and (email) ensure Brevo open-tracking + a `X-Campaign-Id`/tag for webhook correlation.
   - Call provider (`brevo.ts` / `twilio.ts` / `whatsapp.ts`), store `providerMessageId`, set `sent`.
   - Append `sent` event; bump campaign `stats.sent`.
   - On provider error: status `failed`, store error, append `failed` event. (Cloud Tasks retries transient failures with backoff; mark permanent failures non-retryable.)
3. **Track** via webhooks (§9). Each webhook locates the recipient by `providerMessageId` (or campaign tag), updates status + timestamps, appends an event, increments rollups.

### 8.1 Idempotency

- Dispatch keyed by `recipientId`; a retried task must not double-send. Use a `dispatchedAt`/`providerMessageId` guard: if already set, no-op and return 200.
- Webhooks are idempotent on `(recipientId, eventType, providerEventId)`.

### 8.2 Throttling

- Cloud Tasks queue `maxDispatchesPerSecond` tuned per provider (e.g., Twilio MPS, Brevo rate). One queue per channel keeps limits independent.

---

## 9. Tracking & analytics

| Signal | Source | Storage |
|---|---|---|
| Sent | dispatch result | recipient `sent`, event `sent` |
| Delivered | Twilio status / Brevo `delivered` / WhatsApp `delivered` | recipient `delivered`, event |
| **Open (email)** | **Brevo `opened` webhook** (pixel) | recipient open ts + count, event `open` |
| Click | existing short-link click (extend to stamp campaign/recipient) | recipient click ts + count, event `click` |
| Bounce | Brevo `hard_bounce`/`soft_bounce`, Twilio failure | recipient `bounced` + **add to suppression** (hard), event `bounce` |
| Spam complaint | Brevo `spam` | suppression + event `spam` |
| Unsubscribe | `/u/{token}` (email/SMS) + WhatsApp/SMS STOP keyword | contact channel status `unsubscribed` + suppression, event `unsubscribe` |
| Conversion (visit/rating) | existing funnel via short-link → visit → rating | recipient `visitedAt`/`ratedAt`, events `visit`/`rating` |
| Geo / device *(optional)* | IP hash + user-agent on click/open | event `meta.country` / `meta.device` |

**Campaign report** (`GET /campaigns/{id}/report`) computes from `stats` + events: delivery rate, unique/total open rate, CTR, bounce rate, unsubscribe rate, complaint rate, conversion rate, and per-venue / per-channel breakdowns.

**Per-contact history** (`GET /contacts/{id}/history`) lists every campaign received and every action — the Campaign Monitor "subscriber history" equivalent.

### 9.1 Brevo webhook (new)

Configure a Brevo "transactional/marketing webhook" → `POST /webhook/brevo`. Verify via a shared secret in the URL or signature header. Map Brevo events to our event types; correlate to the recipient using a campaign tag / custom header set at send time, falling back to `messageId`.

---

## 10. Compliance (GDPR / Swiss FADP)

Non-negotiable because contacts are EU/Swiss guests:

- **Consent gate:** only contacts with `marketingOptIn = true` (and the relevant channel `subscribed`) are sendable. Consent provenance lives in `consent.*` (`ConsentRecord` captured at the portal).
- **Unsubscribe everywhere:** every marketing email and SMS includes a working unsubscribe (`/u/{token}`); WhatsApp/SMS honour STOP keywords. Unsubscribe is one-click and immediate.
- **Suppression enforced pre-send** at both launch and dispatch.
- **Right to erasure:** deleting a contact removes campaign PII; suppression keeps a hash to honour prior opt-outs without retaining the raw record (document the trade-off).
- **Auditability:** opt-outs/re-subscribes and manual suppression writes are logged with actor + timestamp.
- **Quiet hours (optional):** allow a per-tenant send-window so SMS doesn't arrive at 3am; enforce by shifting `scheduleTime`.
- **No raw IP storage:** store `ipHash` only (matches existing short-link behaviour).

---

## 11. MCP-readiness

Because every capability is a clean REST endpoint scoped by an API key, an MCP server is a thin wrapper. Suggested tool mapping for a future `heidifi-campaigns` MCP:

| MCP tool | Backing endpoint |
|---|---|
| `list_contacts` / `get_contact` | `GET /contacts`, `GET /contacts/{id}` |
| `preview_audience` | `POST /audiences/preview` |
| `create_audience` | `POST /audiences` |
| `create_campaign` | `POST /campaigns` |
| `estimate_campaign` | `POST /campaigns/{id}/estimate` |
| `send_test` | `POST /campaigns/{id}/test` |
| `schedule_campaign` | `POST /campaigns/{id}/schedule` |
| `send_campaign` | `POST /campaigns/{id}/send` |
| `get_campaign_report` | `GET /campaigns/{id}/report` |
| `list_campaigns` | `GET /campaigns` |

Design rules that keep it MCP-friendly: stable JSON schemas, human-readable ids, idempotent writes, every mutating action returns the resulting object, and a **dry-run/estimate** before any send so an agent (and a human) can confirm reach before committing. Sensitive actions (`send_campaign`) should require an explicit scope on the API key.

---

## 12. Multi-tenancy & authorization rules

- All `Campaign_*` docs carry `tenantUserId`; every query filters on it.
- A tenant only ever sees/operates on their own contacts (guests of their venues), audiences, campaigns, suppression and keys.
- Audience venue filters are validated: a tenant may only target `venueIds` they own.
- `SUPER_ADMIN` may impersonate a tenant via `x-tenant-id`.
- API keys are tenant-scoped and scope-limited; revoke = immediate.

---

## 13. Compatibility with existing event marketing

- No changes required to `CaptivePortal_EntityMarketing` or the `onConnect`/`onReconnect` path.
- Shared services (`twilio.ts`, `brevo.ts`, `whatsapp.ts`, `shortlinks.ts`) get small extensions (campaign tagging on short-links; campaign correlation on webhooks) — additive, not breaking.
- `CaptivePortal_Marketing` (funnel) remains for event sends; campaign conversions can be mirrored there or kept on `Campaign_Recipients` (decide in §15).

---

## 14. Phased delivery plan

1. **Phase 0 — Foundations.** `Campaign_Contacts` projection + backfill from `CaptivePortal_Users`; API-key auth + tenant context middleware; `/api/v1` skeleton.
2. **Phase 1 — Audiences.** Filter model + `preview`/`members`; saved audiences.
3. **Phase 2 — Broadcast send-now (email first).** Campaign CRUD, suppression, dispatch via Cloud Tasks, unsubscribe link, Brevo webhook (delivered/open/click/bounce/unsub), per-recipient log + report.
4. **Phase 3 — SMS + WhatsApp.** Extend dispatch + existing webhooks; STOP handling.
5. **Phase 4 — Scheduling.** `scheduledAt` + Cloud Task scheduleTime; cancel/pause/resume; quiet hours.
6. **Phase 5 — Analytics polish + optional geo/device; MCP server.**

---

## 15. Open decisions (need your call)

1. **Scheduler:** Cloud Tasks (recommended) vs. Firestore-job + external trigger. (§5)
2. **Optional tracking:** include geo + device in v1? (cheap) Click-maps / non-human filtering / A-B / 30-day compare → defer? (§3.2)
3. **Conversion storage:** mirror campaign conversions into existing `CaptivePortal_Marketing`, or keep solely on `Campaign_Recipients`? (§13)
4. **Contact dedupe key:** email-only, phone-only, or email+phone within a tenant? Affects merge logic. (§6.1)
5. **Who manages API keys:** tenants self-serve, or super-admin only, in v1? (§7.8)
6. **WhatsApp marketing templates:** confirm Meta-approved template names/locales available for broadcast (marketing-category templates have stricter approval + opt-in rules).

---

## Sources

- StayFi — product, email, SMS, guest marketing: https://stayfi.com/ , https://stayfi.com/email-marketing/ , https://stayfi.com/text-marketing/ , https://stayfi.com/guest-marketing/
- Campaign Monitor API (campaigns, subscribers, segments, journeys, webhooks): https://www.campaignmonitor.com/api/v3-3/campaigns/ , https://www.campaignmonitor.com/api/v3-3/subscribers/ , https://www.campaignmonitor.com/api/v3-3/segments/ , https://www.campaignmonitor.com/api/v3-3/journeys/
- Campaign Monitor analytics / reporting (opens, clicks, bounces, geo, device, click maps, non-human filtering): https://www.campaignmonitor.com/features/email-analytics/ , https://www.campaignmonitor.com/resources/guides/reporting/
- Existing captive-server code: `server/src/routes/internal.ts`, `services/{twilio,brevo,whatsapp,shortlinks}.ts`, `routes/{captive,sms,email,twilioWebhook,whatsappWebhook}.ts`, `jobs/apMonitor.ts`, `types/captive.ts`.
