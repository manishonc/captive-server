// ── 0. Portal branding config (injected server-side; fallback for direct loads) ──
//
// i18n note: the *_DEFAULTS_EN objects below hold the English copy verbatim and
// are never rewritten — they are what a venue sees when it has customised
// nothing, and CONSENT_DEFAULTS_EN in particular must stay byte-identical to the
// templates' .consent-box markup. The live CONNECTED_DEFAULTS/LOGIN_DEFAULTS/
// CONSENT_DEFAULTS/VERIFY_DEFAULTS bindings start as those objects and are
// swapped for catalog-translated copies by refreshLocalizedDefaults() whenever
// the guest's language is not English. Keeping English out of the catalog path
// means a missing i18n.js degrades to exactly today's behaviour.
function t(key) {
  if (!window.HF_I18N) return key;
  return window.HF_I18N.t.apply(window.HF_I18N, arguments);
}

var CONNECTED_DEFAULTS_EN = {
  title: "You're Connected!",
  subtitle: 'You now have internet access.',
  showTitle: true,
  showSubtitle: true,
  showLogo: true,
  buttonText: 'Open heidifi.ai',
  buttonUrl: 'https://heidifi.ai/',
  showButton: true,
  autoSubmit: false,
  customFields: [],
  redirectEnabled: false,
  redirectUrl: '',
  redirectDelaySeconds: 3,
};

var LOGIN_DEFAULTS_EN = {
  fields: {
    firstName: { enabled: true, label: '', required: true },
    lastName:  { enabled: true, label: '', required: true },
    email:     { enabled: true, label: '', required: true },
    // Matches pre-config behavior: phone always shown, never validated.
    phone:     { enabled: true, label: '', required: false },
  },
  buttonText: 'Continue',
  customFields: [],
};

// Must stay byte-identical to the copy baked into the templates' .consent-box
// so default-config venues don't flash mismatched text when JS re-applies it.
var CONSENT_DEFAULTS_EN = {
  heading: 'We care about your privacy',
  subheading: 'Stay in touch with us and find out more about the best offers',
  bodyParagraphs: [
    'I consent to the collection and use of my personal data, provided via WiFi portal registration, by this venue for marketing purposes. I understand that I may withdraw my consent at any time, and that this will not affect the legality of any processing carried out prior to my withdrawal.',
    'I also consent to receiving marketing communications from this venue via email or other electronic means. I understand that I can unsubscribe at any time using the method provided in each communication.',
  ],
  acceptButtonText: 'Accept',
  declineButtonText: "I don't want to stay in touch.",
};

// Live, language-resolved bindings. Start as the English source objects and are
// swapped wholesale by refreshLocalizedDefaults() when the guest picks another
// language — every normalize* function reads these, so nothing downstream needs
// to know a language exists.
var CONNECTED_DEFAULTS = CONNECTED_DEFAULTS_EN;
var LOGIN_DEFAULTS = LOGIN_DEFAULTS_EN;
var CONSENT_DEFAULTS = CONSENT_DEFAULTS_EN;

// RAW_CONFIG is what the server sent, untouched. CONFIG is RAW_CONFIG with the
// active language's translation overlay merged in. Keeping the raw copy is what
// makes switching languages reversible: re-resolving always starts from the
// server's text rather than from text a previous switch already overwrote.
var RAW_CONFIG = (typeof window.PORTAL_CONFIG !== 'undefined') ? window.PORTAL_CONFIG : {
  title: 'Connect to WiFi',
  subtitle: 'Enter your details to get online',
  logoUrl: '',
  showLogo: true,
  primaryColor: '#1c2b4a',
  backgroundColor: '#ffffff',
  collectEmail: true,
  collectName: true,
  showMarketingOptIn: true,
  showPrivacyPolicy: true,
  showTermsOfService: true,
  loginPage: LOGIN_DEFAULTS_EN,
  consentPage: CONSENT_DEFAULTS_EN,
  connectedPage: CONNECTED_DEFAULTS_EN,
};
var CONFIG = RAW_CONFIG;

// ── Language configuration ─────────────────────────────────────────────────
// MIRROR SITE — the `languages` shape must agree with the other six listed in
// the header of cms/app/api/captive-portal/_lib/connected-page.js, plus the
// validator in cms/app/api/captive-portal/_lib/splash-languages.js.
var LANGUAGES_DEFAULTS = {
  enabled: false,
  default: 'en',
  fallback: 'en',
  autoDetect: true,
  available: ['en'],
  translations: {},
};

var LANG_STORAGE_KEY = 'hf_lang';

// Same "trust nothing" rule as normalizeConnectedPage: this also runs on config
// pushed via the preview postMessage, which is not origin-checked by default.
function normalizeLanguages(cfg) {
  var raw = (cfg && cfg.languages && typeof cfg.languages === 'object' && !Array.isArray(cfg.languages))
    ? cfg.languages
    : {};
  var supported = (window.HF_I18N && window.HF_I18N.SUPPORTED) || ['en'];

  function known(code) {
    return typeof code === 'string' && supported.indexOf(code) !== -1;
  }

  var def = known(raw.default) ? raw.default : LANGUAGES_DEFAULTS.default;

  var available = (Array.isArray(raw.available) ? raw.available : [])
    .filter(known)
    .filter(function (code, i, list) { return list.indexOf(code) === i; });
  // The default must always be offerable, or the selector could exclude the very
  // language the base config is written in.
  if (available.indexOf(def) === -1) available.unshift(def);

  var fallback = (known(raw.fallback) && available.indexOf(raw.fallback) !== -1)
    ? raw.fallback
    : def;

  var translations = {};
  var rawTranslations = (raw.translations && typeof raw.translations === 'object' && !Array.isArray(raw.translations))
    ? raw.translations
    : {};
  Object.keys(rawTranslations).forEach(function (code) {
    // Translations for languages that are not currently offered are kept rather
    // than dropped — an admin who temporarily unticks a language must not lose
    // the copy they authored for it. The selector still only shows `available`.
    if (!known(code) || code === def) return;
    var value = rawTranslations[code];
    if (value && typeof value === 'object' && !Array.isArray(value)) translations[code] = value;
  });

  return {
    // A selector with one option is noise — the venue gets its default language
    // and nothing to press.
    enabled: raw.enabled === true && available.length > 1,
    default: def,
    fallback: fallback,
    autoDetect: raw.autoDetect !== false,
    available: available,
    translations: translations,
  };
}

// Merge only the keys a translation is allowed to carry. Structure (which fields
// exist, which channels are on, colours, template) is shared across languages —
// an overlay may restyle words, never behaviour.
function mergeTranslationLayer(target, layer) {
  if (!layer || typeof layer !== 'object') return target;

  function text(value) {
    return (typeof value === 'string' && value.trim()) ? value : null;
  }
  function assignText(dest, src, keys) {
    keys.forEach(function (key) {
      var v = text(src[key]);
      if (v !== null) dest[key] = v;
    });
  }

  var out = Object.assign({}, target);
  assignText(out, layer, ['title', 'subtitle']);

  if (layer.loginPage && typeof layer.loginPage === 'object') {
    var lp = Object.assign({}, out.loginPage);
    assignText(lp, layer.loginPage, ['buttonText']);
    if (layer.loginPage.fields && typeof layer.loginPage.fields === 'object') {
      var fields = Object.assign({}, lp.fields);
      Object.keys(layer.loginPage.fields).forEach(function (id) {
        if (!fields[id]) return;
        var src = layer.loginPage.fields[id] || {};
        var merged = Object.assign({}, fields[id]);
        assignText(merged, src, ['label', 'placeholder']);
        fields[id] = merged;
      });
      lp.fields = fields;
    }
    // Custom fields are keyed BY ID in the overlay, never by position: reordering
    // the base fields must not reassign somebody else's translation.
    if (layer.loginPage.customFields && typeof layer.loginPage.customFields === 'object'
        && Array.isArray(lp.customFields)) {
      var loginOverlay = layer.loginPage.customFields;
      lp.customFields = lp.customFields.map(function (field) {
        var src = field && field.id ? loginOverlay[field.id] : null;
        if (!src || typeof src !== 'object') return field;
        var merged = Object.assign({}, field);
        assignText(merged, src, ['label', 'placeholder']);
        return merged;
      });
    }
    out.loginPage = lp;
  }

  if (layer.consentPage && typeof layer.consentPage === 'object') {
    var cp = Object.assign({}, out.consentPage);
    assignText(cp, layer.consentPage, ['heading', 'subheading', 'acceptButtonText', 'declineButtonText']);
    // All-or-nothing: this array becomes the guest's ConsentRecord, so a
    // half-translated set (one German paragraph, one English) must never render.
    var paragraphs = Array.isArray(layer.consentPage.bodyParagraphs)
      ? layer.consentPage.bodyParagraphs.filter(function (p) { return typeof p === 'string' && p.trim(); })
      : [];
    if (paragraphs.length) cp.bodyParagraphs = paragraphs;
    out.consentPage = cp;
  }

  if (layer.verificationPage && typeof layer.verificationPage === 'object') {
    var vp = Object.assign({}, out.verificationPage);
    // Copy fields ONLY — never `enabled`, `channels`, `requirement` or
    // `rememberDays`. Which channels work is a property of the venue's
    // integrations, not of the language the guest reads.
    assignText(vp, layer.verificationPage, [
      'heading', 'subheading', 'codeInputLabel',
      'sendButtonText', 'verifyButtonText', 'resendLabel',
    ]);
    out.verificationPage = vp;
  }

  if (layer.connectedPage && typeof layer.connectedPage === 'object') {
    var conn = Object.assign({}, out.connectedPage);
    assignText(conn, layer.connectedPage, ['title', 'subtitle', 'buttonText']);
    if (layer.connectedPage.customFields && typeof layer.connectedPage.customFields === 'object'
        && Array.isArray(conn.customFields)) {
      var connOverlay = layer.connectedPage.customFields;
      conn.customFields = conn.customFields.map(function (field) {
        var src = field && field.id ? connOverlay[field.id] : null;
        if (!src || typeof src !== 'object') return field;
        var merged = Object.assign({}, field);
        assignText(merged, src, ['label', 'placeholder']);
        return merged;
      });
    }
    out.connectedPage = conn;
  }

  return out;
}

// Resolution order per field: selected language → fallback language → base
// config (which IS the default language). Applying the fallback layer first and
// the selected layer second gives that precedence for free.
function resolveLangConfig(raw, lang) {
  var langs = normalizeLanguages(raw);
  if (lang === langs.default) return raw;
  var out = raw;
  if (langs.fallback !== langs.default && langs.translations[langs.fallback]) {
    out = mergeTranslationLayer(out, langs.translations[langs.fallback]);
  }
  if (langs.translations[lang]) out = mergeTranslationLayer(out, langs.translations[lang]);
  return out;
}

// Swap the built-in default copy for the active language. Venue-authored text is
// untouched by this — it only changes what an UNCUSTOMISED field falls back to,
// so a German guest at a venue that never edited the consent heading reads a
// German heading instead of an English one.
function refreshLocalizedDefaults(lang) {
  if (lang === 'en' || !window.HF_I18N) {
    CONNECTED_DEFAULTS = CONNECTED_DEFAULTS_EN;
    LOGIN_DEFAULTS = LOGIN_DEFAULTS_EN;
    CONSENT_DEFAULTS = CONSENT_DEFAULTS_EN;
    return;
  }
  CONNECTED_DEFAULTS = Object.assign({}, CONNECTED_DEFAULTS_EN, {
    title: t('connected.title'),
    subtitle: t('connected.subtitle'),
    buttonText: t('connected.buttonText'),
  });
  LOGIN_DEFAULTS = Object.assign({}, LOGIN_DEFAULTS_EN, {
    buttonText: t('login.buttonText'),
  });
  CONSENT_DEFAULTS = Object.assign({}, CONSENT_DEFAULTS_EN, {
    heading: t('consent.heading'),
    subheading: t('consent.subheading'),
    bodyParagraphs: [t('consent.bodyParagraph.0'), t('consent.bodyParagraph.1')],
    acceptButtonText: t('consent.acceptButtonText'),
    declineButtonText: t('consent.declineButtonText'),
  });
  // Declared below this function but hoisted; only ever read at call time.
  VERIFY_DEFAULTS = Object.assign({}, VERIFY_DEFAULTS_EN, {
    heading: t('verify.heading'),
    subheading: t('verify.subheading'),
    codeInputLabel: t('verify.codeInputLabel'),
    sendButtonText: t('verify.sendButtonText'),
    verifyButtonText: t('verify.verifyButtonText'),
    resendLabel: t('verify.resendLabel'),
  });
}

function readStoredLang() {
  try { return window.localStorage.getItem(LANG_STORAGE_KEY); } catch (e) { return null; }
}

function storeLang(code) {
  // Never persist from the CMS editor iframe: the preview shares an origin with
  // the live portal, so writing here would flip the language for the next real
  // guest on that device.
  if (window.PREVIEW_MODE) return;
  try { window.localStorage.setItem(LANG_STORAGE_KEY, code); } catch (e) { /* private mode */ }
}

function queryLang() {
  try { return new URLSearchParams(window.location.search).get('lang'); } catch (e) { return null; }
}

// Priority: an explicit server-side pick (the Aruba /submit re-render carries the
// language the guest chose before the POST) → the guest's own last choice →
// ?lang= → the browser's preference → the venue default.
function pickInitialLanguage(raw) {
  var langs = normalizeLanguages(raw);
  function usable(code) {
    return typeof code === 'string' && langs.available.indexOf(code.trim().toLowerCase()) !== -1;
  }
  if (usable(raw && raw.lang)) return raw.lang.trim().toLowerCase();
  var stored = readStoredLang();
  if (usable(stored)) return stored.trim().toLowerCase();
  var fromQuery = queryLang();
  if (usable(fromQuery)) return fromQuery.trim().toLowerCase();
  if (langs.autoDetect && window.HF_I18N) {
    var prefs = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || ''];
    for (var i = 0; i < prefs.length; i++) {
      // 'de-CH' → 'de': a Swiss-German browser should get German, not the default.
      var base = window.HF_I18N.normalize(prefs[i]);
      if (langs.available.indexOf(base) !== -1) return base;
    }
  }
  return langs.default;
}

var ACTIVE_LANG = 'en';

// Switch language and repaint. Both apply functions are idempotent by design
// (they rebuild #splashFields, #stepVerify and #stepConnected from scratch and
// restore labels from dataset.orig), which is exactly what makes a mid-flow
// switch safe — the guest can be on the consent step and stay there.
function setLanguage(code, opts) {
  opts = opts || {};
  var langs = normalizeLanguages(RAW_CONFIG);
  var next = (typeof code === 'string') ? code.trim().toLowerCase() : '';
  if (langs.available.indexOf(next) === -1) next = langs.default;

  ACTIVE_LANG = next;
  if (window.HF_I18N) window.HF_I18N.setLang(next);
  refreshLocalizedDefaults(next);
  document.documentElement.setAttribute('lang', next);
  if (opts.persist !== false) storeLang(next);

  CONFIG = resolveLangConfig(RAW_CONFIG, next);
  // Preserve the view the page is currently showing — switching language on the
  // connected card must not send the guest back to the login form.
  if (RAW_CONFIG.view !== undefined) CONFIG.view = RAW_CONFIG.view;
  if (opts.repaint === false) return next;

  applyPortalConfig(CONFIG);
  applyView(CONFIG);
  return next;
}

// Guest-facing switcher. Rebuilt on every apply (same contract as #splashFields)
// so the live preview can toggle the whole feature on and off.
function applyLanguageSelector(cfg) {
  var existing = document.getElementById('hfLangSwitch');
  if (existing) existing.parentNode.removeChild(existing);

  var langs = normalizeLanguages(RAW_CONFIG);
  if (!langs.enabled) return;

  var bar = document.createElement('div');
  bar.id = 'hfLangSwitch';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('lang.label'));
  bar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483000;'
    + 'display:flex;gap:2px;padding:3px;border-radius:999px;'
    + 'background:rgba(255,255,255,.82);backdrop-filter:blur(6px);'
    + 'box-shadow:0 1px 4px rgba(0,0,0,.18);font-size:12px;line-height:1';

  langs.available.forEach(function (code) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hf-lang-option';
    btn.setAttribute('data-lang', code);
    var isActive = code === ACTIVE_LANG;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    btn.title = window.HF_I18N ? window.HF_I18N.nativeName(code) : code;
    btn.textContent = code.toUpperCase();
    btn.style.cssText = 'border:0;cursor:pointer;padding:5px 9px;border-radius:999px;'
      + 'font:inherit;font-weight:600;letter-spacing:.02em;'
      + (isActive
        ? 'background:var(--primary,#1c2b4a);color:#fff'
        : 'background:transparent;color:#1c2b4a;opacity:.72');
    btn.addEventListener('click', function () { setLanguage(code); });
    bar.appendChild(btn);
  });

  document.body.appendChild(bar);
}

// Merge a (possibly partial or missing) loginPage with defaults. Old configs
// have no loginPage at all — derive visibility from legacy collectName/collectEmail.
function normalizeLoginPage(cfg) {
  cfg = cfg || {};
  var stored = (cfg.loginPage && typeof cfg.loginPage === 'object' && !Array.isArray(cfg.loginPage))
    ? cfg.loginPage
    : null;

  if (!stored) {
    var collectName = cfg.collectName !== false;
    var collectEmail = cfg.collectEmail !== false;
    return {
      fields: {
        firstName: { enabled: collectName,  label: '', required: collectName },
        lastName:  { enabled: collectName,  label: '', required: collectName },
        email:     { enabled: collectEmail, label: '', required: collectEmail },
        phone:     { enabled: true, label: '', required: false },
      },
      buttonText: LOGIN_DEFAULTS.buttonText,
      customFields: [],
    };
  }

  var storedFields = (stored.fields && typeof stored.fields === 'object') ? stored.fields : {};
  var fields = {};
  Object.keys(LOGIN_DEFAULTS.fields).forEach(function (key) {
    var def = LOGIN_DEFAULTS.fields[key];
    var s = storedFields[key] || {};
    fields[key] = {
      enabled: (s.enabled === undefined) ? def.enabled : s.enabled !== false,
      label: (typeof s.label === 'string') ? s.label : def.label,
      // Only ever set by a translation overlay today — the CMS has no
      // per-field placeholder editor for built-in fields.
      placeholder: (typeof s.placeholder === 'string') ? s.placeholder : '',
      required: (s.required === undefined) ? def.required : s.required === true,
    };
  });
  return {
    fields: fields,
    buttonText: (typeof stored.buttonText === 'string' && stored.buttonText.trim())
      ? stored.buttonText : LOGIN_DEFAULTS.buttonText,
    customFields: (Array.isArray(stored.customFields) ? stored.customFields : []).filter(function (f) {
      return f && f.enabled !== false && f.id && f.label &&
        (f.type === 'checkbox' || f.type === 'text');
    }),
  };
}

function normalizeConsentPage(cfg) {
  cfg = cfg || {};
  var cp = (cfg.consentPage && typeof cfg.consentPage === 'object' && !Array.isArray(cfg.consentPage))
    ? cfg.consentPage
    : {};
  var paragraphs = Array.isArray(cp.bodyParagraphs)
    ? cp.bodyParagraphs.filter(function (p) { return typeof p === 'string' && p.trim(); })
    : [];
  return {
    heading: cp.heading || CONSENT_DEFAULTS.heading,
    subheading: (cp.subheading === undefined || cp.subheading === null)
      ? CONSENT_DEFAULTS.subheading : cp.subheading,
    // Never fall back to empty — this text becomes the guest's ConsentRecord.
    bodyParagraphs: paragraphs.length ? paragraphs : CONSENT_DEFAULTS.bodyParagraphs,
    acceptButtonText: cp.acceptButtonText || CONSENT_DEFAULTS.acceptButtonText,
    declineButtonText: cp.declineButtonText || CONSENT_DEFAULTS.declineButtonText,
  };
}

// Apply branding to the DOM. Safe to call repeatedly (used for live CMS preview).
function applyPortalConfig(cfg) {
  // Colors
  document.documentElement.style.setProperty('--primary', cfg.primaryColor);
  document.body.style.background = cfg.backgroundColor;

  // Logo — class-based control so every template can react consistently:
  //   body.portal-has-logo → reveal/keep the logo (templates style .logo-wrap and
  //     hide their decorative .deco-icon under this class)
  //   body.portal-no-logo  → text-only (logo hidden everywhere)
  // showLogo defaults to true; an empty logoUrl falls back to the default logo
  // already baked into each template's <img src>.
  var showLogo = cfg.showLogo !== false;
  document.body.classList.toggle('portal-has-logo', showLogo);
  document.body.classList.toggle('portal-no-logo', !showLogo);
  if (showLogo && cfg.logoUrl) {
    document.querySelectorAll('.logo-wrap img').forEach(function(el) { el.src = cfg.logoUrl; });
  }

  // Text — template-level headings only. The connected card (#stepConnected)
  // owns its own heading/subtitle; without this scoping the splash title would
  // overwrite the connected card's copy on templates where the card's heading
  // is the first .section-heading in the document.
  var headingEl = document.querySelector('.section-heading');
  if (headingEl && !headingEl.closest('#stepConnected')) headingEl.textContent = cfg.title;
  var subEl = document.querySelector('.section-sub');
  if (subEl && !subEl.closest('#stepConnected')) subEl.textContent = cfg.subtitle;

  // Login-form fields + consent-step copy (both no-ops on missing elements)
  applyLoginPage(cfg);
  applyConsentPage(cfg);
  applyLanguageSelector(cfg);

  // Footer links — set both ways so live preview toggles can re-show them
  // The country-search placeholder is baked into all 33 templates; translating
  // it here beats editing every one of them. Country NAMES stay English in v1 —
  // 51 names x 3 languages buys little when the search also has to match them.
  var countrySearch = document.getElementById('countrySearch');
  if (countrySearch) countrySearch.setAttribute('placeholder', t('country.search'));

  var pl = document.getElementById('privacyLink');
  if (pl) pl.style.display = (cfg.showPrivacyPolicy === false) ? 'none' : '';
  var tl = document.getElementById('termsLink');
  if (tl) tl.style.display = (cfg.showTermsOfService === false) ? 'none' : '';
}

// Show/hide/relabel the built-in splash fields, set the Continue button text,
// and rebuild the configured custom fields. Idempotent — live preview re-runs
// it on every config push, so everything toggles in BOTH directions.
function applyLoginPage(cfg) {
  var lp = normalizeLoginPage(cfg);

  Object.keys(lp.fields).forEach(function (id) {
    var f = lp.fields[id];
    var el = document.getElementById(id);
    var fg = el && el.closest('.field-group');
    if (!fg) return;
    fg.style.display = f.enabled ? '' : 'none';
    var lbl = fg.querySelector('.field-label');
    if (lbl) {
      // Cache the template's baked-in label so clearing a custom label restores it.
      if (!lbl.dataset.orig) lbl.dataset.orig = lbl.textContent.trim();
      // Precedence: the venue's own label (already language-resolved by
      // resolveLangConfig) → the catalog's translation of the built-in label →
      // the template's English markup. The catalog rung is what stops a German
      // guest reading "First Name" at a venue that never renamed the field.
      var fallbackLabel = (ACTIVE_LANG === 'en')
        ? lbl.dataset.orig
        : t('field.' + id + '.label');
      lbl.textContent = (f.label || fallbackLabel) + (f.required ? ' *' : '');
    }
    // Placeholders were never config-driven before; they are now, because a
    // translated form with English sample data reads half-finished.
    if (el && el.tagName === 'INPUT') {
      if (el.dataset.origPlaceholder === undefined) {
        el.dataset.origPlaceholder = el.getAttribute('placeholder') || '';
      }
      var fallbackPlaceholder = (ACTIVE_LANG === 'en')
        ? el.dataset.origPlaceholder
        : t('field.' + id + '.placeholder');
      var placeholder = f.placeholder || fallbackPlaceholder;
      if (placeholder) el.setAttribute('placeholder', placeholder);
    }
  });

  var btn = document.getElementById('btnNext');
  if (btn) btn.textContent = lp.buttonText;

  // Custom splash fields — rebuilt fresh each run, inserted before #step1Error
  // (present in every template).
  var existing = document.getElementById('splashFields');
  if (existing) existing.parentNode.removeChild(existing);
  if (!lp.customFields.length) return;
  var errEl = document.getElementById('step1Error');
  if (!errEl) return;

  var sampleGroup = document.querySelector('#step1 .field-group') || document.querySelector('.field-group');
  var fieldGroupClass = sampleGroup ? sampleGroup.className : 'field-group';
  var wrap = document.createElement('div');
  wrap.id = 'splashFields';
  lp.customFields.forEach(function (field) {
    wrap.appendChild(buildCustomFieldGroup(field, fieldGroupClass, {}));
  });
  errEl.parentNode.insertBefore(wrap, errEl);
}

// Replace the consent step's hardcoded copy with the configured text. Paragraphs
// are rebuilt with createElement + textContent — never innerHTML (tenant input).
function applyConsentPage(cfg) {
  var cp = normalizeConsentPage(cfg);
  var heading = document.querySelector('.consent-heading');
  if (heading) heading.textContent = cp.heading;
  var sub = document.querySelector('.consent-sub');
  if (sub) sub.textContent = cp.subheading;
  var box = document.querySelector('.consent-box');
  if (box) {
    while (box.firstChild) box.removeChild(box.firstChild);
    cp.bodyParagraphs.forEach(function (text) {
      var p = document.createElement('p');
      p.textContent = text;
      box.appendChild(p);
    });
  }
  var accept = document.getElementById('btnAccept');
  if (accept && !accept.disabled) accept.textContent = cp.acceptButtonText;
  var decline = document.getElementById('btnDecline');
  if (decline) decline.textContent = cp.declineButtonText;
}

// Shared checkbox/text field builder used by the splash form and the connected
// card. opts: { autoSubmit, onAutoSave, onAutoSaveDebounced } — connected-page
// auto-save wiring only; the splash form passes {}.
function buildCustomFieldGroup(field, fieldGroupClass, opts) {
  opts = opts || {};
  var group = document.createElement('div');
  group.className = fieldGroupClass;
  var labelText = field.label + (field.required && !opts.autoSubmit ? ' *' : '');

  if (field.type === 'checkbox') {
    var checkLabel = document.createElement('label');
    checkLabel.style.display = 'flex';
    checkLabel.style.alignItems = 'center';
    checkLabel.style.gap = '10px';
    checkLabel.style.cursor = 'pointer';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('data-field-id', field.id);
    box.setAttribute('data-field-type', 'checkbox');
    box.setAttribute('data-label', field.label);
    if (field.required) box.setAttribute('data-required', '1');
    box.style.width = '18px';
    box.style.height = '18px';
    box.style.flexShrink = '0';
    box.style.accentColor = 'var(--primary)';
    if (opts.onAutoSave) box.addEventListener('change', opts.onAutoSave);
    var span = document.createElement('span');
    span.textContent = labelText;
    checkLabel.appendChild(box);
    checkLabel.appendChild(span);
    group.appendChild(checkLabel);
  } else {
    var fieldLabel = document.createElement('label');
    fieldLabel.className = 'field-label';
    fieldLabel.textContent = labelText;
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.setAttribute('data-field-id', field.id);
    input.setAttribute('data-field-type', 'text');
    input.setAttribute('data-label', field.label);
    if (field.required) input.setAttribute('data-required', '1');
    if (opts.onAutoSaveDebounced) input.addEventListener('input', opts.onAutoSaveDebounced);
    if (opts.onAutoSave) input.addEventListener('blur', opts.onAutoSave);
    group.appendChild(fieldLabel);
    group.appendChild(input);
  }
  return group;
}

// Switch which step is visible based on CONFIG.view: 'connected' (GET /success),
// 'consent' (CMS preview of step 2), 'verify' (CMS preview of the OTP step), or
// default → the login form. Re-runnable so the CMS live preview can flip views
// without an iframe reload.
function applyView(cfg) {
  if (cfg.view === 'connected') { renderConnectedView(cfg); return; }
  var previous = document.getElementById('stepConnected');
  if (previous) previous.parentNode.removeChild(previous);
  var step1 = document.getElementById('step1');
  var step2 = document.getElementById('step2');
  var stepVerify = document.getElementById('stepVerify');
  if (cfg.view === 'verify') {
    // Preview only — renderVerifyStep is idempotent and rebuilds on every push
    // so copy edits appear live. It sends nothing: PREVIEW_MODE short-circuits
    // the network call, and the backend refuses preview requests regardless.
    if (step1) step1.classList.add('hidden');
    if (step2) step2.classList.add('hidden');
    renderVerifyStep(cfg, { preview: true });
    return;
  }
  if (stepVerify) stepVerify.classList.add('hidden');
  if (cfg.view === 'consent') {
    if (step1) step1.classList.add('hidden');
    if (step2) step2.classList.remove('hidden');
  } else {
    if (step1) step1.classList.remove('hidden');
    if (step2) step2.classList.add('hidden');
  }
}

// ── Verification step ──────────────────────────────────────────────────────
// MIRROR SITE — the shape below must agree with the other five listed in the
// header of cms/app/api/captive-portal/_lib/connected-page.js.
var VERIFY_DEFAULTS_EN = {
  enabled: false,
  channels: { email: { enabled: true }, sms: { enabled: false }, whatsapp: { enabled: false } },
  defaultChannel: 'email',
  allowGuestChoice: false,
  requirement: 'any',
  heading: 'Verify your details',
  subheading: "We'll send you a code to confirm it's you.",
  codeInputLabel: 'Verification code',
  sendButtonText: 'Send code',
  verifyButtonText: 'Verify',
  resendLabel: 'Resend code',
  rememberDays: 30,
};

var VERIFY_DEFAULTS = VERIFY_DEFAULTS_EN;

// Channel names are brand/protocol nouns — the same in all four languages.
var VERIFY_CHANNEL_LABELS = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

// Same "trust nothing" rule as normalizeConnectedPage: this also runs on config
// pushed via the preview postMessage, which is not origin-checked by default.
function normalizeVerification(vp) {
  vp = vp || {};
  var raw = (vp.channels && typeof vp.channels === 'object') ? vp.channels : {};
  var channels = {};
  ['email', 'sms', 'whatsapp'].forEach(function (k) {
    var c = raw[k];
    channels[k] = {
      enabled: (c && typeof c === 'object' && c.enabled !== undefined)
        ? c.enabled === true
        : VERIFY_DEFAULTS.channels[k].enabled,
    };
  });
  var active = ['email', 'sms', 'whatsapp'].filter(function (k) { return channels[k].enabled; });
  var def = active.indexOf(vp.defaultChannel) !== -1 ? vp.defaultChannel : (active[0] || 'email');
  function str(v, fallback) {
    return (typeof v === 'string' && v.trim()) ? v : fallback;
  }
  return {
    // Never render a step with nothing to send from — that strands the guest.
    enabled: vp.enabled === true && active.length > 0,
    channels: channels,
    activeChannels: active,
    defaultChannel: def,
    allowGuestChoice: vp.allowGuestChoice === true,
    requirement: vp.requirement === 'all' ? 'all' : 'any',
    heading: str(vp.heading, VERIFY_DEFAULTS.heading),
    subheading: (vp.subheading === undefined || vp.subheading === null)
      ? VERIFY_DEFAULTS.subheading : String(vp.subheading),
    codeInputLabel: str(vp.codeInputLabel, VERIFY_DEFAULTS.codeInputLabel),
    sendButtonText: str(vp.sendButtonText, VERIFY_DEFAULTS.sendButtonText),
    verifyButtonText: str(vp.verifyButtonText, VERIFY_DEFAULTS.verifyButtonText),
    resendLabel: str(vp.resendLabel, VERIFY_DEFAULTS.resendLabel),
  };
}

/**
 * Builds #stepVerify from the shared class vocabulary, exactly as
 * renderConnectedView does — see the comment there for why a deterministic
 * rebuild beats cloning #step1. This is also why no template markup changes:
 * all 33 get the step for free.
 */
function renderVerifyStep(cfg, opts) {
  opts = opts || {};
  var step1 = document.getElementById('step1');
  if (!step1) return null;
  var page = normalizeVerification(cfg.verificationPage);

  var previous = document.getElementById('stepVerify');
  if (previous) previous.parentNode.removeChild(previous);

  var card = document.createElement('div');
  card.id = 'stepVerify';
  card.className = (step1.className.replace(/\bhidden\b/g, ' ').replace(/\s+/g, ' ').trim()) || 'step';

  var sampleGroup = document.querySelector('.field-group');
  var fieldGroupClass = sampleGroup ? sampleGroup.className : 'field-group';
  var sampleBtn = document.getElementById('btnNext') || document.querySelector('.btn-primary');
  var btnClass = sampleBtn ? sampleBtn.className : 'btn-primary';

  var heading = document.createElement('h1');
  heading.className = 'section-heading';
  heading.textContent = page.heading;
  card.appendChild(heading);

  var sub = document.createElement('p');
  sub.className = 'section-sub';
  sub.id = 'verifySubheading';
  // The connecting state advances this copy while the guest waits — announce it.
  sub.setAttribute('aria-live', 'polite');
  sub.textContent = page.subheading;
  card.appendChild(sub);

  // Channel picker, only when the tenant lets the guest choose between more
  // than one. A single-channel venue gets no redundant radio group.
  if (page.allowGuestChoice && page.activeChannels.length > 1) {
    var chooser = document.createElement('div');
    chooser.className = fieldGroupClass;
    chooser.id = 'verifyChannelGroup';
    var chooserLabel = document.createElement('label');
    chooserLabel.className = 'field-label';
    chooserLabel.textContent = t('verify.channelPrompt');
    chooser.appendChild(chooserLabel);
    page.activeChannels.forEach(function (channel) {
      var wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:14px;cursor:pointer';
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'verifyChannel';
      radio.value = channel;
      radio.checked = channel === page.defaultChannel;
      radio.setAttribute('data-verify-channel', channel);
      wrap.appendChild(radio);
      wrap.appendChild(document.createTextNode(VERIFY_CHANNEL_LABELS[channel] || channel));
      chooser.appendChild(wrap);
    });
    card.appendChild(chooser);
  }

  var codeGroup = document.createElement('div');
  codeGroup.className = fieldGroupClass;
  var codeLabel = document.createElement('label');
  codeLabel.className = 'field-label';
  codeLabel.setAttribute('for', 'verifyCode');
  codeLabel.textContent = page.codeInputLabel;
  var codeInput = document.createElement('input');
  // NOT type="number": codes are zero-padded, and number inputs strip leading
  // zeros and render spinners. inputmode gives the numeric keypad anyway.
  codeInput.type = 'text';
  codeInput.id = 'verifyCode';
  codeInput.setAttribute('inputmode', 'numeric');
  codeInput.setAttribute('pattern', '[0-9]*');
  codeInput.setAttribute('autocomplete', 'one-time-code');
  codeInput.setAttribute('maxlength', '6');
  codeInput.setAttribute('enterkeyhint', 'go');
  codeInput.setAttribute('autocorrect', 'off');
  codeInput.setAttribute('autocapitalize', 'off');
  codeInput.setAttribute('spellcheck', 'false');
  codeInput.setAttribute('aria-describedby', 'verifyError');
  codeInput.placeholder = '000000';
  codeGroup.appendChild(codeLabel);
  codeGroup.appendChild(codeInput);
  card.appendChild(codeGroup);

  var err = document.createElement('div');
  err.className = 'error-msg';
  err.id = 'verifyError';
  err.setAttribute('role', 'alert');
  err.style.display = 'none';
  card.appendChild(err);

  var submit = document.createElement('button');
  submit.type = 'button';
  submit.id = 'btnVerify';
  submit.className = btnClass;
  // Lets the state painter restore the tenant's own label without threading the
  // config through every call.
  submit.setAttribute('data-idle-label', page.verifyButtonText);
  submit.textContent = page.verifyButtonText;
  card.appendChild(submit);

  var resend = document.createElement('button');
  resend.type = 'button';
  resend.id = 'btnResend';
  resend.className = 'verify-link';
  resend.style.cssText = 'display:block;margin:12px auto 0;background:none;border:0;'
    + 'font-size:13px;text-decoration:underline;cursor:pointer;color:inherit;opacity:.75';
  resend.textContent = page.resendLabel;
  card.appendChild(resend);

  var change = document.createElement('button');
  change.type = 'button';
  change.id = 'btnChangeDestination';
  change.style.cssText = resend.style.cssText;
  change.textContent = t('verify.changeDestination');
  card.appendChild(change);

  if (opts.preview) {
    var note = document.createElement('p');
    note.style.cssText = 'margin:14px 0 0;font-size:12px;opacity:.6;text-align:center';
    note.textContent = t('verify.previewNote');
    card.appendChild(note);
    // Hard-coded sample, never derived from real guest or tenant data.
    sub.textContent = page.subheading + ' (e.g. j•••@example.com)';
    submit.disabled = true;
    resend.disabled = true;
    change.disabled = true;
  }

  step1.parentNode.insertBefore(card, step1);
  return card;
}

// Timer state for the connected view. Declared HERE, above the initial
// applyView() call, not next to renderConnectedView further down: that call runs
// during module execution and reaches renderConnectedView via hoisting, but `var`
// assignments below it have not run yet, so the arrays would still be undefined.
var _connAutoSaveTimer = null;
var _connRedirectTimers = [];

// Apply branding, then switch view: /success injects view:'connected', the CMS
// consent preview injects view:'consent'; everything else shows the login form.
//
// The portal server holds the page behind a boot overlay until we add .hf-ready,
// so that nobody sees the raw template — placeholder copy on /, the login form on
// /success — while this file is still in flight. `finally` is deliberate: if
// renderConnectedView throws (see 6b69970, where it did exactly that, between
// removing the old card and inserting the new one) the guest must still get a
// page. They fall back to the unbranded template, which is the old behaviour,
// rather than being stranded on the spinner.
try {
  // Resolve the language BEFORE the first paint so the guest never sees English
  // copy flip to their own. setLanguage repaints on its own, which is why there
  // is no separate applyPortalConfig call on this path.
  //
  // persist:false — the initial pick may come from the browser's Accept-Language
  // rather than a deliberate choice, and writing that to localStorage would make
  // a guess look like a decision on the next visit. Only a tap on the switcher
  // persists.
  setLanguage(pickInitialLanguage(RAW_CONFIG), { persist: false });
} finally {
  document.documentElement.classList.add('hf-ready');
}

// ── Connected view renderer ────────────────────────────────────────────────
// Clones #step1 and rebuilds it as the "You're connected" card using only the
// class vocabulary every template shares (.step, .section-heading, .section-sub,
// .field-group, .field-label, .btn-primary, .error-msg) so each template's own
// CSS styles it natively — no per-template markup needed.

function _connParam(k) {
  return new URLSearchParams(window.location.search).get(k) || '';
}

function normalizeConnectedPage(cp) {
  cp = cp || {};
  return {
    title: cp.title || CONNECTED_DEFAULTS.title,
    subtitle: (cp.subtitle === undefined || cp.subtitle === null) ? CONNECTED_DEFAULTS.subtitle : cp.subtitle,
    showTitle: cp.showTitle !== false,
    showSubtitle: cp.showSubtitle !== false,
    showLogo: cp.showLogo !== false,
    buttonText: cp.buttonText || CONNECTED_DEFAULTS.buttonText,
    // https-only, mirroring server-side validation — anything else falls back
    buttonUrl: (typeof cp.buttonUrl === 'string' && /^https:\/\//i.test(cp.buttonUrl))
      ? cp.buttonUrl : CONNECTED_DEFAULTS.buttonUrl,
    showButton: cp.showButton !== false,
    autoSubmit: cp.autoSubmit === true,
    customFields: (Array.isArray(cp.customFields) ? cp.customFields : []).filter(function (f) {
      return f && f.enabled !== false && f.id && f.label &&
        (f.type === 'checkbox' || f.type === 'text');
    }),
    // Last line of defence: this also runs on config pushed via preview
    // postMessage, which is not origin-checked by default. Trust nothing.
    redirectEnabled: cp.redirectEnabled === true,
    redirectUrl: (typeof cp.redirectUrl === 'string' && /^https:\/\//i.test(cp.redirectUrl))
      ? cp.redirectUrl : '',
    // Guard the type before Number(): Number(null)/Number('')/Number(false) are
    // all 0, a valid delay meaning "redirect immediately", so an unset value
    // would become the most aggressive setting instead of the default.
    redirectDelaySeconds: (function (v) {
      if (typeof v !== 'number' && typeof v !== 'string') return CONNECTED_DEFAULTS.redirectDelaySeconds;
      if (typeof v === 'string' && v.trim() === '') return CONNECTED_DEFAULTS.redirectDelaySeconds;
      var n = Number(v);
      return isFinite(n) ? Math.min(30, Math.max(0, Math.round(n)))
        : CONNECTED_DEFAULTS.redirectDelaySeconds;
    })(cp.redirectDelaySeconds),
  };
}

// True when the venue wants guests sent to their own site instead of this page.
function isRedirectActive(page) {
  return page.redirectEnabled === true && /^https:\/\//i.test(page.redirectUrl || '');
}

function renderConnectedView(cfg) {
  var step1 = document.getElementById('step1');
  if (!step1) return;
  var page = normalizeConnectedPage(cfg.connectedPage);
  var redirectActive = isRedirectActive(page);

  // Live preview rebuilds the card on every config push
  var previous = document.getElementById('stepConnected');
  if (previous) previous.parentNode.removeChild(previous);

  // Timers outlive the node they were created for, so a preview keystroke storm
  // would otherwise stack dozens of pending navigations and countdown ticks.
  _connRedirectTimers.forEach(clearTimeout);
  _connRedirectTimers = [];

  // Build the card fresh from the shared class vocabulary. Cloning #step1 and
  // stripping it proved fragile: templates differ in whether the heading lives
  // inside the step, and a rebuild would clone the now-hidden step1 (inheriting
  // .hidden). A deterministic build renders identically on every template.
  var card = document.createElement('div');
  card.id = 'stepConnected';
  card.className = (step1.className.replace(/\bhidden\b/g, ' ').replace(/\s+/g, ' ').trim()) || 'step';

  var sampleGroup = document.querySelector('.field-group');
  var fieldGroupClass = sampleGroup ? sampleGroup.className : 'field-group';
  var sampleBtn = document.getElementById('btnNext') || document.querySelector('.btn-primary');
  var btnClass = sampleBtn ? sampleBtn.className : 'btn-primary';

  if (page.showTitle) {
    var heading = document.createElement('h1');
    heading.className = 'section-heading';
    heading.textContent = page.title;
    card.appendChild(heading);
  }
  if (page.showSubtitle && page.subtitle) {
    var sub = document.createElement('p');
    sub.className = 'section-sub';
    sub.textContent = page.subtitle;
    card.appendChild(sub);
  }

  var destTarget = redirectActive ? page.redirectUrl : page.buttonUrl;

  var redirectNote = null;
  if (redirectActive) {
    redirectNote = document.createElement('p');
    redirectNote.className = 'section-sub';
    redirectNote.id = 'connectedRedirectNote';
    card.appendChild(redirectNote);
  }

  // Destination link: an anchor with target=_blank is what pops the macOS CNA
  // into the real browser. In redirect mode it renders even when showButton is
  // off — it is the only user-gesture escape when window.open is popup-blocked,
  // so that flag governs the label rather than the anchor's existence.
  var destBtn = null;
  if (redirectActive || page.showButton) {
    destBtn = document.createElement('a');
    destBtn.className = btnClass;
    destBtn.id = redirectActive ? 'connectedRedirectLink' : 'connectedBtn';
    destBtn.href = destTarget;
    destBtn.target = '_blank';
    destBtn.rel = 'noopener';
    destBtn.style.display = 'block';
    destBtn.style.textAlign = 'center';
    destBtn.style.textDecoration = 'none';
    destBtn.style.boxSizing = 'border-box';
    destBtn.style.marginTop = '16px';
    destBtn.textContent = (redirectActive && !page.showButton) ? t('connected.continue') : page.buttonText;
    card.appendChild(destBtn);
  }

  // Redirect takes precedence over custom fields — guests leave this page before
  // they could answer, so drop the wrapper, Submit, thanks and error nodes together.
  if (!redirectActive && page.customFields.length) {
    var wrap = document.createElement('div');
    wrap.id = 'connectedFields';
    wrap.style.marginTop = '18px';
    wrap.style.textAlign = 'left';

    var autoSave = function () {
      clearTimeout(_connAutoSaveTimer);
      submitConnectedForm(true);
    };
    var autoSaveDebounced = function () {
      clearTimeout(_connAutoSaveTimer);
      _connAutoSaveTimer = setTimeout(function () { submitConnectedForm(true); }, 900);
    };

    page.customFields.forEach(function (field) {
      wrap.appendChild(buildCustomFieldGroup(field, fieldGroupClass, page.autoSubmit ? {
        autoSubmit: true,
        onAutoSave: autoSave,
        onAutoSaveDebounced: autoSaveDebounced,
      } : {}));
    });

    // Auto-save mode stores on every interaction — no Submit button needed.
    if (!page.autoSubmit) {
      var submitBtn = document.createElement('button');
      submitBtn.className = btnClass;
      submitBtn.id = 'connectedSubmit';
      submitBtn.type = 'button';
      submitBtn.textContent = t('connected.submit');
      submitBtn.addEventListener('click', function () { submitConnectedForm(false); });
      wrap.appendChild(submitBtn);
    }

    card.appendChild(wrap);

    var thanks = document.createElement('p');
    thanks.className = 'section-sub';
    thanks.id = 'connectedThanks';
    thanks.style.display = 'none';
    thanks.style.marginTop = '18px';
    thanks.textContent = t('connected.thanks');
    card.appendChild(thanks);

    var errEl = document.createElement('p');
    errEl.className = 'error-msg';
    errEl.id = 'connectedError';
    errEl.style.display = 'none';
    card.appendChild(errEl);
  }

  step1.parentNode.insertBefore(card, step1);
  step1.classList.add('hidden');
  var step2 = document.getElementById('step2');
  if (step2) step2.classList.add('hidden');

  // Connected-page logo toggle rides the same body classes the templates
  // already style for the splash showLogo setting.
  if (!page.showLogo) {
    document.body.classList.remove('portal-has-logo');
    document.body.classList.add('portal-no-logo');
  }

  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || '');

  // window.open is the only thing that escapes the chrome-less CNA sheet into the
  // real browser; window.location keeps the guest trapped inside it with no
  // address bar. dismissCna pokes Apple's detect URL so iOS closes the sheet.
  function openDestination(dismissCna) {
    var w = window.open(destTarget, '_blank');
    if (!w) window.location.href = destTarget;
    if (isIOS && dismissCna) {
      _connRedirectTimers.push(setTimeout(function () {
        window.location.href = 'http://captive.apple.com/hotspot-detect.html';
      }, 600));
    }
  }

  if (redirectActive) {
    var host = page.redirectUrl;
    try { host = new URL(page.redirectUrl).hostname; } catch (e) { /* keep full url */ }

    if (window.PREVIEW_MODE) {
      // Describe the behaviour instead of performing it — the editor iframe must
      // never navigate away, and a countdown that hits zero and does nothing
      // reads as broken.
      redirectNote.textContent = t('connected.redirectNote', host, page.redirectDelaySeconds);
      if (destBtn) destBtn.addEventListener('click', function (e) { e.preventDefault(); });
    } else {
      if (destBtn) {
        destBtn.addEventListener('click', function (e) { e.preventDefault(); openDestination(true); });
      }
      var remaining = page.redirectDelaySeconds;
      var tick = function () {
        redirectNote.textContent = remaining > 0
          ? t('connected.redirectingIn', remaining)
          : t('connected.redirecting');
        if (remaining > 0) {
          remaining -= 1;
          _connRedirectTimers.push(setTimeout(tick, 1000));
        }
      };
      tick();
      // Floor so a 0s setting still paints the card before navigating away.
      var delayMs = Math.max(300, page.redirectDelaySeconds * 1000);
      window.addEventListener('load', function () {
        _connRedirectTimers.push(setTimeout(function () { openDestination(true); }, delayMs));
      });
    }
  } else if (isIOS && destBtn) {
    // iOS CNA never opens links on its own — auto-fire the destination like the
    // old static page did, but only when there is nothing to fill in first.
    destBtn.addEventListener('click', function (e) { e.preventDefault(); openDestination(false); });
    if (!window.PREVIEW_MODE && !page.customFields.length) {
      window.addEventListener('load', function () {
        _connRedirectTimers.push(setTimeout(function () { openDestination(true); }, 500));
      });
    }
  }
}

var _connThanksTimer = null;

// auto=true → fired by an input listener in auto-save mode: no required
// validation, fields stay visible, and a short-lived "Saved" note is shown.
function submitConnectedForm(auto) {
  var wrap = document.getElementById('connectedFields');
  var errEl = document.getElementById('connectedError');
  var thanks = document.getElementById('connectedThanks');
  if (!wrap) return;

  var responses = {};
  var missing = null;
  var inputs = wrap.querySelectorAll('[data-field-id]');
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    var id = input.getAttribute('data-field-id');
    var required = input.getAttribute('data-required') === '1';
    if (input.getAttribute('data-field-type') === 'checkbox') {
      if (required && !input.checked && !missing) missing = input.getAttribute('data-label');
      responses[id] = input.checked;
    } else {
      var value = (input.value || '').trim();
      if (required && !value && !missing) missing = input.getAttribute('data-label');
      responses[id] = value;
    }
  }

  if (!auto && missing) {
    if (errEl) {
      errEl.textContent = t('error.fillIn', missing);
      errEl.style.display = 'block';
    }
    return;
  }
  if (errEl) errEl.style.display = 'none';

  var showSaved = function () {
    if (!thanks) return;
    if (auto) {
      thanks.textContent = t('connected.saved');
      thanks.style.display = 'block';
      clearTimeout(_connThanksTimer);
      _connThanksTimer = setTimeout(function () { thanks.style.display = 'none'; }, 2000);
    } else {
      wrap.style.display = 'none';
      thanks.textContent = t('connected.thanks');
      thanks.style.display = 'block';
    }
  };

  if (window.PREVIEW_MODE) {
    showSaved();
    return;
  }

  var btn = document.getElementById('connectedSubmit');
  if (!auto && btn) { btn.disabled = true; btn.textContent = t('connected.saving'); }

  fetch('/api/connected-form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apmac: _connParam('apmac') || _connParam('ap'),
      mac: _connParam('mac') || _connParam('id'),
      responses: responses,
    }),
  }).then(function (r) {
    if (!r.ok) throw new Error('bad status');
    showSaved();
  }).catch(function () {
    if (auto) return; // silent — next interaction retries
    if (btn) { btn.disabled = false; btn.textContent = t('connected.submit'); }
    if (errEl) {
      errEl.textContent = t('connected.saveFailed');
      errEl.style.display = 'block';
    }
  });
}

// ── Live preview: accept config pushed from the CMS editor (preview mode only) ──
// Gated on PREVIEW_MODE so live guest sessions never accept external messages.
// The payload is display-only (title/subtitle/colors) on a page already flagged
// "PREVIEW MODE" and never shown to real guests, so when no explicit allowlist is
// configured we accept any origin — this prevents the live preview from silently
// breaking when the CMS is served from an unanticipated origin. Set
// window.ALLOWED_CMS_ORIGINS (array) to lock it down.
if (window.PREVIEW_MODE) {
  var ALLOWED_CMS_ORIGINS = window.ALLOWED_CMS_ORIGINS;
  window.addEventListener('message', function (e) {
    if (Array.isArray(ALLOWED_CMS_ORIGINS) && ALLOWED_CMS_ORIGINS.length &&
        ALLOWED_CMS_ORIGINS.indexOf(e.origin) === -1) {
      console.warn('[heidifi preview] ignored message from disallowed origin:', e.origin);
      return;
    }
    var d = e.data;
    if (!d || d.type !== 'heidifi:splash-preview' || !d.config) return;
    // Only fields applyable without a reload; templateId is handled via iframe reload.
    // Pushes land on RAW_CONFIG, not CONFIG: CONFIG is a derived, language-resolved
    // view, so writing to it directly would be overwritten by the next language
    // switch — and the editor's untranslated base text would leak into whichever
    // language happened to be showing.
    ['title', 'subtitle', 'primaryColor', 'backgroundColor', 'logoUrl', 'showLogo',
     'showPrivacyPolicy', 'showTermsOfService',
     'loginPage', 'consentPage', 'verificationPage', 'connectedPage', 'languages',
     'view'].forEach(function (k) {
      if (d.config[k] !== undefined) RAW_CONFIG[k] = d.config[k];
    });
    // `lang` is the editor's "show me this language" control, separate from the
    // stored config. Falls back to the current pick so a push that omits it does
    // not silently reset the preview to the default language.
    setLanguage(d.config.lang || ACTIVE_LANG, { persist: false });
    console.log('[heidifi preview] applied live config from', e.origin);
  });
  console.log('[heidifi preview] live preview listener attached');
}

// DEBUG badge — hidden, remove once pipeline is verified
// var _src = (typeof window.PORTAL_CONFIG !== 'undefined') ? 'firebase' : 'default';
// var _badge = document.getElementById('configDebugBadge');
// _badge.style.cssText = 'font-size:10px;text-align:left;color:#555;margin:0 0 12px;font-family:monospace;background:#f5f5f5;border:1px solid #ddd;border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-all';
// _badge.textContent = '[source: ' + _src + ']\n' + JSON.stringify(CONFIG, null, 2);
