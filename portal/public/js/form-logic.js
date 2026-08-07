// ── 1. Vendor params (Aruba: apmac/mac/post — UniFi: ap/id/url/ssid) ───────
var _params = new URLSearchParams(window.location.search);
function param(k) { return _params.get(k) || ''; }
function isUnifi() { return !!param('ap'); }
function clientMac() { return param('mac') || param('id'); }
function apMac() { return param('apmac') || param('ap'); }

// ── 3. Step 1 → Step 2 transition ─────────────────────────────────────────
// Resolved per call, not cached in an object literal: the guest can switch
// language after a failed submit, and a cached English message would survive it.
function fieldErrorMsg(id) {
  return t('error.' + id);
}

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
    if (invalid) { showErr(err, fieldErrorMsg(id)); return; }
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
        showErr(err, t('error.fillIn', input.getAttribute('data-label')));
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
// The card is the only thing the guest can see between "I typed my code" and "I
// am online", and on UniFi that gap is create-user + unifi-authorize + up to 10s
// of waitForInternet. `phase` is the single source of truth and every DOM write
// on the card goes through paintVerifyState, so no branch can leave a stale
// label behind — which is exactly what used to happen: the success path fired
// completeSubmission unawaited and the finally then reset the button to idle.
var _verifyState = {
  channel: null,
  phase: 'idle',            // idle | sending | verifying | connecting
  token: null,              // last minted token — a failed connect retries the connect, not the code
  resendTimer: null,
  resendUntil: 0,           // epoch ms; the resend button is a pure function of (phase, resendUntil)
  subheadingText: '',       // idle copy to restore after a busy phase
  connectTimers: [],
  autoTimer: null,
  lastRejectedCode: null,   // never auto-resubmit digits the server just refused
};

// Guards the only thing here that is not cosmetic. Two /create-user calls for one
// guest means a duplicate session row, an inflated connectionCount and — because
// the reconnect branch re-runs the dispatchers — a SECOND welcome message, which
// is billable. Deliberately independent of the card so it holds even if the DOM
// is broken.
var _submitInFlight = false;

// The server returns machine codes only (see server/src/routes/verify.ts), which
// is what lets every one of these live in the translation catalog rather than in
// the API response. An unknown code falls back to the generic message.
var VERIFY_ERROR_CODES = [
  'invalid_code', 'code_expired', 'too_many_attempts', 'too_many_requests',
  'invalid_destination', 'undeliverable', 'channel_unavailable',
  'channel_not_enabled', 'provider_error', 'ap_not_registered',
  'verification_unavailable',
];

function verifyErrorText(code, extra) {
  var msg = (VERIFY_ERROR_CODES.indexOf(code) !== -1)
    ? t('verifyError.' + code)
    : t('error.generic');
  return extra ? msg + ' ' + extra : msg;
}

// Every caller's intent is "stop, and hand the card back to the guest", so this
// is a transition rather than just a paint.
function showVerifyError(code, extra, opts) {
  opts = opts || {};
  setVerifyState('idle', {
    error: verifyErrorText(code, extra),
    clearCode: opts.clearCode,
    focus: opts.focus,
    label: opts.label,
  });
}

function verifyDestinationPayload() {
  return {
    email: _pendingSubmission.email,
    phone: _pendingSubmission.phone,
    phoneCountryCode: _pendingSubmission.dialCode,
  };
}

// ── Verify-card state machine ─────────────────────────────────────────────
// Copy for the connecting wait. A spinner that says nothing for ~12s reads as
// broken in a captive mini-browser, and "keep this page open" is the
// operationally useful line — guests close the CNA sheet.
// Text resolved lazily via key so a language switch mid-connect repaints
// correctly on the next tick.
var VERIFY_CONNECT_COPY = [
  { at: 0,    key: 'connect.step1' },
  { at: 4000, key: 'connect.step2' },
  { at: 8000, key: 'connect.step3' },
];
// fetch() has no timeout of its own, so without this a hung request would trap
// the guest behind a card with every control disabled.
var VERIFY_CONNECT_WATCHDOG_MS = 20000;

function verifySpinner() {
  var slow = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var i = document.createElement('span');
  i.setAttribute('aria-hidden', 'true');
  // hf-spin is defined by injectBootGate in <style id="hf-boot-style">, which is
  // never removed — so the keyframe is live on all 33 templates and this needs
  // no new CSS.
  i.style.cssText = 'display:inline-block;width:13px;height:13px;margin-right:8px;'
    + 'vertical-align:-2px;border:2px solid currentColor;border-right-color:transparent;'
    + 'border-radius:50%;opacity:.85;animation:hf-spin ' + (slow ? '2.4s' : '.7s') + ' linear infinite';
  return i;
}

function setVerifyBusyLabel(btn, label) {
  btn.textContent = '';                  // also wipes any previous spinner
  btn.appendChild(verifySpinner());
  btn.appendChild(document.createTextNode(label));
}

// sendCode rewrites the subheading ("code sent to j•••@…"). Routing those writes
// through here gives the connecting copy something correct to hand back.
function setVerifySubheading(text) {
  _verifyState.subheadingText = text;
  var sub = document.getElementById('verifySubheading');
  if (sub && _verifyState.phase !== 'connecting') sub.textContent = text;
}

function stopResendCountdown() {
  clearInterval(_verifyState.resendTimer);
  _verifyState.resendTimer = null;
}

// The resend button is a pure function of (phase, resendUntil). Without this the
// old 1s interval would re-enable it mid-connect on its own.
function paintResendButton() {
  var btn = document.getElementById('btnResend');
  if (!btn) return;
  var label = normalizeVerification(CONFIG.verificationPage).resendLabel;
  if (_verifyState.phase !== 'idle') { btn.disabled = true; return; }
  var left = Math.ceil((_verifyState.resendUntil - Date.now()) / 1000);
  if (left > 0) { btn.disabled = true; btn.textContent = t('verify.resendCountdown', label, left); return; }
  btn.disabled = false;
  btn.textContent = label;
}

function ensureResendTicking() {
  if (_verifyState.resendTimer) return;
  if (_verifyState.resendUntil <= Date.now()) return;
  _verifyState.resendTimer = setInterval(function () {
    paintResendButton();
    if (_verifyState.resendUntil <= Date.now()) stopResendCountdown();
  }, 1000);
}

function startResendCountdown(seconds) {
  _verifyState.resendUntil = Date.now() + Math.max(0, seconds || 0) * 1000;
  stopResendCountdown();
  paintResendButton();
  ensureResendTicking();
}

function clearConnectTimers() {
  for (var t = 0; t < _verifyState.connectTimers.length; t++) {
    clearTimeout(_verifyState.connectTimers[t]);
  }
  _verifyState.connectTimers = [];
}

// The phase is assigned BEFORE the paint and the paint is wrapped: a cosmetic
// throw must never break a guard or stop a connect.
function setVerifyState(next, opts) {
  _verifyState.phase = next;
  clearTimeout(_verifyState.autoTimer);
  clearConnectTimers();
  try { paintVerifyState(next, opts || {}); } catch (e) { /* cosmetics never block the grant */ }
}

function paintVerifyState(next, opts) {
  var card = document.getElementById('stepVerify');
  // No card (verification off, or renderVerifyStep returned null) or a hidden one
  // (the consent step owns its own buttons) — nothing to say here.
  if (!card || card.classList.contains('hidden')) return;

  var btn    = document.getElementById('btnVerify');
  var input  = document.getElementById('verifyCode');
  var sub    = document.getElementById('verifySubheading');
  var err    = document.getElementById('verifyError');
  var change = document.getElementById('btnChangeDestination');
  var radios = document.querySelectorAll('input[name="verifyChannel"]');
  var busy   = next !== 'idle';

  card.setAttribute('aria-busy', busy ? 'true' : 'false');

  if (input) {
    // readOnly, not disabled: no template styles input:disabled, so a disabled
    // field would inherit UA greying that looks different on all 33.
    input.readOnly = busy;
    input.style.opacity = busy ? '.65' : '';
    if (next === 'verifying' || next === 'connecting') input.blur();   // drops the iOS keyboard
  }
  if (err) {
    if (opts.error) showErr(err, opts.error);
    else err.style.display = 'none';
  }
  // Abandoning an in-flight send is harmless — the guest may have spotted a typo.
  if (change) change.disabled = (next === 'verifying' || next === 'connecting');
  for (var i = 0; i < radios.length; i++) radios[i].disabled = busy;
  paintResendButton();

  if (!btn) return;
  if (next === 'sending')   { btn.disabled = true; setVerifyBusyLabel(btn, t('verify.sending')); return; }
  if (next === 'verifying') { btn.disabled = true; setVerifyBusyLabel(btn, t('verify.verifying')); return; }

  if (next === 'connecting') {
    btn.disabled = true;
    setVerifyBusyLabel(btn, t('verify.connecting'));
    if (sub) {
      sub.textContent = t(VERIFY_CONNECT_COPY[0].key);
      for (var s = 1; s < VERIFY_CONNECT_COPY.length; s++) {
        (function (step) {
          _verifyState.connectTimers.push(setTimeout(function () {
            if (_verifyState.phase === 'connecting') sub.textContent = t(step.key);
          }, step.at));
        })(VERIFY_CONNECT_COPY[s]);
      }
    }
    _verifyState.connectTimers.push(setTimeout(function () {
      if (_verifyState.phase !== 'connecting') return;
      var c = document.getElementById('btnChangeDestination');
      if (c) c.disabled = false;
      if (sub) sub.textContent = t('verify.takingLonger');
    }, VERIFY_CONNECT_WATCHDOG_MS));
    return;
  }

  // idle
  btn.disabled = false;
  btn.textContent = opts.label || btn.getAttribute('data-idle-label') || t('verify.verifyButtonText');
  if (sub && _verifyState.subheadingText) sub.textContent = _verifyState.subheadingText;
  if (input && opts.clearCode) input.value = '';
  if (input && opts.focus) { try { input.focus(); } catch (e) {} }
  ensureResendTicking();
}

/**
 * Auto-submit once the guest has 6 digits in the box.
 *
 * The WhatsApp authentication template ships a Copy-code button and iOS offers
 * the SMS code above the keyboard, so paste/autofill is the expected input path
 * — not typing followed by a deliberate tap. One `input` listener covers typing,
 * paste and autofill.
 */
function maybeAutoSubmit(page) {
  var input = document.getElementById('verifyCode');
  if (!input) return;
  var raw = input.value || '';
  // A pasted "482913 is your … code" or "48 29 13" still needs cleaning.
  var digits = raw.replace(/\D+/g, '').slice(0, 6);
  if (digits !== raw) input.value = digits;
  clearTimeout(_verifyState.autoTimer);
  if (digits.length !== 6) return;
  if (_verifyState.phase !== 'idle') return;
  // Never auto-fire digits the server just refused — five attempts is not many,
  // and a stubborn re-paste would burn them. A deliberate tap still retries.
  if (digits === _verifyState.lastRejectedCode) return;
  // Short delay so the 6th digit paints before the button becomes a spinner.
  _verifyState.autoTimer = setTimeout(function () {
    var live = document.getElementById('verifyCode');
    if (_verifyState.phase === 'idle' && live && live.value === digits) checkCode(page);
  }, 90);
}

function startVerification(page) {
  var card = renderVerifyStep(CONFIG, { preview: false });
  // No card means no #step1 to build from — connect rather than strand.
  if (!card) { completeSubmission(null); return; }

  document.getElementById('step1').classList.add('hidden');
  document.getElementById('step2').classList.add('hidden');
  card.classList.remove('hidden');

  // Fresh entry — the guest may be arriving here a second time via "Use a
  // different one", and a stale token or memo would misroute the next pass.
  stopResendCountdown();
  clearConnectTimers();
  clearTimeout(_verifyState.autoTimer);
  _verifyState.phase = 'idle';
  _verifyState.token = null;
  _verifyState.lastRejectedCode = null;
  _verifyState.resendUntil = 0;
  _verifyState.subheadingText = page.subheading;

  var picked = document.querySelector('input[name="verifyChannel"]:checked');
  _verifyState.channel = (picked && picked.value) || page.defaultChannel;

  document.getElementById('btnVerify').addEventListener('click', function () { checkCode(page); });
  document.getElementById('btnResend').addEventListener('click', function () { sendCode(); });
  document.getElementById('btnChangeDestination').addEventListener('click', function () {
    stopResendCountdown();
    clearConnectTimers();
    clearTimeout(_verifyState.autoTimer);
    // The destination is about to change, so the token no longer matches what
    // will be submitted — completeSubmission would null it out anyway.
    _verifyState.token = null;
    _verifyState.lastRejectedCode = null;
    _verifyState.phase = 'idle';
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
  document.getElementById('verifyCode').addEventListener('input', function () { maybeAutoSubmit(page); });
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
  // Also blocks resend / channel-flip during verifying and connecting, both of
  // which could otherwise start a second connect via the hand-offs below.
  if (_verifyState.phase !== 'idle') return;
  setVerifyState('sending');

  var body = Object.assign({
    channel: _verifyState.channel,
    apmac: apMac(),
    mac: clientMac(),
    // Picks the OTP email/SMS wording; see services/otpMessages.ts. WhatsApp is
    // pinned to an approved Meta locale server-side, so this is advisory there.
    language: ACTIVE_LANG,
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
      if (data.destinationMasked) {
        setVerifySubheading(t('verify.codeSentTo', data.destinationMasked));
      }
      // A fresh code means the old rejection no longer applies.
      _verifyState.lastRejectedCode = null;
      setVerifyState('idle', { clearCode: true });
      startResendCountdown(data.resendInSeconds || 60);
      return;
    }

    // A cooldown is NOT a failure — the guest reopened the captive browser and a
    // code is already in flight. Show the entry state with the countdown.
    if (data.code === 'resend_too_soon') {
      setVerifySubheading(data.destinationMasked
        ? t('verify.alreadySentTo', data.destinationMasked)
        : t('verify.alreadySent'));
      setVerifyState('idle');
      startResendCountdown(data.retryAfterSeconds || 60);
      return;
    }

    var alt = (Array.isArray(data.fallbackChannels) && data.fallbackChannels.length)
      ? t('verify.alsoTry', data.fallbackChannels.join(', '))
      : '';
    startResendCountdown(0);
    showVerifyError(data.code, alt);
  } catch (e) {
    startResendCountdown(0);
    showVerifyError(null);
  } finally {
    // Only a path that neither handed off nor already transitioned lands here
    // still 'sending' — e.g. a throw between the fetch and the state call.
    if (_verifyState.phase === 'sending') setVerifyState('idle');
  }
}

async function checkCode(page) {
  var input = document.getElementById('verifyCode');
  if (!input) return;
  // The one double-submit gate, and it is synchronous — so an Enter key repeat
  // or a fast double-tap cannot get a second request away.
  if (_verifyState.phase !== 'idle') return;
  // A connect that failed AFTER the code was accepted retries the CONNECT, not
  // the code: the token is good for 15 minutes, the consumed-code grace only 120s.
  if (_verifyState.token) { completeSubmission(_verifyState.token); return; }

  var code = (input.value || '').trim();
  if (!/^\d{4,8}$/.test(code)) { showVerifyError('invalid_code', '', { focus: true }); return; }

  setVerifyState('verifying');

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
      stopResendCountdown();
      _verifyState.token = data.verificationToken;
      // Sets 'connecting' synchronously, so the finally below stands down.
      completeSubmission(data.verificationToken);
      return;
    }

    // Plural form comes from the catalog, not string concatenation — the rule
    // differs per language and concatenation cannot express it.
    var left = (typeof data.attemptsLeft === 'number' && window.HF_I18N)
      ? window.HF_I18N.plural('verify.attemptsLeft', data.attemptsLeft)
      : '';
    _verifyState.lastRejectedCode = code;
    showVerifyError(data.code, left, {
      // Clear only when the digits themselves are dead. A transport failure
      // probably had the right code — don't make them retype it.
      clearCode: data.code === 'invalid_code' || data.code === 'code_expired'
              || data.code === 'too_many_attempts',
      focus: data.code === 'invalid_code',
    });
  } catch (e) {
    showVerifyError(null);
  } finally {
    // Only a path that neither handed off nor painted an error lands here still
    // 'verifying' — e.g. a throw between the fetch and the state call. Guarding
    // on the phase rather than a handedOff flag also catches a throw AFTER the
    // hand-off, which is what used to reset the button mid-connect.
    if (_verifyState.phase === 'verifying') setVerifyState('idle');
  }
}

// ── 5c. Submit ────────────────────────────────────────────────────────────
async function completeSubmission(verificationToken) {
  var p = _pendingSubmission;
  if (!p) return;
  // The guard that actually matters. A second /create-user takes the reconnect
  // branch server-side, which re-runs the marketing dispatchers — the guest gets
  // a second welcome message and it is billable.
  if (_submitInFlight) return;
  _submitInFlight = true;
  // Runs synchronously before the first await, so every caller's finally sees
  // 'connecting'. Placed HERE rather than in checkCode so it covers all four
  // hand-off points: checkCode 200, checkCode 409, sendCode 409, and sendCode's
  // remembered-device token. No-op when the card is absent or hidden.
  setVerifyState('connecting');

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
        // Persisted on the guest record and reused for every later email/SMS/
        // WhatsApp we send them — see services/guestLanguage.ts.
        language: ACTIVE_LANG,
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
          language: ACTIVE_LANG,
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
      // lang rides the URL because /success is a fresh document: some captive
      // network assistants run with localStorage disabled, and without this the
      // connected card would revert to the venue default language.
      window.location.href = '/success?apmac=' + encodeURIComponent(apMac())
        + '&mac=' + encodeURIComponent(clientMac())
        + '&lang=' + encodeURIComponent(ACTIVE_LANG);
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
    // Same reasoning as the token above: /submit re-renders the template
    // server-side, so the chosen language has to survive the POST.
    var langInput = document.getElementById('f_lang');
    if (!langInput) {
      langInput = document.createElement('input');
      langInput.type = 'hidden';
      langInput.id = 'f_lang';
      langInput.name = 'lang';
      document.getElementById('portalForm').appendChild(langInput);
    }
    langInput.value = ACTIVE_LANG;
    document.getElementById('portalForm').submit();

  } catch (e) {
    _submitInFlight = false;
    // The verify step may be the one on screen, so hand THAT card back rather
    // than only painting an error on it. The token is kept, so the retry re-runs
    // just the connect and never re-hits /verify/check.
    var stepVerify = document.getElementById('stepVerify');
    if (stepVerify && !stepVerify.classList.contains('hidden')) {
      setVerifyState('idle', {
        error: t('error.generic'),
        label: t('verify.tryAgain'),
      });
    } else if (err) {
      showErr(err, t('error.generic'));
    }
    if (btnAccept) {
      btnAccept.disabled = false;
      btnAccept.textContent = normalizeConsentPage(CONFIG).acceptButtonText;
    }
    if (btnDecline) btnDecline.disabled = false;
  }
}

// Aruba POSTs away and UniFi navigates to /success; either way a Back tap can
// restore this page from bfcache with the card frozen mid-connect and every
// control disabled. Hand it back rather than strand them.
//
// Trade-off: this (and the 20s watchdog) can let a guest retry a /create-user
// that actually succeeded before the page froze. That is strictly better than a
// permanently dead card; the clean fix is an idempotency key on the server.
window.addEventListener('pageshow', function (e) {
  if (!e.persisted) return;
  _submitInFlight = false;
  if (_verifyState.phase === 'connecting') setVerifyState('idle', { label: t('verify.tryAgain') });
});

// ── 6. Document modal (Privacy Policy + Terms of Service) ─────────────────
// Keyed by 'privacy'|'terms' AND language: the same venue serves a different
// document per language, so a language switch must not reuse the cached one.
var docCache = {};

var DOC_CONFIG = {
  privacy: { api: '/api/privacy-policy', labelKey: 'doc.privacy' },
  terms:   { api: '/api/terms',          labelKey: 'doc.terms' },
};

function openDoc(e, type) {
  if (e) e.preventDefault();
  var cfg = DOC_CONFIG[type];
  if (!cfg) return;

  var cacheKey = type + ':' + ACTIVE_LANG;
  document.getElementById('ppTitle').textContent = t(cfg.labelKey);
  document.getElementById('ppModal').classList.add('open');

  if (docCache[cacheKey]) {
    document.getElementById('ppContent').textContent = docCache[cacheKey];
    return;
  }

  document.getElementById('ppContent').textContent = t('doc.loading');
  // Forward the AP MAC so the backend can serve this venue's document override,
  // and the language so it can serve that override's translation. Scope resolves
  // BEFORE language server-side: a venue's own document in its default language
  // beats a translated platform default.
  var docParams = new URLSearchParams();
  if (apMac()) docParams.set('apmac', apMac());
  docParams.set('lang', ACTIVE_LANG);
  fetch(cfg.api + '?' + docParams.toString())
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var text = d.content || t('doc.notAvailable', t(cfg.labelKey));
      docCache[cacheKey] = text;
      // The document's own title is translated too when a variant exists.
      if (d.title) document.getElementById('ppTitle').textContent = d.title;
      document.getElementById('ppContent').textContent = text;
    })
    .catch(function() {
      document.getElementById('ppContent').textContent = t('doc.unavailable');
    });
}

function closeModal() {
  document.getElementById('ppModal').classList.remove('open');
}

document.getElementById('ppModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
