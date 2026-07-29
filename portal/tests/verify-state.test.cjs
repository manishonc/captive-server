/**
 * State-machine tests for the verify step.
 *
 * Run: node tests/verify-state.test.cjs        (from captive-server/portal)
 * Requires jsdom:  npm i --no-save jsdom
 *
 * Why this exists: the card is the only thing a guest can see between "I typed
 * my code" and "I am online", and on UniFi that gap is create-user +
 * unifi-authorize + up to 10s of waitForInternet. It used to reset itself to an
 * idle, re-armed state the instant the code was accepted — which looked broken
 * AND let a second tap through, and a second /create-user re-runs the marketing
 * dispatchers server-side (a duplicate, billable welcome message).
 *
 * The load-bearing assertions are "never idle on the success path", "no second
 * /create-user", and the degraded case at the end.
 */

const fs = require('fs');
const P = require('path');
const ejs = require(P.join(__dirname, '..', 'node_modules', 'ejs'));
const { JSDOM } = require('jsdom');

const PORTAL = P.join(__dirname, '..');
const srv = fs.readFileSync(P.join(PORTAL, 'server.js'), 'utf8');

function extract(name) {
  const i = srv.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('helper not found in server.js: ' + name);
  return srv.slice(i, srv.indexOf('\n}\n', i) + 3);
}
const helpers = (() => {
  const code = [
    'const DEFAULT_PRIMARY="#1c2b4a";',
    'const HEX_COLOR=/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;',
    extract('safeColor'), extract('injectBootGate'),
    'module.exports={injectBootGate};',
  ].join('\n');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', 'Buffer', code)(m, m.exports, require, Buffer);
  return m.exports;
})();

const CONFIG_FIXTURE = {
  templateId: 'classic',
  title: 'Test WiFi', subtitle: 'Connect',
  primaryColor: '#1c2b4a', backgroundColor: '#ffffff',
  showLogo: true, logoUrl: '',
  showMarketingOptIn: true, showPrivacyPolicy: true, showTermsOfService: true,
  scopeKey: 'venue:test',
  loginPage: {
    fields: {
      firstName: { enabled: true, label: '', required: true },
      lastName: { enabled: true, label: '', required: true },
      email: { enabled: true, label: '', required: true },
      phone: { enabled: true, label: '', required: true },
    },
    buttonText: 'Continue', customFields: [],
  },
  consentPage: {
    heading: 'Privacy', subheading: '', bodyParagraphs: ['We care.'],
    acceptButtonText: 'Accept', declineButtonText: 'No thanks',
  },
  verificationPage: {
    enabled: true,
    channels: { email: { enabled: true }, sms: { enabled: true }, whatsapp: { enabled: false } },
    defaultChannel: 'email', allowGuestChoice: true, requirement: 'any',
    heading: 'Verify your details', subheading: "We'll send you a code.",
    codeInputLabel: 'Verification code', sendButtonText: 'Send code',
    verifyButtonText: 'Verify', resendLabel: 'Resend code', rememberDays: 30,
  },
  connectedPage: {
    title: 'Connected', subtitle: '', showTitle: true, showSubtitle: false, showLogo: true,
    buttonText: 'Go', buttonUrl: 'https://heidifi.ai/', showButton: true, autoSubmit: false,
    customFields: [], redirectEnabled: false, redirectUrl: '', redirectDelaySeconds: 3,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  ✓ ' + msg); }
  else { failed += 1; console.error('  ✗ ' + msg); }
}

/**
 * Boots the portal at step 1 with verification enabled, then walks the guest to
 * the verify card. `routes` maps an endpoint suffix to a handler returning
 * { status, body }. Every call is recorded in `calls`.
 */
async function boot({ routes = {}, breakCard = false } = {}) {
  const cfg = JSON.parse(JSON.stringify(CONFIG_FIXTURE));
  let html = await ejs.renderFile(P.join(PORTAL, 'public/templates', cfg.templateId + '.html'), {
    portalConfig: cfg, portalConfigJson: JSON.stringify(cfg), previewMode: false,
  });
  html = helpers.injectBootGate(html, cfg);

  const calls = [];
  let submittedForm = false;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://p.heidifi.ai/?apmac=aa:bb:cc:dd:ee:ff&mac=11:22:33:44:55:66',
    beforeParse(w) {
      w.HTMLFormElement.prototype.submit = function () { submittedForm = true; };
      w.fetch = (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : {};
        calls.push({ url, body });
        const key = Object.keys(routes).find((k) => String(url).indexOf(k) !== -1);
        const res = key ? routes[key](body, calls) : { status: 200, body: { success: true } };
        if (res.hang) return new Promise(() => {});
        return Promise.resolve({
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: () => Promise.resolve(res.body),
        });
      };
      if (breakCard) {
        const real = w.document.getElementById.bind(w.document);
        w.document.getElementById = (id) => (id === 'stepVerify' ? null : real(id));
      }
    },
  });
  const w = dom.window;
  for (const f of ['config.js', 'country-selector.js', 'form-logic.js']) {
    try { w.eval(fs.readFileSync(P.join(PORTAL, 'public/js', f), 'utf8')); }
    catch (e) { console.error('   script threw in ' + f + ': ' + e.message); }
  }
  const d = w.document;
  // Fill step 1 and walk to consent, then accept → startVerification → sendCode.
  d.getElementById('firstName').value = 'Test';
  d.getElementById('lastName').value = 'Guest';
  d.getElementById('email').value = 'guest@example.com';
  d.getElementById('phone').value = '791234567';
  w.goToConsent();
  w.submitConsent(true);
  await sleep(40);
  return { w, d, calls, form: () => submittedForm };
}

const SENT = { status: 200, body: { success: true, channel: 'email', destinationMasked: 'g•••@example.com', resendInSeconds: 60, attemptsAllowed: 5 } };
const TOKEN = 'hv1.payload.sig';

(async () => {
  console.log('\nHappy path: code accepted');
  {
    const { w, d, calls } = await boot({
      routes: {
        '/verify/send': () => SENT,
        '/verify/check': () => ({ status: 200, body: { success: true, verificationToken: TOKEN } }),
        // Hang so the card is observable in its connecting state.
        '/api/create-user': () => ({ hang: true }),
      },
    });
    ok(d.getElementById('stepVerify'), 'verify card shown');
    ok(w.eval('_verifyState.phase') === 'idle', 'idle once the code has been sent');
    ok(d.getElementById('verifyCode').readOnly === false, 'code input editable when idle');

    d.getElementById('verifyCode').value = '482913';
    d.getElementById('btnVerify').click();
    await sleep(60);

    const phase = w.eval('_verifyState.phase');
    ok(phase === 'connecting', 'phase is connecting after the code is accepted (was: ' + phase + ')');
    const btn = d.getElementById('btnVerify');
    ok(btn.disabled === true, 'verify button STAYS disabled through the connect');
    ok(/Connecting/.test(btn.textContent), 'button reads "Connecting…", never back to idle');
    ok(btn.querySelector('span[aria-hidden]'), 'spinner present in the button');
    ok(d.getElementById('verifyCode').readOnly === true, 'code input readOnly while connecting');
    ok(d.getElementById('btnResend').disabled === true, 'resend disabled while connecting');
    ok(d.getElementById('btnChangeDestination').disabled === true, 'change-destination disabled while connecting');
    const radios = d.querySelectorAll('input[name="verifyChannel"]');
    ok(radios.length > 0 && Array.from(radios).every((r) => r.disabled), 'channel radios disabled while connecting');
    ok(/getting you online/i.test(d.getElementById('verifySubheading').textContent), 'connecting copy shown');
    ok(d.getElementById('stepVerify').getAttribute('aria-busy') === 'true', 'aria-busy set');

    // The whole point: a second tap must not produce a second create-user.
    d.getElementById('btnVerify').click();
    w.eval('checkCode(normalizeVerification(CONFIG.verificationPage))');
    await sleep(40);
    const creates = calls.filter((c) => String(c.url).indexOf('/api/create-user') !== -1);
    ok(creates.length === 1, 'exactly one /create-user despite repeated taps (got ' + creates.length + ')');
    const checks = calls.filter((c) => String(c.url).indexOf('/verify/check') !== -1);
    ok(checks.length === 1, 'exactly one /verify/check (got ' + checks.length + ')');
  }

  console.log('\nWrong code');
  {
    const { w, d } = await boot({
      routes: {
        '/verify/send': () => SENT,
        '/verify/check': () => ({ status: 400, body: { success: false, code: 'invalid_code', attemptsLeft: 4 } }),
      },
    });
    d.getElementById('verifyCode').value = '111111';
    d.getElementById('btnVerify').click();
    await sleep(60);
    ok(w.eval('_verifyState.phase') === 'idle', 'back to idle after a rejection');
    ok(d.getElementById('verifyCode').value === '', 'code input cleared');
    ok(d.activeElement === d.getElementById('verifyCode'), 'code input refocused');
    ok(/not right/i.test(d.getElementById('verifyError').textContent), 'error message shown');
    ok(/4 attempts left/.test(d.getElementById('verifyError').textContent), 'attempts remaining shown');
    ok(d.getElementById('btnVerify').disabled === false, 'button re-armed for a retry');
    ok(d.getElementById('btnVerify').textContent === 'Verify', "tenant's own label restored");
  }

  console.log('\nAuto-submit on paste');
  {
    const { w, d, calls } = await boot({
      routes: {
        '/verify/send': () => SENT,
        '/verify/check': () => ({ status: 400, body: { success: false, code: 'invalid_code', attemptsLeft: 3 } }),
      },
    });
    const input = d.getElementById('verifyCode');
    // Paste as it arrives from an SMS body, with noise around the digits.
    input.value = '48 29 13';
    input.dispatchEvent(new w.Event('input'));
    await sleep(20);
    ok(input.value === '482913', 'non-digits stripped from a pasted code');
    await sleep(150);
    let checks = calls.filter((c) => String(c.url).indexOf('/verify/check') !== -1);
    ok(checks.length === 1, 'auto-submitted without a tap (got ' + checks.length + ')');

    // Re-pasting the same rejected digits must NOT auto-fire again and burn an attempt.
    input.value = '482913';
    input.dispatchEvent(new w.Event('input'));
    await sleep(200);
    checks = calls.filter((c) => String(c.url).indexOf('/verify/check') !== -1);
    ok(checks.length === 1, 'a rejected code does not auto-fire again (got ' + checks.length + ')');
    // ...but a deliberate tap still retries it.
    d.getElementById('btnVerify').click();
    await sleep(60);
    checks = calls.filter((c) => String(c.url).indexOf('/verify/check') !== -1);
    ok(checks.length === 2, 'a deliberate tap still retries the same digits');
  }

  console.log('\nRemembered device (no code typed)');
  {
    const { w, d } = await boot({
      routes: {
        '/verify/send': () => ({ status: 200, body: { success: true, alreadyVerified: true, verificationToken: TOKEN } }),
        '/api/create-user': () => ({ hang: true }),
      },
    });
    ok(w.eval('_verifyState.phase') === 'connecting', 'goes straight to connecting, not an empty idle form');
    ok(/Connecting/.test(d.getElementById('btnVerify').textContent), 'button shows connecting');
  }

  console.log('\nConnect fails');
  {
    const { w, d, calls } = await boot({
      routes: {
        '/verify/send': () => SENT,
        '/verify/check': () => ({ status: 200, body: { success: true, verificationToken: TOKEN } }),
        '/api/create-user': () => ({ status: 500, body: { success: false } }),
      },
    });
    d.getElementById('verifyCode').value = '482913';
    d.getElementById('btnVerify').click();
    await sleep(80);
    ok(w.eval('_verifyState.phase') === 'idle', 'card handed back after a failed connect');
    ok(d.getElementById('btnVerify').textContent === 'Try again', 'button reads "Try again"');
    ok(d.getElementById('btnVerify').disabled === false, 'button re-armed');
    ok(w.eval('_submitInFlight') === false, 'submit latch released');
    ok(w.eval('_verifyState.token') === TOKEN, 'token retained for the retry');

    // The retry must re-run only the connect — the code was already accepted.
    d.getElementById('btnVerify').click();
    await sleep(80);
    const checks = calls.filter((c) => String(c.url).indexOf('/verify/check') !== -1);
    ok(checks.length === 1, 'retry does NOT re-hit /verify/check (got ' + checks.length + ')');
    const creates = calls.filter((c) => String(c.url).indexOf('/api/create-user') !== -1);
    ok(creates.length === 2, 'retry does re-run the connect (got ' + creates.length + ')');
  }

  console.log('\nDegraded: the painter cannot find the card');
  {
    // Every paint early-returns, so the guest sees no state changes at all — but
    // the phase is still assigned and the guards still hold, so verifying and
    // connecting must both work. Auth never depends on the card rendering.
    const { w, d, calls } = await boot({
      breakCard: true,
      routes: {
        '/verify/send': () => SENT,
        '/verify/check': () => ({ status: 200, body: { success: true, verificationToken: TOKEN } }),
        '/api/create-user': () => ({ status: 200, body: { success: true, id: 'g1' } }),
      },
    });
    d.getElementById('verifyCode').value = '482913';
    d.getElementById('btnVerify').click();
    await sleep(80);
    ok(w.eval('_verifyState.phase') === 'connecting', 'phase still tracked without a paintable card');
    const creates = calls.filter((c) => String(c.url).indexOf('/api/create-user') !== -1);
    ok(creates.length === 1, 'guest still gets connected when the card cannot be painted');

    // The guard lives in state, not in the DOM, so it holds here too.
    d.getElementById('btnVerify').click();
    await sleep(40);
    ok(calls.filter((c) => String(c.url).indexOf('/api/create-user') !== -1).length === 1,
      'double-submit still blocked with no card to disable');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
