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
  rollup_venue → the venue's daily numbers (JourneyStats), every 15 min, 2 min behind real time
  apply_config_inflight → an owner's "apply to guests already in these journeys" save
  stay_poll    → an Airbnb calendar feed, every 4 h (or Sync now): Stays kept in step with it
  stay_trigger → a linked guest's stay moment (arrival 17:00, day 2 10:00, …): the stay journey starts

Twilio status / inbound, Brevo webhook, the /u unsubscribe page ── +1 guarded line each ──▶ event + signal task
the CMS (PR E): POST /internal/adaptive/ingest/click | /ingest/rating ─────────────────────▶ event + signal task
```

- `server.ts` doesn't change. The hook is in `routes/captive.ts` and wrapped in `runAdaptiveHook`,
  so an Adaptive error can never fail or delay a login.
- `/create-user` skips UniFi access points; `/unifi/authorize` hands them over once the controller
  has let the guest online.
- The worker never imports `server.ts`, so the Campaign Manager scheduler and the AP monitor don't
  run twice.
- The worker is the only process that reads owners' calendar links (outbound https). The one
  exception planned is PR D's "Check link", which reads the link once in the API process.

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
- Airbnb stays: to HeidiFi when two or more bookings vanish from a calendar at once
  (`stay_feed_suspect`); to the owner once a day while their calendar link has failed for more
  than 24 h (`stay_feed_failing`), and once per pair of overlapping bookings (`stay_overlap`).

**Sign-up breaker:** more than `safety.maxNewContactsPerApPerHour` (60) new guests at one access point in
an hour → the rest of that hour's new guests start no journeys (they are still recorded).

## Daily numbers — `CaptivePortal_JourneyStats`

One doc per venue, journey and day: `{venueId}_{journeyKey}_{yyyymmdd}`, the day being when the event
happened in the venue's time zone. `{venueId}__venue_{yyyymmdd}` (journey key `_venue`) holds the venue's
totals over all journeys, plus its visits. No personal data; kept forever. The results route (PR D)
reads them by id.

| Field | Counts (from `CaptivePortal_JourneyEvents`) |
|---|---|
| `entered`, `converted` | guests who started / reached the goal |
| `ended.{status}`, `exited.{reason}` | how journeys ended (`completed`, `exhausted`, `converted`, `suppressed`, `failed`, and `cancelled` for a stay journey whose booking was cancelled — reason `stay_cancelled`) and why |
| `sends.{channel}.{sent,delivered,opened,clicked,bounced,failed,unknown}` | live messages (a message clicked twice counts once) |
| `bySlot.{slot}` / `byVariant.{variantId}` → `{sent, clicked}` | per time slot and wording |
| `credits.{channel}` | credits charged for marketing messages (equals the ledger) |
| `utility.{sends, providerCostMinor}` | service messages (never charged) and their provider cost |
| `skipped.{reason}` | sends skipped or blocked, by the "why" reason |
| `dryRun.{…}` | everything of test-run guests, same shape — a test run never shows in `sends` or `credits` |
| `visits.{total, first, revisits, captures}` (`_venue` only) | visits, first visits, revisits, Wi-Fi sign-ins |
| `stays.{created, changed, cancelled, linked, overlapFlagged, momentsSkipped}` (`_venue` only) | Airbnb bookings synced, moved, cancelled, linked to a guest, overlapping, and stay moments skipped (too late or switched off) — counted whatever the mode, never under `dryRun` |
| `rollupWatermark`, `updatedAt`, `schemaVersion` | how far the numbers go |

- **How:** after the worker runs a task for a venue, it arms `rollup:{venueId}:{15-min bucket}`, due 2 min
  after the bucket ends. The rollup reads the venue's log in commit order (`recordedAt`, a server
  timestamp) from its watermark (`JourneyStats/{venueId}_rollup`) up to real now − 2 min, one transaction per
  500 events: add the counts, move the watermark. Re-running changes nothing. Each event counts on the
  day it happened (`occurredAt`): a connect handled late still counts on the day of the visit; a webhook
  is dated when it reaches us, so a delivery report Brevo retries for two days counts on the day it arrived.
- `revenueEstimateMinor` is not stored: the results route works it out (converted × the venue's
  average spend), so a changed average needs no recount.
- Locally, `POST /internal/adaptive/dev/rollup` `{ "venueId"? }` rolls up at once (no 2-min lag) and
  returns the docs. Use it there: with the fake clock ahead, the automatic rollup runs as soon as it's
  armed and leaves the last 2 real minutes for the venue's next one.

## Owner edits and switches mid-journey (plan §3.10)

- **Every save is a new config version**; running guests stay on the version they started with.
- **"Apply to guests already in these journeys"** (`applyToInFlight: true` on the save, see
  docs/adaptive-api.md): the save queues `apply_config_inflight`, which marks the install's running
  guests (all its journeys, on the template version the values were written for) with
  `pendingConfigVersion` + `pendingConfigAt`. Each guest moves to the new values at their first step after
  the freeze window of the save (`freezeWindowMinutes`, seeded 60). Within the window nothing changes: a
  send that goes out then — planned before the save, or reached by a delay ending or a click — keeps the
  values it was planned with, and a send planned within the window keeps them even if a pause or a provider
  retry holds it longer. The send record and the "why" record show the version used, and the guest's log
  gets `journey.config_updated`. An offer already issued keeps its label.
- **Pause, a journey switched off, another playbook turned on, Guest info off:** those guests stop at
  their next send (`suppressed`, `switched_off`); a send planned within the freeze window of the switch
  still goes. The switch times are recorded when they happen — `AdaptiveVenues.pausedAt`,
  `AdaptiveVenues.switchedOffAt.{installId}`, `VenuePlaybooks.journeys.{key}.disabledAt` — so a later,
  unrelated save can't re-open the window. A switched-off playbook keeps its settings.

## Airbnb stays (calendar feeds)

Plan §3.3. The owner saves the listing's iCal export link — one feed per venue,
`CaptivePortal_StayFeeds/venue_{venueId}`. The worker reads it every 4 h and keeps one
`CaptivePortal_Stays/st_{hash(feedId:uid)}` per booking. The first guest who connects during a stay is
linked to it, and each switched-on stay journey starts at its moment.

**Reading the link** (`stays/fetch.ts`, `stays/ical.ts`)
- https only (`webcal://` and `http://` are saved as `https://`), port 443, no `user:pass@`, no IP-literal
  host. Every resolved address must be public — private, loopback, link-local, CGNAT, unique-local,
  cloud-metadata, NAT64 and IPv4-mapped ranges are refused — and the socket connects to the address that
  was checked. At most 3 redirects, each checked again; 10 s for the whole chain; 1 MB.
- The link is a secret. It is stored as it is (`url`), only ever shown masked, and never logged; errors
  are codes (`lastError: 'TIMEOUT' | 'LINK_INVALID' | 'HTTP_503' | …`), turned into the owner's words when
  shown.
- **Which events are stays:** Airbnb reservations, and in other feeds (VRBO, PMS) only events whose title
  starts with "Reserved". Booking.com marks bookings and closures alike, so a Booking.com feed — or another
  feed with events but no "Reserved" one that has never given a stay — is **unsupported**:
  `feedWarning: 'unsupported_source'`, no stays, not an error. Stored: UID, dates, status — never the
  calendar's text, names or phone digits. Skipped: cancelled or recurring events, events without a UID,
  stays over 90 nights.
- **Times:** check-in and checkout are the dates at Guest info's check-in/checkout time — the first valid
  `HH:MM` between 06:00 and 22:00, English first, then the other languages alphabetically. Without one,
  scheduling uses 15:00 / 10:00, but the wording never prints that: those messages skip as
  `guest_info_missing`.

**The sync** (`stays/sync.ts`, task `stay_poll`)
- Each feed polls on its own fixed 4 h grid (`stay_poll:{feedId}:{slot}`). A save, Sync now
  (`stay_sync:…`, never re-arms) and the worker's watchdog (at start, then hourly) restart a stopped chain
  on the same slot, so a feed has one chain.
- One poll at a time per feed (a lease on the feed). A fetch or parse error is recorded, never thrown:
  `failing` after 3 in a row, and the owner is emailed once a day after 24 h.
- A new booking → `stay.created`; new dates → `stay.changed` (`datesVersion + 1`); a booking missing →
  a miss. **Two misses at least 30 min apart (engine clock) → cancelled** (`stay.cancelled`). A 304 or the
  same content again still counts (its missing bookings are `lastMissingStayIds`). From checkout day on a
  stay is frozen: never missed, never cancelled.
- **Two or more bookings gone at once** are held for 24 h (`feedWarning: 'mass_missing'`, one HeidiFi
  alert): a wrong link or a cut-off file looks the same. Saving a different link lifts the hold at once. A
  single missing booking always follows the two-miss rule.
- Overlapping bookings (back-to-back is not one) → both `overlap_flagged`, nobody new is linked, the owner
  is emailed. A stay already linked keeps running. A booking missing from the content is on its way out,
  not an overlap (a cancel-and-rebook of the same dates flags nothing); it isn't linked either, and —
  outside the 24 h hold for several bookings gone at once — it doesn't count as upcoming.
- A feed deleted, or saved with another link, while a poll runs: that poll's remaining writes are refused
  (each checks the feed and its lease first) and it ends `superseded`; the save's own sync waits for it
  (put back for 60 s) and then reads the new link.
- Each change is written in one transaction with its event and, for a change or a cancellation, an
  `event_route` task that brings it to the guest's journeys (linked or not — the task reads the Stay fresh).

**Linking a guest** (`stays/link.ts`, in the worker's connect handling)
- Every fresh connect at an Airbnb venue can link, after the usual gates (an install, launch not off, an
  email or phone, the sign-up breaker, not handled late). The window is 12 h before check-in until
  checkout. On a turnover day it opens at the previous stay's checkout, and nobody seen at the venue during
  the previous stay is linked — every stay checking out that day counts (also an `overlap_flagged` one, or
  two of them after a double booking), and the window opens at the latest of their checkouts. A booking
  missing from the calendar's last content (the feed's `lastMissingStayIds`) is never linked — until its
  checkout day, when absence is no longer a signal (D-C31: some feeds drop a stay that day) and it links
  like any confirmed stay. The first guest wins; `linkMode` (test/live) is frozen then.
- A guest already linked to a stay here that isn't over is never linked to another. **Known limit:** a
  guest with two back-to-back bookings is linked only to the first; the second runs without them.
- Then each stay journey's moment is scheduled (`stay_trigger:{stayId}:{journey}:{datesVersion}:{moment}`),
  for every stay journey the venue could run: its installs' (a paused playbook, Guest info switched off)
  at their pinned version, and the catalogue's other stay journeys for its type (a playbook turned on
  later) at the published one. Whether it is switched on is checked when the moment comes. Up to 12 h
  late runs at once; later is skipped (`stay.moment_skipped`) — only for a journey the venue has set up.

**At the moment** (`stays/moments.ts`, task `stay_trigger`) everything is checked again: the stay isn't
cancelled (a linked, overlapping one keeps its moments), it is still this guest's and the same dates
version, it's at most 12 h late, launch isn't off (a guest linked in a test run stays one), and the journey
is switched on (a journey the venue has but that is off or paused → `stay.moment_skipped` /
`switched_off`; one it never set up passes quietly). Then a `stay.moment` event starts the journey. Its time is the later of the moment and the
link, so a guest linked after the venue went live still gets the moment that brought them in.
- **Checkout reminder vs Stay guide:** the Checkout reminder (Guest info) doesn't start when this stay's
  Stay guide covers the guest: 2+ nights, Stay guide on (or switched off within the freeze window before
  the moment), and its instance for this stay active or completed. A late-linked guest, a 1-night stay, or
  a Stay guide paused or switched off earlier gets the reminder.
- A guest linked while the stay playbook is paused, or before it is turned on, gets the moments that come
  once it runs.
- **Known limits:** a moment that comes while the venue is paused starts nothing and is lost (Stay guide's
  welcome passed while paused means no Stay guide for that stay; the Checkout reminder then covers the
  guest); when checkout moves earlier so that Stay guide's "day before checkout, 17:00" has passed, Stay
  guide finishes without checkout instructions and the reminder stays quiet.

**While a stay journey runs** it reads its Stay fresh at every step. `stay.changed` moves a wait anchored
on the stay (a target already past takes `past`; a wait counted from arrival that now ends at or after
checkout — the stay was shortened — is past too; a wait already due whose anchor didn't move just fires);
`stay.cancelled` — or a Stay that is gone — ends the journey as `cancelled` / `stay_cancelled`. A send due
on a Stay that is cancelled but whose event hasn't arrived yet goes to gate rule 1, which skips it
(`send.skipped`, "the booking was cancelled", test runs too) and ends the journey the same way; the live
claim reads the Stay again, so a cancel between the first look and the send is caught there. The checkout message has a second wording without the late-checkout sentence, used when the price is
0 or cleared. The info page link (`{{link.hub}}`) is only sent when Guest info has content, and Local tips
only when there are tips.

**Launch mode off** stops each feed's chain at its next poll — no fetch, no write, no re-arm, so an
account that was never on writes nothing — except a feed with a linked stay that isn't over (checkout + 3
days), which keeps syncing so a running Stay guide still hears about changes. While off nobody new is
linked and no new moment starts.

**The sandbox calendar** (local only; D-C23, instead of the plan's "local calendar file"): a feed link
`sandbox:calendar/<name>` reads `CaptivePortal_AdaptiveSandboxCalendars/<name>` from the emulator, so the
API, a worker in another container and the skill share it. Anywhere else a `sandbox:` link is refused like
any non-https link.

The owner routes (save, check link, sync now, status, delete) come with PR D; PR C has the service they
mount (`service/stays.ts`).

**Open follow-ups** (found in PR C's reviews, disputed there, not fixed yet — decide before live):
1. **A first activation reaches past guests.** A guest linked while only Guest info is on gets the
   catalogue's stay moments scheduled. If the stay playbook is then turned on for the first time, their
   review ask (checkout day 15:00) and book-direct offer (checkout + 3 days) still start — also for a
   guest who checked out before it was turned on, against "past guests aren't messaged". Suggested
   guard in `handleStayTrigger`: a journey the venue didn't have at link time (payload `installId` is
   `''`) starts only if `stay.checkOutAt > install.liveSince`.
2. **A shortened stay with a checkout after 11:00** still sends the mid-stay message (check-in + 2 days,
   11:00) on checkout morning, and then no checkout instructions. Suggested: an arrival-anchored wait
   whose target falls on or after the checkout's local day takes `past`.
3. **A due wait and a plain wake skip the "not after checkout" rule.** The `stay.changed` shortcut that
   fires a due wait, and a timer wake after a shortening, can send the mid-stay message after the new
   checkout. Suggested: apply the same `past` rule there as when a wait is entered.
4. **Checkout day:** a booking that vanished from the calendar the evening before its checkout day can
   still be linked that morning (absence isn't a signal from checkout day on, D-C31). Option: also
   skip a stay with `missingCount > 0`.
5. **A same-link save during a failing poll's fetch** is overwritten by that poll's error write (old
   error count, `failing`, `failingSince`). Suggested: compute the error fields from the feed read in
   `finishFeed`'s transaction.
6. **Tests:** no emulator test covers the link query returning an `overlap_flagged` previous stay; the
   sign-up breaker (PR B) can let one extra new guest through under load (its test flaked once) — a
   separate fix is in progress.

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
   # PR B2: the daily numbers read a venue's log in commit order; "apply to running guests" pages a journey's guests
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyEvents --query-scope=COLLECTION --field-config=field-path=venueId,order=ascending --field-config=field-path=recordedAt,order=ascending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyInstances --query-scope=COLLECTION --field-config=field-path=venueId,order=ascending --field-config=field-path=journeyKey,order=ascending --field-config=field-path=status,order=ascending
   # PR C: the stays a connecting guest could be linked to
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_Stays --query-scope=COLLECTION --field-config=field-path=venueId,order=ascending --field-config=field-path=status,order=ascending --field-config=field-path=checkOutAt,order=ascending
   ```

   The other stay lookups (`Stays` by `feedId`, by `venueId` + `contactId`; `StayFeeds` by `status`;
   `JourneyInstances` by `context.stayId` + `status`) are equality-only and use the automatic single-field
   indexes — don't exempt those fields. The worker probes them all.

   TTL policies:

   ```bash
   for C in CaptivePortal_JourneyTasks CaptivePortal_JourneyEvents CaptivePortal_JourneySends CaptivePortal_JourneyInstances CaptivePortal_Visits CaptivePortal_AdaptiveAlerts signups CaptivePortal_Stays; do
     gcloud firestore fields ttls update expireAt --collection-group=$C --enable-ttl --project=$P
   done
   ```

   Single-field exemptions: see `fieldOverrides` in the JSON, e.g.
   `gcloud firestore indexes fields update dueAt --collection-group=CaptivePortal_JourneyTasks --disable-indexes --project=$P`.
   The JourneyStats count maps (`sends`, `skipped`, `exited`, `ended`, `bySlot`, `byVariant`, `credits`,
   `utility`, `dryRun`, `visits`, `stays`) are only read by doc id, so their indexes can be switched off the same way.
   PR C also exempts `CaptivePortal_StayFeeds` `url` (the calendar link, a secret) and `lastError`, never queried.
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

1. `killSwitch.sendingPaused = true`. Live sends hold, and no deploy is needed. **This is the way to hold
   live stay messages** too.
2. `launch.default = "off"` (and remove the overrides). No new journeys start: no new stay links, no new
   stay moments, and calendar polling stops for feeds with no linked stay that isn't over. **It doesn't
   stop Stay guides that are already running:** they keep their mode and keep sending, and their feeds
   keep syncing so they hear about changes — use step 1 to hold them.
3. Stop the `adaptive-worker` app in Coolify. Tasks wait in Firestore; calendar polling stops.
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
| `POST /internal/adaptive/dev/clock` `{ "advance": "48h" }` or `{ "at": "2026-10-12T13:10:00Z" }` | Moves the fake clock (forward, or to a moment) |
| `POST /internal/adaptive/dev/launch` `{ "accounts": { "tenant_demo": "test" } }` | Sets launch modes |
| `GET /internal/adaptive/dev/guest-log?email=…` | Shows events, sends and the "why" sentences |
| `POST /internal/adaptive/dev/provider-event` `{ "sendKey", "event": "delivered\|opened\|click\|rating\|stop\|reply…" }` | Fakes a webhook / CMS signal for one send, through the real hook functions |
| `POST /internal/adaptive/dev/rollup` `{ "venueId"? }` | Rolls the daily numbers up now (no 2-min lag) and returns the JourneyStats docs |
| `PUT /internal/adaptive/dev/calendar/:name` `{ "venueId"?, "stays": [{ "checkIn": "today", "checkOut": "5n" }] }` or `{ "ics" }` | Writes the sandbox calendar a `sandbox:calendar/<name>` feed reads (Airbnb-shaped; `today`, `+Nd`, `YYYY-MM-DD`; checkout also `Nn` nights) |
| `GET /internal/adaptive/dev/calendar/:name` | That calendar as `text/calendar` |
| `POST /internal/adaptive/dev/stay-feed` `{ "venueId", "url" }` | Saves the venue's calendar link (the service PR D's route will mount) |
| `POST /internal/adaptive/dev/stay-sync` `{ "venueId" }` | Polls the feed now, in the API process under the worker's feed lease; starts its 4 h chain if it isn't running (no `nextPollAt`, or one more than 1 h past); returns what changed and the stays |
| `POST /internal/adaptive/dev/stay-check` `{ "venueId", "url" }` | "Check link": fetch + parse, store nothing → `{ ok, upcoming, nextCheckIn }` or `{ ok: false, errorCode }` |

`GET /dev/guest-log` also lists the guest's stays. Misses count at most every 30 minutes on the fake
clock, so to cancel a booking by hand: remove it, `/dev/stay-sync`, `/dev/clock { "advance": "30m" }`,
`/dev/stay-sync` again (the skill's `set-stay.sh --cancel`). After `advance-time.sh --reset` moves the
clock back, the feed's next poll (its `stay_poll` task and `nextPollAt`) is still at the old, later
engine time: the worker doesn't poll the feed until the engine clock gets there, and `/dev/stay-sync`
polls once per call without restarting the chain (it only restarts one with no `nextPollAt`, or one
more than 1 h past). Reload the data to start over.

Tests:

```bash
npx tsx tests/adaptiveRuntimeCore.test.ts      # pure, no Firestore
npx tsx tests/adaptiveCompose.test.ts          # message composition (pure)
npx tsx tests/adaptiveProviders.test.ts        # Brevo / Twilio clients against a fake HTTP layer
npx tsx tests/adaptiveRollupsEdits.test.ts     # daily-number counting + the mid-journey config swap (pure)
npx tsx tests/adaptiveStaysCore.test.ts        # the iCal reader, the safe fetcher (fake DNS + HTTP), stay times, the sync rules (pure)
npx tsx tests/adaptiveStaysEngine.test.ts      # stays in the interpreter, gate, numbers, wording and link window (pure)
bash tests/emulator/run.sh                     # needs Docker; starts a throwaway emulator on 127.0.0.1:8085
                                               # (project demo-adaptive-test); ADAPTIVE_TEST_EMULATOR=host:port reuses one
```
