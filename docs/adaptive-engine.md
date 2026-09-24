# Adaptive Campaigns — the engine

The engine runs Adaptive journeys for guests who connect to a venue's Wi-Fi.
Design: `research/heidifi-adaptive-campaign-manager/prd/04-engine-runtime.md`. Build plan:
`~/.claude/plans/in-the-captive-portal-spicy-wombat.md`.

**This release (PR A) runs in test mode only.** Journeys run for real, but every send ends as a
`dry_run` record: nothing is sent to Brevo or Twilio and no credits are charged. There are no provider
adapters in this build, so an account set to `live` is stopped by gate rule 1 ("sending isn't set up").

## How it runs

```
guest logs in ── /create-user or /unifi/authorize ── +1 guarded line ──▶ JourneyEvents + JourneyTasks
                                                                                   │
adaptive-worker (own container) ◀── leases due tasks every 5 s ────────────────────┘
  event_route  → contact + consent (ConsentEvents) → visit (Visits) → journeys start (JourneyInstances)
  node_run     → the interpreter walks steps; a send goes through the 10-rule gate
               → JourneySends (dry_run) + a "why" record; send.skipped / send.deferred events
  visit_end    → 3 h "visit ended" fallback (A2 review ask)
```

- `server.ts` doesn't change. The hook is in `routes/captive.ts` and wrapped in `runAdaptiveHook`,
  so an Adaptive error can never fail or delay a login.
- `/create-user` skips UniFi access points; `/unifi/authorize` hands them over once the controller
  has let the guest online.
- The worker never imports `server.ts`, so the Campaign Manager scheduler and the AP monitor don't
  run twice.

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
   for C in CaptivePortal_JourneyTasks CaptivePortal_JourneyEvents CaptivePortal_JourneySends CaptivePortal_JourneyInstances CaptivePortal_Visits; do
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

   Launch is still `off`.

5. **Test run for one account:** set `launch.accounts.<your tenant> = "test"`.

## Rollback (fastest first)

1. `killSwitch.sendingPaused = true`. Live sends hold, and no deploy is needed.
2. `launch.default = "off"` (and remove the overrides). No new journeys start.
3. Stop the `adaptive-worker` app in Coolify. Tasks wait in Firestore.
4. Revert the PR. The login hook does nothing while every account is off.

## Local test stack

The `heidifi-local-test` skill has launch entries for `adaptive-worker`. Its `run-service.sh` sets
`ADAPTIVE_SANDBOX=1`, which only works when `FIRESTORE_EMULATOR_HOST` is set. That turns on:

| Route | What it does |
|---|---|
| `POST /internal/adaptive/dev/clock` `{ "advance": "48h" }` | Moves the fake clock |
| `POST /internal/adaptive/dev/launch` `{ "accounts": { "tenant_demo": "test" } }` | Sets launch modes |
| `GET /internal/adaptive/dev/guest-log?email=…` | Shows events, sends and the "why" sentences |

Tests:

```bash
npx tsx tests/adaptiveRuntimeCore.test.ts      # pure, no Firestore
bash tests/emulator/run.sh                     # needs the Firestore emulator on 127.0.0.1:8080
```
