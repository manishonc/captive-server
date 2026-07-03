// ── 0. Portal branding config (injected server-side; fallback for direct loads) ──
var CONNECTED_DEFAULTS = {
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
};

var CONFIG = (typeof window.PORTAL_CONFIG !== 'undefined') ? window.PORTAL_CONFIG : {
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
  connectedPage: CONNECTED_DEFAULTS,
};

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

  // Conditional fields
  if (!cfg.collectName) {
    ['firstName', 'lastName'].forEach(function(id) {
      var el = document.getElementById(id);
      var fg = el && el.closest('.field-group');
      if (fg) fg.style.display = 'none';
    });
  }
  if (!cfg.collectEmail) {
    var emailEl = document.getElementById('email');
    var emailFg = emailEl && emailEl.closest('.field-group');
    if (emailFg) emailFg.style.display = 'none';
  }

  // Footer links
  if (!cfg.showPrivacyPolicy) {
    var pl = document.getElementById('privacyLink');
    if (pl) pl.style.display = 'none';
  }
  if (!cfg.showTermsOfService) {
    var tl = document.getElementById('termsLink');
    if (tl) tl.style.display = 'none';
  }
}

// Apply immediately (synchronous, no flash)
applyPortalConfig(CONFIG);

// Connected view (GET /success): same template file, but the login form is
// swapped for a success card built from the template's own building blocks.
if (CONFIG.view === 'connected') renderConnectedView(CONFIG);

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
  };
}

var _connAutoSaveTimer = null;

function renderConnectedView(cfg) {
  var step1 = document.getElementById('step1');
  if (!step1) return;
  var page = normalizeConnectedPage(cfg.connectedPage);

  // Live preview rebuilds the card on every config push
  var previous = document.getElementById('stepConnected');
  if (previous) previous.parentNode.removeChild(previous);

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

  // Destination link: an anchor with target=_blank is what pops the macOS CNA
  // into the real browser.
  var destBtn = null;
  if (page.showButton) {
    destBtn = document.createElement('a');
    destBtn.className = btnClass;
    destBtn.id = 'connectedBtn';
    destBtn.href = page.buttonUrl;
    destBtn.target = '_blank';
    destBtn.rel = 'noopener';
    destBtn.style.display = 'block';
    destBtn.style.textAlign = 'center';
    destBtn.style.textDecoration = 'none';
    destBtn.style.boxSizing = 'border-box';
    destBtn.style.marginTop = '16px';
    destBtn.textContent = page.buttonText;
    card.appendChild(destBtn);
  }

  if (page.customFields.length) {
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
      var group = document.createElement('div');
      group.className = fieldGroupClass;
      var labelText = field.label + (field.required && !page.autoSubmit ? ' *' : '');

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
        if (page.autoSubmit) box.addEventListener('change', autoSave);
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
        if (page.autoSubmit) {
          input.addEventListener('input', autoSaveDebounced);
          input.addEventListener('blur', autoSave);
        }
        group.appendChild(fieldLabel);
        group.appendChild(input);
      }
      wrap.appendChild(group);
    });

    // Auto-save mode stores on every interaction — no Submit button needed.
    if (!page.autoSubmit) {
      var submitBtn = document.createElement('button');
      submitBtn.className = btnClass;
      submitBtn.id = 'connectedSubmit';
      submitBtn.type = 'button';
      submitBtn.textContent = 'Submit';
      submitBtn.addEventListener('click', function () { submitConnectedForm(false); });
      wrap.appendChild(submitBtn);
    }

    card.appendChild(wrap);

    var thanks = document.createElement('p');
    thanks.className = 'section-sub';
    thanks.id = 'connectedThanks';
    thanks.style.display = 'none';
    thanks.style.marginTop = '18px';
    thanks.textContent = 'Thanks! Your response has been saved.';
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

  // iOS CNA never opens links on its own — auto-fire the destination like the
  // old static page did, but only when there is nothing to fill in first.
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  if (isIOS && destBtn) {
    destBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var w = window.open(page.buttonUrl, '_blank');
      if (!w) window.location.href = page.buttonUrl;
    });
    if (!window.PREVIEW_MODE && !page.customFields.length) {
      window.addEventListener('load', function () {
        setTimeout(function () {
          var w = window.open(page.buttonUrl, '_blank');
          if (!w) { window.location.href = page.buttonUrl; }
          // Poke Apple's detect URL to trigger CNA dismissal
          setTimeout(function () {
            window.location.href = 'http://captive.apple.com/hotspot-detect.html';
          }, 600);
        }, 500);
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
      errEl.textContent = 'Please fill in: ' + missing;
      errEl.style.display = 'block';
    }
    return;
  }
  if (errEl) errEl.style.display = 'none';

  var showSaved = function () {
    if (!thanks) return;
    if (auto) {
      thanks.textContent = 'Saved';
      thanks.style.display = 'block';
      clearTimeout(_connThanksTimer);
      _connThanksTimer = setTimeout(function () { thanks.style.display = 'none'; }, 2000);
    } else {
      wrap.style.display = 'none';
      thanks.textContent = 'Thanks! Your response has been saved.';
      thanks.style.display = 'block';
    }
  };

  if (window.PREVIEW_MODE) {
    showSaved();
    return;
  }

  var btn = document.getElementById('connectedSubmit');
  if (!auto && btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

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
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
    if (errEl) {
      errEl.textContent = 'Could not save your response. Please try again.';
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
    ['title', 'subtitle', 'primaryColor', 'backgroundColor', 'logoUrl', 'showLogo', 'connectedPage'].forEach(function (k) {
      if (d.config[k] !== undefined) CONFIG[k] = d.config[k];
    });
    applyPortalConfig(CONFIG);
    if (CONFIG.view === 'connected') renderConnectedView(CONFIG);
    console.log('[heidifi preview] applied live config from', e.origin);
  });
  console.log('[heidifi preview] live preview listener attached');
}

// DEBUG badge — hidden, remove once pipeline is verified
// var _src = (typeof window.PORTAL_CONFIG !== 'undefined') ? 'firebase' : 'default';
// var _badge = document.getElementById('configDebugBadge');
// _badge.style.cssText = 'font-size:10px;text-align:left;color:#555;margin:0 0 12px;font-family:monospace;background:#f5f5f5;border:1px solid #ddd;border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-all';
// _badge.textContent = '[source: ' + _src + ']\n' + JSON.stringify(CONFIG, null, 2);
