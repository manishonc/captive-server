# Adaptive Campaigns — the engine

The engine runs Adaptive journeys for guests who connect to a venue's Wi-Fi.
Design: `research/heidifi-adaptive-campaign-manager/prd/04-engine-runtime.md`. Build plan:
`~/.claude/plans/in-the-captive-portal-spicy-wombat.md`.

**Test run** (`test`): journeys run for real, but every send ends as a `dry_run` record — nothing is
sent to Brevo or Twilio and no credits are charged. **Live** (`live`, with the pause released): messages
go out through Adaptive's own Brevo and Twilio clients and marketing messages are charged.

> **Don't set an account to `live` before PR E is deployed.** Until then the offer and info-page links
> land on a 404, rating links still show today's 5★-only Google step, and the CMS doesn't forward clicks
> and ratings, so "wait for a click" never wakes.

## How it runs

```
guest logs in ── /create-user or /unifi/authorize ── +1 guarded line ──▶ JourneyEvents + JourneyTasks
                                                                                   │
adaptive-worker (own container) ◀── leases due tasks every 5 s ────────────────────┘
  event_route  → contact + consent (ConsentEvents) → visit (Visits) → journeys start (JourneyInstances)
  node_run     → the interpreter walks steps; a send goes through the 10-rule gate
               → test: JourneySends (dry_run) + a "why" record
               → live: mint links → phase 1 (re-check + claim) → provider → record → charge
  visit_end    → 3 h "visit ended" fallback (A2 review ask)
  signal       → a delivery report, open, click, bounce, STOP / START, unsubscribe, reply, rating
  send_sweep   → a charge that failed after a send the provider accepted, repaired

Twilio status / inbound, Brevo webhook, the /u unsubscribe page ── +1 guarded line each ──▶ event + signal task
the CMS (PR E): POST /internal/adaptive/ingest/click | /ingest/rating ─────────────────────▶ event + signal task
```

- `server.ts` doesn't change. The hook is in `routes/captive.ts` and wrapped in `runAdaptiveHook`,
  so an Adaptive error can never fail or delay a login.
- `/create-user` skips UniFi access points; `/unifi/authorize` hands them over once the controller
  has let the guest online.
- The worker never imports `server.ts`, so the Campaign Manager scheduler and the AP monitor don't
  run twice.

## Sending (live)

- **Exactly once** (`send/dispatch.ts`):
  1. One transaction re-checks the pause, consent, blocks, the weekly limit and a low rating, then
     creates the send record `dispatching`.
  2. One provider request: no automatic retries, 15 s timeout, never scheduled at the provider.
  3. The answer is recorded:
     - `sent` → charged once with `debitOne` (ledger `debit_auto_{sendKey}`);
     - `failed` (4xx; Twilio 21610 also STOP-blocks the number) → not charged;
     - "try later" (429, or the connection failed before the request left) → the record is removed and
       the send retried, at most 3 times, then skipped;
     - `unknown` (timeout / 5xx after sending) → never resent, not charged; a later Brevo "delivered"
       repairs it and charges it.
  - A worker that dies mid-send leaves the record; the retried task finds it and never sends again.
  - A charge that fails after an accepted send is repaired by a `send_sweep` task (charged late, never
    twice).
- **Priced on the text sent:** links are real short links (`${VISITOR_BASE_URL}/s/<code>`, minted only
  once the gate says yes); the SMS gets a STOP line in the guest's language; credits = rate card ×
  segments of that exact text. Adaptive always charges, whatever `ENFORCE_CREDITS` says.
- **Email:** plain-text wording becomes simple HTML (escaped), with the preheader, a localized unsubscribe
  footer + `List-Unsubscribe` headers (marketing), "Powered by HeidiFi" unless the plan hides it, and the
  sendKey in `X-Mailin-custom` so Brevo webhooks find the send. No open pixel.
- **SMS:** the same Twilio sender and status-callback URL as today (the webhook's signature check
  depends on it); statuses are matched by the message SID.
- A channel without credentials is skipped (the ladder moves on) and HeidiFi is alerted.

## Signals coming back

| Source | Adaptive effect |
|---|---|
| Twilio status (`/webhook/twilio/sms-status`) | delivered / failed on the send |
| Twilio inbound STOP / START | SMS blocked on the number for every owner + consent revoked (`revokedVia: channel`); START undoes exactly that (only when the Twilio signature was checked) |
| Twilio inbound plain reply | `repliedAt` on the last live SMS to that number; one "replies aren't read" SMS per 30 days |
| Brevo delivered / opened (not proxy opens) | status, `openedAt`, the guest's open count |
| Brevo hard bounce / invalid | the address's bounce count; 2 (or invalid) → email blocked for everyone |
| Brevo spam / unsubscribed, the `/u` page | email consent revoked for that venue (spam also blocks the address) |
| CMS click (PR E) | the journey's "wait for click", the guest's favourite channel |
| CMS rating (PR E) | ≤ 2★: no more marketing at that venue; ≤ 3★: the owner gets an email (with the private feedback, which is not kept in the log) |

Each hook runs after today's processing and never changes today's reply. Brevo events without an
Adaptive sendKey cost nothing; Twilio statuses are only looked up while an account is not off or sending
is not paused.

## Alerts

Written once to `CaptivePortal_AdaptiveAlerts` (one per venue, reason and day) and emailed:
- to HeidiFi at `AdaptiveConfig/global.alerts.email` (set it by hand until the admin card, PR D) when
  sends are blocked by a setup problem, a daily ceiling is reached, the sign-up breaker trips, or provider
  credentials are refused;
- to the owner (`Users/{tenant}.email`) for a rating of 3★ or less.

**Sign-up breaker:** more than `safety.maxNewContactsPerApPerHour` (60) new guests at one access point in
an hour → the rest of that hour's new guests start no journeys (they are still recorded).

## Switches — `CaptivePortal_AdaptiveConfig/global`

| Field | Default when missing | Meaning |
|---|---|---|
| `launch.default` | `off` | Launch mode for accounts without an override: `off` / `test` / `live` |
| `launch.accounts.<tenantUserId>` | — | Per-account override |
| `killSwitch.sendingPaused` | `true` | Emergency brake: live sends hold (re-checked every 15 min; more than 6 h late → skipped) |
| `safety.maxSendsPerVenuePerDay` | 500 | Circuit breaker per venue |
| `safety.maxSendsPlatformPerDay` | 5000 | Circuit breaker for the platform |
| `safety.staleAfterHours` | 6 | A send more than this late (e.g. the worker was stopped) is skipped |
| `sms.allowedCountries` | CH, LI, DE, AT, FR, IT | SMS countries |

- Launch mode only decides which **new** guests start journeys. A guest keeps the mode they started
  with, so a test-run guest never gets a real message.
- Missing or malformed values read as the safe setting: off and paused.
- A change reaches the worker within about 10 s and the login hook within 60 s (both cache it).
  A guest who connects in that window starts with the mode the worker last read.
- Until the admin card ships (PR D), change these in the Firebase console. Locally, use
  `POST /internal/adaptive/dev/launch`.

## Deploy (captive-server first)

1. **Create the indexes, TTL policies and exemptions.** They're listed in
   `firestore.adaptive.indexes.json`. Create them by hand — never with the Firebase CLI, because the
   project is shared.

   Composite indexes:

   ```bash
   P=<project-id>
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyTasks --query-scope=COLLECTION --field-config=field-path=status,order=ascending --field-config=field-path=dueAt,order=ascending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyTasks --query-scope=COLLECTION --field-config=field-path=status,order=ascending --field-config=field-path=leaseUntil,order=ascending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyInstances --query-scope=COLLECTION --field-config=field-path=contactId,order=ascending --field-config=field-path=status,order=ascending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneySends --query-scope=COLLECTION --field-config=field-path=venueId,order=ascending --field-config=field-path=mode,order=ascending --field-config=field-path=createdAt,order=ascending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneySends --query-scope=COLLECTION --field-config=field-path=mode,order=ascending --field-config=field-path=createdAt,order=ascending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneySends --query-scope=COLLECTION --field-config=field-path=venueId,order=ascending --field-config=field-path=mode,order=ascending --field-config=field-path=purpose,order=ascending --field-config=field-path=createdAt,order=ascending
   ```

   TTL policies:

   ```bash
   for C in CaptivePortal_JourneyTasks CaptivePortal_JourneyEvents CaptivePortal_JourneySends CaptivePortal_JourneyInstances CaptivePortal_Visits CaptivePortal_AdaptiveAlerts signups; do
     gcloud firestore fields ttls update expireAt --collection-group=$C --enable-ttl --project=$P
   done
   ```

   Single-field exemptions: see `fieldOverrides` in the JSON, e.g.
   `gcloud firestore indexes fields update dueAt --collection-group=CaptivePortal_JourneyTasks --disable-indexes --project=$P`.
   Wait until every index shows **Enabled**.

2. **Check** that `GUEST_OTP_PEPPER` is set on the `server` app. The identity key is derived from
   it, and without it the engine stays idle.

3. **Deploy `server`** from the Coolify dashboard. Check:
   - `/health`;
   - one real test login;
   - `GET /internal/adaptive/admin/engine` without the secret returns a JSON 401.

4. **Create the `adaptive-worker` app** (DEPLOY.md, Service 4). Copy the server's env values and deploy.
   `GET /internal/adaptive/admin/engine` (with the secret) should then show:
   - the worker `alive`;
   - `sameVersion: true`;
   - `sameKey: true`;
   - `indexCheck.ok: true`.

   Launch is still `off`. After the first test-run guest connects, `identity.pinnedFingerprint` is
   set and `identity.apiMatchesPinned` is `true`.

5. **Test run for one account:** set `launch.accounts.<your tenant> = "test"`.

### The identity-key guard

Contact ids are hashed with a key derived from `GUEST_OTP_PEPPER`, so both apps must have the same
value, and it must not change. Each connect task carries the API's key fingerprint; the first one that
matches the worker's is pinned in `engine_status.identity.keyFingerprint`.

- **The worker's key differs from the pinned one** (the pepper changed): the worker stays idle
  (`state: idle_identity`, reason in `identityProblem`). Put the old value back. Only after a deliberate
  change, knowing every guest becomes a new contact (consent, visit counts and STOP blocks don't carry
  over), delete `identity` on that doc to pin the new key.
- **The apps disagree before anything is pinned:** connect tasks are held (retried every 10 min) and
  `keyWarning` says so; the worker itself keeps `state: running`. Fix the value on the wrong app and
  redeploy it. If it was the worker, the held connects go through at once. If it was the server, the
  held tasks still carry its old key: they go through within 10 minutes of the next guest connecting
  (that connect pins the key), each refreshing `keyWarning` — it keeps its last message and time.
- **The API disagrees with the pinned key:** the worker still handles its connects (their data is fine)
  and sets `keyWarning`; `sameKey: false` on this status means the `server` app's pepper is wrong now.

### Dead tasks and guest details

Tasks that fail 8 times become `dead` and are kept 30 days for the admin view. A guest's raw contact
details on a connect task are removed as soon as the task is done or dead; a connect task nobody ever
handles expires after 30 days.

## Rollback (fastest first)

1. `killSwitch.sendingPaused = true`. Live sends hold, and no deploy is needed.
2. `launch.default = "off"` (and remove the overrides). No new journeys start.
3. Stop the `adaptive-worker` app in Coolify. Tasks wait in Firestore.
4. Revert the PR. The login hook does nothing while every account is off.

## Local test stack

The `heidifi-local-test` skill starts the worker with `run-service.sh worker` (no port, so no launch
entry). Its `run-service.sh` sets `ADAPTIVE_SANDBOX=1`, which only works when `FIRESTORE_EMULATOR_HOST`
is set. That turns on the fake clock, the dev routes and the **sandbox provider**: live sends go to
`CaptivePortal_AdaptiveSandboxOutbox` instead of Brevo / Twilio (the real providers never run against the
emulator, even with credentials in the environment). Deterministic failures: an email containing
`+reject`, `+timeout`, `+ratelimit` or `+authfail`; a phone ending `0000` (21610), `0001` (unknown),
`0002` (try later) or `0003` (credentials refused).

| Route | What it does |
|---|---|
| `POST /internal/adaptive/dev/clock` `{ "advance": "48h" }` | Moves the fake clock |
| `POST /internal/adaptive/dev/launch` `{ "accounts": { "tenant_demo": "test" } }` | Sets launch modes |
| `GET /internal/adaptive/dev/guest-log?email=…` | Shows events, sends and the "why" sentences |
| `POST /internal/adaptive/dev/provider-event` `{ "sendKey", "event": "delivered\|opened\|click\|rating\|stop\|reply…" }` | Fakes a webhook / CMS signal for one send, through the real hook functions |

Tests:

```bash
npx tsx tests/adaptiveRuntimeCore.test.ts      # pure, no Firestore
npx tsx tests/adaptiveCompose.test.ts          # message composition (pure)
npx tsx tests/adaptiveProviders.test.ts        # Brevo / Twilio clients against a fake HTTP layer
bash tests/emulator/run.sh                     # needs Docker; starts a throwaway emulator on 127.0.0.1:8085
                                               # (project demo-adaptive-test); ADAPTIVE_TEST_EMULATOR=host:port reuses one
```
