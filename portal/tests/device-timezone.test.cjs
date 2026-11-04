/**
 * The phone's time zone on /create-user and /unifi-authorize.
 *
 * Run: node tests/device-timezone.test.cjs        (from captive-server/portal)
 * Requires jsdom:  npm i --no-save jsdom
 *
 * Adaptive Campaigns keeps quiet hours (21:00–09:00) and send times in the guest's own time
 * (manager spec §2: "timezone — captured at connect"). The portal sends what the browser says,
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`; the server checks it. A browser that
 * can't say sends an empty string, and the login works as before.
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

/**
 * Boots the portal with the browser's zone faked (`zone`: a name, or 'throw' for a browser
 * whose Intl fails), fills step 1, walks to the consent step and taps Accept.
 */
async function connect({ zone, query = '?apmac=aa:bb:cc:dd:ee:ff&mac=11:22:33:44:55:66' }) {
  const cfg = JSON.parse(JSON.stringify(CONFIG_FIXTURE));
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
      const Real = w.Intl.DateTimeFormat;
      const fake = function (locales, options) {
        if (options && options.timeZone) return new Real(locales, options); // the page's own formatting
        if (zone === 'throw') throw new Error('no Intl here');
        const real = new Real(locales, options);
        return { format: (d) => real.format(d), resolvedOptions: () => Object.assign({}, real.resolvedOptions(), { timeZone: zone }) };
      };
      fake.supportedLocalesOf = Real.supportedLocalesOf;
      w.Intl.DateTimeFormat = fake;
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
  d.getElementById('btnAccept').click();
  await sleep(60);
  return calls;
}

const bodyOf = (calls, path) => (calls.find((c) => c.url.indexOf(path) !== -1) || {}).body;

(async () => {
  console.log('\nThe browser knows its zone');
  {
    const calls = await connect({ zone: 'Europe/London' });
    const b = bodyOf(calls, '/api/create-user');
    ok(b && b.timezone === 'Europe/London', 'create-user: timezone is the browser\'s zone');
    ok(b && b.marketingConsent && b.marketingConsent.given === true, 'the rest of the body is as before');
  }

  console.log('\nUniFi: /unifi-authorize carries it too');
  {
    const calls = await connect({ zone: 'Asia/Kolkata', query: '?ap=aa:bb:cc:dd:ee:ff&id=11:22:33:44:55:66' });
    ok((bodyOf(calls, '/api/create-user') || {}).timezone === 'Asia/Kolkata', 'create-user: Asia/Kolkata');
    ok((bodyOf(calls, '/api/unifi-authorize') || {}).timezone === 'Asia/Kolkata', 'unifi-authorize: Asia/Kolkata');
  }

  console.log('\nA browser whose Intl fails still logs in');
  {
    const calls = await connect({ zone: 'throw' });
    const b = bodyOf(calls, '/api/create-user');
    ok(b && b.timezone === '', 'create-user: timezone is empty');
    ok(b && b.email === 'guest@example.com', 'the login went ahead');
  }

  console.log('\nAn absurdly long value is cut to 64 characters (the server refuses it anyway)');
  {
    const calls = await connect({ zone: 'Europe/' + 'x'.repeat(100) });
    const b = bodyOf(calls, '/api/create-user');
    ok(b && typeof b.timezone === 'string' && b.timezone.length === 64, 'timezone is 64 characters');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
