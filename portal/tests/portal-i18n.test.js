/**
 * Tests for the portal's language resolution — the pure half of the splash i18n
 * feature.
 *
 * Run: node tests/portal-i18n.test.js   (from captive-server/portal)
 *
 * config.js and i18n.js are browser scripts with no module system, so they are
 * evaluated in a vm context with a DOM stub thin enough to let the module-level
 * boot path run. Everything asserted here is pure data resolution; the DOM
 * painting is covered by the manual QA matrix in docs/splash-languages.md.
 *
 * The invariants below are the ones that corrupt guest-facing or legal output if
 * they break:
 *   - a translation may change WORDS, never STRUCTURE (which verification
 *     channels are on is a property of the venue's integrations, not of the
 *     language the guest reads)
 *   - consent paragraphs are replaced all-or-nothing, because the rendered array
 *     is persisted verbatim into the guest's ConsentRecord
 *   - translations for languages that are not currently offered are KEPT, so an
 *     admin who unticks a language does not lose the copy they wrote for it
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}

// ── DOM stub ───────────────────────────────────────────────────────────────
// Just enough for config.js's module-level applyPortalConfig/applyView to run
// without throwing. Every query returns null so the paint work is a no-op.
function buildContext(portalConfig, opts) {
  opts = opts || {};
  const noop = () => {};
  const stubEl = () => ({
    style: { cssText: '' },
    dataset: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop,
    getAttribute: () => null,
    appendChild: noop,
    removeChild: noop,
    insertBefore: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener: noop,
    parentNode: { removeChild: noop, insertBefore: noop },
    textContent: '',
    className: 'step',
  });

  const document = {
    documentElement: { style: { setProperty: noop }, classList: { add: noop }, setAttribute: noop },
    body: { classList: { toggle: noop, add: noop, remove: noop }, style: {}, appendChild: noop },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: stubEl,
  };

  const store = {};
  const window = {
    PORTAL_CONFIG: portalConfig,
    PREVIEW_MODE: false,
    location: { search: opts.search || '' },
    navigator: { languages: opts.browserLanguages || ['en-US'] },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    addEventListener: noop,
    matchMedia: () => ({ matches: false }),
  };

  const ctx = vm.createContext({
    window, document, navigator: window.navigator, console,
    URLSearchParams, URL, Object, Array, Math, Number, String, JSON, Date,
    setTimeout, clearTimeout, setInterval, clearInterval, isFinite,
  });
  ctx.window.document = document;
  ctx.__store = store;

  vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'config.js'), 'utf8'), ctx);
  return ctx;
}

function baseConfig(languages) {
  return {
    title: 'Welcome',
    subtitle: 'Sign in',
    loginPage: {
      fields: { firstName: { enabled: true, label: 'First Name', required: true } },
      buttonText: 'Continue',
      customFields: [{ id: 'cf1', type: 'text', label: 'Room', placeholder: '101', enabled: true }],
    },
    consentPage: { heading: 'Privacy', bodyParagraphs: ['EN para one', 'EN para two'] },
    verificationPage: { enabled: true, channels: { email: { enabled: true } }, heading: 'Verify', rememberDays: 30 },
    connectedPage: { title: 'Online', customFields: [] },
    languages,
  };
}

const FULL_LANGUAGES = {
  enabled: true,
  default: 'en',
  fallback: 'en',
  autoDetect: true,
  available: ['en', 'de', 'fr', 'xx'],
  translations: {
    de: {
      title: 'Willkommen',
      loginPage: {
        buttonText: 'Weiter',
        fields: { firstName: { label: 'Vorname', placeholder: 'Anna' } },
        customFields: { cf1: { label: 'Zimmer' } },
      },
      consentPage: { heading: 'Datenschutz', bodyParagraphs: ['DE Absatz'] },
      verificationPage: { heading: 'Bestätigen', enabled: false, channels: { sms: { enabled: true } } },
    },
    fr: { title: 'Bienvenue' },
    en: { title: 'SHOULD BE DROPPED' },
    it: { title: 'Ciao' },
  },
};

console.log('\nnormalizeLanguages');
{
  const ctx = buildContext(baseConfig(FULL_LANGUAGES));
  const run = (js) => vm.runInContext(js, ctx);
  const langs = run('normalizeLanguages(RAW_CONFIG)');

  test('drops language codes with no catalog', () => {
    assertEqual(langs.available, ['en', 'de', 'fr']);
  });
  test('drops a translation for the default language (the base IS that language)', () => {
    assertEqual('en' in langs.translations, false);
  });
  test('keeps a translation whose language is not currently offered', () => {
    assertEqual('it' in langs.translations, true);
  });
  test('selector enabled when more than one language is offered', () => {
    assertEqual(langs.enabled, true);
  });

  test('selector disabled when only one language is offered', () => {
    const single = buildContext(baseConfig({ enabled: true, default: 'en', available: ['en'] }));
    assertEqual(vm.runInContext('normalizeLanguages(RAW_CONFIG).enabled', single), false);
  });
  test('default is forced into available when the admin left it out', () => {
    const c = buildContext(baseConfig({ enabled: true, default: 'de', available: ['en', 'fr'] }));
    assertEqual(vm.runInContext('normalizeLanguages(RAW_CONFIG).available', c), ['de', 'en', 'fr']);
  });
  test('fallback outside available is repinned to the default', () => {
    const c = buildContext(baseConfig({ enabled: true, default: 'en', fallback: 'it', available: ['en', 'de'] }));
    assertEqual(vm.runInContext('normalizeLanguages(RAW_CONFIG).fallback', c), 'en');
  });
}

console.log('\nresolveLangConfig — words change, structure does not');
{
  const ctx = buildContext(baseConfig(FULL_LANGUAGES));
  const run = (js) => vm.runInContext(js, ctx);
  run("setLanguage('de', { persist: false })");

  test('translated title', () => assertEqual(run('CONFIG.title'), 'Willkommen'));
  test('untranslated subtitle falls back to the base config', () => {
    assertEqual(run('CONFIG.subtitle'), 'Sign in');
  });
  test('translated button text', () => assertEqual(run('CONFIG.loginPage.buttonText'), 'Weiter'));
  test('translated built-in field label', () => {
    assertEqual(run('CONFIG.loginPage.fields.firstName.label'), 'Vorname');
  });
  test('translated built-in field placeholder', () => {
    assertEqual(run('CONFIG.loginPage.fields.firstName.placeholder'), 'Anna');
  });
  test('custom field translated by id, not by position', () => {
    assertEqual(run('CONFIG.loginPage.customFields[0].label'), 'Zimmer');
  });
  test('custom field keeps its base placeholder when the overlay omits one', () => {
    assertEqual(run('CONFIG.loginPage.customFields[0].placeholder'), '101');
  });
  test('consent paragraphs are replaced as a whole set', () => {
    assertEqual(run('CONFIG.consentPage.bodyParagraphs'), ['DE Absatz']);
  });
  test('verification COPY is translated', () => {
    assertEqual(run('CONFIG.verificationPage.heading'), 'Bestätigen');
  });
  test('verification `enabled` cannot be overridden by a translation', () => {
    assertEqual(run('CONFIG.verificationPage.enabled'), true);
  });
  test('verification `channels` cannot be overridden by a translation', () => {
    assertEqual(run('CONFIG.verificationPage.channels'), { email: { enabled: true } });
  });
}

console.log('\nBuilt-in defaults follow the active language');
{
  const ctx = buildContext(baseConfig(FULL_LANGUAGES));
  const run = (js) => vm.runInContext(js, ctx);

  run("setLanguage('de', { persist: false })");
  test('uncustomised connected title uses the German default', () => {
    assertEqual(run('CONNECTED_DEFAULTS.title'), 'Sie sind verbunden!');
  });
  test('uncustomised verify copy uses the German default', () => {
    assertEqual(run('VERIFY_DEFAULTS.sendButtonText'), 'Code senden');
  });

  run("setLanguage('en', { persist: false })");
  test('English defaults are the untouched originals', () => {
    assertEqual(run('CONNECTED_DEFAULTS.title'), "You're Connected!");
  });
  test('switching back to the default restores base text', () => {
    assertEqual(run('CONFIG.title'), 'Welcome');
  });
  test('switching back restores base consent paragraphs', () => {
    assertEqual(run('CONFIG.consentPage.bodyParagraphs'), ['EN para one', 'EN para two']);
  });
}

console.log('\nFallback chain: selected → fallback → base');
{
  const cfg = baseConfig({
    enabled: true,
    default: 'en',
    fallback: 'de',
    available: ['en', 'de', 'fr'],
    translations: {
      de: { title: 'Willkommen', subtitle: 'DE Untertitel' },
      fr: { title: 'Bienvenue' },
    },
  });
  const ctx = buildContext(cfg);
  const run = (js) => vm.runInContext(js, ctx);
  run("setLanguage('fr', { persist: false })");

  test('selected language wins over the fallback', () => assertEqual(run('CONFIG.title'), 'Bienvenue'));
  test('fallback language fills a gap the selected language left', () => {
    assertEqual(run('CONFIG.subtitle'), 'DE Untertitel');
  });
}

console.log('\nInitial language pick');
{
  test('browser preference is matched on its base tag (de-CH → de)', () => {
    const ctx = buildContext(baseConfig(FULL_LANGUAGES), { browserLanguages: ['de-CH', 'de'] });
    assertEqual(vm.runInContext('pickInitialLanguage(RAW_CONFIG)', ctx), 'de');
  });
  test('browser preference is ignored when autoDetect is off', () => {
    const cfg = baseConfig(Object.assign({}, FULL_LANGUAGES, { autoDetect: false }));
    const ctx = buildContext(cfg, { browserLanguages: ['de-CH'] });
    assertEqual(vm.runInContext('pickInitialLanguage(RAW_CONFIG)', ctx), 'en');
  });
  test('?lang= is honoured', () => {
    const ctx = buildContext(baseConfig(FULL_LANGUAGES), { search: '?lang=fr', browserLanguages: ['en'] });
    assertEqual(vm.runInContext('pickInitialLanguage(RAW_CONFIG)', ctx), 'fr');
  });
  test('server-pinned lang outranks everything (the Aruba /submit re-render)', () => {
    const cfg = Object.assign(baseConfig(FULL_LANGUAGES), { lang: 'de' });
    const ctx = buildContext(cfg, { search: '?lang=fr', browserLanguages: ['fr'] });
    assertEqual(vm.runInContext('pickInitialLanguage(RAW_CONFIG)', ctx), 'de');
  });
  test('a language the venue no longer offers is ignored', () => {
    const ctx = buildContext(baseConfig(FULL_LANGUAGES), { search: '?lang=it', browserLanguages: ['en'] });
    assertEqual(vm.runInContext('pickInitialLanguage(RAW_CONFIG)', ctx), 'en');
  });
  test('setLanguage coerces an unavailable language to the default', () => {
    const ctx = buildContext(baseConfig(FULL_LANGUAGES));
    assertEqual(vm.runInContext("setLanguage('it', { persist: false })", ctx), 'en');
  });
}

console.log('\nCatalog');
{
  const ctx = buildContext(baseConfig(FULL_LANGUAGES));
  const run = (js) => vm.runInContext(js, ctx);

  // A key present in `en` but missing in `de` silently renders English inside an
  // otherwise German page — the failure mode is invisible in code review and
  // only shows up in front of a guest, so it is asserted structurally.
  test('every language defines exactly the same key set as English', () => {
    const source = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf8');
    const keysFor = (code) => {
      const start = source.indexOf(`\n    ${code}: {`);
      if (start === -1) throw new Error(`no catalog block for ${code}`);
      const end = source.indexOf('\n    },', start);
      const block = source.slice(start, end);
      return new Set(Array.from(block.matchAll(/^ {6}'([^']+)':/gm), (m) => m[1]));
    };
    const en = keysFor('en');
    ['de', 'it', 'fr'].forEach((code) => {
      const other = keysFor(code);
      const missing = [...en].filter((k) => !other.has(k));
      const extra = [...other].filter((k) => !en.has(k));
      if (missing.length) throw new Error(`${code} is missing: ${missing.join(', ')}`);
      if (extra.length) throw new Error(`${code} has keys English does not: ${extra.join(', ')}`);
    });
  });

  test('unknown key returns the key so QA can see the gap', () => {
    assertEqual(run("window.HF_I18N.t('nope.not.a.key')"), 'nope.not.a.key');
  });
  test('unknown language normalizes to English', () => {
    assertEqual(run("window.HF_I18N.normalize('zz')"), 'en');
  });
  test('plural: one', () => {
    run("window.HF_I18N.setLang('de')");
    assertEqual(run("window.HF_I18N.plural('verify.attemptsLeft', 1)"), 'Noch 1 Versuch.');
  });
  test('plural: other', () => {
    assertEqual(run("window.HF_I18N.plural('verify.attemptsLeft', 3)"), 'Noch 3 Versuche.');
  });
  test('interpolation fills positional placeholders', () => {
    run("window.HF_I18N.setLang('en')");
    assertEqual(run("window.HF_I18N.t('connected.redirectNote', 'example.com', 5)"),
      'Redirects to example.com after 5s');
  });
}

console.log('\nPreview mode never persists a language choice');
{
  const ctx = buildContext(baseConfig(FULL_LANGUAGES));
  vm.runInContext('window.PREVIEW_MODE = true;', ctx);
  vm.runInContext("setLanguage('de');", ctx);
  test('localStorage untouched in preview', () => {
    assertEqual(Object.keys(ctx.__store).length, 0);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
