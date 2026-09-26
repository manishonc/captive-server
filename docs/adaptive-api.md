# Adaptive Campaigns — playbooks API (`/internal/adaptive`)

The one API for Adaptive Campaigns playbooks. All rules and all Firestore writes
live behind it (`server/src/adaptive/`), so the CMS screens, the CMS AI and the
MCP tools share one set of checks instead of each keeping a copy.

- **Auth:** `x-internal-secret: $INTERNAL_API_SECRET`, like every `/internal` route.
  Callers authenticate the user themselves first (the CMS checks the Firebase token
  and the `adaptive.*` permission; the MCP resolves the tenant from the OAuth token).
- **Writes** carry `actor: { uid, kind: 'super_admin' | 'tenant_user' | 'mcp' | 'seed', role? }`
  in the JSON body. It is recorded on the documents (`createdBy`, `lastEditedBy`, …).
- **Responses:** `{ ok: true, … }` or `{ ok: false, error, code, issues? }`.

| `code` | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 | Body or params not in the expected shape (`issues` lists the fields) |
| `unauthorized` | 401 | Missing or wrong `x-internal-secret` |
| `forbidden` | 403 | A venue that doesn't belong to the tenant |
| `not_found` | 404 | Playbook, version, journey or setup doesn't exist |
| `conflict` | 409 | Someone else changed it meanwhile (reload), or the action doesn't fit the current state |
| `no_changes` | 409 | Nothing to publish |
| `validation_failed` | 422 | The checks found errors; `issues` has them (codes below) |

`issues` are `{ code, severity: 'error' | 'warning' | 'info', message, path? }`.
Errors block the action; warnings and info never do.

Nothing here sends a message. There is no engine yet, and
`CaptivePortal_AdaptiveConfig/global.killSwitch.sendingPaused` is seeded `true`.

> **Since PR A–D** the engine exists and sends (docs/adaptive-engine.md): the playbook routes
> above still send nothing themselves; the owner, public and admin routes of PR D are listed in
> "PR D routes" below.

## Admin (platform) — `/internal/adaptive/admin`

| Method & path | Body | Returns |
|---|---|---|
| `GET /playbooks` | — | `{ playbooks: PlaybookSummary[] }` |
| `POST /playbooks` | `{ mode: 'blank' \| 'copy', name, kind?, venueTypes?, copyFrom?, actor }` | playbook detail (new draft v1; key generated from the name) |
| `GET /playbooks/:key` | — | `{ playbook, draft, published, versions[], venues: { setUp, active }, rules }` |
| `PATCH /playbooks/:key` | `{ listed: boolean, actor }` | detail — show/hide in the owners' gallery (no new version) |
| `DELETE /playbooks/:key` | `{ actor }` | `{ deleted }` — only never-published playbooks |
| `PUT /playbooks/:key/draft` | `{ content: PlaybookContent, baseVersion, actor }` | detail + `validation` — the first edit after a publish opens draft v(n+1); `baseVersion` = the `latestVersion` you loaded (409 if it moved) |
| `DELETE /playbooks/:key/draft` | `{ actor }` | detail — the live version is unchanged |
| `POST /playbooks/:key/check` | — | `{ version, report }` |
| `POST /playbooks/:key/publish` | `{ changelog, draftVersion, actor }` | detail — 422 with `issues` when the check has errors |
| `GET /playbooks/:key/versions/:v` | — | `{ version }` (read-only snapshot) |
| `POST /playbooks/:key/versions/:v/restore` | `{ actor }` | detail — copies v into the draft |
| `GET /playbooks/:key/diff?from=&to=` | — | `{ from, to, changes: DiffLine[] }` — `from`/`to` are a number, `live` or `draft` |
| `GET /journey-templates` | — | `{ journeyTemplates[] }` (with `startsWhen`, `channels`, `usedIn`, `versions`) |
| `GET /journey-templates/:key?version=` | — | `{ journey, version, versions, steps[], summary }` — steps in plain words |
| `PATCH /journey-templates/:key` | `{ availability: 'available' \| 'coming_soon', actor }` | journey detail |
| `GET /question-bank` | — | `{ questions[] }` |
| `GET /config` | — | `{ config, rules }` |

`PlaybookContent` (what a draft saves):

```ts
{
  kind: 'marketing' | 'utility',            // fixed after the first publish
  name: I18n, summary: I18n,                // I18n = { en, de?, it?, fr? }
  icon: 'utensils' | 'home' | 'store' | 'key' | 'gift' | 'layers' | 'spark',
  venueTypes: ('restaurant' | 'cafe' | 'airbnb' | 'other')[],
  journeys: [{ journeyKey, templateVersion, defaultEnabled, required, priority, slotDefaults }],   // order = priority
  offerMenuDefaults: [{ offerKey, name, label: I18n, kind: 'free_item' | 'percent' | 'amount' | 'upsell', value, currency?, expiryDays }],
  questionKeys: string[],
  estimateHints: { avgTouchesPerGuest: { [journeyKey]: number }, returnRate, avgSpend: { amountMinor, currency } },
}
```

## Tenant — `/internal/adaptive/tenants/:tenantUserId`

| Method & path | Body | Returns |
|---|---|---|
| `GET /gallery` | — | `{ playbooks: GalleryPlaybook[], guestInfo }` — published marketing playbooks with owner-facing journeys, blanks and offers, plus `fitsVenueIds` |
| `GET /overview` | — | `{ accountOn, sendingLive, venues[] }` — each venue with its switch, setups and overlap flags |
| `GET /venues/:venueId/setups/:playbookKey` | — | `{ setup, playbook }` — for "Edit journeys" (at the pinned version) |
| `POST /setups/validate` | `SetupInput` | `{ report }` |
| `POST /setups/estimate` | `{ playbookKey, playbookVersion?, venueIds, journeys }` | `{ estimate }` — credits/month, cost, return, per venue |
| `POST /setups/preview` | `{ playbookKey, journeyKey, slots, lang, venueId? }` | `{ messages[] }` — "See what guests get" for example guest Anna |
| `PUT /setups` | `SetupInput & { actor }` | `{ results[], report }` — saves; with `activate: true` also runs the pre-flight and turns on |
| `POST /venues/:venueId/activate` | `{ playbookKey, overlapAck?, actor }` | switch to a playbook the venue already has set up |
| `POST /venues/:venueId/pause` | `{ actor }` | pause the running playbook |
| `POST /venues/:venueId/resume` | `{ actor }` | resume |
| `POST /venues/:venueId/guest-info` | `{ enabled, actor }` | Guest info switch |
| `GET` / `PUT /venues/:venueId/guest-info` | PUT: `{ locales, baseVersion, actor }` | Guest info **content** (PR D; the `POST` above stays the switch) — see "PR D routes" |
| … | | every other PR D owner route: see "PR D routes" below |

```ts
SetupInput = {
  playbookKey, playbookVersion?,             // defaults to the live version
  venueIds: string[],
  journeys: { [journeyKey]: { enabled, slots: { [slotKey]: value } } },   // omitted journeys/blanks keep the venue's current values (playbook defaults for a new setup)
  timezones: { [venueId]: IANA },            // required to turn on (F01)
  overlapAck: { [venueId]: boolean },        // needed when the Marketing tab or an automation also welcomes guests (F03)
  guestInfo?: boolean,                       // Guest info switch for these venues
  activate?: boolean,                        // Turn on (needs adaptive.activate in the CMS)
  applyToInFlight?: boolean,                 // "Apply to guests already in these journeys?" (default false)
  audience?: { [venueId]: { sms: 'verified' | 'all', email: 'verified' | 'all' } },   // PR D: "who gets messages", saved with the setup
}
```

**`applyToInFlight`** (plan §3.10). Every save creates a new config version; guests already in a
journey keep the values they started with. With `applyToInFlight: true` (recorded on the version doc),
the running guests of this playbook at these venues — every journey of it — move to the new values at
their first step after 60 minutes (`freezeWindowMinutes`). Nothing within 60 minutes of the save uses the
new values: a send that goes out then keeps the old ones, whether it was planned before the save or a
delay ending or a click reaches it, and so does a send planned within the 60 minutes that a pause or a
provider retry holds longer. An offer a guest was already given keeps its wording. Guests who started on
a different template version than the saved values keep theirs. The response is the same; the worker
marks the guests within seconds.

Turning a playbook on sets the venue's previously active playbook to `inactive`
in the same transaction — a venue has at most one active marketing playbook. Its
settings are kept, so switching back is one call.

## Engine — `/internal/adaptive` (see docs/adaptive-engine.md)

| Method + path | Body | What |
|---|---|---|
| `GET /admin/engine` | — | Workers (heartbeat, version, identity key), queue, index check, launch |
| `POST /ingest/click` | `{ shortCode }` | The CMS resolver forwards a **counted** (non-bot) click on a journey short link. Ids are read from the short-link and send docs, never from the caller. `{ ok, ignored }` — `ignored: true` for any link that isn't an Adaptive journey link. |
| `POST /ingest/rating` | `{ shortCode, stars: 1–5, feedback? ≤1000 }` | A rating submitted from a journey rating link. ≤ 2★ stops marketing to that guest at that venue; ≤ 3★ emails the owner (the feedback goes only into that email). |
| `POST /dev/clock`, `/dev/launch`, `/dev/provider-event`; `GET /dev/guest-log` | | Local sandbox only (404 in production) |
| `POST /dev/rollup` | `{ venueId? }` | Local sandbox only: the daily numbers (JourneyStats) rolled up now, and the docs |
| `PUT /dev/calendar/:name` | `{ ics }` or `{ venueId?, stays: [{ uid?, checkIn, checkOut? \| nights? }] }` | Local sandbox only: the calendar a `sandbox:calendar/<name>` feed reads. `checkIn`: `today`, `+Nd`, `-Nd` or `YYYY-MM-DD` (the engine clock's today in the venue's zone); `checkOut`: the same or `Nn` (nights). The first stay keeps its UID across calls, so new dates are a date change. |
| `GET /dev/calendar/:name` | — | Local sandbox only: that calendar as `text/calendar` |
| `POST /dev/stay-feed` | `{ venueId, url }` | Local sandbox only: saves the venue's calendar link → `{ feed, stays, syncQueued }` (the service PR D's `PUT …/stay-feed` mounts) |
| `POST /dev/stay-sync` | `{ venueId }` | Local sandbox only: polls the feed now under the worker's feed lease (misses count at most every 30 min on the fake clock) and starts its 4 h chain if it isn't running (no `nextPollAt`, or one more than 1 h past) → `{ result: { outcome, created, changed, missed, cancelled, … }, feed, stays }` |
| `POST /dev/stay-check` | `{ venueId, url }` | Local sandbox only: "Check link", fetch + parse, nothing stored → `{ ok: true, upcoming, nextCheckIn? }` or `{ ok: false, errorCode, error }` (`unsupported_source` for Booking.com and feeds without "Reserved" events) |

`GET /admin/engine` also returns `feeds: { total, failing }` (Airbnb calendar feeds).
`GET /admin/engine` (PR D) also returns `deadTasks` (the 50 newest, a dead STOP or old-style unsubscribe
first: kind, what, urgent, guestDetails, venue, account, attempts, dueAt, diedAt, createdAt, last error
with addresses scrubbed — never the payload; `urgentDeadTasks` counts the urgent ones) and `failingFeeds` (venue, account, error code +
words, since — never the link).

`POST /dev/fail-task` `{ taskId }` — local sandbox only (PR D): makes a task `dead`, to try the admin retry.

**Calendar links (PR C service, routes in PR D).** `server/src/adaptive/service/stays.ts` has
`saveStayFeed`, `checkStayFeed`, `syncStayFeedNow`, `deleteStayFeed` and `getStayFeed` for PR D's
`GET/PUT/DELETE /tenants/:t/venues/:v/stay-feed`, `POST …/stay-feed/check` and `POST …/stay-feed/sync`.
They check the venue belongs to the tenant (403); saving and checking a link also need an Airbnb venue
(400), while reading, syncing and deleting don't (a feed stays readable and removable after the venue
type changes). A bad link is a 400 with the owner's sentence for its rule (e.g. `"That calendar link
isn't valid"`, `"The link must start with https:// (or webcal://)."`) that never repeats the link; the
link is only ever returned masked
(`https://www.airbnb.com/….ics`: the host and whether it is an `.ics` file, nothing of the path or
query), and errors are codes (`lastError`) with the owner's words beside them (`lastErrorWords`).

## PR D routes — owner, guest pages, HeidiFi admin

All under `/internal/adaptive`, behind `x-internal-secret` like everything here. Same answer shape
(`{ ok: true, … }` / `{ ok: false, error, code, issues? }`); PR D adds three statuses outside PR 1's
codes: **429** `rate_limited` (Check link / Sync now / the test-send cap), **410** `gone` (an expired
offer or info link), **503** `unavailable` (e.g. no identity key for a lookup), plus **400**
`confirmation_required` on the admin launch (with `confirmPhrase`) and **503** `engine_status_unknown`
there (the worker's readiness couldn't be read for a go-live — reload and try again). Writes need `actor`; owner writes
accept `actor.kind` `tenant_user` or `super_admin` (never `mcp` / `seed` → 403), admin writes
`super_admin` only. Every venue, stay and guest is checked against the tenant (403 / 404, never naming
another account). The **permission** and **audit key** columns are what the cms allow-list
(`_lib/adaptive-routes.ts`, PR E) should use; `adaptive.guestinfo.write` is new (MANAGER+).

### Owner — `/tenants/:tenantUserId/…`

| Method & path | Body / query | Returns | Permission (cms) | Audit key |
|---|---|---|---|---|
| `GET /venues/:v/stay-feed` | — | `{ feed \| null, stays: [{ stayId, checkIn, checkOut, nights, status, linked, linkedContactId, linkedGuest {name, email, phone} (masked), linkedBy, linkMode }] }` — the link only masked | adaptive.read | — |
| `PUT /venues/:v/stay-feed` | `{ url, actor }` | `{ feed, stays, syncQueued }` — Airbnb venues only (400); a bad link → 400 with the owner's sentence, never the link | adaptive.configure | `adaptive.venue.stay_feed_save` |
| `DELETE /venues/:v/stay-feed` | `{ actor }` | `{ deleted, cancelled }` — unlinked future stays cancel; linked ones keep running | adaptive.configure | `adaptive.venue.stay_feed_delete` |
| `POST /venues/:v/stay-feed/check` | `{ url, actor }` | `{ check: { ok: true, upcoming, nextCheckIn?, source } \| { ok: false, errorCode, error } }` — fetch + parse now, nothing stored; 20 an hour per account (429) | adaptive.configure | `adaptive.venue.stay_feed_check` |
| `POST /venues/:v/stay-feed/sync` | `{ actor }` | `{ queued, reason? }` — a poll within seconds (not while launch is off); 30 an hour (429) | adaptive.configure | `adaptive.venue.stay_feed_sync` |
| `POST /venues/:v/stays/:stayId/unlink` | `{ expectContactId, actor }` | `{ unlinked, feed, stays }` — that person's stay messages stop and they are never linked to this stay again automatically; the next guest who connects in the window is; 409 when someone else is linked now | adaptive.configure | `adaptive.venue.stay_unlink` |
| `POST /venues/:v/stays/:stayId/link` | `{ contactId, expectContactId?, actor }` | `{ linked, resuming, feed, stays }` — link a guest seen at this venue by hand (replacing someone needs `expectContactId`); they get the stay's remaining messages. Linking back someone unlinked earlier (`resuming: true`): the worker picks their stay journeys up where they stopped, within seconds; 409 while the venue doesn't start new guests, for a cancelled/finished stay or a guest linked elsewhere here | adaptive.configure | `adaptive.venue.stay_link` |
| `GET /venues/:v/guest-info` | — | `{ guestInfo: { locales, version, updatedAt, updatedBy } \| null, enabled, resolvedTimes: { checkIn, checkOut }, warnings[] }` — includes the Wi-Fi password and door code (the owner typed them; **no MCP tool reads this route**) | adaptive.read | — |
| `PUT /venues/:v/guest-info` | `{ locales: { en?, de?, it?, fr?: fields \| null }, baseVersion, actor }` | as GET + `resynced` — a language sent is replaced, `null` removes it, one left out is kept; `baseVersion` = the `version` loaded (0 when none; 409 if it moved); 422 with `issues` for a bad time (`HH:MM`, 06:00–22:00) or link | **adaptive.guestinfo.write** | `adaptive.venue.guest_info_content` |
| `GET /venues/:v/audience` | — | `{ audience: { sms, email }, isDefault, updatedAt, counts: { basis, sms: { verified, unverified }, email: { verified, unverified }, smsOtherCountries } }` — opted-in guests of the last 30 days; a number in a country SMS doesn't go to (the admin's SMS countries) counts by email only (`smsOtherCountries`), in the estimate too | adaptive.read | — |
| `PUT /venues/:v/audience` | `{ sms: 'verified'\|'all', email: 'verified'\|'all', actor }` | as GET — applies from the next send (also to running guests); 409 before the venue's first setup (save it with `PUT /setups` `audience` then) | adaptive.configure | `adaptive.venue.audience` |
| `POST /venues/:v/test-send` | `{ journeyKey, nodeId?, channel: 'sms'\|'email', lang?, recipientId, actor }` | `{ sent, channel, journeyKey, nodeId, variant, purpose, wordingLang, to (masked), problem?, preview: { subject?, text } (secrets masked) }` — one step with the venue's real values for sample guest Anna, to a **saved** test recipient (`CaptivePortal_TestRecipients/{tenant}`); no record, no link, no credits; shares the daily test cap (429; fails closed); refused while launch is off. Links follow the engine's rules (no info-page link without Guest info, no booking link without one); a message a guest wouldn't get → 422 with `missing` and `reason` (`guest_info_missing`, `booking_link_missing`). A saved number needs its country code (`+41…` or `0041…`). Rendered like the engine: in the wording's own language (`wordingLang`; English values and STOP line when the asked language has no wording) | adaptive.configure | `adaptive.venue.test_send` |
| `GET /results` | `?venueId&from&to&journeys=1` | `{ range, rangesDiffer?, venues: [{ venueId, name, timezone, range, card, testRun, waitingForCredits: { waiting, lowBalance, messagesWaiting, messagesWaitingTruncated?, messagesWaitingUnknown?, startedWaitingLast72h, startedWaitingLast72hTruncated? }, journeys? }] }` — `card`: `guestsStarted, cameBack, messages, creditsUsed, estimatedRevenue (cameBack × the venue's average spend; null without one), visits, stays { syncedInRange, changed, cancelled, linked, upcoming }, skipped`; venue-local dates (a real date, else 400), ≤ 92 days (default 30), each venue's own `range`; the top-level `range` only when all venues share it (else `null` + `rangesDiffer`); every Adaptive venue when `venueId` is left out. `waiting` = messages that can't be paid right now (`messagesWaiting`: those whose last look found them short, measured again against the wallet now — also through quiet hours) or — while the account is live and a marketing playbook is on at the venue — a wallet that can't pay one SMS segment or one email (`lowBalance`). Measured with one budget for the account (each channel's own credits first, then the shared pool; cheapest first); more than 1000 flagged → `messagesWaitingTruncated` and `waiting`; the read failed → `messagesWaitingUnknown` and `waiting`. A venue whose setup belongs to another account (moved) isn't listed. `startedWaitingLast72h` counts messages, not deferrals | adaptive.read | — |
| `GET /venues/:v/guests` | `?cursor&limit (≤100)&lang` | `{ guests: [{ contactId, name, email, phone (masked), lang, firstVisitAt, lastVisitAt, visitCount, consent { email, sms, whatsapp: { state: yes\|no\|none, ownerStopped } }, lowRating, journeys[] }], nextCursor }` — a cursor not from us → 400 | adaptive.read | — |
| `GET /venues/:v/guests/:contactId` | `?lang=en\|de` | `{ contactId, guest (masked), venue { visits, consent }, journeys[], stays[], creditsUsed, timeline: [{ at, kind, venueId, venueName, journeyKey, sentence, mode, channel, credits }], truncated }` — plain sentences for all this owner's venues; nothing of other owners | adaptive.read | — |
| `POST /venues/:v/guests/:contactId/marketing` | `{ action: 'stop'\|'resume', scope: 'venue'\|'all', actor }` | `{ changed, consent, note }` — stop = consent revoked by the owner on every channel at this venue or all venues (a splash tick can't undo it; START doesn't either); resume gives back only what the guest had said yes to. `scope: 'all'` also covers venues the guest visits later. A START texted or a splash yes given while the owner's stop stands is kept for the owner's resume. Adaptive only | adaptive.configure | `adaptive.guest.marketing` |
| `GET /venues/:v/messages` | `?kind=sends\|skips&days (≤92)&cursor&limit&lang` | `{ messages: [{ at, type, mode, journeyKey, journeyName, channel, status, credits, to (masked), contactId, guest (masked), line }], nextCursor }` — no message bodies; a cursor not from us → 400 | adaptive.read | — |
| `POST /guests/find` | `{ guestId \| contactId \| email \| phone }` | `{ contactId, guest (masked), venues: [{ venueId, lastVisitAt }] }` — a read (POST so addresses stay out of URLs); 404 when not this account's; refuses (409) when the server's identity key differs from the engine's. For the MCP | (MCP) | — |
| `POST /venues/:v/start-sending` | `{ actor }` | `{ venueId, sendingConfirmedAt, sendingConfirmedBy, alreadyConfirmed, needsStartSending: false }` — only while the account is live (409 before); once | **adaptive.activate** | `adaptive.venue.start_sending` |

`GET /overview` also returns (PR D) `sendingLive` = this account's launch mode is `live`, `sendingPaused`,
`launchMode`, and per venue `adaptive.needsStartSending` + `adaptive.sendingConfirmedAt`. The estimate
(`POST /setups/estimate`) also takes `audience?: { [venueId]: { sms, email } }` (else the saved choice,
else the defaults), prices only the guests that choice can reach, and returns `estimate.audience`
per venue (`{ audience, isDefault, counts }`).

PR E follow-up: in a German timeline (`?lang=de`, this guest route and `GET /admin/guests/:contactId`)
an issued offer is named with the German label of the venue's offer menu (its setups; the active
one first, then the others); the event itself stores the English label, which English timelines
and a menu without German keep using.

### Guest pages — `/public/…` (server-to-server; the cms page calls it)

| Method & path | Query | Returns |
|---|---|---|
| `GET /public/offer/:shortCode` | `?venueId&lang?` | `{ venueId, venueName, lang, offer: { label, expiresAt, expiresOn, status: valid\|expired\|redeemed } }`; 410 after expiry + 7 days |
| `GET /public/info/:shortCode` | `?venueId&lang?` | `{ venueId, venueName, lang, info: { fields… }, secrets: { wifiPassword, doorCode, keyInstructions, shownFrom, shownUntil }, stay \| null }` — secrets only in the stay window (12 h before check-in to 2 h after checkout; other links: the Wi-Fi password only, 30 days); 410 after checkout + 7 days, or once the stay is cancelled / no longer this guest's |
| `GET /public/rating/:shortCode` | `?venueId&lang?` | `{ venueId, venueName, lang, staffName: string \| null }` — for the rating page of a journey's review ask (`{{link.rating}}`, PR E follow-up): `lang` = `?lang` when en/de/it/fr, else the guest's language, else `en`; `staffName` = the journey's `staff_name` blank in the config version the guest's journey runs with (trimmed; `null` when empty or the journey has none). **Never a 410**: nothing secret, and a rating from the link counts at any time (`/ingest/rating` has no age limit) |

Only a live journey link of the right kind at `venueId` answers; anything else is the same 404.
`Cache-Control: no-store`. Opening a page is not a click (the cms forwards clicks to `/ingest/click`).

Offer `status` (PR E follow-up): `expired` once past `expiresAt`, even when the guest came back
(expiry comes first); else `redeemed` once the guest came back; else `valid`.

### HeidiFi admin — `/admin/…` (SUPER_ADMIN)

| Method & path | Body | Returns | Audit key |
|---|---|---|---|
| `GET /admin/launch` | — | `{ version, launch { default, accounts, liveSince, changedAt, changedBy, note }, paused, pauseReason, safety, sms { allowedCountries, knownCountries }, alerts { email }, accountNames (overrides and accounts with venues waiting), waitingForStartSending { tenant: n }, warnings[], history[] }` | — |
| `POST /admin/launch/check` | `{ change, actor }` | `{ summary: { lines, loosening[], confirmPhrase, empty }, blockers[] }` — nothing written; 503 `engine_status_unknown` when a go-live's worker check couldn't be read | `adaptive.admin.launch_check` |
| `PUT /admin/launch` | `{ change: { default?, accounts?: { tenant: mode \| null }, paused?, safety?, smsCountries?, alertsEmail? }, baseVersion?, confirm?, note?, pauseReason?, actor }` | `{ changed, summary }` + GET's answer. Changes that loosen sending (going live, releasing the pause, higher limits, more SMS countries) need `baseVersion` and the typed `confirm` phrase; the brake (pause, off, test, lower) needs neither, and a change of the alert email needs `baseVersion` only. 503 `engine_status_unknown` when a go-live's worker check couldn't be read. Going live is refused (409 `engine_not_ready`) unless a worker runs this code with the same identity key. Writes `history/{version}` and `launch.liveSince` | `adaptive.admin.launch` |
| `POST /admin/tasks/:taskId/retry` | `{ actor }` | `{ taskId, kind, retried, warning? }` — a dead task only (409 otherwise); keeps its due time; refuses signals whose guest details were removed and logins older than 72 h; the warning for a rating only when it was never applied and its private feedback is lost | `adaptive.task.retry` |
| `POST /admin/guests/search` | `{ email \| phone, actor }` | `{ results: [{ contactId, tenantUserId, account, matchedBy, name, lastSeenAt, venues[], blocks }] }` — refuses (409) when the server's identity key differs from the engine's | `adaptive.guest.search` |
| `GET /admin/guests/:contactId` | `?lang` | the full record: contact, places, sends (with every rule's check and fact, `statusHistory`), consent ledger, instances, stays, blocks, weekly window, events, timeline | `adaptive.admin.guest_view` (GET, audited) |
| `POST /admin/decisions/replay` | `{ sendKey \| eventId, lang?, actor }` | `{ replay: { replayable, same, stage, engine { recorded, current, sameCode }, stored, replayed, differences[], sentence } }` — decisions recorded before PR D answer `replayable: false` | `adaptive.decision.replay` |

Account names (`accountNames[…].name` on the launch card, `account.name` in guest search) come from
the `Users` doc: `displayName`, then `display_name` (cms owner docs, PR E follow-up), `companyName`,
`name` — the first that isn't empty; `null` when none.

## Check codes

| Where | Codes |
|---|---|
| Playbook (admin Check / publish) | K01 shape · K02 kind locked · P01 name · P02 journeys · P03 required ⇒ on · P04 newest pin (warn) · P05 questions (warn) · P06 pinned version exists · P07 coming soon ⇒ off · V04 offers & defaults · V07 wording (warn) · V09 venue types · V10 same trigger (warn) · V14 info playbook |
| Journey template (seed / CI) | V01 graph · V02 pools · V03 caps · V04 offer blanks · V05 high value · V06 trigger config · V08 channel diff · V14 info journey · V16 registry |
| Owner setup (save / turn on) | S01 venue · S02 journeys on/off · S03 blanks · S04 playbook offered · F01 time zone · F02 account active · F03 overlap acknowledged · W01 WhatsApp later (info) · W02 stay calendar (warn) |

## Seed

The server creates the four prototype playbooks (Restaurant growth, Airbnb stay,
Local business, Guest info), their 12 journey templates, EN/DE wording, the
question bank and the platform rules once at boot — `create()` only, so nothing
an admin changed is ever overwritten. To inspect or run it by hand:

```bash
npx tsx src/adaptive/seed/run.ts           # dry run
npx tsx src/adaptive/seed/run.ts --apply   # create what is missing
```

### Wi-Fi card wording — hand edit where the seed already ran (PR E follow-up, E-D10)

The Wi-Fi card (pool `wifi_info`, letter A) no longer says "Menu, opening hours…" (an Airbnb has
neither); SMS and email now share one neutral line that fits every venue type. New databases get
the new text from the seed; the seed never overwrites, so wherever it already ran (production, and
any emulator whose data survived a server start) edit the doc
**`CaptivePortal_Variants/var_7600ede441779e425513e5da5952cb21`** by hand. In each of the four
string fields, replace only the words shown; keep everything else, including every `{{…}}` and the
line breaks of the email bodies:

| Field | Replace | With |
|---|---|---|
| `channels.sms.text` | `Menu, opening hours and more:` | `Everything you need to know:` |
| `channels.email.body` | `Menu, opening hours and everything else:` | `Everything you need to know:` |
| `locales.de.sms.text` | `Menü, Öffnungszeiten und mehr:` | `Alles Wichtige:` |
| `locales.de.email.body` | `Menü, Öffnungszeiten und alles Weitere:` | `Alles Wichtige:` |

Don't touch `mergeFieldsUsed` (the same blanks as before) or `contentHash` (stale afterwards, but
nothing reads it at runtime). The server and worker pick the change up within 30 seconds (the
catalogue cache). The full new texts are in `server/src/adaptive/seed/definitions/variants.ts`
(the block at the end of the file).
