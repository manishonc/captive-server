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

```ts
SetupInput = {
  playbookKey, playbookVersion?,             // defaults to the live version
  venueIds: string[],
  journeys: { [journeyKey]: { enabled, slots: { [slotKey]: value } } },   // omitted journeys/blanks keep the venue's current values (playbook defaults for a new setup)
  timezones: { [venueId]: IANA },            // required to turn on (F01)
  overlapAck: { [venueId]: boolean },        // needed when the Marketing tab or an automation also welcomes guests (F03)
  guestInfo?: boolean,                       // Guest info switch for these venues
  activate?: boolean,                        // Turn on (needs adaptive.activate in the CMS)
}
```

Turning a playbook on sets the venue's previously active playbook to `inactive`
in the same transaction — a venue has at most one active marketing playbook. Its
settings are kept, so switching back is one call.

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
