/**
 * Guards the splash interview script against drifting from the config it describes.
 *
 * Run: npx tsx tests/splashInterview.test.ts
 *
 * The script is static prose that a model follows to conduct an interview, so
 * nothing at runtime will ever notice if it goes stale — a question pointing at a
 * config key that no longer exists just makes the agent quietly ask for something
 * that cannot be set. These assertions are the only thing standing between a
 * renamed config field and a wrong interview.
 *
 * The key list below is deliberately hand-written rather than derived: the point is
 * to fail when the CMS shape changes, which means it has to be a second, independent
 * statement of what the shape is. Source of truth:
 * cms/app/api/captive-portal/_lib/splash-config.js and the two page validators
 * beside it.
 */
import { SPLASH_INTERVIEW, SPLASH_RULES, SPLASH_ASKING_STYLE, interviewPayload } from '../src/mcp/splashInterview';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Every dotted path a question is allowed to target. */
const VALID_KEYS = new Set([
  // top level
  'templateId', 'title', 'subtitle', 'logoUrl', 'showLogo',
  'primaryColor', 'backgroundColor',
  'showMarketingOptIn', 'showPrivacyPolicy', 'showTermsOfService',
  // loginPage
  'loginPage.fields', 'loginPage.buttonText', 'loginPage.customFields',
  // consentPage
  'consentPage.heading', 'consentPage.subheading', 'consentPage.bodyParagraphs',
  'consentPage.acceptButtonText', 'consentPage.declineButtonText',
  // verificationPage
  'verificationPage.enabled', 'verificationPage.channels', 'verificationPage.defaultChannel',
  'verificationPage.allowGuestChoice', 'verificationPage.requirement',
  'verificationPage.rememberDays', 'verificationPage.heading', 'verificationPage.subheading',
  'verificationPage.codeInputLabel', 'verificationPage.sendButtonText',
  'verificationPage.verifyButtonText', 'verificationPage.resendLabel',
  // connectedPage
  'connectedPage.title', 'connectedPage.subtitle',
  'connectedPage.showTitle', 'connectedPage.showSubtitle', 'connectedPage.showLogo',
  'connectedPage.buttonText', 'connectedPage.buttonUrl', 'connectedPage.showButton',
  'connectedPage.autoSubmit', 'connectedPage.customFields',
  'connectedPage.redirectEnabled', 'connectedPage.redirectUrl', 'connectedPage.redirectDelaySeconds',
]);

const BUILT_IN_LOGIN_FIELDS = ['firstName', 'lastName', 'email', 'phone'];
const VERIFICATION_CHANNELS = ['email', 'sms', 'whatsapp'];

console.log('\nstructure');

test('the six steps are present, in the guest journey order', () => {
  const ids = SPLASH_INTERVIEW.map((s) => s.id);
  const expected = ['design', 'login', 'consent', 'verification', 'connected', 'terms'];
  assert(
    JSON.stringify(ids) === JSON.stringify(expected),
    `expected ${expected.join(' -> ')}, got ${ids.join(' -> ')}`,
  );
});

test('every step is usable: title, why, preview page, questions', () => {
  for (const step of SPLASH_INTERVIEW) {
    assert(step.title.length > 0, `${step.id} has no title`);
    assert(step.why.length > 20, `${step.id} needs a real explanation of why it exists`);
    assert(
      ['login', 'consent', 'verify', 'connected'].includes(step.previewPage),
      `${step.id} has an unrenderable previewPage "${step.previewPage}"`,
    );
    assert(step.questions.length > 0, `${step.id} asks nothing`);
  }
});

test('every question has something to ask and a type', () => {
  for (const step of SPLASH_INTERVIEW) {
    for (const q of step.questions) {
      assert(q.ask.trim().length > 10, `${step.id}/${q.key}: "ask" is too short to be a question`);
      assert(q.ask.includes('?'), `${step.id}/${q.key}: "ask" should read as a question`);
      assert(q.type.length > 0, `${step.id}/${q.key} has no type`);
    }
  }
});

console.log('\nthe script matches the config it configures');

test('every question key is a real splash config path', () => {
  const unknown: string[] = [];
  for (const step of SPLASH_INTERVIEW) {
    for (const q of step.questions) {
      if (!VALID_KEYS.has(q.key)) unknown.push(`${step.id}/${q.key}`);
    }
  }
  assert(
    unknown.length === 0,
    `these questions target keys that are not in the splash config: ${unknown.join(', ')}\n    ` +
      'Either the config shape changed (update VALID_KEYS above and the script), or the key is a typo.',
  );
});

test('no key is asked about twice', () => {
  const seen = new Map<string, string>();
  for (const step of SPLASH_INTERVIEW) {
    for (const q of step.questions) {
      const previous = seen.get(q.key);
      assert(!previous, `${q.key} is asked in both "${previous}" and "${step.id}"`);
      seen.set(q.key, step.id);
    }
  }
});

test('the built-in login fields are offered, and nothing invented', () => {
  const q = SPLASH_INTERVIEW.find((s) => s.id === 'login')?.questions
    .find((x) => x.key === 'loginPage.fields');
  assert(q, 'the login step must ask which guest fields to collect');
  assert(
    JSON.stringify(q.options) === JSON.stringify(BUILT_IN_LOGIN_FIELDS),
    `login field options must be exactly ${BUILT_IN_LOGIN_FIELDS.join('/')}, got ${JSON.stringify(q.options)}`,
  );
});

test('the verification channels are exactly the three that exist', () => {
  const step = SPLASH_INTERVIEW.find((s) => s.id === 'verification');
  const channels = step?.questions.find((x) => x.key === 'verificationPage.channels');
  const dflt = step?.questions.find((x) => x.key === 'verificationPage.defaultChannel');
  assert(channels && dflt, 'the verification step must ask about channels and the default');
  assert(
    JSON.stringify(channels.options) === JSON.stringify(VERIFICATION_CHANNELS),
    `channel options must be ${VERIFICATION_CHANNELS.join('/')}, got ${JSON.stringify(channels.options)}`,
  );
  assert(
    JSON.stringify(dflt.options) === JSON.stringify(VERIFICATION_CHANNELS),
    'the default channel must be chosen from the same three',
  );
});

test('requirement offers only any/all', () => {
  const q = SPLASH_INTERVIEW.find((s) => s.id === 'verification')?.questions
    .find((x) => x.key === 'verificationPage.requirement');
  assert(q, 'verification must ask about the requirement mode');
  assert(
    JSON.stringify(q.options) === JSON.stringify(['any', 'all']),
    `requirement must offer any/all, got ${JSON.stringify(q.options)}`,
  );
});

test('every dependsOn points at a key the script actually asks about', () => {
  const asked = new Set(SPLASH_INTERVIEW.flatMap((s) => s.questions.map((q) => q.key)));
  for (const step of SPLASH_INTERVIEW) {
    for (const q of step.questions) {
      if (!q.dependsOn) continue;
      assert(
        asked.has(q.dependsOn),
        `${step.id}/${q.key} depends on "${q.dependsOn}", which is never asked — the model would skip it forever`,
      );
    }
  }
});

test('a dependent question is asked after the switch it depends on', () => {
  for (const step of SPLASH_INTERVIEW) {
    const order = step.questions.map((q) => q.key);
    step.questions.forEach((q, i) => {
      if (!q.dependsOn) return;
      const gate = order.indexOf(q.dependsOn);
      if (gate === -1) return; // asked in another step, covered above
      assert(gate < i, `${step.id}: "${q.key}" is asked before its gate "${q.dependsOn}"`);
    });
  }
});

console.log('\nfields where getting it wrong is expensive');

test('the fields with hard formats say so', () => {
  const notesFor = (key: string) => {
    for (const step of SPLASH_INTERVIEW) {
      const q = step.questions.find((x) => x.key === key);
      if (q) return q.note ?? '';
    }
    return '';
  };

  assert(/hex/i.test(notesFor('primaryColor')), 'primaryColor must warn about the hex format');
  assert(/hex/i.test(notesFor('backgroundColor')), 'backgroundColor must warn about the hex format');
  assert(/b-cdn\.net|upload/i.test(notesFor('logoUrl')), 'logoUrl must explain the CDN restriction');
  assert(/https/i.test(notesFor('connectedPage.buttonUrl')), 'buttonUrl must say https only');
  assert(/https/i.test(notesFor('connectedPage.redirectUrl')), 'redirectUrl must say https only');
});

test('the consent text is flagged as legal text, not copy', () => {
  const q = SPLASH_INTERVIEW.find((s) => s.id === 'consent')?.questions
    .find((x) => x.key === 'consentPage.bodyParagraphs');
  assert(q, 'the consent step must cover the body paragraphs');
  assert(
    /NEVER|never/.test(q.note ?? ''),
    'the paragraphs land verbatim on every guest record — the note must tell the model not to write them',
  );
});

test('verification warns that it forces a login field', () => {
  const step = SPLASH_INTERVIEW.find((s) => s.id === 'verification');
  const text = JSON.stringify(step);
  assert(/mandatory|required/i.test(text), 'the verification step must mention the forced field');
  assert(
    /switches itself off|silently switches/i.test(text),
    'it must mention that zero channels turns verification off',
  );
});

console.log('\nrules and style');

test('the rules cover every invariant that silently corrupts a config', () => {
  const text = SPLASH_RULES.join('\n').toLowerCase();
  const required: Array<[string, RegExp]> = [
    ['full replace, not a patch', /full replace|full_replace/],
    ['warnings must be read', /warnings/],
    ['verification forces login fields', /force-enables|force-requires|forces/],
    ['zero channels turns verification off', /zero enabled channels|turns itself off/],
    ['the CDN-only logo rule', /b-cdn\.net/],
    ['6-digit hex colours', /6-digit hex/],
    ['consent text is legal text', /legal text|verbatim/],
    ['consent can be skipped entirely', /showmarketingoptin/],
    ['no apply without confirmation', /confirmtoken|apply_splash_config/],
    ['config is per venue, not per access point', /per venue/],
  ];
  for (const [what, pattern] of required) {
    assert(pattern.test(text), `SPLASH_RULES is missing: ${what}`);
  }
});

test('the asking style tells the model to interview, not interrogate', () => {
  assert(SPLASH_ASKING_STYLE.length >= 5, 'the style guidance is too thin to change behaviour');
  const text = SPLASH_ASKING_STYLE.join('\n').toLowerCase();
  assert(/one step at a time/.test(text), 'must say to ask one step at a time');
  assert(/default|current/.test(text), 'must say to offer the current value as the easy answer');
  assert(/website/.test(text), 'must cover the "here is my website" case');
});

test('the payload a client receives is complete and ordered', () => {
  const payload = interviewPayload();
  assert(payload.steps.length === 6, 'all six steps should ship');
  assert(payload.rules.length >= 10, 'the rules should ship');
  assert(payload.askingStyle.length >= 5, 'the style guidance should ship');
  assert(payload.workflow.length >= 5, 'the workflow should spell out preview-then-apply');
  const workflow = payload.workflow.join(' ');
  assert(
    workflow.indexOf('preview_splash_config') < workflow.indexOf('apply_splash_config'),
    'the workflow must put preview before apply',
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
