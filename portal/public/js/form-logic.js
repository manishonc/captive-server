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

// ── 5. Step 2 → (verify) → Submit ─────────────────────────────────────────
// Everything gathered at consent time, held while the guest verifies. Module
// scope so the verify handlers can finish the original submit without re-reading
// a form that is now hidden.
var _pendingSubmission = null;

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

  _pendingSubmission = {
    firstName: document.getElementById('firstName').value.trim(),
    lastName:  document.getElementById('lastName').value.trim(),
    email:     document.getElementById('email').value.trim(),
    phone:     document.getElementById('phone').value.trim(),
    dialCode:  document.getElementById('selectedCode').textContent,
    splashResponses: collectSplashResponses(),
    privacyPolicyConsent: privacyPolicyConsent,
    termsConsent: termsConsent,
    marketingConsent: marketingConsent,
  };

  // Verification sits AFTER consent, so a code is never sent to someone who then
  // declines. A guest who declined MARKETING still verifies — this is about the
  // contact details being real, not about marketing permission.
  var verification = normalizeVerification(CONFIG.verificationPage);
  if (verification.enabled) {
    startVerification(verification);
    return;
  }

  completeSubmission(null);
}

// ── 5b. Verification step ─────────────────────────────────────────────────
var _verifyState = { channel: null, resendTimer: null, sending: false };

var VERIFY_ERRORS = {
  invalid_code:             'That code is not right. Please check and try again.',
  code_expired:             'That code expired. Send a new one to continue.',
  too_many_attempts:        'Too many attempts. Please wait a few minutes and try again.',
  too_many_requests:        'Too many requests. Please wait a few minutes and try again.',
  invalid_destination:      'That contact detail does not look right. Go back and check it.',
  undeliverable:            'We could not reach you there.',
  channel_unavailable:      'That method is unavailable right now.',
  channel_not_enabled:      'That method is not available here.',
  provider_error:           'We could not send your code. Please try again.',
  ap_not_registered:        'This WiFi point is not set up. Please ask staff for help.',
  verification_unavailable: 'Verification is unavailable right now. Please ask staff for help.',
};

function showVerifyError(code, extra) {
  var el = document.getElementById('verifyError');
  if (!el) return;
  var msg = VERIFY_ERRORS[code] || 'Something went wrong. Please try again.';
  showErr(el, extra ? msg + ' ' + extra : msg);
}

function verifyDestinationPayload() {
  return {
    email: _pendingSubmission.email,
    phone: _pendingSubmission.phone,
    phoneCountryCode: _pendingSubmission.dialCode,
  };
}

function startResendCountdown(seconds) {
  var btn = document.getElementById('btnResend');
  if (!btn) return;
  var label = normalizeVerification(CONFIG.verificationPage).resendLabel;
  var left = Math.max(0, seconds || 0);
  clearInterval(_verifyState.resendTimer);
  function tick() {
    if (left <= 0) {
      clearInterval(_verifyState.resendTimer);
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    btn.disabled = true;
    btn.textContent = label + ' (' + left + 's)';
    left -= 1;
  }
  tick();
  _verifyState.resendTimer = setInterval(tick, 1000);
}

function startVerification(page) {
  var card = renderVerifyStep(CONFIG, { preview: false });
  // No card means no #step1 to build from — connect rather than strand.
  if (!card) { completeSubmission(null); return; }

  document.getElementById('step1').classList.add('hidden');
  document.getElementById('step2').classList.add('hidden');
  card.classList.remove('hidden');

  var picked = document.querySelector('input[name="verifyChannel"]:checked');
  _verifyState.channel = (picked && picked.value) || page.defaultChannel;

  document.getElementById('btnVerify').addEventListener('click', function () { checkCode(page); });
  document.getElementById('btnResend').addEventListener('click', function () { sendCode(); });
  document.getElementById('btnChangeDestination').addEventListener('click', function () {
    clearInterval(_verifyState.resendTimer);
    card.classList.add('hidden');
    document.getElementById('step1').classList.remove('hidden');
    // The guest re-enters via step 2, so the consent buttons must work again.
    var a = document.getElementById('btnAccept');
    var d = document.getElementById('btnDecline');
    if (a) { a.disabled = false; a.textContent = normalizeConsentPage(CONFIG).acceptButtonText; }
    if (d) d.disabled = false;
  });
  document.getElementById('verifyCode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); checkCode(page); }
  });
  // Switching channel re-sends, so the live code always matches the chosen method.
  Array.prototype.forEach.call(document.querySelectorAll('input[name="verifyChannel"]'), function (radio) {
    radio.addEventListener('change', function () {
      _verifyState.channel = radio.value;
      sendCode();
    });
  });

  sendCode();
}

async function sendCode() {
  if (_verifyState.sending) return;
  _verifyState.sending = true;
  var errEl = document.getElementById('verifyError');
  if (errEl) errEl.style.display = 'none';

  var body = Object.assign({
    channel: _verifyState.channel,
    apmac: apMac(),
    mac: clientMac(),
  }, verifyDestinationPayload());

  try {
    var res = await fetch('/api/verify/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });

    // Verification was turned off (or degraded) while the guest was mid-flow.
    if (res.status === 409) { completeSubmission(null); return; }

    // Remembered device, or the server waived verification: both hand back a
    // token and nothing was sent.
    if (res.ok && data.verificationToken) { completeSubmission(data.verificationToken); return; }

    if (res.ok) {
      var sub = document.getElementById('verifySubheading');
      if (sub && data.destinationMasked) {
        sub.textContent = 'Enter the 6-digit code we sent to ' + data.destinationMasked;
      }
      startResendCountdown(data.resendInSeconds || 60);
      return;
    }

    // A cooldown is NOT a failure — the guest reopened the captive browser and a
    // code is already in flight. Show the entry state with the countdown.
    if (data.code === 'resend_too_soon') {
      var sub2 = document.getElementById('verifySubheading');
      if (sub2) {
        sub2.textContent = 'We already sent a code'
          + (data.destinationMasked ? ' to ' + data.destinationMasked : '')
          + ' — check your messages.';
      }
      startResendCountdown(data.retryAfterSeconds || 60);
      return;
    }

    var alt = (Array.isArray(data.fallbackChannels) && data.fallbackChannels.length)
      ? 'You can also try: ' + data.fallbackChannels.join(', ') + '.'
      : '';
    showVerifyError(data.code, alt);
    startResendCountdown(0);
  } catch (e) {
    showVerifyError(null);
    startResendCountdown(0);
  } finally {
    _verifyState.sending = false;
  }
}

async function checkCode(page) {
  var btn = document.getElementById('btnVerify');
  var input = document.getElementById('verifyCode');
  if (!btn || !input || btn.disabled) return;
  var code = (input.value || '').trim();
  if (!/^\d{4,8}$/.test(code)) { showVerifyError('invalid_code'); return; }

  btn.disabled = true;
  btn.textContent = 'Verifying…';
  var errEl = document.getElementById('verifyError');
  if (errEl) errEl.style.display = 'none';

  var body = Object.assign({
    channel: _verifyState.channel,
    apmac: apMac(),
    mac: clientMac(),
    code: code,
  }, verifyDestinationPayload());

  try {
    var res = await fetch('/api/verify/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });

    if (res.status === 409) { completeSubmission(null); return; }
    if (res.ok && data.verificationToken) {
      clearInterval(_verifyState.resendTimer);
      completeSubmission(data.verificationToken);
      return;
    }

    var left = (typeof data.attemptsLeft === 'number')
      ? data.attemptsLeft + ' attempt' + (data.attemptsLeft === 1 ? '' : 's') + ' left.'
      : '';
    showVerifyError(data.code, left);
  } catch (e) {
    showVerifyError(null);
  } finally {
    btn.disabled = false;
    btn.textContent = page.verifyButtonText;
  }
}

// ── 5c. Submit ────────────────────────────────────────────────────────────
async function completeSubmission(verificationToken) {
  var p = _pendingSubmission;
  if (!p) return;

  var err        = document.getElementById('step2Error');
  var btnAccept  = document.getElementById('btnAccept');
  var btnDecline = document.getElementById('btnDecline');

  // The token is bound to the destination it verified. If the guest edited a
  // field after verifying, drop it here rather than let the server reject the
  // mismatch with a bare 403 — this way they get a clean re-verify.
  var liveEmail = document.getElementById('email').value.trim();
  var livePhone = document.getElementById('phone').value.trim();
  if (verificationToken && (liveEmail !== p.email || livePhone !== p.phone)) {
    verificationToken = null;
  }

  var firstName = p.firstName;
  var lastName  = p.lastName;
  var email     = p.email;
  var phone     = p.phone;
  var dialCode  = p.dialCode;
  var splashResponses = p.splashResponses;
  var privacyPolicyConsent = p.privacyPolicyConsent;
  var termsConsent = p.termsConsent;
  var marketingConsent = p.marketingConsent;

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
        verificationToken,
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
          verificationToken,
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
    // No template ships this field, and /submit is the Aruba grant path that has
    // to see the token — create it rather than edit 33 templates.
    if (verificationToken) {
      var tokenInput = document.getElementById('f_verificationToken');
      if (!tokenInput) {
        tokenInput = document.createElement('input');
        tokenInput.type = 'hidden';
        tokenInput.id = 'f_verificationToken';
        tokenInput.name = 'verificationToken';
        document.getElementById('portalForm').appendChild(tokenInput);
      }
      tokenInput.value = verificationToken;
    }
    document.getElementById('portalForm').submit();

  } catch (e) {
    // The verify step may be the one on screen, so report the failure there.
    var stepVerify = document.getElementById('stepVerify');
    var verifyErr = document.getElementById('verifyError');
    if (stepVerify && !stepVerify.classList.contains('hidden') && verifyErr) {
      showErr(verifyErr, 'Something went wrong. Please try again.');
    } else if (err) {
      showErr(err, 'Something went wrong. Please try again.');
    }
    if (btnAccept) {
      btnAccept.disabled = false;
      btnAccept.textContent = normalizeConsentPage(CONFIG).acceptButtonText;
    }
    if (btnDecline) btnDecline.disabled = false;
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
