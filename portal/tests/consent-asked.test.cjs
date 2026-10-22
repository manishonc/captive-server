/**
 * consentAsked on /create-user and /unifi-authorize.
 *
 * Run: node tests/consent-asked.test.cjs        (from captive-server/portal)
 * Requires jsdom:  npm i --no-save jsdom
 *
 * Adaptive Campaigns reads an explicit "I don't want to stay in touch" as the guest taking back an
 * earlier yes. The portal therefore says whether the guest actually saw the consent step and tapped
 * a button on it (consentAsked: true), so a venue that hides the step (its "no" is ours, not the
 * guest's) never takes anything back. marketingConsent itself is sent exactly as before.
 */

const fs = require('fs');
const P = require('path');
const ejs = require(P.join(__dirname, '..', 'node_modules', 'ejs'));
const { JSDOM } = require('jsdom');

const PORTAL = P.join(__dirname, '..');

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
      phone: { enabled: true, label: '', required: false },
    },
    buttonText: 'Continue', customFields: [],
  },
  consentPage: {
    heading: 'Privacy', subheading: '', bodyParagraphs: ['We care.'],
    acceptButtonText: 'Accept', declineButtonText: 'No thanks',
  },
  verificationPage: { enabled: false },
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

/** Boots the portal, fills step 1 and walks to the consent step (or past it when it is hidden). */
async function boot({ showMarketingOptIn = true, query = '?apmac=aa:bb:cc:dd:ee:ff&mac=11:22:33:44:55:66' } = {}) {
  const cfg = JSON.parse(JSON.stringify(CONFIG_FIXTURE));
  cfg.showMarketingOptIn = showMarketingOptIn;
  const html = await ejs.renderFile(P.join(PORTAL, 'public/templates', cfg.templateId + '.html'), {
    portalConfig: cfg, portalConfigJson: JSON.stringify(cfg), previewMode: false,
  });
  const calls = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://p.heidifi.ai/' + query,
    beforeParse(w) {
      w.HTMLFormElement.prototype.submit = function () {};
      w.fetch = (url, init) => {
        calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : {} });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      };
    },
  });
  const w = dom.window;
  for (const f of ['config.js', 'country-selector.js', 'form-logic.js']) {
    try { w.eval(fs.readFileSync(P.join(PORTAL, 'public/js', f), 'utf8')); }
    catch (e) { console.error('   script threw in ' + f + ': ' + e.message); }
  }
  const d = w.document;
  d.getElementById('firstName').value = 'Test';
  d.getElementById('lastName').value = 'Guest';
  d.getElementById('email').value = 'guest@example.com';
  w.goToConsent();
  await sleep(20);
  return { w, d, calls };
}

const bodyOf = (calls, path) => (calls.find((c) => c.url.indexOf(path) !== -1) || {}).body;

(async () => {
  console.log('\nAccept on the consent step');
  {
    const { d, calls } = await boot();
    d.getElementById('btnAccept').click();
    await sleep(40);
    const b = bodyOf(calls, '/api/create-user');
    ok(b && b.marketingConsent && b.marketingConsent.given === true, 'marketingConsent.given is true');
    ok(b && b.consentAsked === true, 'consentAsked is true');
    ok(b && !('asked' in b.marketingConsent) && !('consentAsked' in b.marketingConsent), 'marketingConsent itself is unchanged');
  }

  console.log('\n"I don\'t want to stay in touch" on the consent step');
  {
    const { d, calls } = await boot();
    d.getElementById('btnDecline').click();
    await sleep(40);
    const b = bodyOf(calls, '/api/create-user');
    ok(b && b.marketingConsent && b.marketingConsent.given === false, 'marketingConsent.given is false');
    ok(b && b.consentAsked === true, 'consentAsked is true: an explicit no');
  }

  console.log('\nThe venue hides the consent step');
  {
    const { d, calls } = await boot({ showMarketingOptIn: false });
    const b = bodyOf(calls, '/api/create-user');
    ok(d.getElementById('step2').classList.contains('hidden'), 'the consent step was never shown');
    ok(b && b.marketingConsent && b.marketingConsent.given === false, 'marketingConsent.given is false');
    ok(b && b.consentAsked === false, 'consentAsked is false: not the guest\'s no');
  }

  console.log('\nUniFi: /unifi-authorize carries it too');
  {
    const { d, calls } = await boot({ query: '?ap=aa:bb:cc:dd:ee:ff&id=11:22:33:44:55:66' });
    d.getElementById('btnDecline').click();
    await sleep(60);
    const create = bodyOf(calls, '/api/create-user');
    const auth = bodyOf(calls, '/api/unifi-authorize');
    ok(create && create.consentAsked === true, 'create-user: consentAsked true');
    ok(auth && auth.consentAsked === true && auth.marketingConsent && auth.marketingConsent.given === false, 'unifi-authorize: consentAsked true, given false');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
