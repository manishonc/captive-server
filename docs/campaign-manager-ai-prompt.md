# AI Implementation Prompt — Campaign Manager

> Paste this into an AI coding agent (Claude Code / similar) working inside the `captive-server` repo. It is grounded in the real codebase. Pair it with `docs/campaign-manager-spec.md`, which is the source of truth — this prompt tells the agent *how to work*; the spec tells it *what to build*.

---

## ROLE

You are a senior backend engineer implementing a **tenant-level Campaign Manager** in the existing `captive-server` service. Read `docs/campaign-manager-spec.md` in full before writing any code. It defines the data models, endpoints, scheduling design, tracking, compliance and phasing. Follow it exactly; if you must deviate, stop and explain why.

## THE PRODUCT (one paragraph)

A "Campaign Monitor, simplified" for the captive-portal. A tenant selects an audience from the Wi-Fi guests captured across their venues (all guests, a rule-based segment, or hand-picked recipients), composes an email / SMS / WhatsApp message, and sends it now or schedules it. The system fans out durably, tracks delivery/opens/clicks/bounces/unsubscribes per recipient and in aggregate, enforces consent + suppression, and exposes everything as a clean REST API so it can later back an MCP server for AI agents. This is **broadcast**, separate from the existing Wi-Fi-event-triggered messaging (`onConnect`/`onReconnect`) — do not modify that path's behaviour.

## EXISTING STACK — WORK WITH IT, DON'T REINVENT

- **Express + TypeScript**, entry `server/src/server.ts`, routers under `server/src/routes/`, services under `server/src/services/`, types in `server/src/types/captive.ts`. Build: `npm run build` (tsc → `dist/`), run on port 4000.
- **Firestore** via `firebase-admin` (`server/src/firebase.ts`). No ORM; use the Admin SDK directly. New collections are prefixed `Campaign_`.
- **Providers already implemented — reuse, do not replace:**
  - Email → `services/brevo.ts` `sendEmail(to, subject, body, delayMinutes)` (Brevo, supports `scheduledAt`).
  - SMS → `services/twilio.ts` `scheduleSms(to, content, delayMinutes)` + `toE164(...)` (Twilio; native scheduling 15min–35d).
  - WhatsApp → `services/whatsapp.ts` `sendWhatsAppTemplate(to, template)` (Meta Cloud API; **no native scheduling**).
  - Short-links/clicks → `services/shortlinks.ts` `swapVenueRatingUrl(...)`, `swapTrackedLinks(...)`, `createShortLink(...)`.
- **Internal auth pattern to mirror:** `routes/internal.ts` `requireInternalSecret(req,res)` checks `x-internal-secret` against `INTERNAL_API_SECRET`. Response convention is `{ ok: boolean, ... }` / `{ ok:false, error }`. Match this everywhere.
- **Existing webhooks to extend (don't rewrite):** `routes/twilioWebhook.ts`, `routes/whatsappWebhook.ts` already correlate by provider message id — extend them to also update `Campaign_Recipients` when a `campaignId` is present.
- **Guest data source:** `CaptivePortal_Users` (fields incl. `email`, `phone`, `phoneCountryCode`, `marketingOptIn`, consent records, `captivePortalAccessPointId`, `connectionCount`). Project these into `Campaign_Contacts`.

## HARD REQUIREMENTS

1. **API-first.** All campaign logic lives in captive-server as REST under `/api/v1` (per spec §7), consumed by both the CMS and a future MCP server. Stable JSON schemas, human-readable ids, every mutating call returns the resulting object.
2. **Two auth modes** (spec §7.1): (a) CMS proxy `x-internal-secret` + `x-tenant-id`; (b) tenant `Authorization: Bearer <api key>` resolved from `Campaign_ApiKeys` (store hashed secret only). Both resolve a `tenantUserId`. **Every query is scoped by `tenantUserId`** — no cross-tenant access. Add middleware that produces `req.tenantContext`.
3. **Scheduling = Google Cloud Tasks. NO cron, NO `setTimeout`.** (spec §5.) A scheduled campaign creates one Cloud Task with `scheduleTime` → `POST /internal/campaigns/{id}/launch`. Launch fans out and enqueues per-recipient dispatch tasks → `POST /internal/campaigns/{id}/recipients/{rid}/dispatch`. These internal endpoints use the `x-internal-secret` guard. Make a thin `services/cloudTasks.ts` wrapper; keep the queue name/region configurable via env. If Cloud Tasks credentials are absent in dev, provide a clearly-labelled local fallback that still avoids cron (e.g., immediate inline dispatch for `send-now`) — but production path is Cloud Tasks.
4. **Idempotency.** Launch guarded by a transactional `status` transition; dispatch is a no-op if `providerMessageId`/`dispatchedAt` already set; webhooks idempotent on `(recipientId, type, providerEventId)`.
5. **Consent + suppression enforced before every send**, at both launch and dispatch (spec §10). Only `marketingOptIn` contacts with the channel `subscribed` are sendable. Every email/SMS carries a working unsubscribe (`/u/{token}`); honour SMS/WhatsApp STOP.
6. **Tracking** per spec §9: add `POST /webhook/brevo` for delivered/open/click/bounce/spam/unsubscribe; extend short-links to stamp `campaignId`+`recipientId`; write append-only `Campaign_Events`; maintain denormalized `Campaign_Campaigns.stats` and per-recipient timestamps.
7. **Don't break existing behaviour.** Event-triggered marketing, AP monitor cron, UniFi internal routes, and current webhooks must keep working. Additive changes only.

## DELIVERABLES

- New routers: `routes/campaigns.ts`, `routes/audiences.ts`, `routes/contacts.ts`, `routes/suppression.ts`, `routes/apiKeys.ts`, `routes/unsubscribe.ts` (public `/u/{token}`), `routes/brevoWebhook.ts`; new internal handlers in `routes/internal.ts` (`launch`, `dispatch`).
- New services: `services/cloudTasks.ts`, `services/campaigns.ts` (orchestration), `services/audiences.ts` (filter evaluation), `services/contacts.ts` (projection/dedupe), `services/suppression.ts`, `services/apiKeys.ts`.
- Types in `types/campaign.ts` matching spec §6 exactly.
- Wire new routers in `server.ts`.
- A backfill script `scripts/backfill-contacts.ts` projecting `CaptivePortal_Users` → `Campaign_Contacts`.
- Update `.env.example` + `docs/env-vars.md` with new vars (Cloud Tasks queue/region/service-account, `BREVO_WEBHOOK_SECRET`, unsubscribe signing secret, etc.).
- A short `docs/campaign-manager-implementation.md` describing what was built, env setup, and how to test each phase.

## BUILD ORDER (follow the spec's phasing — ship vertically, test each phase)

1. **Phase 0:** types, tenant-context middleware (both auth modes), `/api/v1` skeleton, `Campaign_Contacts` projection + backfill script.
2. **Phase 1:** audiences — filter model, `POST /audiences/preview` (count + sample), saved audiences, `members`.
3. **Phase 2:** email broadcast send-now — campaign CRUD, suppression checks, dispatch via Cloud Tasks, unsubscribe link + `/u/{token}`, `POST /webhook/brevo`, per-recipient log + `GET /campaigns/{id}/report`.
4. **Phase 3:** SMS + WhatsApp dispatch; extend Twilio/WhatsApp webhooks; STOP handling.
5. **Phase 4:** scheduling (`scheduledAt` → Cloud Task scheduleTime), cancel/pause/resume, optional quiet hours.
6. **Phase 5:** analytics polish; optional geo/device from existing ipHash+user-agent; (later) MCP server wrapper.

## CODING STANDARDS

- TypeScript strict; mirror the style of existing routes/services. Keep handlers thin; put logic in services.
- Validate inputs explicitly (the repo has no validation lib — match its manual-validation style, or introduce `zod` only if you also note it in the implementation doc).
- Firestore writes: use transactions/batched writes for state transitions and counter rollups; never trust client-supplied `tenantUserId`.
- Log errors with a tagged prefix like the existing `[INTERNAL ...]` convention. Never log raw PII or secrets.
- Store only `ipHash` (reuse existing hashing), never raw IPs.

## DEFINITION OF DONE (per phase)

- Endpoints return the documented shapes; tenant isolation verified (a tenant cannot read/act on another tenant's data).
- Send-now and scheduled flows produce correct `Campaign_Recipients` + `Campaign_Events` and accurate `stats` rollups.
- Suppression + unsubscribe demonstrably block sends.
- Idempotency proven (replaying a dispatch/webhook task does not double-count or double-send).
- No regression in event-triggered marketing or existing webhooks.
- `npm run build` passes; the implementation doc explains how to test the phase end-to-end (incl. how to simulate provider webhooks).

## BEFORE YOU START — CONFIRM THESE (from spec §15)

Ask the maintainer (or assume the spec's recommendation and note it) for: scheduler choice (Cloud Tasks assumed), whether geo/device tracking is in v1, conversion storage location, contact dedupe key (email+phone within tenant assumed), API-key ownership, and the list of Meta-approved WhatsApp marketing templates. Do not block Phase 0–2 on these except the dedupe key (needed for contacts) and Cloud Tasks (needed for dispatch).
