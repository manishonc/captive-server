// ── 1. Vendor params (Aruba: apmac/mac/post — UniFi: ap/id/url/ssid) ───────
var _params = new URLSearchParams(window.location.search);
function param(k) { return _params.get(k) || ''; }
function isUnifi() { return !!param('ap'); }
function clientMac() { return param('mac') || param('id'); }
function apMac() { return param('apmac') || param('ap'); }

// ── 3. Step 1 → Step 2 transition ─────────────────────────────────────────
var FIELD_ERROR_MSGS = {
  firstName: 'Please enter your first name.',
  lastName:  'Please enter your last name.',
  email:     'Please enter a valid email address.',
  phone:     'Please enter your phone number.',
};

function goToConsent() {
  var lp  = normalizeLoginPage(CONFIG);
  var err = document.getElementById('step1Error');

  var ids = ['firstName', 'lastName', 'email', 'phone'];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    var f = lp.fields[id];
    if (!f.enabled || !f.required) continue;
    var value = document.getElementById(id).value.trim();
    var invalid = (id === 'email') ? (!value || !value.includes('@')) : !value;
    if (invalid) { showErr(err, FIELD_ERROR_MSGS[id]); return; }
  }

  // Required custom splash fields
  var wrap = document.getElementById('splashFields');
  if (wrap) {
    var inputs = wrap.querySelectorAll('[data-field-id]');
    for (var j = 0; j < inputs.length; j++) {
      var input = inputs[j];
      if (input.getAttribute('data-required') !== '1') continue;
      var empty = input.getAttribute('data-field-type') === 'checkbox'
        ? !input.checked
        : !(input.value || '').trim();
      if (empty) {
        showErr(err, 'Please fill in: ' + input.getAttribute('data-label'));
        return;
      }
    }
  }
  err.style.display = 'none';

  if (!CONFIG.showMarketingOptIn) {
    submitConsent(false);
    return;
  }

  document.getElementById('step1').classList.add('hidden');
  document.getElementById('step2').classList.remove('hidden');
}

function showErr(el, msg) {
  el.textContent = msg;
  el.style.display = 'block';
}

// Allow Enter key on step 1 inputs to advance
['firstName','lastName','email','phone'].forEach(function(id) {
  document.getElementById(id).addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); goToConsent(); }
  });
});

// ── 4. Consent text ────────────────────────────────────────────────────────
// The ConsentRecord must store the exact copy the guest saw — tenants can
// customize it via consentPage.bodyParagraphs (normalizeConsentPage falls back
// to the platform default when unset).
function getConsentText() {
  return normalizeConsentPage(CONFIG).bodyParagraphs.join('\n\n');
}

// Gather custom splash-field answers as {fieldId: value}; undefined when the
// venue has no splash custom fields so legacy request bodies stay unchanged.
function collectSplashResponses() {
  var wrap = document.getElementById('splashFields');
  if (!wrap) return undefined;
  var inputs = wrap.querySelectorAll('[data-field-id]');
  if (!inputs.length) return undefined;
  var responses = {};
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    var id = input.getAttribute('data-field-id');
    responses[id] = input.getAttribute('data-field-type') === 'checkbox'
      ? input.checked
      : (input.value || '').trim();
  }
  return responses;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// The controller returns 200 as soon as it accepts authorize-guest, but it pushes
// the grant to the AP asynchronously. Redirecting immediately sends the device to
// its captive-detection URL while the AP firewall is still closed, so the OS
// concludes it is still captive and re-opens the splash page. Poll a host outside
// the walled garden — blocked over HTTPS pre-auth, so a rejection means the grant
// has not landed yet — and only redirect once it answers.
async function waitForInternet(timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 1500);
    try {
      await fetch('https://www.gstatic.com/generate_204', {
        mode: 'no-cors', cache: 'no-store', signal: ctl.signal,
      });
      clearTimeout(timer);
      return true;
    } catch (e) {
      clearTimeout(timer);
      await sleep(400);
    }
  }
  return false;
}

// ── 5. Step 2 → Submit ────────────────────────────────────────────────────
async function submitConsent(marketing) {
  if (window.PREVIEW_MODE) {
    var previewQs = new URLSearchParams({ preview: '1' });
    if (apMac()) previewQs.set('apmac', apMac());
    if (param('templateId')) previewQs.set('templateId', param('templateId'));
    window.location.href = '/success?' + previewQs.toString();
    return;
  }

  var btnAccept  = document.getElementById('btnAccept');
  var btnDecline = document.getElementById('btnDecline');
  var err        = document.getElementById('step2Error');

  btnAccept.disabled  = true;
  btnDecline.disabled = true;
  btnAccept.textContent = 'Connecting\u2026';
  err.style.display = 'none';

  var now = new Date().toISOString();
  var ver = '1.0';
  var consentText = getConsentText();

  var privacyPolicyConsent = { given: true,    timestamp: now, version: ver, text: consentText };
  var termsConsent         = { given: true,    timestamp: now, version: ver, text: consentText };
  var marketingConsent     = { given: marketing, timestamp: now, version: ver, text: consentText };

  // GDPR audit cookie — 1 year
  document.cookie = 'gdpr_consent=' + encodeURIComponent(JSON.stringify({
    privacyPolicy: privacyPolicyConsent,
    terms:         termsConsent,
    marketing:     marketingConsent,
  })) + '; max-age=31536000; path=/; SameSite=Lax';

  var firstName = document.getElementById('firstName').value.trim();
  var lastName  = document.getElementById('lastName').value.trim();
  var email     = document.getElementById('email').value.trim();
  var phone     = document.getElementById('phone').value.trim();
  var dialCode  = document.getElementById('selectedCode').textContent;
  var splashResponses = collectSplashResponses();

  try {
    var res = await fetch('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName, lastName, email,
        phone, phoneCountryCode: dialCode,
        mac:   clientMac(),
        ip:    param('ip'),
        url:   param('url'),
        post:  param('post'),
        apmac: apMac(),
        privacyPolicyConsent,
        termsConsent,
        marketingConsent,
        splashResponses,
      }),
    });
    if (!res.ok) throw new Error('Server error');

    if (isUnifi()) {
      var authRes = await fetch('/api/unifi-authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName, lastName, email,
          phone, phoneCountryCode: dialCode,
          clientMac: clientMac(),
          apMac: apMac(),
          url: param('url'),
          ssid: param('ssid'),
          privacyPolicyConsent,
          termsConsent,
          marketingConsent,
          splashResponses,
        }),
      });
      var authData = await authRes.json().catch(function() { return {}; });
      if (!authRes.ok || !authData.success) {
        throw new Error(authData.message || 'Could not authorize WiFi access');
      }
      await waitForInternet(10000);

      // On UniFi param('url') is the device's captive-DETECTION url, never a
      // tenant destination — captive.apple.com/hotspot-detect.html (whose body is
      // the word "Success") or connectivitycheck.gstatic.com/generate_204 (blank).
      // Honouring it skipped /success, so the venue's connected page never showed.
      window.location.href = '/success?apmac=' + encodeURIComponent(apMac())
        + '&mac=' + encodeURIComponent(clientMac());
      return;
    }

    // Aruba: populate hidden form and POST to /submit → swarm.cgi
    document.getElementById('f_firstName').value        = firstName;
    document.getElementById('f_lastName').value         = lastName;
    document.getElementById('f_email').value            = email;
    document.getElementById('f_phone').value            = phone;
    document.getElementById('f_phoneCountryCode').value = dialCode;
    document.getElementById('f_mac').value              = clientMac();
    document.getElementById('f_ip').value               = param('ip');
    document.getElementById('f_url').value              = param('url');
    document.getElementById('f_post').value             = param('post');
    document.getElementById('f_apmac').value            = apMac();
    document.getElementById('portalForm').submit();

  } catch (e) {
    showErr(err, 'Something went wrong. Please try again.');
    btnAccept.disabled  = false;
    btnDecline.disabled = false;
    btnAccept.textContent = normalizeConsentPage(CONFIG).acceptButtonText;
  }
}

// ── 6. Document modal (Privacy Policy + Terms of Service) ─────────────────
var docCache = {};   // keyed by 'privacy' | 'terms'

var DOC_CONFIG = {
  privacy: { api: '/api/privacy-policy', label: 'Privacy Policy' },
  terms:   { api: '/api/terms',          label: 'Terms of Service' },
};

function openDoc(e, type) {
  if (e) e.preventDefault();
  var cfg = DOC_CONFIG[type];
  if (!cfg) return;

  document.getElementById('ppTitle').textContent = cfg.label;
  document.getElementById('ppModal').classList.add('open');

  if (docCache[type]) {
    document.getElementById('ppContent').textContent = docCache[type];
    return;
  }

  document.getElementById('ppContent').textContent = 'Loading\u2026';
  // Forward the AP MAC so the backend can serve this venue's document override.
  var docUrl = apMac() ? cfg.api + '?apmac=' + encodeURIComponent(apMac()) : cfg.api;
  fetch(docUrl)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var text = d.content || (cfg.label + ' not available.');
      docCache[type] = text;
      document.getElementById('ppContent').textContent = text;
    })
    .catch(function() {
      document.getElementById('ppContent').textContent =
        'Unable to load document. Please ask staff for a copy.';
    });
}

function closeModal() {
  document.getElementById('ppModal').classList.remove('open');
}

document.getElementById('ppModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
