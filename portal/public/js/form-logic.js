// ── 1. Vendor params (Aruba: apmac/mac/post — UniFi: ap/id/url/ssid) ───────
var _params = new URLSearchParams(window.location.search);
function param(k) { return _params.get(k) || ''; }
function isUnifi() { return !!param('ap'); }
function clientMac() { return param('mac') || param('id'); }
function apMac() { return param('apmac') || param('ap'); }

// ── 3. Step 1 → Step 2 transition ─────────────────────────────────────────
function goToConsent() {
  var firstName = document.getElementById('firstName').value.trim();
  var lastName  = document.getElementById('lastName').value.trim();
  var email     = document.getElementById('email').value.trim();
  var err       = document.getElementById('step1Error');

  if (CONFIG.collectName) {
    if (!firstName) { showErr(err, 'Please enter your first name.'); return; }
    if (!lastName)  { showErr(err, 'Please enter your last name.');  return; }
  }
  if (CONFIG.collectEmail) {
    if (!email || !email.includes('@')) {
      showErr(err, 'Please enter a valid email address.'); return;
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
var CONSENT_TEXT =
  'I consent to the collection and use of my personal data, provided via ' +
  'WiFi portal registration, by this venue for marketing purposes. I understand ' +
  'that I may withdraw my consent at any time, and that this will not affect the ' +
  'legality of any processing carried out prior to my withdrawal.\n\n' +
  'I also consent to receiving marketing communications from this venue via email ' +
  'or other electronic means. I understand that I can unsubscribe at any time ' +
  'using the method provided in each communication.';

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

  var privacyPolicyConsent = { given: true,    timestamp: now, version: ver, text: CONSENT_TEXT };
  var termsConsent         = { given: true,    timestamp: now, version: ver, text: CONSENT_TEXT };
  var marketingConsent     = { given: marketing, timestamp: now, version: ver, text: CONSENT_TEXT };

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
        }),
      });
      var authData = await authRes.json().catch(function() { return {}; });
      if (!authRes.ok || !authData.success) {
        throw new Error(authData.message || 'Could not authorize WiFi access');
      }
      var dest = param('url');
      var successUrl = '/success?apmac=' + encodeURIComponent(apMac())
        + '&mac=' + encodeURIComponent(clientMac());
      window.location.href = (dest && /^https?:\/\//i.test(dest)) ? dest : successUrl;
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
    btnAccept.textContent = 'Accept';
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
  fetch(cfg.api)
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
