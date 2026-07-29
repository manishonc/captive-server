/**
 * Regression test for the Android pre-auth connected page.
 *
 * Run: node tests/android-connect.test.cjs      (from captive-server/portal)
 * Requires jsdom:  npm i --no-save jsdom
 *
 * Why this exists: Android's captive network assistant closes the instant
 * swarm.cgi authenticates, so /success is never reached and the connected page
 * has to be rendered BEFORE auth, on the /submit response. That makes this the
 * one page where a rendering mistake does not just look wrong — it can stop a
 * guest getting online at all.
 *
 * The load-bearing assertions are the last three:
 *   - the venue's own destination button and auto-redirect are suppressed, since
 *     following either pre-auth navigates away from the page that authenticates
 *   - the swarm.cgi form keeps its exact field contract
 *   - the form still auto-submits even if the cosmetic card fails to build
 */

const fs = require('fs');
const P = require('path');
const ejs = require(P.join(__dirname, '..', 'node_modules', 'ejs'));
const { JSDOM } = require('jsdom');

const PORTAL = P.join(__dirname, '..');
const srv = fs.readFileSync(P.join(PORTAL, 'server.js'), 'utf8');

// Pull the pure helpers out of server.js without booting express.
function extract(name) {
  const i = srv.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('helper not found in server.js: ' + name);
  return srv.slice(i, srv.indexOf('\n}\n', i) + 3);
}
const helpers = (() => {
  const code = [
    'const DEFAULT_PRIMARY="#1c2b4a";',
    'const HEX_COLOR=/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;',
    extract('escapeHtml'), extract('safeColor'), extract('injectBootGate'),
    extract('androidConnectTail'), extract('androidFallbackCard'),
    'module.exports={escapeHtml,injectBootGate,androidConnectTail,androidFallbackCard};',
  ].join('\n');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', 'Buffer', code)(m, m.exports, require, Buffer);
  return m.exports;
})();

// A venue config in the shape /splash-config returns. Deliberately hostile to
// this page: a destination button AND an auto-redirect are both switched on, so
// the test proves they are suppressed rather than merely absent.
const VENUE_CONFIG = {
  templateId: 'spa-wellness',
  title: 'Serenity Spa WiFi',
  subtitle: 'Relax, you are online',
  primaryColor: '#2d5f4f',
  backgroundColor: '#ffffff',
  showLogo: true,
  logoUrl: '',
  showMarketingOptIn: true,
  showPrivacyPolicy: true,
  showTermsOfService: true,
  loginPage: {
    fields: {
      firstName: { enabled: true, label: '', required: true },
      lastName: { enabled: true, label: '', required: true },
      email: { enabled: true, label: '', required: true },
      phone: { enabled: true, label: '', required: true },
    },
    buttonText: 'Continue',
    customFields: [],
  },
  connectedPage: {
    title: 'You are connected',
    subtitle: 'Enjoy your stay',
    showTitle: true, showSubtitle: true, showLogo: true,
    buttonText: 'Visit our site', buttonUrl: 'https://example.com/', showButton: true,
    autoSubmit: false,
    customFields: [{ id: 'visit-again', type: 'checkbox', label: 'I will visit again', required: false, enabled: true }],
    redirectEnabled: true, redirectUrl: 'https://example.com/', redirectDelaySeconds: 3,
  },
};

const SUBMIT_ARGS = {
  switchUrl: 'https://captive-2022.aio.cloudauth.net/swarm.cgi',
  email: 'guest@example.com',
  buttonUrl: 'https://heidifi.ai/',
  buttonHost: 'heidifi.ai',
  primaryColor: '#2d5f4f',
};

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed += 1; console.log('  ✓ ' + msg); }
  else { failed += 1; console.error('  ✗ ' + msg); }
}

async function buildPage({ breakCard = false } = {}) {
  // Mirrors the /submit Android branch exactly.
  const preAuth = {
    ...VENUE_CONFIG,
    view: 'connected',
    connectedPage: { ...VENUE_CONFIG.connectedPage, showButton: false, redirectEnabled: false },
  };
  let html = await ejs.renderFile(P.join(PORTAL, 'public/templates', preAuth.templateId + '.html'), {
    portalConfig: preAuth, portalConfigJson: JSON.stringify(preAuth), previewMode: false,
  });
  html = helpers.injectBootGate(html, preAuth);
  html = html.replace('</body>', helpers.androidConnectTail(SUBMIT_ARGS) + '\n</body>');

  let submitted = false;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://p.heidifi.ai/submit',
    beforeParse(w) {
      w.fetch = () => new Promise(() => {});
      w.HTMLFormElement.prototype.submit = function () { submitted = true; };
      // Simulate config.js never producing the card (404, AP-blocked, parse error).
      if (breakCard) {
        const realGet = w.document.getElementById.bind(w.document);
        w.document.getElementById = (id) => (id === 'stepConnected' ? null : realGet(id));
      }
    },
  });
  const w = dom.window;
  for (const f of ['config.js', 'country-selector.js', 'form-logic.js']) {
    try { w.eval(fs.readFileSync(P.join(PORTAL, 'public/js', f), 'utf8')); }
    catch (e) { console.error('   script threw in ' + f + ': ' + e.message); }
  }
  return { d: w.document, submitted: () => submitted };
}

(async () => {
  console.log('\nAndroid pre-auth connected page');
  const { d, submitted } = await buildPage();

  ok(d.getElementById('stepConnected'), "venue's own card is rendered (not the generic fallback)");
  ok(d.getElementById('step1').className.includes('hidden'), 'login form hidden');
  ok(d.body.textContent.includes('You are connected'), "venue's connected copy is used");
  ok(d.getElementById('connectedFields'), 'venue custom fields still rendered (portal is inside the walled garden)');
  ok(d.documentElement.className.includes('hf-ready'), 'boot gate lifted');

  ok(!d.getElementById('connectedBtn'), 'destination button suppressed — pre-auth it would navigate away');
  ok(!d.getElementById('connectedRedirectLink'), 'auto-redirect suppressed — pre-auth it would navigate away');

  const f = d.getElementById('hfArubaForm');
  ok(f, 'swarm.cgi form present');
  ok(f && f.getAttribute('action') === SUBMIT_ARGS.switchUrl, 'form posts to swarm.cgi');
  ok(f && f.getAttribute('method').toLowerCase() === 'post', 'form method is POST');
  ok(f && f.querySelector('[name=cmd]').value === 'authenticate', 'cmd=authenticate');
  ok(f && f.querySelector('[name=user]').value === SUBMIT_ARGS.email, 'user = guest email');
  ok(f && f.querySelector('[name=password]').value === 'guest', 'password = guest');
  ok(f && f.querySelector('[name=url]').value === SUBMIT_ARGS.buttonUrl, 'url = venue destination');
  ok(d.body.textContent.includes('heidifi.ai'), 'destination hostname shown to the guest');
  ok(/Activating connection in/.test(d.body.textContent), 'countdown shown');

  console.log('  (waiting for the 5s countdown)');
  await new Promise((r) => setTimeout(r, 5500));
  ok(submitted(), 'form auto-submits at t+5s — the guest gets online');

  console.log('\nDegraded: card cannot be built');
  const broken = await buildPage({ breakCard: true });
  ok(broken.d.getElementById('hfArubaForm'), 'form still present');
  await new Promise((r) => setTimeout(r, 5500));
  ok(broken.submitted(), 'form STILL auto-submits — auth never depends on the card rendering');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
