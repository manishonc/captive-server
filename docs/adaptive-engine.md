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
  node_run     → the interpreter walks steps; a send goes through the 11-rule gate
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
- The worker is the only process that reads owners' calendar links on its schedule (outbound https).
  The one exception is the owner's "Check link" (PR D, `POST …/stay-feed/check`), which reads the
  link once in the API process, with the same safe fetcher (20 checks an hour per account).

## Sending (live)

- **Exactly once** (`send/dispatch.ts`):
  1. One transaction re-checks the pause, consent, blocks, the weekly limit, the spacing and a low rating, then
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
  parts of that exact text, counted as the carrier bills them (PR F0: `core/runtime/smsParts.ts`, an emoji
  is two UTF-16 units). Adaptive always charges, whatever `ENFORCE_CREDITS` says.
- **Email:** plain-text wording becomes simple HTML (escaped), with the preheader, a localized unsubscribe
  footer + `List-Unsubscribe` headers (marketing), "Powered by HeidiFi" unless the plan hides it, and the
  sendKey in `X-Mailin-custom` so Brevo webhooks find the send. No open pixel.
- **SMS:** the same Twilio sender and status-callback URL as today (the webhook's signature check
  depends on it); statuses are matched by the message SID.
- A channel without credentials is skipped (the ladder moves on) and HeidiFi is alerted.

## Spacing between marketing messages (PR F0)

- **Rule 9, `spacing`** (right after quiet hours; fair use and credits are now rules 10 and 11, and the "why"
  view shows 11 checks): no marketing
  message to a person within `AdaptiveConfig/global.marketingGapHours` (4) of their last one, whichever
  venue or owner sent it — the same scope as the weekly limit, read from the same
  `NetworkPeople.recentMarketingTouches`. Before this, two messages held overnight both went at
  09:00–09:20.
- Held: until 4 h after the last one + a repeatable 0–20 min (from the send key); a gap that ends in quiet
  hours goes on to their end. Past the step's `expireAfter` the message is skipped (`spacing_expired`),
  as with quiet hours — the 0–20 min is counted too, so a gap that ends just before the deadline can still
  skip it (the safe side: nothing is sent after its deadline). Info messages are never spaced.
- The phase-1 transaction re-reads the touches, so two sends to one person claimed at the same moment can't
  both pass. A hold that moves (another message went meanwhile) writes a new `send.deferred`, so the
  owner's timeline shows the new time.
- Limits: like the weekly limit it sees only Adaptive's live marketing sends (Marketing-tab and Campaign
  Manager sends write no touch; test runs and info messages write none either, so a welcome can follow a
  Wi-Fi card within minutes). No API writes `marketingGapHours` yet: the default applies to a config doc
  without it; changing it is a hand edit of `AdaptiveConfig/global` — hours from 0 to 48 (`0` switches it
  off; the owner sentence names whole hours, and says "just got another message" otherwise). A value that
  isn't one of those (e.g. `"0"` as text, or 49) reads as 4 h and logs `[ADAPTIVE] AdaptiveConfig/global
  marketingGapHours … using 4 h` once per process; the rest of the doc is unaffected.
- Records written before PR F0 have no `spacing` input: Replay treats that as "no gap set", and reports them
  as "the engine changed since" (ENGINE_RUNTIME_VERSION 2026-09-29.a).

## SMS parts and seeded wording (PR F0)

- `core/runtime/smsParts.ts` counts parts the way the carrier bills: GSM-7 160 / 153 septets (an extension
  character such as `€` takes two), anything else UCS-2 at 70 / 67 UTF-16 units (an emoji takes two), and no
  character is split across two parts. Adaptive's pricing (`send/pricing.ts`), the sandbox provider, reply
  notices and the owner estimate use it. The shared `services/smsBilling.ts` counter (legacy campaigns) is
  unchanged; it counts an emoji as one unit.
- The seeded SMS are GSM-7 now: no 🎁 and no "–" (welcome A/B, German book-direct, checkout A). The German
  welcome is 2 parts (30 credits), not 4 (60). `tests/adaptiveSeedUpgrade.test.ts` keeps every seeded SMS
  GSM-7 and every marketing SMS within 2 parts (36-character venue name, longest offer, real link, STOP line).
- The owner estimate prices SMS the way the engine sends it (`service/estimateSms.ts`): an SMS-first
  journey's first message by SMS at the parts its wording takes at that venue, the follow-ups on the next rung
  of the ladder (email: an SMS is never "opened", so a follow-up moves on). The PR 1 formula priced every
  touch as a one-part SMS; the difference is added per venue and journey. It is an approximation: a guest who
  taps the SMS link gets the welcome's last reminder by SMS again (`same_as_last_click`), priced here as email,
  so the bill can be higher by about one SMS per clicking guest.
- Merge values in an SMS (a guest or venue name typed on a phone) get their typographic punctuation replaced
  (’ ‘ ‹ › → ', “ ” „ « » → ", – — → -, … → ..., non-breaking and other wide spaces → space), so one "Luigi’s" doesn't make the
  SMS Unicode — only when that makes the whole SMS GSM-7 without more parts. Letters are never changed: "Zoë"
  or "François" keep that SMS UCS-2 (priced correctly), and then nothing is replaced. Codes (Wi-Fi password,
  door code, key instructions), the Wi-Fi name, links and any value that is a web address always go exactly as typed.
- The Twilio adapter sends `smartEncoded: false`: our price is the text as sent. When Twilio reports a
  different part count than ours, the worker logs `[ADAPTIVE] twilio counted N SMS parts, Adaptive priced M`.
- Getting new seed wording into a database where the seed already ran: the **seed upgrade step**
  (`seed/wordingUpgrades.ts`, run by the boot-time seed after its create-only pass). It rewrites a platform
  wording doc only while its stored text is exactly one of the earlier seed texts it lists, keeps the old
  text in `CaptivePortal_Variants/{id}/history/`, and records the upgrade in `seedUpgrades`. A text already kept
  in `history/` is never replaced again, so an old text put back on purpose stays. A doc edited by hand is left
  alone and named in the boot log ("Not upgraded (edited by hand)", with the stored text's hash). To change
  seeded wording later: patch it at the end of `seed/definitions/variants.ts` and add an entry with the old text's
  hash (several entries for one wording are fine; a broken entry stops the seed before it writes anything).

## The bandit (PR F1)

- **Off by default.** `AdaptiveConfig/global.bandit { mode, accounts }` — global and per account, changed on
  the admin launch card (turning it on needs "BANDIT ON"; off is one click and works on a stale card). Off is
  exactly the rotation of PR B. A missing or malformed value reads as off.
- **What it picks**, for marketing sends only, always inside every send rule: the wording — Thompson sampling
  among the step's active wordings in the guest's language, without the last touch's text when the step's
  `requireDiff` lists `variant` (one left: `forced:require_diff`, no draws, doesn't train) and without wordings
  retired at this venue (one left: `forced:retired`, one draw, still trains) — and, at `slot` steps, the slot
  (morning / afternoon / evening; the minute inside it stays repeatable). A pool with one wording: the
  rotation decides, as before.
- **Arms** (`CaptivePortal_BanditArms`; the send path reads them by id; the learner, the pool rebuild and the
  admin numbers query them on `venueId`, `scope` and `journeyKey` — single-field equality, no composite index,
  so the worker's start probes are unchanged): one doc per venue, journey and step (`ba_…`) with the data per
  segment (`new`, `returning`, `stay`, `unknown`) and `all`; `pool_…` docs with every venue summed, rebuilt from
  scratch daily, no tenant on them; `learn_{venueId}` holds the learner's marks and its `facts`: the journeys a
  return visit was credited to (`visitCredits`, 30 days) and the sends that were clicked, rated, came back or
  were unsubscribed from (`clicked`, `rated`, `visited`, `penalized`, 15 days: they wait for the send's close,
  each counted by its event's own time); at most 3,000 entries per map (the oldest go first), so the doc stays
  far under 1 MiB. A wording's arm is its content (`v:` + 12 hex of its hash, as loaded), so an edited text
  starts a fresh arm.
- **The draw:** prior (the pooled arm as 20 pseudo-sends once it has ≥ 200 finished sends; an arm the pool
  doesn't know yet — a new or edited wording — starts at the mean of the wordings it is compared with, as 20
  pseudo-sends: their data at this level (the segment's or the venue's, ≥ 30 finished sends), else the pool's
  (≥ 200), so it gets a fair test against wordings with numbers; a flat 5 % only while there is no mean) + the
  venue's data (its segment's once that has ≥ 100 finished sends at this step, else all segments'). The data is
  finished sends only (see the learner). The method names the level: `bandit:segment`, `bandit:venue`,
  `bandit:pool` or `bandit:prior`.
- **Sticky per send:** while the bandit is on, a held send (quiet hours, credits, spacing, a provider retry)
  keeps its wording and draws (`waiting.variantPick`, also for a pick without draws) unless that wording's
  text was edited meanwhile (a new arm: drawn again); a slot draw rides in the wait to the send
  (`waiting.slotPick`).
- **The record:** `JourneySends.bandit` / `JourneyEvents.data.bandit` — the segment and, per part, the level,
  the pick and every candidate's α, β and θ (`in`: the send went inside its slot). `DECISION_VERSION` 3.
  Replay re-checks the pick from the stored θ, draws every θ again from the send key and checks the
  decision's wording method and slot rule against the block (`banditChecked`); `REPLAY_VERSION` stays 1, so
  older records replay as before. The block stays near 1 KB (past it the letters are dropped; the draws stay,
  so a pool of more than about 12 wordings grows it a little).
- **Unreadable arms** (a read error, or 1.5 s): the rotation stands in (`rotation:bandit_unavailable`) for 30
  seconds. A send never waits on the bandit.
- **The learner** (`bandit/learn.ts`; task `learn_arms` per venue and hour, armed with the rollup while the
  bandit is on for the account and 7 days + 12 hours after each bandit send): the venue's log from its own mark
  (the rollup's query and index) and the live sends older than 7 days + 12 hours (`JourneySends(venueId, mode,
  createdAt)`), one transaction per page, exactly once; a venue's first run starts 15 days back; a run closes
  only up to its task's due time (after an outage, the sends whose signals are still queued wait). A send's
  whole reward lands when it finishes (its 7 days + 12 hours: a late signal is in), so the draw sees finished sends only — counting a
  click the day it happens but "no click" a week later made any arm with young sends look good, and the bandit
  locked onto whichever wording got the traffic; until then the learner counts what the admin numbers show and
  remembers the send's `facts`. Rewards (the brief's DF1): click α+1; rating α+2 (any stars), once per send; a
  return visit within 7 days α+4, once per journey, to that journey's last live marketing send (nothing when
  that send has no draws); no click within 7 days β+1; an email unsubscribe or spam report β+10, once per send;
  an SMS STOP β+10 when this send was the number's last live SMS; a hard bounce nothing. Sends close only once
  the log is caught up. Test runs and info messages never train; a slot learns only from sends that went inside
  it. Weekly per step: the data × 0.95, and a wording with ≥ 200 finished sends and under 1 % chance of being
  best among today's texts at two weekly checks in a row retires at that venue, for good (never the last one;
  slots never) — one check at 5 % retired a wording as good as the other at 4 venues in 10 within a quarter.
  `learn_pool`, armed daily by the worker while the bandit is on anywhere, rebuilds the pools and deletes a pool
  no venue has any more (a deleted account's share drops out within a day); the send path ignores a pool not
  rebuilt for 48 hours.
- **Screens:** the launch card's row; per-wording numbers in the admin Journeys view
  (`GET /admin/journeys/:key/bandit`, with the venues where a wording retired); the draws in the admin guest
  record's "Why?". Owners see a learning line only once it is on for their account and the account is live
  (`overview.banditOn`).
- **New wordings (F-D11):** review ask B, last reminder B and stay review B (GSM-7, en + de). With the bandit
  off, the rotation sends B only as a follow-up (the review ask's and stay review's second message).
- **Local:** `POST /dev/launch {"bandit":{"accounts":{"<tenant>":"on"}}}` and `POST /dev/learn
  {"venueId"?, "pool"?}` (the learner now, and the pooled rebuild).

## The AI agents (PR F2a)

The foundation every Claude call goes through; its only job so far is the admin's **Test connection**
(`ping`). The copy writer comes with F2b. Nothing here sends a message, charges credits or waits on the
sending pause.

- **One way to a model:** `brain/run.ts` `runAgent()`, called only by the worker's AI lane. Only
  `brain/modelClient.ts` imports the Anthropic SDK, and the API process never loads it
  (`tests/adaptiveBrainBoundary.test.ts`); the AI code never reaches the send path or the wallet, and the
  send path never reaches the AI code.
- **The path:** worker → the cms model relay (`${CMS_INTERNAL_URL}/api/captive-portal/internal/model-relay/v1/messages`,
  `x-internal-secret` = the worker's `INTERNAL_API_SECRET`) → the Vercel AI Gateway's Anthropic-compatible
  Messages API with the cms's gateway credential. The worker holds no model key. The official
  `@anthropic-ai/sdk` (pinned), loaded on the first run (never at boot: an SDK that fails to load fails AI
  runs only), with `maxRetries: 0`, ≤ 210 s per call and its environment switches pinned (no
  `ANTHROPIC_LOG` body logging, no `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` picked up); typed answers
  through `output_config.format` (the job's Zod schema) and adaptive thinking at the agent's effort. Errors
  keep the relay's / gateway's own words (capped), never the request. The real client refuses under
  `FIRESTORE_EMULATOR_HOST`; in the sandbox the fake model answers instead (`brain/sandboxModel.ts`: every
  request logged to `CaptivePortal_AdaptiveSandboxModelCalls`, faults queued through `POST /dev/model-answer`).
- **The relay** (cms `app/api/captive-portal/internal/model-relay/v1/messages`): checks the secret in constant
  time (503 when the cms has none, 401 when it differs), refuses under the emulator, checks the whole request
  (plain text only, no tools, no streaming, no beta header, allowed models, at most 8,000 output tokens, 256 KB)
  and forwards only that checked body with a pinned `anthropic-version`; gives the gateway 200 s (its 504 is a
  timeout to the worker: costed at the worst case, like one of ours); at most 300
  calls a day (UTC, `CaptivePortal_AgentUsage/relay-{yyyymmdd}`; over it a 429 `relay_daily_limit`, which the
  worker treats as setup, not as a busy model).
- **Models** (gateway ids, list prices per million tokens in/out): `anthropic/claude-opus-5.5` $4 / $20,
  `anthropic/claude-sonnet-5.5` $2 / $10 (cache reads $0.20; 5-minute cache writes 1.25 × input). Each agent has a
  model and a fallback, tried once after a 429, a 5xx, a dropped connection or a timeout — never a third call.
- **A run** (`CaptivePortal_AgentRuns/{ar_…}`, one per task attempt, `expireAt` + 13 months): never twice —
  an attempt of a task another attempt of which started is `already_called` (after closing that run if its
  worker left it `running`), a Test connection that waited over 10 minutes for a worker is `stale` → gates → budget → the package (allowed fields only) and the
  privacy scan (emails, phones and the job's secret values in strings and keys, and whole numbers as long as a
  phone number; a finding stops the run and nothing of the package is stored; the finding names the path,
  with any key that holds data replaced by `<key #n>`) → the request's size as sent → the record `running`
  (with the usage docs it will count in) → the model → the checks: only a normal end (`end_turn`) is read,
  then JSON, the job's schema (enums and ranges aren't enforced upstream), every number in the reasoning in
  the input (values and keys), the prompt or the schema (rounding within one unit, percentages of fractions,
  "percent" and decimal commas; a unit after a number or a currency before it is still a claim; small counts
  free), the job's own checks → the record finished: `ok`, `rejected` (answered, failed a check — never
  used), `failed` (no usable answer) or `skipped` (never called: `stale`, `already_called`, `agent_off`,
  `agents_off`, `not_live`, `budget`, `daily_limit`) with the tokens, the cost at the model's list price, the
  latency and the attempts. From the model call on nothing throws (a throw would hand the task out again and
  call the model twice); a record deleted meanwhile (an account delete) is not written back.
- **The switch and the budget:** `AdaptiveConfig/global.agents { mode, accounts, monthlyBudgetUsd }` on the admin
  launch card: on needs "AI ON", a higher budget "LOOSEN LIMITS"; off and a lower budget are one click. Missing =
  off and $100 a month; a budget that can't be read is 0 (every agent paused). A scheduled run needs its agent on
  (`CaptivePortal_Agents/{key}.enabled`), the switch on (the account's override first) and, for an account's job,
  the account live. The Test connection is one run a person asked for: it runs while the switch is off.
- **Spend** (`CaptivePortal_AgentUsage`, real UTC dates, read by id): `month_{yyyymm}` (the platform's cost, per
  agent and per account) and `{agent}_{yyyymmdd}` (runs, outcomes, tokens, cost). It is counted before the record
  is finished; a call that timed out or was stopped after reaching the relay is counted at its worst case (the
  request in, a full answer out — it may have been billed). Only runs that reached the relay count toward the
  agent's runs a day. At 100 % of the month's budget every agent is skipped until the month ends or the budget
  goes up; sends never notice. HeidiFi's alert email gets `agent_budget` at 80 % and 100 % (once each per month
  and budget: a raised budget alerts again) and `agent_failing` for every failed run, once a day per agent and
  cause, with what to check.
- **The lane** (`brain/lane.ts`): the worker claims a batch and waits for all of it, so an `agent_run` task only
  starts here and the batch moves on: one run at a time per worker (another `agent_run` is put back for a minute,
  one for an agent this build doesn't know for ten; its own task, handed back to it after the lease ran out,
  stays with the run). The lease is renewed as the run starts and every 30 s while the worker still holds it: a
  lease lost before the start runs nothing, one lost during the run aborts the call (the next attempt then finds
  the started run and skips). The call is aborted at the deadline (about 4 minutes, both calls included) and
  the lane gives up 30 s later. The task is done whatever the outcome (a failed call is in the run log); only an
  unexpected error fails it, and the queue hands it out again (`maxAttempts: 3`; a later attempt never calls the
  model once an earlier one started). A renewal Firestore doesn't answer stops the run only once the last good
  one is three intervals old. On SIGTERM the worker
  aborts the run and waits for it to record what happened. The heartbeat's `ai` block says whether the worker
  has `CMS_INTERNAL_URL` and `INTERNAL_API_SECRET` (booleans only) — the admin "AI agents" card shows it, and
  warns when the only live worker is idle (it then runs no task, agents included).
- **Never twice, round 2 (review):** the run record is written in one transaction with a check that the worker
  still holds the task's lease (a claim by another worker lands before it — nothing written, nothing called — or
  after it — the next attempt sees the record); every attempt checks the task's other attempts (1–4), so a run
  left `running` by a worker that died mid-call is closed by the next attempt as `failed / interrupted` and counted
  at its worst case (both models, a full answer); a dead `agent_run` task is never retried by the admin tools. An
  agent's output limit is 8,000 tokens (thinking included), so an answer fits in one call's 200 s. After SIGTERM
  the lane stops the run (recorded as `aborted`, "the worker was stopping", no alert) and hands any `agent_run` it
  claims straight back to the queue. A spend counter that can't be read blocks every run and stays as it is (an
  increment would reset it) until a person fixes it; the admin card says so. The budget and the runs a day are
  checked before the call: with several workers they are soft limits (the relay's 300 a day is the hard one).
- **Round 3 (review):** a run is counted once (`countedAt` on its record, set in the counting transaction), so a
  run that counted and then stopped before finishing isn't counted again when the next attempt closes it; a
  record that never reached the model call (no request recorded) is closed without a count or an alert; the
  record is written with a nonce, so a transaction retried after a late commit knows its own write; a relay URL
  that isn't a web address, or a secret a header can't carry, is refused before anything is sent (never quoted);
  after a call that ran into its time limit the fallback needs 60 s left; a damaged day counter pauses that agent
  for the day (the card says so). The privacy scan also reads URL escapes and "&#64;", "(at)"/"(dot)" emails,
  Swiss numbers with mixed separators, short dates ("01.10.26", "03.10."), Swiss company numbers, IBANs (a valid
  check, as their own kind), and matches secrets across "ß"/"ss", apostrophes, hyphens and a genitive "s" —
  input builders pass a name's parts as secrets too. Rounds 4–5: an umlaut in a secret reads as "ae/oe/ue"
  (never the plain vowel, which is often a word: "Schön"/"schon", "Bürger"/"Burger"), an umlaut in the text reads
  both ways (a secret stored as "Muller" is found in "Müller"), and nothing is folded ("Mael" isn't "mal"); a
  four-digit code also matches as "12 34" (never "1 234" or "17-22"), a longer one in any groups ("1234 5678");
  "+41"/"0041" numbers with mixed separators, "(point)", "&#46;" and double URL escapes are read; lists of years,
  map coordinates, "@2x" image names, "Infos @ www.sonne.ch" and long ids inside web links (unless the link has
  "tel:", "wa.me/", "phone=" or a "+" number) are not personal data; a secret too long for a pattern is compared
  squashed; long whitespace runs scan in linear time. Round 6: letters with strokes read as typed without them
  ("Søren" = "Soren"); a phone behind an invisible character or glued to its label ("Tel079…") is found; a
  four-digit code also matches digit by digit ("4 8 2 1"). Round 7 (each finding checked by an independent
  skeptic): HTML character references are read ("&nbsp;", "&uuml;"); a name part of 3 letters is checked ("Tim");
  a Swiss number glued to any word, and a "+"/"00" number glued to the next word, are found; a number glued to an
  id by "_" isn't a phone; a code with its own punctuation matches as written ("01.10.2026"); two regexes that
  took 30–60 s on 240 KB of adversarial text are linear. The numbers check reads times and dates in the input in
  parts ("11.30" = 11, 30, 11.30; an ISO date as "17.10"), percent words in German, French and Italian, and "1 234"
  when the input has 1234 — invented numbers are still caught.
- **Round 4 (review):** closing an interrupted run and counting it is one transaction (a run that counted its own
  spend before it stopped keeps that amount — `countedMicroUsd` — and isn't counted again, and if it still finishes
  it writes its real result over the close; one closed at the worst case keeps the closed record, matching what was
  counted, and its late answer is never applied); an error while closing fails the
  task (nothing was called; it is tried again); every 10 minutes the worker closes runs still `running` after 30
  minutes (a worker that died on the task's last attempt) and counts them the same way; a lease renewal is awaited
  at most 10 s (one that lands later still counts) and the three-interval rule is checked on every tick, so a run
  without a confirmed lease stops within about 100 s of the last good renewal's start, inside the 2-minute lease.
- **Round 7 (review with skeptics):** the relay tells a gateway call that never went out (`api_error` 502: the
  worker may try its second model) from one that broke off after it was sent (`relay_answer_lost` 502: maybe
  billed — counted at the worst case, no second call); the worker reads its own connection errors the same way
  (refused / unknown host / bad certificate = never sent, anything else = maybe sent, counted at the worst case).
  A secret is removed from upstream text before the text is cut to length; the model call's secret header never
  follows a redirect (one is `relay_not_configured`, not counted — round 8), and `CMS_INTERNAL_URL` must be
  `https://` for it (plain http only to this machine). The worker's credit top-up trigger
  (`services/autoRefillTrigger.ts`, older code) sends the same secret to the same address and does follow
  redirects: set `CMS_INTERNAL_URL` to the final address (`https://portal.heidifi.ai`). A run whose count failed
  is counted by its finish, in the same transaction (unless the count did land); a run another attempt closed,
  or whose account is gone, never reports an outcome to use (`failed / interrupted`, `skipped / gone`). A shutdown
  before the run is recorded records nothing and hands the task straight back (one while it is being recorded
  ends `failed / aborted` before the call: nothing sent, $0); the next attempt closes every earlier run
  left unfinished, not only the first. A failed SDK load is `sdk_unavailable` (not `bad_schema`).
- **Round 8 (review with skeptics):** a run that ends before the model call no longer says its counters failed; a
  redirect on the model call is `relay_not_configured` (not counted, no second model); the run's summary is scanned
  whole as well as cut to 500 characters (one over 240,000 characters is replaced by the job's label). Privacy scan: bullets ("•", "∙", "・") read as "·" (year lists stay year
  lists, a phone written with bullets is found); UUIDs are ids; a "00" number glued to a word counts only when it is
  written with spaces; "Tel_079 …" is found; a URL escape inside a character reference ("&#37;40") is decoded, and
  only real entity names are read. Secrets: a code with its own punctuation matches exactly as written ("12-34" —
  never "12.34" or part of a longer number); a 3-letter name is a whole word with no genitive, and the text's accents
  count ("Dan" is not "dans", "Gia" not "già"); a secret with under 4 letters and digits but 6+ characters is
  checked exactly as written. Numbers check: the input's dates and times, read in parts, explain only numbers quoted
  without "%" (a price's cents, a date's day or a time's minutes never explain a rate); "CHF 18.50" is a price, not
  a time; "5 000" is one number (reported as written when the input doesn't have it); each quoted number is checked
  against the input by binary search (30,000 against 30,000 in milliseconds).
- **Round 9 (review with skeptics):** a run whose count failed and whose account is gone meanwhile is counted by its
  finish, in the platform's totals; the admin card remembers which version a refused save was based on (a refusal
  that arrives after the row moved on doesn't stick; settings recreated by hand at version 0 load with Reset).
  Privacy scan: a "00" number glued to the next word is a phone again ("0049-7531-123456Wir"; only the start of a
  UUID is an id); map coordinates go up to 180 degrees ("333.1234567" is a phone). Numbers check: the input's
  "1 200" and "1.200" also give 1200 (an honest "1 200 Gäste" passes); a date's or a time's parts explain only the
  same number ("17.10.2026" explains no "18", "18:30" no "19" — nor an invented "31" next to the ping's date;
  a bare "17.10" is also the decimal 17.1, which does); seconds
  are read; a list of rates ("5/10/20 %", "5/10/20 Prozent") is no date.
- **Round 10 (review with skeptics):** after a refused save the admin card waits for a load before Reset takes the
  server's values (never an older version than its own last save). Privacy scan: the start of a UUID is an id only
  when its letters show it, in one case, with its third group ending there — so a "00" phone grouped
  "00491511-2345-678" is found, also glued to a word ("…-678Bitte"), and so is a phone after such an id. Numbers
  check: a "%" after a date with a 4-digit year, or a URL escape after it ("…17.10.2026%2018:00"), doesn't make the
  date a rate list ("%25" is a percent sign); "v2.100" is a label, while "CHF1.200" / "Fr.1.200.–" give 1200.
- **The privacy scan, round 2:** it scans the package as serialized (what is sent) and the run's summary; texts are
  put in one form first (compatibility forms such as fullwidth digits and no-break spaces, every dash as "-",
  invisible characters removed), and dates, times and two-decimal amounts are taken out before the phone check
  (they neither count as digits nor hide a number next to them). Emails also as "%40", with a quoted name or a
  non-Latin domain; secrets without case, accents or invisible characters — digits as whole numbers outside
  dates, words as whole words (rounds 3–6 below refined this; `brain/privacy.ts`'s header is the full rule). Keys
  that aren't plain field names (starting lower-case) are never written into a finding's path.
- **No new composite index:** reads are by id or single-field — the admin run log orders by `createdAt`, the
  worker's sweep of unfinished runs queries `status`, and the cms account delete queries `tenantUserId` and
  `byTenant.<account>` (keep those fields indexed).
- **Local:** `POST /dev/agent-run {"agentKey":"ping"}` queues a run; `POST /dev/model-answer
  {"agentKey":"ping","answers":[{"fault":"rate_limit"}]}` makes the next answer fail; `GET /dev/model-calls` lists
  what the fake model received.

## The WhatsApp template writer (PR W2a)

The first agent whose answer is used: `wa_template_writer` (`brain/jobs/waTemplateWriter.ts`, prompt
`wa-writer-v1`) writes one platform WhatsApp template for one Adaptive message in one language — a `new` one,
a `translation` of the English one (same name, same fields), an `alternative` (Suggest only), or a `fix` of a
template Meta rejected or paused (in place, at most 2 AI fixes per template). It messages nobody and sends
nothing to Meta, so it never waits on the guest-sending pause (Manish, 2026-10-05). Defaults: off, Opus 5.5
with Sonnet 5.5 as fallback (changeable on the AI agents card), effort medium, 10 runs a day, 4,000 output
tokens, the system prompt cached.

- **What the model gets** (`core/whatsapp/aiBrief.ts`, built by the API in `whatsapp/aiRequests.ts`): the
  message's purpose and rule (MARKETING / UTILITY), the fields it may use with what they mean and how to write
  them (a fallback in the language), the link the button opens, today's platform SMS/email wording of that
  message (the variant WhatsApp can carry best — fewest fields a template can't have, so "Checkout
  instructions" B without the late check-out offer only some venues make; links taken out; a sentence that
  held another field left out whole; a text with contact data left out entirely and counted), the other
  templates' bodies, the English template (translation), Meta's reason (fix) and, for a service message, the
  words Meta reads as promotion (`avoidWords`). No personal data; the privacy scan still runs. The prompt
  states the field rules the checks enforce (real words between two fields, three words of its own per field,
  defaults in the language). The **local part** (never sent: the check context as the API saw it, the
  target template and its version) travels on the run as `input.local` (at most 200 KB).
- **The answer** `{reasoning, language, body, buttonText, category, categoryReason}`: our code adds the footer
  (the STOP line, marketing only), the button (`${VISITOR_BASE_URL}/{{1}}`) and the examples. Rejected (nothing
  written, one log row) when a template check T01–T22 fails or a writer check: WW01 category ≠ the message's
  rule · WW02 language (as declared and as its own words read; German "ss", never "ß") · WW05 contact data ·
  WW06 promotion in a service message · WW07 the same text as another template of the message, as the one it
  fixes (text and button) or as the English one it translates · WW08 any warning, for the daily gap-fill and
  the AI fixes (Auto, W2b, never sends one) · WW09 no button text where the message's link needs one · WW10 a
  number, price or percentage the brief doesn't give (in the text, a default or the button: a made-up
  discount, fee or time would reach every venue's guests) · WW11 a default left as "…" or a first-name default
  in another language (Meta never sees defaults). A fix must target the language asked for (`other_language`);
  an English template filed under another category than the message's rule is never a translation source (all
  languages of a name share one category).
- **Applied once** (new in `brain/run.ts`, for any job with an `apply`): an `ok` run is finished with
  `apply: {state: 'pending'}`; then `store/agents.ts` `applyRunOnce` runs the job's `apply` and stamps
  `apply {state: applied | superseded | failed, code, detail, ref, at}` in **one transaction** — a run already
  stamped is never applied again. The writer's apply reads first (the message's templates, the ops doc), checks
  the answer is still wanted, then writes the draft (`origin: 'ai'`, `ai {runId, kind, requestedBy, model,
  promptVersion, reasoning, categoryReason, appliedVersion, fixes}`, `useEnabled: true`), its log row and
  clears the cell's pending mark. A conflict (the language appeared, no free name, the template was edited, not
  editable, at the fix limit, the cell filled for the gap-fill) is `superseded` with an `ai.superseded` row —
  never a retry. A run another attempt closed, or whose record couldn't be finished, is never applied.
- **Recovery:** a throw from the apply (a passing Firestore error) fails the task; its next attempt finds the
  finished run and applies the **stored answer** (checked against the schema again; one that doesn't read is
  `failed / bad_stored_answer`) without calling the model, and ends `skipped / applied_earlier`. A dead task's
  answer is applied by the worker's sweep (with the abandoned-run sweep, every 10 minutes) once it is 15 minutes
  old; after 7 days it is stamped `failed / apply_gave_up` with an `agent_failing` alert. A stored answer is
  gated again before it is applied: when its agent or the AI switch was turned off meanwhile it is stamped
  `superseded` with the gate's reason and never written. `finishRun` carries a nonce (as `startRun` does), so
  a transaction the SDK replays after a late commit knows its own finish.
- **Before the model** (`precheck`, new): the writer re-reads the registry; a run no longer needed (the cell
  filled, the template edited since, …) is skipped with **no run record** and one routine `ai.skipped` row.
  `report` (new): every run that wasn't applied — rejected, failed, skipped, stopped by a deploy mid-call, left
  running by a crash (closed by the next attempt or the abandoned-run sweep), a stored answer that couldn't be
  used — writes one log row and clears its own pending mark; quiet skips (another attempt has it, the worker is
  stopping before the call) write nothing.
- **Gates** (`brain/gate.ts`): a `manual` run (Suggest) needs the AI switch but not the agent's own switch;
  `waitsOnSendingPause` (opt-in, new reason `sending_paused`) makes a job's scheduled runs wait on the pause —
  the writer doesn't opt in.
- **Triggers:** "Suggest with AI" (`POST /admin/whatsapp/suggest`, trigger `manual`); the **daily gap-fill**
  (the template tick, right after a complete sync, once a UTC day, trigger `schedule`): needs the AI switch, the
  writer's Scheduled runs and budget; every available message × language with nothing approved, in review, being
  sent or waiting — English (`new`) first, a translation once the English is approved or in review; a cell with
  a run on its way, rejected 3 runs in a row (7 days off) or rejected/dismissed within 30 days is skipped; at most
  the writer's runs left today minus 3 (kept for Suggest), 3 minutes apart. The day is stamped once something was
  queued or nothing was missing. An error in it is logged (`ai.error`) and keeps none of W1's alerts back.
- **One run per cell:** the task and the cell's pending mark (`AdaptiveConfig/whatsapp.aiPending`) are written
  in one transaction — a second click is refused (409 `pending`), never a second task. A mark counts only while
  its task is queued or held by a worker (so a run that ended in any way, even without a word, never leaves its
  cell "writing"), and a run clears only its own mark. Runs queued count against the writer's runs today (the
  overview's `ai.queued`; Suggest is refused with `daily_limit` once queued + run reach the limit). The
  gap-fill's counters live in `aiGapFill {lastDay, cooldowns, rejects}` on the same doc.
- **The run log** shows `apply` on each line; the WhatsApp activity log has `ai.requested`,
  `ai.request_refused`, `ai.draft_written`, `ai.fix_written`, `ai.superseded`, `ai.skipped`, `ai.rejected`,
  `ai.failed`, `ai.gap_fill`, `ai.error`.
- **Boundaries** (`tests/adaptiveBrainBoundary.test.ts`, `tests/adaptiveWhatsAppBoundary.test.ts`): the brain
  reaches only the pure WhatsApp core and `whatsapp/store.ts` + `whatsapp/aiDrafts.ts` (loaded lazily by the job,
  so the registry stays pure) — never a Meta client, the sync, the submit or the API side; submit, connection and
  hints never reach the brain.
- **No new index:** the sweep reads `apply.state == 'pending'`, the apply reads the message's templates by
  `use.poolKey` — single fields.
- **Local:** turn the AI on (`POST /dev/launch` with `agents`), press Suggest on the WhatsApp tab; the fake
  model writes a valid template that names its message. `POST /dev/model-answer {"agentKey":"wa_template_writer",
  "answers":[{"answer":{…}}]}` makes the next answer what you give (e.g. a wrong category, to see a rejection).

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
| The owner's "Stop marketing to this guest" (PR D) | consent revoked by the owner (`revokedVia: owner`) on every channel at one venue or all their venues; a splash tick can't undo it and START doesn't re-grant it; the owner's Resume gives back only what the guest had said yes to. "All venues" also covers venues the guest visits later (`ownerStoppedAll`). A guest's own STOP over an owner's stop replaces it (Resume can't undo the guest's no); a START texted or a splash yes given while the owner's stop stands is kept (`ownerPrior: granted`) and comes back with the owner's Resume — at every venue, also one opened after "all venues" |

Each hook runs after today's processing and never changes today's reply. Brevo events without an
Adaptive sendKey cost nothing; Twilio statuses are only looked up while an account is not off or sending
is not paused.

## Alerts

Written once to `CaptivePortal_AdaptiveAlerts` (one per venue, reason and day) and emailed:
- to HeidiFi at `AdaptiveConfig/global.alerts.email` (set on the admin launch card, `PUT /admin/launch`) when
  sends are blocked by a setup problem, a daily ceiling is reached, the sign-up breaker trips, or provider
  credentials are refused;
- to the owner (`Users/{tenant}.email`) for a rating of 3★ or less.
- Airbnb stays: to HeidiFi when two or more bookings vanish from a calendar at once
  (`stay_feed_suspect`); to the owner once a day while their calendar link has failed for more
  than 24 h (`stay_feed_failing`), and once per pair of overlapping bookings (`stay_overlap`).

**Sign-up breaker:** more than `safety.maxNewContactsPerApPerHour` (60) new guests at one access point in
an hour → the rest of that hour's new guests start no journeys (they are still recorded). Each access point
and hour has that many places, each taken once by the first new guest's task to claim it, so tasks
running at the same time can't let more through (#97).

## Daily numbers — `CaptivePortal_JourneyStats`

One doc per venue, journey and day: `{venueId}_{journeyKey}_{yyyymmdd}`, the day being when the event
happened in the venue's time zone. `{venueId}__venue_{yyyymmdd}` (journey key `_venue`) holds the venue's
totals over all journeys, plus its visits. No personal data; kept forever. The results route
(`GET /tenants/:t/results`, PR D) reads them by id: "came back" = conversions of journeys whose goal is
a return visit, estimated revenue = that × `AdaptiveVenues.avgSpendPerVisit`, test runs apart.

| Field | Counts (from `CaptivePortal_JourneyEvents`) |
|---|---|
| `entered`, `converted` | guests who started / reached the goal |
| `ended.{status}`, `exited.{reason}` | how journeys ended (`completed`, `exhausted`, `converted`, `suppressed`, `failed`, and `cancelled` for a stay journey whose booking was cancelled — reason `stay_cancelled` — or whose guest the owner unlinked — reason `stay_unlinked`, PR D) and why; a guest the sign-up breaker or a late connect kept out gets `journey.not_started` in the log (for the timeline), not counted |
| `sends.{channel}.{sent,delivered,opened,clicked,bounced,failed,unknown}` | live messages (a message clicked twice counts once) |
| `bySlot.{slot}` / `byVariant.{variantId}` → `{sent, clicked}` | per time slot and wording |
| `credits.{channel}` | credits charged for marketing messages (equals the ledger) |
| `utility.{sends, providerCostMinor}` | service messages (never charged) and their provider cost |
| `skipped.{reason}` | sends skipped or blocked, by the "why" reason |
| `dryRun.{…}` | everything of test-run guests, same shape — a test run never shows in `sends` or `credits` |
| `visits.{total, first, revisits, captures}` (`_venue` only) | visits, first visits, revisits, Wi-Fi sign-ins |
| `stays.{created, changed, cancelled, linked, unlinked, overlapFlagged, momentsSkipped}` (`_venue` only) | Airbnb bookings synced, moved, cancelled, linked to a guest, unlinked by the owner, overlapping, and stay moments skipped (too late or switched off) — counted whatever the mode, never under `dryRun` |
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
- https only (`webcal://` and `http://` are saved as `https://`, and every link in its standard form, so
  `HTTPS://`, an upper-case host or `:443` is the same link), port 443, no `user:pass@`, no IP-literal
  host. Every resolved address must be public — private, loopback, link-local, CGNAT, unique-local,
  cloud-metadata, NAT64, IPv4-mapped and IPv4-compatible ranges are refused — and the socket connects to
  the address that was checked. At most 3 redirects, each checked again; 10 s for the whole chain; 1 MB.
- The link is a secret. It is stored (`url`), only ever shown masked, and never logged; errors
  are codes (`lastError: 'TIMEOUT' | 'LINK_INVALID' | 'HTTP_503' | …`), turned into the owner's words when
  shown.
- **Which events are stays:** Airbnb reservations, and in other feeds (VRBO, PMS) only events whose title
  starts with "Reserved". Booking.com marks bookings and closures alike, so a Booking.com feed (its PRODID,
  or `@booking.com` UIDs / "CLOSED - Not available" events with no "Reserved" one) — or another feed with
  events but no "Reserved" one — is **unsupported** while it has never given a stay: `feedWarning:
  'unsupported_source'`, no stays, not an error. A feed that once gave a stay (`reservedSeen`) stays
  supported whatever it looks like later, so its last booking can still be cancelled; a PMS feed passing
  Booking.com events through keeps its "Reserved" stays. Stored: UID, dates, status — never the calendar's
  text, names or phone digits. Skipped: cancelled or recurring events, events without a UID, stays over 90
  nights — a known stay whose reservation event grows past 90 nights is still seen (kept at the dates it
  had, never missed); a split booking whose merged pieces pass 90 nights keeps its first 90 nights.
- **Times:** check-in and checkout are the dates at Guest info's check-in/checkout time — the first valid
  `HH:MM` between 06:00 and 22:00, English first, then the other languages alphabetically. Without one,
  scheduling uses 15:00 / 10:00, but the wording never prints that: those messages skip as
  `guest_info_missing`.

**The sync** (`stays/sync.ts`, task `stay_poll`)
- Each feed polls on its own fixed 4 h grid (`stay_poll:{feedId}:{slot}`). A save, Sync now
  (`stay_sync:…`, never re-arms) and the worker's watchdog (at start, then hourly) restart a stopped chain
  on the same slot, so a feed has one chain.
- One poll at a time per feed (a lease on the feed). A fetch or parse error is recorded, never thrown:
  `failing` after 3 in a row, and the owner is emailed once a day after 24 h. The count is taken from the
  feed as it is when the error is written, so a save of the same link during a poll's fetch ("try again")
  makes that error the first of a fresh start.
- A new booking → `stay.created`; new dates → `stay.changed` (`datesVersion + 1`); a booking missing →
  a miss. **Two misses at least 30 min apart (engine clock) → cancelled** (`stay.cancelled`). A 304 or the
  same content again still counts (its missing bookings are `lastMissingStayIds`). From checkout day on a
  stay is frozen: never missed, never cancelled — and it leaves the missing list, but the same content
  again doesn't reset a miss it already has (only new content that has it again does).
- **Two or more bookings gone at once** are held for 24 h (`feedWarning: 'mass_missing'`, one HeidiFi
  alert): a wrong link or a cut-off file looks the same. Saving a different link lifts the hold at once. A
  single missing booking always follows the two-miss rule. A booking still in the content is seen (its
  misses reset) also while the hold is on — only the missing ones are held.
- Overlapping bookings (back-to-back is not one) → both `overlap_flagged`, nobody new is linked, the owner
  is emailed. A stay already linked keeps running. A booking missing from the content is on its way out,
  not an overlap (a cancel-and-rebook of the same dates flags nothing) — also on its checkout day, when it
  has left the missing list with a miss on record; it isn't linked either, and — outside the 24 h hold for
  several bookings gone at once — it doesn't count as upcoming.
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
  two of them after a double booking), and the window opens at the latest of their checkouts. The
  outgoing stay of a turnover (another stay not cancelled checks in on its checkout day) is not linked on
  that day (from midnight, venue time), so a next guest or a cleaner connecting before its checkout time
  isn't taken for its guest. The cost: its own guest, if they first connect that day, gets none of its
  moments — the review ask and book-direct offer (on a 1-night stay also Local tips, due that morning),
  and between midnight and about 05:00 also the checkout-eve moments still inside the 12 h grace (the
  Checkout reminder; on a 1-night stay also Stay guide's welcome). A booking
  missing from the calendar's last content (the feed's `lastMissingStayIds`) is never linked. From its
  checkout day absence is no longer a signal (D-C31: some feeds drop a stay that day), so it leaves that
  list — but a booking missed by an earlier poll and not seen since (`missingCount > 0`) still isn't
  linked. The first guest wins; `linkMode` (test/live) is frozen then.
- A guest already linked to a stay here that isn't over is never linked to another. **Known limit:** a
  guest with two back-to-back bookings is linked only to the first; the second runs without them.
- Then each stay journey's moment is scheduled (`stay_trigger:{stayId}:{journey}:{datesVersion}:{moment}`),
  for every stay journey the venue could run: its installs' (a paused playbook, Guest info switched off)
  at their pinned version, and the catalogue's other stay journeys for its type (a playbook turned on
  later) at the published one. Whether it is switched on is checked when the moment comes. Up to 12 h
  late runs at once; later is skipped (`stay.moment_skipped`) — only for a journey the venue has set up,
  and not for a guest who checked out before that install went live.

**At the moment** (`stays/moments.ts`, task `stay_trigger`) everything is checked again: the stay isn't
cancelled (a linked, overlapping one keeps its moments), it is still this guest's and the same dates
version, it's at most 12 h late, launch isn't off (a guest linked in a test run stays one), and the journey
is switched on (a journey the venue has but that is off or paused → `stay.moment_skipped` /
`switched_off`; one it never set up passes quietly). Then a `stay.moment` event starts the journey. Its time is the later of the moment and the
link, so a guest linked after the venue went live still gets the moment that brought them in.
- **Past guests aren't messaged:** a guest who checked out at or before the journey's install went live
  (`checkOutAt <= liveSince`: the activation, or Guest info switched on) gets none of its moments — e.g. the
  stay playbook turned on for the first time after they left: no review ask, no book-direct offer. Checked
  first, from the install that has the journey (on, paused or switched off) when the moment comes — never
  from the task's `installId` (a date change re-stamps it). Recorded once per stay, journey and link as
  `moment.passed` (`reason: 'checked_out_before_live'`), which is not a `stay.*` event and isn't counted
  in the numbers: such a moment is never "missed", also when it comes paused, switched off or late. `liveSince` moves on every activate, so a guest who
  left before an owner turned the running playbook on again loses the post-stay messages still to come
  (fails closed). Guest info only has the Checkout reminder, which comes before checkout, so a wizard save
  can't cut it — a post-checkout Guest info journey would need this rule looked at again.
- **Checkout reminder vs Stay guide:** the Checkout reminder (Guest info) doesn't start when this stay's
  Stay guide covers the guest: 2+ nights, Stay guide on (or switched off within the freeze window before
  the moment, with 15 min to spare for the worker's lag — near the edge both go rather than neither), and its
  instance for this stay active or completed. A late-linked guest, a 1-night stay, or
  a Stay guide paused or switched off earlier gets the reminder.
- A guest linked while the stay playbook is paused, or before it is turned on, gets the moments that come
  once it runs — unless they checked out before it went live (see "Past guests aren't messaged").
- **Known limits:** a moment that comes while the venue is paused starts nothing and is lost (Stay guide's
  welcome passed while paused means no Stay guide for that stay; the Checkout reminder then covers the
  guest); when checkout moves earlier so that Stay guide's "day before checkout, 17:00" has passed, Stay
  guide finishes without checkout instructions and the reminder stays quiet.

**While a stay journey runs** it reads its Stay fresh at every step. `stay.changed` moves a wait anchored
on the stay (a target already past takes `past`; a wait already due whose anchor didn't move just fires,
except a wait an owner's re-link resumed, which is left to its own re-armed timer so the stale rule
judges it). A wait counted from arrival that would end on checkout's local day or later — the stay was
shortened — is `past`: when it is entered, when its `stay.changed` finds it already due, and when its timer
wakes before that event arrived — judged on the day it would go and on the fresh Stay's own target (so Stay
guide's mid-stay message never goes on the day the guest leaves; a journey's own start moment, like Local
tips on day 2 of a 1-night stay, isn't a wait and isn't covered);
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

The owner routes (PR D) mount this service: save, Check link, Sync now, status, delete, and two more:
**unlink** a wrongly linked person (a cleaner who connected first) — their stay messages stop, they are
never linked to that stay again automatically, and the next guest who connects in the window is linked
and gets the remaining messages — and **link by hand** a guest seen at the venue. Each unlink bumps the
Stay's `linkSeq`, which goes into the next link's moment task keys and event ids (`stays/times.ts`
`linkSeqSuffix`), so the new guest's moments never collide with the first guest's. An unlinked person's
stay journeys end as `cancelled` / `stay_unlinked` with their wait kept (the cancel isn't committed if
the owner has linked them back meanwhile). Linking that same person back by hand writes `stay.relinked`
in the link's transaction; the worker (`handleStayRelinked`) then, only while the Stay is still theirs
at that link generation: makes the journeys the unlink ended active again (`journey.resumed`; not a
journey another run took meanwhile), lets each running one hear the re-link (a wait anchored on the
stay is entered again when the dates moved while unlinked), re-arms a kept wait at its own time (a step
long past runs at once and the gate's stale rule decides; a journey unlinked before its first step
starts), and only then schedules the moments of journeys that never started. Until it has finished
(`Stays.relinkPendingSeq` = the link generation; always cleared at its end, also when the booking was
cancelled meanwhile) a connect doesn't schedule that stay's moments and a date change is delivered to
the running journeys but retried for its moments. An auto-link never picks someone the owner
unlinked from that stay. An owner's lift of a stop the guest had no yes behind reads as "no answer"
again everywhere (the gate too), so a later splash tick grants it.

**Known limits** (found in PR C's reviews, parked on purpose):
- **The checkout overlap rule is not airtight.** The Checkout reminder stays quiet when Stay guide still
  sends inside the freeze (with 15 min to spare), but a Stay guide checkout message held past the freeze —
  quiet hours in the guest's phone zone deferring it, or a worker more than 15 min late — is then skipped
  too: neither goes. It needs an owner switch-off in the 45 min before the checkout-eve 17:00 and a far
  phone zone or a late worker. A fix would keep the step's first planned time for the freeze check across
  a quiet-hours or ceiling hold (never `intendedAt` itself: the 6 h stale rule would then skip every
  overnight hold), for service sends only — to be done with or before PR D's Replay.
- **Over-90-night edge cases:** a known stay kept at its old dates after its event grew past 90 nights
  with a later check-in can overlap a new booking in the dates it gave up (a false overlap flag); a split
  booking whose merged pieces pass 90 nights is shortened to its first 90 nights. Both need a booking over
  90 nights, which is unsupported anyway.
- **A wait counted from checkout whose timer wakes before its `stay.changed`:** if checkout moved earlier
  and the worker wakes Stay guide's "day before checkout, 17:00" before the change reaches the journey, it
  still sends (e.g. the booking cut at 16:57 to end that morning, the worker late past 17:00 → the checkout
  message after the guest left); handled in the other order, the wait is `past` and nothing goes. Only
  waits counted from arrival are judged on the fresh Stay at a wake.
- **An early next guest on a turnover day:** a guest first seen at the venue before the previous stay's
  checkout is never linked to the next stay (D-C11), also when nobody was linked to the previous one. If
  the next stay's whole party connects before that checkout, it gets no Stay guide and no Checkout
  reminder. It is no longer taken for the outgoing stay's guest (see "Linking a guest").

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
| `bandit.mode`, `bandit.accounts.<tenantUserId>` | `off` | PR F1: learning (the bandit) |
| `agents.mode`, `agents.accounts.<tenantUserId>` | `off` | PR F2a: scheduled AI agent runs (the admin's Test connection runs either way) |
| `agents.monthlyBudgetUsd` | 100 | PR F2a: the AI budget a month (0, or unreadable = every agent paused) |

- Launch mode only decides which **new** guests start journeys. A guest keeps the mode they started
  with, so a test-run guest never gets a real message.
- Missing or malformed values read as the safe setting: off and paused.
- A change reaches the worker within about 10 s and the login hook within 60 s (both cache it).
  A guest who connects in that window starts with the mode the worker last read.
- Change them on the admin launch card (`GET/PUT /internal/adaptive/admin/launch`, PR D), **never in
  the Firebase console**: the card writes `launch.liveSince` (Start sending depends on it), a
  `history/{n}` copy and keeps `killSwitch.reason` (PR 1's rules parser falls back to the paused seed
  without it). A live account without `liveSince` holds every venue until its owner clicks Start sending.
  Locally, `POST /internal/adaptive/dev/launch` uses the same function.
- Changes that loosen sending (going live, releasing the pause, higher limits, more SMS countries) need
  a typed phrase on the card; pausing, off and test runs are one click, so the brake never fails.
  Going live is refused while no worker runs the same code with the same identity key.

## Start sending (PR D)

Owners who turned a venue on before HeidiFi set their account live saw "nothing is sent until HeidiFi
launches sending". When the account goes live, such a venue **waits for one click on Start sending**
(`POST /tenants/:t/venues/:v/start-sending`, an ADMIN of the account):
- While it waits, the venue acts like launch `off` for new guests — marketing and Guest info alike: the
  login hook writes nothing, the worker records nobody, no journey starts, no stay is linked, no stay
  moment starts. Calendar feeds keep syncing. The owner overview says `needsStartSending: true`.
- "Turned on before" = the venue's never-moving `AdaptiveVenues.firstOnAt` (real time) is earlier than
  the account's `launch.liveSince` (stamped by the admin card each time the account moves into live).
  Either missing → held (fail closed). A venue turned on after its account's current go-live date doesn't
  wait — but a new go-live after a rollback holds again every venue that was never confirmed, including
  ones turned on during the earlier live period (see Rollback).
- After the click only guests from then on start (judged at the connect, the visit's start or the stay
  moment): nobody is backfilled — a guest who checked out before the click gets no stay journey from
  it, as with a playbook turned on after they left (`moment.passed`, reason
  `checked_out_before_start_sending`). The click only works while the account is live, and stays valid
  through a rollback; a venue turned on during an off gap waits for its own click.
- A visit keeps the mode it started in (`Visits.startMode`): a visit that began in a test run ends as a
  test run even when the account went live meanwhile, so a guest from before launch never gets a live
  review ask.
- `sendingLive` in the owner overview now means "this account is live"; `sendingPaused` says whether
  HeidiFi paused sending.

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
   # PR D: the owner's guests list, a guest's timeline and consent ledger, the messages list / credit waits, the dead-task list
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_ContactVenues --query-scope=COLLECTION --field-config=field-path=venueId,order=ascending --field-config=field-path=lastVisitAt,order=descending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyEvents --query-scope=COLLECTION --field-config=field-path=contactId,order=ascending --field-config=field-path=occurredAt,order=descending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_ConsentEvents --query-scope=COLLECTION --field-config=field-path=contactId,order=ascending --field-config=field-path=occurredAt,order=descending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyEvents --query-scope=COLLECTION --field-config=field-path=venueId,order=ascending --field-config=field-path=type,order=ascending --field-config=field-path=occurredAt,order=descending
   gcloud firestore indexes composite create --project=$P --collection-group=CaptivePortal_JourneyTasks --query-scope=COLLECTION --field-config=field-path=status,order=ascending --field-config=field-path=doneAt,order=descending
   ```

   **Create PR D's five before deploying PR D:** the worker probes every query at start (the owner
   screens' ones too) and stays idle while one is missing.

   The other stay lookups (`Stays` by `feedId`, by `venueId` + `contactId`; `StayFeeds` by `status`;
   `JourneyInstances` by `context.stayId` + `status`) are equality-only and use the automatic single-field
   indexes — don't exempt those fields. The worker probes them all. So are PR D's lookups by `contactId`
   (JourneyInstances, JourneySends, Stays, ContactVenues) and `VenuePlaybooks` by `venueId`.

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
   PR D exempts `CaptivePortal_JourneySends` `replay` (the decision's replay inputs, never queried; without
   the exemption every subfield of every send is indexed). PR F1 exempts `CaptivePortal_JourneySends`
   `bandit`, `CaptivePortal_BanditArms` `segments` and `facts`, and `CaptivePortal_JourneyInstances`
   `waiting.variantPick` and `waiting.slotPick` (the picks a held send keeps) the same way (never queried;
   keep `venueId`, `scope`, `journeyKey` and `tenantUserId` indexed — the learner, the admin numbers and the
   cms account delete query them — and the rest of `waiting`: `waiting.creditsShort` is queried), e.g.
   `gcloud firestore indexes fields update bandit --collection-group=CaptivePortal_JourneySends --disable-indexes --project=$P`.
   PR F1 adds no composite index. The TTL entries for `CaptivePortal_AdaptiveAlerts`
   and `signups` are now in the JSON too — for `signups`, check first that no other collection named
   `signups` in the project uses `expireAt`.
   PR F2a adds no composite index. Its one entry is `CaptivePortal_AgentRuns` `expireAt`: a TTL policy (a run's
   `expireAt` is 13 months after it started) with the field's own indexes off (`"indexes": []`, like the other
   TTL fields) — both in the Firebase console (Firestore → TTL policies, and Indexes → Single field → exemption).
   `CaptivePortal_Agents` and `CaptivePortal_AgentUsage` keep no `expireAt`. Don't exempt `AgentUsage`'s
   `byTenant`: the cms account delete finds an account's leftover shares with `byTenant.<account> > 0`.
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

Tasks that fail 8 times become `dead` and are kept 30 days for the admin view (`GET /admin/engine`
`deadTasks`; `POST /admin/tasks/:id/retry` puts one back once, keeping its due time — refused for a
STOP / START / reply / old-style unsubscribe whose guest details are gone, and for logins older than 72 h).
The list names what each dead signal was (`what`), and puts a dead STOP or old-style unsubscribe first
with `urgent: true` (`urgentDeadTasks` counts them): the guest's "no" was never applied, and it can't be. A guest's raw contact
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

Going live again after a rollback moves the account's `liveSince` (PR D): venues confirmed before stay
confirmed. **Every venue never confirmed waits for one Start sending click** — a venue turned on during
the off gap, and also one turned on during the earlier live period that never needed a click (the owner
overview shows `needsStartSending`, the launch card counts them per account). Tell those owners. While a
venue waits, new guests there aren't recorded, and running live journeys there don't see revisits or
offer redemptions.

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
| `POST /internal/adaptive/dev/clock` `{ "advance": "48h" }` or `{ "at": "2026-10-12T13:10:00Z" }` | Moves the fake clock (forward, or to a moment — never earlier than real time: activations are stamped in real time; `{ "reset": true }` goes back to it) |
| `POST /internal/adaptive/dev/launch` `{ "accounts": { "tenant_demo": "test" } }` | Sets launch modes |
| `GET /internal/adaptive/dev/guest-log?email=…` | Shows events, sends and the "why" sentences |
| `POST /internal/adaptive/dev/provider-event` `{ "sendKey", "event": "delivered\|opened\|click\|rating\|stop\|reply…" }` | Fakes a webhook / CMS signal for one send, through the real hook functions |
| `POST /internal/adaptive/dev/rollup` `{ "venueId"? }` | Rolls the daily numbers up now (no 2-min lag) and returns the JourneyStats docs |
| `PUT /internal/adaptive/dev/calendar/:name` `{ "venueId"?, "stays": [{ "checkIn": "today", "checkOut": "5n" }] }` or `{ "ics" }` | Writes the sandbox calendar a `sandbox:calendar/<name>` feed reads (Airbnb-shaped; `today`, `+Nd`, `YYYY-MM-DD`; checkout also `Nn` nights) |
| `GET /internal/adaptive/dev/calendar/:name` | That calendar as `text/calendar` |
| `POST /internal/adaptive/dev/stay-feed` `{ "venueId", "url" }` | Saves the venue's calendar link (the same service as the owner's `PUT …/stay-feed`) |
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
