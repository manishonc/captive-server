/**
 * The guided question script for setting up a venue's splash screen.
 *
 * Why this lives on the SERVER rather than in a client-side skill: the splash tools
 * are shipped as MCP only — no ChatGPT app, no Claude plugin — so there is no
 * bundle of instructions riding alongside them. Anything a model needs to know in
 * order to ask sensible questions has to come back in a tool result. Every client
 * (Claude, ChatGPT, the CMS's own in-app chat) then conducts the same interview.
 *
 * This is static data on purpose. The MCP service has no model access of any kind —
 * no AI key, and MCP elicitation/sampling are not implemented here — so it cannot
 * generate or ask anything itself. It hands the calling model a script; the model
 * does the talking.
 *
 * Step order mirrors the CMS editor's six tabs, which in turn mirror the order a
 * guest meets the pages: design -> login -> consent -> verification -> connected ->
 * terms. Keep them in sync (cms/app/components/captive-portal/AccessPointSplashScreenSection.tsx).
 */

export interface InterviewQuestion {
  /** Dotted path into the splash config this answer sets. */
  key: string;
  /** What to ask the tenant, in plain language. */
  ask: string;
  type: 'enum' | 'text' | 'longtext' | 'hex' | 'boolean' | 'number' | 'url' | 'list' | 'fields';
  /** Where to get the valid values, when they are not fixed. */
  source?: string;
  options?: string[];
  /** Only worth asking when this is true. */
  dependsOn?: string;
  /** A constraint or consequence the model should mention if it matters. */
  note?: string;
}

export interface InterviewStep {
  id: string;
  title: string;
  /** Why this step exists — use it to explain the step to the tenant. */
  why: string;
  /** Which preview URL shows the result of this step. */
  previewPage: 'login' | 'consent' | 'verify' | 'connected';
  /** Skip the whole step when this is false. */
  skipWhen?: string;
  questions: InterviewQuestion[];
}

export const SPLASH_INTERVIEW: InterviewStep[] = [
  {
    id: 'design',
    title: 'Look and feel',
    why: 'Sets the template and the two colours every page inherits. Doing this first means the tenant sees their own branding for the rest of the interview.',
    previewPage: 'login',
    questions: [
      {
        key: 'templateId',
        ask: 'Which design do you want? I can suggest a few that suit your kind of venue, and each one has a link you can open to see it.',
        type: 'enum',
        source: 'list_splash_templates',
        note: 'Every template renders the same fields, so this is purely a visual choice — nothing is lost by picking any of them.',
      },
      {
        key: 'logoUrl',
        ask: 'Shall we use your logo? Here is what you already have uploaded.',
        type: 'url',
        source: 'list_venue_logos',
        note: 'Must be one of the tenant\'s uploaded CDN images. There is no way to import a logo from an arbitrary web address — if none of the uploaded files fit, ask them to upload it under Media in the dashboard, then call list_venue_logos again.',
      },
      { key: 'showLogo', ask: 'Show the logo on the splash pages?', type: 'boolean' },
      {
        key: 'primaryColor',
        ask: 'What is your brand colour? It is used for buttons and accents.',
        type: 'hex',
        note: '6-digit hex only, e.g. #1c2b4a. Shorthand like #abc and alpha values are rejected.',
      },
      {
        key: 'backgroundColor',
        ask: 'And the page background colour?',
        type: 'hex',
        note: 'Same 6-digit hex rule. Check the contrast against the primary colour before suggesting a pair.',
      },
    ],
  },
  {
    id: 'login',
    title: 'The login page',
    why: 'The first thing a guest sees, and the only place guest contact details are captured — whatever is turned off here is data the venue will never have for marketing.',
    previewPage: 'login',
    questions: [
      {
        key: 'title',
        ask: 'What headline should greet guests? Something like "Welcome to <venue>".',
        type: 'text',
        note: 'Up to 100 characters.',
      },
      {
        key: 'subtitle',
        ask: 'And a line under it explaining what to do?',
        type: 'text',
        note: 'Up to 250 characters. An empty string is a valid choice and hides the line.',
      },
      {
        key: 'loginPage.fields',
        ask: 'Which details should guests give you — first name, last name, email, phone? And which of those are mandatory?',
        type: 'fields',
        options: ['firstName', 'lastName', 'email', 'phone'],
        note: 'These four are the only built-in fields. Email is what marketing campaigns need most; phone is shown but optional by default. Anything else has to be a custom field.',
      },
      {
        key: 'loginPage.buttonText',
        ask: 'What should the button say?',
        type: 'text',
        note: 'Up to 40 characters. Defaults to "Continue".',
      },
      {
        key: 'loginPage.customFields',
        ask: 'Anything else you want to ask guests here — a room number, a booking reference?',
        type: 'list',
        note: 'Up to 8, each needing a stable lowercase id, a type of "text" or "checkbox", and a label. Ids are permanent: they key the stored answers, so renaming one orphans the old data.',
      },
    ],
  },
  {
    id: 'consent',
    title: 'The consent page',
    why: 'Where guests opt in to marketing. The paragraphs here are stored verbatim on every guest record as the consent they gave, so this is legal text, not copy.',
    previewPage: 'consent',
    skipWhen: 'showMarketingOptIn === false',
    questions: [
      {
        key: 'showMarketingOptIn',
        ask: 'Do you want to ask guests for marketing consent at all?',
        type: 'boolean',
        note: 'Turning this off skips the entire consent step — guests go straight from the form to being online, and no consent is captured, so marketing campaigns will have no opted-in audience.',
      },
      { key: 'consentPage.heading', ask: 'Heading for the consent step?', type: 'text', dependsOn: 'showMarketingOptIn', note: 'Up to 100 characters.' },
      { key: 'consentPage.subheading', ask: 'A supporting line under it?', type: 'text', dependsOn: 'showMarketingOptIn', note: 'Up to 250 characters; empty hides it.' },
      {
        key: 'consentPage.bodyParagraphs',
        ask: 'Do you have your own consent wording, or shall we keep the standard GDPR text? If you have your own, please paste it exactly.',
        type: 'longtext',
        dependsOn: 'showMarketingOptIn',
        note: 'Up to 4 paragraphs, 1000 characters each. NEVER draft or paraphrase this yourself — it is the legal record of what each guest agreed to. Keep the platform default unless the tenant supplies their own text.',
      },
      { key: 'consentPage.acceptButtonText', ask: 'Label for the accept button?', type: 'text', dependsOn: 'showMarketingOptIn', note: 'Up to 40 characters.' },
      { key: 'consentPage.declineButtonText', ask: 'And for declining?', type: 'text', dependsOn: 'showMarketingOptIn', note: 'Up to 60 characters. Guests who decline still get online — this is consent, not access.' },
    ],
  },
  {
    id: 'verification',
    title: 'Guest verification (one-time code)',
    why: 'An optional wall: guests must confirm an email or phone number with a code before getting online. It raises data quality and blocks junk sign-ups, at the cost of friction and per-message spend.',
    previewPage: 'verify',
    skipWhen: 'verificationPage.enabled === false',
    questions: [
      {
        key: 'verificationPage.enabled',
        ask: 'Do you want guests to confirm their email or phone with a one-time code before they get online? Most venues leave this off.',
        type: 'boolean',
        note: 'Default off, and it should stay off unless the tenant clearly asks for it. Read out the consequences before turning it on: real messages get sent, and the matching login field becomes mandatory.',
      },
      {
        key: 'verificationPage.channels',
        ask: 'How should the code reach them — email, SMS, or WhatsApp?',
        type: 'fields',
        options: ['email', 'sms', 'whatsapp'],
        dependsOn: 'verificationPage.enabled',
        note: 'At least one must be on, or verification silently switches itself off. SMS and WhatsApp both verify the phone number, so enabling both still asks for one number.',
      },
      {
        key: 'verificationPage.defaultChannel',
        ask: 'Which of those should be the default?',
        type: 'enum',
        options: ['email', 'sms', 'whatsapp'],
        dependsOn: 'verificationPage.enabled',
        note: 'Must be one of the enabled channels, otherwise it gets repinned. The default channel\'s login field is forced to mandatory.',
      },
      { key: 'verificationPage.allowGuestChoice', ask: 'Let guests pick which channel they want?', type: 'boolean', dependsOn: 'verificationPage.enabled' },
      {
        key: 'verificationPage.requirement',
        ask: 'Is one confirmed contact enough, or must every enabled channel be verified?',
        type: 'enum',
        options: ['any', 'all'],
        dependsOn: 'verificationPage.enabled',
        note: '"all" makes every targeted login field mandatory, which is a lot of friction. "any" is almost always right.',
      },
      {
        key: 'verificationPage.rememberDays',
        ask: 'How long should a verified guest be remembered before being asked again?',
        type: 'number',
        dependsOn: 'verificationPage.enabled',
        note: '0 to 90 days. 0 means re-verify on every single visit.',
      },
      { key: 'verificationPage.heading', ask: 'Heading for the verification step?', type: 'text', dependsOn: 'verificationPage.enabled', note: 'Up to 100 characters.' },
    ],
  },
  {
    id: 'connected',
    title: 'The connected page',
    why: 'What guests see once they are online. A second chance to point them somewhere useful — a menu, a booking page, a review link.',
    previewPage: 'connected',
    questions: [
      { key: 'connectedPage.title', ask: 'What should the "you are online" page say?', type: 'text', note: 'Up to 100 characters.' },
      { key: 'connectedPage.subtitle', ask: 'And a line under it?', type: 'text', note: 'Up to 250 characters; empty hides it.' },
      {
        key: 'connectedPage.buttonUrl',
        ask: 'Where should the button send guests — your website, menu, or booking page?',
        type: 'url',
        note: 'https only. An invalid URL silently falls back to heidifi.ai, which means every guest of that venue gets sent to us instead of them — worth double-checking.',
      },
      { key: 'connectedPage.buttonText', ask: 'What should that button say?', type: 'text', note: 'Up to 40 characters.' },
      {
        key: 'connectedPage.redirectEnabled',
        ask: 'Or would you rather send guests there automatically, without them tapping anything?',
        type: 'boolean',
        note: 'An automatic redirect takes precedence over connected-page custom fields — those questions will never be answered. Do not enable both.',
      },
      { key: 'connectedPage.redirectUrl', ask: 'Which address should they be sent to?', type: 'url', dependsOn: 'connectedPage.redirectEnabled', note: 'https only. If this is invalid the redirect just never fires, with no error shown.' },
      { key: 'connectedPage.redirectDelaySeconds', ask: 'After how many seconds?', type: 'number', dependsOn: 'connectedPage.redirectEnabled', note: '0 to 30 seconds.' },
      {
        key: 'connectedPage.customFields',
        ask: 'Want to ask guests anything once they are online — a quick rating, or a newsletter tick-box?',
        type: 'list',
        note: 'Up to 8, same id/type/label rules as the login page. This is a good spot for optional questions, since the guest already has internet and nothing is blocking them.',
      },
    ],
  },
  {
    id: 'terms',
    title: 'Terms and privacy links',
    why: 'The footer links on the splash pages. The documents themselves are edited in the dashboard, not through these tools — this step only controls whether the links show.',
    previewPage: 'login',
    questions: [
      { key: 'showPrivacyPolicy', ask: 'Show a privacy policy link in the footer?', type: 'boolean' },
      { key: 'showTermsOfService', ask: 'Show a terms of service link?', type: 'boolean' },
    ],
  },
];

/**
 * Invariants a model will otherwise violate, because nothing in the config's shape
 * hints at them and the API reports none of them as an error.
 */
export const SPLASH_RULES: string[] = [
  'Writes are a FULL REPLACE of every validated key, not a patch. Always start from the config returned by start_splash_setup or get_splash_config, change what you need, and send the whole object back. Omitting a key resets it to its default.',
  'Nothing is ever rejected — invalid values are silently coerced. So the response to preview_splash_config always tells you what actually happened: read `warnings` and repeat anything important to the tenant before applying. An empty `warnings` array is the only proof you got what you asked for.',
  'Turning verification on FORCE-ENABLES and FORCE-REQUIRES the matching login field: email verification requires the email field, SMS and WhatsApp both require the phone field. With requirement "all", every targeted field becomes mandatory. You cannot verify a contact the guest was never asked for.',
  'Verification with zero enabled channels turns ITSELF OFF rather than stranding guests on a screen with nothing to send from. If you meant to enable it, enable a channel too.',
  'logoUrl must be an https URL whose hostname ends in .b-cdn.net. Anything else — including a perfectly good logo on the venue\'s own website — is silently replaced with an empty string, which shows the default HeidiFi logo. There is no import-from-URL path: use list_venue_logos, or ask the tenant to upload the file in the dashboard first.',
  'Colours must be 6-digit hex (#1c2b4a). An invalid colour is neither stored nor reset — the venue\'s existing colour simply stays, so a typo looks like nothing happened.',
  'consentPage.bodyParagraphs is stored verbatim on every guest record as the consent that guest gave. It is legal text. Never write, translate or tidy it yourself — keep the platform default unless the tenant supplies their own wording.',
  'showMarketingOptIn: false skips the whole consent step. No consent is captured, so the venue will have no opted-in audience for campaigns. Say so before setting it.',
  'Never call apply_splash_config in the same turn you called preview_splash_config unless the tenant has already said yes to that exact change. apply requires the confirmToken from the preview, and refuses if the config drifted.',
  'Splash config is per VENUE, not per access point. Every access point at a venue shows the same splash screen, and a change is live for guests the moment it applies.',
  'A guest who declines marketing consent still gets online. Consent is not access — do not describe declining as being cut off.',
];

/** How to run the interview, as opposed to what to ask. */
export const SPLASH_ASKING_STYLE: string[] = [
  'Ask about one step at a time and wait for an answer. Do not dump all six steps, or a bare list of 30 config fields, on the tenant.',
  'Lead with what the venue already has. Read the current config, branding and venue type first, then propose concrete values and ask for confirmation — "I would use your brand navy #1c2b4a and the Coffee Artisan template, does that work?" beats "what colour would you like?".',
  'Offer the current or default value as the easy answer so a tenant can say "that is fine" and move on.',
  'If the tenant only asked for one thing — a new logo, a different headline — do that one thing. Do not walk them through the whole interview uninvited.',
  'If they give you a website instead of details, read it yourself, pull out the colours, tone and wording, and come back with a proposal. These tools cannot fetch a website for you.',
  'Skip the verification step unless it comes up. It is off by default for good reason, and turning it on puts a code wall in front of the venue\'s wifi.',
  'Before applying, show the tenant the diff, anything in `warnings`, and the preview links — then wait for an explicit yes.',
];

/** Everything a client needs to run the interview, in one payload. */
export function interviewPayload() {
  return {
    steps: SPLASH_INTERVIEW,
    rules: SPLASH_RULES,
    askingStyle: SPLASH_ASKING_STYLE,
    workflow: [
      '1. start_splash_setup(venueId) — current config, branding, templates, logos, and this script.',
      '2. Interview the tenant, step by step, proposing values as you go.',
      '3. preview_splash_config(venueId, config) — check `warnings`, then show them the diff and the preview links.',
      '4. Get an explicit yes.',
      '5. apply_splash_config(venueId, config, confirmToken) — live immediately.',
    ],
  };
}
