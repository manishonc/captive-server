# Splash multi-language

Guests can read the splash screen in English, German, Italian or French and
switch between them. The language they end up on is stored with them and reused
for the verification code, venue automations and campaigns.

Off by default: a venue that does nothing renders exactly as it did before.

## How resolution works

Three layers, checked in order per field:

1. the language the guest selected
2. the venue's **fallback** language
3. the base config — which **is** the venue's **default** language

So a half-finished translation shows real copy, never blanks. A field the venue
never customised falls through to a built-in default, and those are translated
in `portal/public/js/i18n.js`, so an untouched venue still reads as German to a
German guest.

**A translation may change words, never structure.** Which fields exist, whether
verification is on, which channels it uses, colours and the template are venue
settings shared across every language. The validator drops structural keys from
a translation overlay and reports it as a `structural_key_ignored` warning.

## Where the strings live

| Kind | Where | Who writes it |
|---|---|---|
| Copy the venue wrote (title, labels, consent, buttons) | `languages.translations.<code>` in the splash config | the tenant, in the CMS Languages tab |
| Everything else a guest reads (validation errors, OTP progress, "Redirecting…", doc-modal chrome) | `portal/public/js/i18n.js` CATALOG | us |
| OTP email/SMS body | `server/src/services/otpMessages.ts` OTP_COPY | us |
| Terms / Privacy | `CaptivePortal_Documents.translations.<code>` | the tenant (CMS write path not yet built) |

Adding a language means adding it to **all** of:

- `portal/public/js/i18n.js` — `SUPPORTED` **and** a full CATALOG block
- `portal/server.js` — `SUPPORTED_LANGS`, `CONNECTING_COPY`
- `server/src/services/guestLanguage.ts` — `SUPPORTED_LANGUAGES`
- `cms/app/api/captive-portal/_lib/languages.js` — `SUPPORTED_LANGUAGES`
- `cms/app/components/captive-portal/splash/shared.ts` — `SUPPORTED_LANGUAGES`, `LANGUAGE_META`
- `server/src/services/otpMessages.ts` — `OTP_COPY`

`portal/tests/portal-i18n.test.js` fails if a catalog block is missing keys that
English has, which is the guard against a half-translated page.

## Two things that need a human before going live in a new language

1. **Consent boilerplate.** The `consent.bodyParagraph.*` entries in the de/it/fr
   catalogs are provisional translations of HeidiFi's own default consent text.
   Whatever renders is persisted verbatim into the guest's `ConsentRecord`, so
   they need legal review before a venue enables that language. A venue that
   writes its own consent copy never reaches them.
2. **WhatsApp OTP.** Meta approves AUTHENTICATION templates per locale, and
   sending an unapproved locale is error 132001 — a total channel outage, not a
   wording problem. `OTP_WHATSAPP_APPROVED_LOCALES` in `otpMessages.ts` is
   therefore `['en']` until the translations are approved; a German guest gets an
   English WhatsApp code while email and SMS are already translated. Submit the
   template translation, wait for approval, **then** append the code.

## Manual QA

There is no browser harness for the portal, so these are by hand. Enable at
least two languages on a test venue first.

- switcher appears only when the venue offers ≥2 languages
- switching mid-flow repaints login, consent, verify and connected without
  losing what the guest already typed
- form placeholders translate, not just labels
- the consent text stored on the guest matches the language they were reading
- Terms/Privacy modal fetches per language and falls back cleanly
- Aruba: choose German, submit — the connected card is still German
  (`f_lang` → `?lang=`), and so is `/success`
- opening the CMS preview in German must not change the language for the next
  real guest on that device (preview never writes `localStorage`)
- a language removed from the venue after a guest picked it: the guest falls back
  to the default, and their stored `language` is left alone for targeting

## Marketing in the guest's language

Two separate systems, same model in both: the **base** message is the venue's
default-language copy, and `translations.<code>` overrides only the fields it
defines. A guest whose language has no variant gets the base — which is why a
partly-translated automation or campaign is safe to leave running.

|  | Venue automations | Campaign Manager |
|---|---|---|
| Storage | `CaptivePortal_EntityMarketing/venue_<id>` | `CaptivePortal_Campaigns` |
| Edit | Marketing tab → language pills on each message | Campaign editor → language tabs on each message |
| Target one language | not applicable (fires per guest) | `segment.language` (incl. `unknown`) |
| MCP | read-only (`get_venue_marketing_config`) | `create_campaign` / `update_campaign` |

A variant carries **content only**. `id`, `channel` and `delayMinutes` are
rejected: one message must stay one message across languages, or
`_lib/message-versions.js` treats a language edit as a different message and
per-message analytics stop being attributable. (`translations` is deliberately
not an identity field, so editing a translation correctly mints a new *version*
of the same message.)

Two rules that are easy to get wrong:

- **Every language needs its own unsubscribe link.** The CMS injects one into
  each translated email body; the MCP port rejects a body without one. Different
  mechanism, same guarantee — checking only the base body would let a translated
  email ship without one.
- **WhatsApp variants can only change the locale**, and only to one Meta has
  already approved for that same template. Meta owns the body; an unapproved
  locale is error 132001.

`segment.language` is for when the content genuinely differs per language. If it
is the same message in four languages, write one campaign with four variants —
that keeps the stats in one place.

## Notes

- Country **names** in the phone picker stay English in v1; only the search
  placeholder and "no results" are translated.
- The SMS `Reply STOP to unsubscribe` suffix stays English — STOP is the carrier
  keyword. Unsubscribe pages and email footers are likewise not yet translated.
- Guests captured before this shipped have no `language`. They are the
  `unknown` bucket in audience filters and receive default-language content.
