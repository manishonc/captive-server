const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const ejs = require('ejs');
const crypto = require('crypto');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '4000', 10);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
// redirect:false — /success is a real route now; without it the static layer
// 301s the bare /success (a directory in public/) before the route can run.
// maxAge — /js/config.js is 28 KB and used to be revalidated on every single
// portal hit, which on a barely-open captive link is a large slice of the delay
// before the page can be branded. An hour is short enough that a redeploy reaches
// returning devices quickly; the tenant's config is never cached here, it rides
// inline in the HTML below.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  redirect: false,
  maxAge: '1h',
}));

const PORTAL_HTML = path.join(__dirname, 'public', 'index.html');
const TEMPLATES_DIR = path.join(__dirname, 'public', 'templates');
const VALID_TEMPLATES = ['classic', 'minimal', 'dark', 'vacation', 'coffee-shop', 'restaurant-dark', 'hotel-luxury', 'restaurant-fine-dining', 'restaurant-casual', 'restaurant-fast-food', 'coffee-artisan', 'coffee-modern', 'airbnb-mountain', 'airbnb-beach', 'spa-wellness', 'coworking', 'bar-lounge', 'airbnb-loft', 'airbnb-countryside', 'airbnb-coastal', 'airbnb-lakehouse', 'airbnb-desert', 'airbnb-city-night', 'airbnb-scandi', 'airbnb-boho', 'airbnb-passport', 'airbnb-bento', 'aurora-glass', 'neon-pulse', 'brutalist-bold', 'neumorphic-soft', 'art-deco', 'editorial-serif'];
const DEFAULT_TEMPLATE = 'classic';
// Views the CMS splash editor may force via ?view=. Preview-gated: a guest must
// never be able to jump past step 1 by editing the query string.
const PREVIEWABLE_VIEWS = ['consent', 'verify'];
// Lets the backend trust the X-Forwarded-For we set on proxied guest requests.
const PORTAL_SHARED_SECRET = process.env.PORTAL_SHARED_SECRET || '';

// Fetch splash config from backend (server-to-server, not CNA-side)
// `draft` is a preview-only opaque id for a splash config the CMS has staged but
// not published (see internal/splash-config in the CMS). The backend renders it
// through the same defaults as a live config, and it works without an apmac so a
// venue with no access point yet can still be designed.
function fetchSplashConfig(apmac, draft) {
  return new Promise((resolve) => {
    const params = new URLSearchParams();
    if (apmac) params.set('apmac', apmac);
    if (draft) params.set('draft', draft);
    const qs = params.toString();
    const reqPath = '/splash-config' + (qs ? '?' + qs : '');
    const useHttps = SERVER_PORT === 443;
    const http = require(useHttps ? 'https' : 'http');
    const r = http.request({
      hostname: process.env.SERVER_HOST || 'server',
      port: SERVER_PORT,
      path: reqPath,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(5000, () => { r.destroy(); resolve(null); });
    r.end();
  });
}

// ── Boot gate ──────────────────────────────────────────────────────────────
// Every template ships #step1 visible and loads /js/config.js as the LAST tag in
// <body>. So the browser paints the raw template first and only then runs the
// script that brands it — on / the guest sees the template's placeholder copy
// before the venue's own, and on /success (which renders the very same template,
// with view:'connected' merged in) the guest sees the login form again for as
// long as config.js takes to arrive. On a captive link that is about a second.
//
// Gate only the parts that are actually wrong until then — #step1 and #step2 hold
// the copy, labels and logo that config.js rewrites — and float a spinner over
// them. The template's own chrome (card, decorations) is static CSS that is always
// correct, so it paints straight away and the page never flips colour mid-load.
// config.js lifts the gate with <html class="hf-ready"> once branding and the
// correct view are in place. Injected server-side so all 33 templates are covered
// without editing any of them.
const DEFAULT_PRIMARY = '#1c2b4a';
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// These land inside a <style> block, so anything but a literal hex colour is an
// injection vector. Tenant input is never trusted here — bad values fall back.
// Normalised to 6 digits because the spinner track appends an alpha pair: '#abc33'
// and '#rrggbbaa33' are both invalid, and an invalid colour drops the whole
// `border` shorthand, which would leave the spinner with no ring at all.
function safeColor(value, fallback) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value.trim())) return fallback;
  let hex = value.trim().toLowerCase();
  if (hex.length === 4) hex = '#' + hex.slice(1).split('').map((c) => c + c).join('');
  return hex.slice(0, 7);
}

function injectBootGate(html, config) {
  const fg = safeColor(config && config.primaryColor, DEFAULT_PRIMARY);

  // Paint the venue's background from the very first frame instead of letting
  // config.js swap it in later. Skipped for #ffffff, which the templates treat as
  // "unset" so their own decorative background survives — see the inline script
  // each template runs right after window.PORTAL_CONFIG.
  const rawBg = safeColor(config && config.backgroundColor, '');
  const bodyBg = (rawBg && rawBg !== '#ffffff')
    ? `  html:not(.hf-ready) body { background: ${rawBg}; }\n`
    : '';

  const head = `
<link rel="preload" as="script" href="/js/config.js">
<style id="hf-boot-style">
${bodyBg}  html:not(.hf-ready) #step1,
  html:not(.hf-ready) #stepVerify,
  html:not(.hf-ready) #step2 { visibility: hidden; }
  #hf-boot {
    position: fixed; top: 0; right: 0; bottom: 0; left: 0;
    display: flex; align-items: center; justify-content: center;
    z-index: 2147483647;
    transition: opacity .18s ease-out;
  }
  #hf-boot i {
    display: block; width: 34px; height: 34px;
    border: 3px solid ${fg}33; border-top-color: ${fg}; border-radius: 50%;
    animation: hf-spin .7s linear infinite;
  }
  @keyframes hf-spin { to { transform: rotate(360deg); } }
  html.hf-ready #hf-boot { opacity: 0; pointer-events: none; }
  @media (prefers-reduced-motion: reduce) { #hf-boot i { animation-duration: 2.4s; } }
</style>
<script>
  // Failsafe: if config.js never runs — 404, parse error, blocked by the AP — the
  // guest must still get a usable page rather than an endless spinner. Worst case
  // they see the unbranded template, which is exactly the old behaviour.
  setTimeout(function () {
    document.documentElement.classList.add('hf-ready');
  }, 4000);
</script>`;

  // Anchors verified present in all 33 templates: every one has a </head> and a
  // bare <body>. Both replaces are first-occurrence only, which is what we want.
  return html
    .replace('</head>', `${head}\n</head>`)
    .replace('<body>', '<body>\n<div id="hf-boot" aria-hidden="true"><i></i></div>');
}

// UniFi external hotspot redirects to /guest/s/{site}/ (not /). Forward to / with params intact.
// UniFi uses ap + id; Aruba uses apmac + mac — normalize below.
app.get('/guest/s/:site', (req, res) => {
  const q = new URLSearchParams(req.query);
  if (req.query.ap && !q.has('apmac')) q.set('apmac', String(req.query.ap));
  if (req.query.id && !q.has('mac')) q.set('mac', String(req.query.id));
  const qs = q.toString();
  console.log('[PORTAL UNIFI]', req.path, qs || '(no query)');
  res.redirect(302, '/' + (qs ? '?' + qs : ''));
});

// GET / — captive portal entry point
// Pass ?preview=1 to render with the preview banner (dashboard use only).
// Aruba never appends this param so real users are unaffected.
app.get('/', async (req, res) => {
  const { cmd, mac, ip, network, apmac, ap, id, site, post, url, preview, view, draft, templateId: templateIdOverride } = req.query;
  const resolvedApmac = apmac || ap;
  const resolvedMac = mac || id;
  if (cmd || ap) {
    console.log('[PORTAL HIT]', JSON.stringify({
      vendor: ap ? 'unifi' : 'aruba',
      cmd, mac: resolvedMac, ip, network, apmac: resolvedApmac, site, post, url,
      timestamp: new Date().toISOString(),
    }));
  }

  try {
    // Preview-gated like ?view= and ?templateId=: a guest must never be able to
    // render an unpublished config by editing the query string.
    const draftId = preview === '1' && draft ? String(draft) : undefined;
    const result = await fetchSplashConfig(resolvedApmac, draftId);
    const apRegistered = !resolvedApmac || !result || result.registered !== false;

    if (!apRegistered) {
      return res.sendFile(path.join(__dirname, 'public', 'unregistered.html'));
    }

    let config = (result && result.config) || null;
    // Preview-only view switch (CMS consent-page editor) — same mechanism as
    // /success's view:'connected'. Gated on preview so guests can't skip step 1.
    if (preview === '1' && PREVIEWABLE_VIEWS.includes(view)) {
      config = { ...(config || {}), view };
    }
    // In preview mode, allow ?templateId= to override the saved template (CMS template picker)
    const rawId = (preview === '1' && templateIdOverride && VALID_TEMPLATES.includes(templateIdOverride))
      ? templateIdOverride
      : (config?.templateId || DEFAULT_TEMPLATE);
    const templateId = VALID_TEMPLATES.includes(rawId) ? rawId : DEFAULT_TEMPLATE;
    const templatePath = path.join(TEMPLATES_DIR, `${templateId}.html`);
    const html = await ejs.renderFile(templatePath, {
      portalConfig: config,
      portalConfigJson: config ? JSON.stringify(config) : 'undefined',
      previewMode: preview === '1',
    });
    res.send(injectBootGate(html, config));
  } catch (err) {
    console.error('[PORTAL RENDER ERROR]', err);
    res.sendFile(PORTAL_HTML);
  }
});

// Generic proxy helper for GET requests to the backend server
function proxyGet(backendPath, res) {
  const useHttps = SERVER_PORT === 443;
  const http = require(useHttps ? 'https' : 'http');
  const proxyReq = http.request({
    hostname: process.env.SERVER_HOST || 'server',
    port: SERVER_PORT,
    path: backendPath,
    method: 'GET',
  }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', () => res.status(502).json({ success: false }));
  proxyReq.end();
}

// Forward the AP MAC so the backend can resolve venue-specific document overrides.
function docPath(backendPath, req) {
  const apmac = String(req.query.apmac || '').trim();
  return apmac ? `${backendPath}?apmac=${encodeURIComponent(apmac)}` : backendPath;
}

// GET /api/privacy-policy — proxies to backend GET /privacy-policy
app.get('/api/privacy-policy', (req, res) => proxyGet(docPath('/privacy-policy', req), res));

// GET /api/terms — proxies to backend GET /terms
app.get('/api/terms', (req, res) => proxyGet(docPath('/terms', req), res));

/**
 * Generic POST proxy to the backend.
 *
 * Forwards the guest's real address in X-Forwarded-For alongside the shared
 * secret. Without this every request reaches the backend carrying THIS
 * container's IP — identical for every guest in the estate — which makes any
 * per-IP rate limit either useless or, worse, a throttle applied to all venues
 * collectively. The backend only trusts the header when the secret matches
 * (port 4000 is published on the host, so an unconditional read would be
 * trivially spoofable).
 */
function proxyPost(backendPath, req, res, tag) {
  const useHttps = SERVER_PORT === 443;
  const http = require(useHttps ? 'https' : 'http');
  const payload = JSON.stringify(req.body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  const guestIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  if (guestIp) headers['X-Forwarded-For'] = guestIp;
  if (PORTAL_SHARED_SECRET) headers['x-portal-secret'] = PORTAL_SHARED_SECRET;

  const proxyReq = http.request({
    hostname: process.env.SERVER_HOST || 'server',
    port: SERVER_PORT,
    path: backendPath,
    method: 'POST',
    headers,
  }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', (err) => {
    console.error(`[${tag} PROXY ERROR]`, err.message);
    res.status(502).json({ success: false, message: 'Could not reach server' });
  });
  proxyReq.write(payload);
  proxyReq.end();
}

// POST /api/unifi-authorize — proxy to server POST /unifi/authorize (UniFi guest access)
app.post('/api/unifi-authorize', (req, res) => proxyPost('/unifi/authorize', req, res, 'UNIFI'));

// POST /api/create-user — proxy to server service to persist user in Firestore
app.post('/api/create-user', (req, res) => proxyPost('/create-user', req, res, 'CREATE-USER'));

// POST /api/connected-form — proxy to server to store connected-page form answers
app.post('/api/connected-form', (req, res) => proxyPost('/connected-form', req, res, 'CONNECTED FORM'));

// Guest contact verification (OTP). The backend refuses any request flagged as
// preview, so the CMS splash preview can never spend an SMS/WhatsApp credit.
app.post('/api/verify/send', (req, res) => proxyPost('/verify/send', req, res, 'VERIFY SEND'));
app.post('/api/verify/check', (req, res) => proxyPost('/verify/check', req, res, 'VERIFY CHECK'));

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The swarm.cgi login form plus the countdown UI, injected into the venue's own
 * connected template for Android guests.
 *
 * Android's CNA closes the instant swarm.cgi authenticates, so /success is never
 * reached — the connected page has to be shown BEFORE auth, on this response.
 *
 * The timer is armed before any DOM work and every cosmetic step is wrapped, so
 * a rendering failure delays nobody: the guest still gets online at t+5s. Auth
 * must never depend on the card looking right.
 */
function androidConnectTail({ switchUrl, email, buttonUrl, buttonHost, primaryColor }) {
  return `
<form id="hfArubaForm" method="POST" action="${escapeHtml(switchUrl)}" style="display:none">
  <input type="hidden" name="cmd" value="authenticate">
  <input type="hidden" name="user" value="${escapeHtml(email)}">
  <input type="hidden" name="password" value="guest">
  <input type="hidden" name="url" value="${escapeHtml(buttonUrl)}">
</form>
<script>
(function () {
  var form = document.getElementById('hfArubaForm');
  var secs = 5, submitted = false, label = null, btn = null;

  function go() {
    if (submitted) return;
    submitted = true;
    clearInterval(timer);
    try { if (btn) { btn.disabled = true; btn.textContent = 'Connecting\\u2026'; } } catch (e) {}
    form.submit();
  }
  var timer = setInterval(function () {
    secs -= 1;
    try { if (label) label.textContent = 'Activating connection in ' + secs + 's\\u2026'; } catch (e) {}
    if (secs <= 0) go();
  }, 1000);

  try {
    // config.js has already built #stepConnected from the venue's config by the
    // time this runs — it is the last script in the body.
    var card = document.getElementById('stepConnected') || document.body;
    var sampleBtn = document.querySelector('.btn-primary');

    var hint = document.createElement('p');
    hint.className = 'section-sub';
    hint.textContent = 'Open your browser and visit:';

    var box = document.createElement('div');
    box.style.cssText = 'background:rgba(0,0,0,.05);border-radius:10px;padding:14px;margin:12px 0;text-align:center';
    var host = document.createElement('span');
    host.textContent = ${JSON.stringify(buttonHost)};
    host.style.cssText = 'font-size:20px;font-weight:700;letter-spacing:.5px;color:${primaryColor}';
    box.appendChild(host);

    label = document.createElement('p');
    label.className = 'section-sub';
    label.style.cssText = 'font-size:12px;opacity:.7;margin:0 0 12px';
    label.textContent = 'Activating connection in ' + secs + 's\\u2026';

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = sampleBtn ? sampleBtn.className : 'btn-primary';
    btn.textContent = 'Connect Now';
    btn.onclick = go;

    card.appendChild(hint);
    card.appendChild(box);
    card.appendChild(label);
    card.appendChild(btn);
  } catch (e) { /* cosmetic only — the timer above still authenticates */ }
})();
</script>`;
}

/**
 * Pre-verification fallback: the original self-contained card. Used when the
 * venue's template cannot be rendered, so a template problem can never stop an
 * Android guest getting online.
 */
function androidFallbackCard({ switchUrl, email, buttonUrl, buttonHost, primaryColor }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're Connected!</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea,#764ba2);padding:20px}
    .card{background:#fff;border-radius:16px;padding:36px 28px;width:100%;max-width:360px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.15)}
    .icon{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#48bb78,#38a169);margin:0 auto 20px;display:flex;align-items:center;justify-content:center}
    h1{font-size:22px;color:#333;margin-bottom:8px}
    .sub{font-size:14px;color:#888;margin-bottom:20px;line-height:1.5}
    .url-box{background:#f0f4ff;border-radius:10px;padding:14px;margin-bottom:20px}
    .url-box span{font-size:20px;font-weight:700;color:${primaryColor};letter-spacing:.5px}
    .hint{font-size:12px;color:#aaa;margin-bottom:20px}
    button{width:100%;padding:14px;background:${primaryColor};color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer}
    button:disabled{opacity:.6;cursor:not-allowed}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
    </div>
    <h1>You're Connected!</h1>
    <p class="sub">You now have WiFi access.<br>Open your browser and visit:</p>
    <div class="url-box"><span>${escapeHtml(buttonHost)}</span></div>
    <p class="hint" id="hint">Activating connection in <strong id="n">5</strong>s&hellip;</p>
    <button id="btn" onclick="connect()">Connect Now</button>
  </div>

  <form id="f" method="POST" action="${escapeHtml(switchUrl)}" style="display:none">
    <input type="hidden" name="cmd" value="authenticate">
    <input type="hidden" name="user" value="${escapeHtml(email)}">
    <input type="hidden" name="password" value="guest">
    <input type="hidden" name="url" value="${escapeHtml(buttonUrl)}">
  </form>

  <script>
    function connect() {
      clearInterval(t);
      document.getElementById('btn').disabled = true;
      document.getElementById('btn').textContent = 'Connecting…';
      document.getElementById('f').submit();
    }
    var n = 5;
    var t = setInterval(function() {
      n--;
      document.getElementById('n').textContent = n;
      if (n <= 0) connect();
    }, 1000);
  </script>
</body>
</html>`;
}

/**
 * Local validation of a guest verification token.
 *
 * This is the Aruba grant path: /submit emits an auto-submitting form to
 * swarm.cgi, so once we respond the guest is authenticated. Gating only
 * /create-user would leave a direct POST here wide open.
 *
 * Validated locally with pure crypto rather than a backend round trip, because
 * this sits on the critical path to getting online. The checks mirror the
 * server's (services/verificationToken.ts): version, HMAC, expiry, venue scope,
 * and the destination the guest is actually submitting.
 *
 * Returns { ok, reason }.
 */
function verifyTokenLocally(token, expected) {
  const secret = process.env.GUEST_VERIFICATION_SIGNING_SECRET || '';
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (typeof token !== 'string' || !token.trim()) return { ok: false, reason: 'missing' };

  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'hv1') return { ok: false, reason: 'malformed' };

  const data = `${parts[0]}.${parts[1]}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'expired' };
  // A token minted at another venue must not work here.
  if (expected.scopeKey && payload.s !== expected.scopeKey) {
    return { ok: false, reason: 'scope_mismatch' };
  }
  // A waiver token authorizes without proving anything — the backend issues it
  // when the venue's daily OTP budget is spent.
  if (payload.b === 1) return { ok: true, bypassed: true };
  // Email is the only destination this path can re-derive; phone-channel tokens
  // are re-checked by the backend on /create-user, which runs before this.
  if (payload.c === 'email') {
    const submitted = String(expected.email || '').trim().toLowerCase();
    if (!submitted || payload.d !== submitted) return { ok: false, reason: 'destination_mismatch' };
  }
  return { ok: true };
}

// POST /submit — log guest data, return auto-submit form to Aruba cloud auth
app.post('/submit', async (req, res) => {
  const { firstName, lastName, email, mac, ip, url, post, apmac } = req.body;
  const ua = req.headers['user-agent'] || '';
  const isAndroid = /Android/i.test(ua);

  console.log('[GUEST SUBMIT]', JSON.stringify({
    firstName,
    lastName,
    email,
    mac,
    ip,
    post,
    platform: isAndroid ? 'android' : 'other',
    timestamp: new Date().toISOString()
  }));

  // Configured connected-page destination; hardcoded defaults kept when the
  // backend is unreachable — auth must never block on config.
  let buttonUrl = 'https://heidifi.ai/';
  let primaryColor = '#667eea';
  // Hoisted: the Android branch below renders the venue's own template from it.
  let config = {};
  try {
    const result = await fetchSplashConfig(apmac);
    config = (result && result.config) || {};

    // Verification gate for the Aruba path. `verificationPage` here is the
    // RESOLVED config (the backend already subtracted unusable channels), so
    // enabled:true means this venue genuinely requires a verified contact.
    if (config.verificationPage && config.verificationPage.enabled === true) {
      const verdict = verifyTokenLocally(req.body.verificationToken, {
        scopeKey: config.scopeKey,
        email,
      });
      if (!verdict.ok) {
        console.warn('[VERIFY GATE] /submit refused:', verdict.reason, apmac);
        return res.status(403).json({ success: false, code: 'verification_required', reason: verdict.reason });
      }
    }

    const cp = config.connectedPage || {};
    // Android's CNA closes the moment swarm.cgi authenticates, so /success never
    // renders and this is the ONLY destination these guests reach. When the venue
    // configured a redirect that is their intended destination — honouring
    // buttonUrl instead would send Android somewhere different from every other
    // platform in the same venue.
    const redirectActive = cp.redirectEnabled === true
      && typeof cp.redirectUrl === 'string' && /^https:\/\//i.test(cp.redirectUrl);
    if (redirectActive) {
      buttonUrl = cp.redirectUrl;
    } else if (typeof cp.buttonUrl === 'string' && /^https:\/\//i.test(cp.buttonUrl)) {
      buttonUrl = cp.buttonUrl;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(config.primaryColor || '')) {
      primaryColor = config.primaryColor;
    }
  } catch (err) {
    console.error('[SUBMIT CONFIG ERROR]', err);
  }
  let buttonHost = 'heidifi.ai';
  try { buttonHost = new URL(buttonUrl).hostname; } catch { /* keep default */ }

  const switchUrl = `https://${post}/swarm.cgi`;
  const portalDomain = process.env.PORTAL_DOMAIN || req.headers.host;
  // Named to distinguish it from connectedPage.redirectUrl — this is where Aruba
  // returns the guest so /success can render, not a tenant destination.
  const successReturnUrl = `http://${portalDomain}/success`
    + `?apmac=${encodeURIComponent(apmac || '')}&mac=${encodeURIComponent(mac || '')}`;

  const cardArgs = { switchUrl, email, buttonUrl, buttonHost, primaryColor };

  if (isAndroid) {
    // Android closes the CNA the instant swarm.cgi authenticates, so /success is
    // never reached. Render the venue's OWN connected template here instead, and
    // inject the login form + countdown into it — Android then sees the same
    // styled card every other device gets, rather than a generic one.
    try {
      // Pre-auth sanitisation. The guest has no internet yet, so the venue's
      // destination button and any auto-redirect would navigate away from the
      // very page that authenticates them. Custom fields stay: they post to the
      // portal, which is inside the walled garden.
      const preAuthConfig = {
        ...config,
        view: 'connected',
        connectedPage: {
          ...(config.connectedPage || {}),
          showButton: false,
          redirectEnabled: false,
        },
      };
      const rawId = preAuthConfig.templateId || DEFAULT_TEMPLATE;
      const templateId = VALID_TEMPLATES.includes(rawId) ? rawId : DEFAULT_TEMPLATE;
      const html = await ejs.renderFile(path.join(TEMPLATES_DIR, `${templateId}.html`), {
        portalConfig: preAuthConfig,
        portalConfigJson: JSON.stringify(preAuthConfig),
        previewMode: false,
      });
      const gated = injectBootGate(html, preAuthConfig);
      // Injected last in the body so config.js has already built #stepConnected.
      return res.send(gated.replace('</body>', `${androidConnectTail(cardArgs)}\n</body>`));
    } catch (err) {
      // A template problem must never stop a guest getting online.
      console.error('[ANDROID CONNECT RENDER ERROR]', err);
      return res.send(androidFallbackCard(cardArgs));
    }
  } else {
    // iOS / macOS / other: auto-submit immediately, then /success handles opening
    // the real browser via window.open (iOS) or a target=_blank button (macOS).
    res.send(`<!DOCTYPE html>
<html>
<head><title>Connecting...</title></head>
<body>
  <p style="text-align:center;margin-top:40vh;font-family:sans-serif;color:#555;">Connecting you to the internet...</p>
  <form id="loginForm" method="POST" action="${escapeHtml(switchUrl)}">
    <input type="hidden" name="cmd" value="authenticate" />
    <input type="hidden" name="user" value="${escapeHtml(email)}" />
    <input type="hidden" name="password" value="guest" />
    <input type="hidden" name="url" value="${escapeHtml(successReturnUrl)}" />
  </form>
  <script>document.getElementById('loginForm').submit();</script>
</body>
</html>`);
  }
});

// GET /success — shown after authentication, lets user open real browser.
// Renders the venue's splash template with view:'connected' so the page matches
// the selected design (config.js builds the connected card). Falls back to the
// legacy static page whenever the backend or rendering is unavailable.
const STATIC_SUCCESS_HTML = path.join(__dirname, 'public', 'success', 'index.html');
app.get('/success', async (req, res) => {
  const { apmac, ap, preview, draft, templateId: templateIdOverride } = req.query;
  const resolvedApmac = apmac || ap;
  try {
    // Preview-gated, same as on GET / — see the note on fetchSplashConfig.
    const draftId = preview === '1' && draft ? String(draft) : undefined;
    const result = await fetchSplashConfig(resolvedApmac, draftId);
    if (!result || result.registered === false) {
      return res.sendFile(STATIC_SUCCESS_HTML);
    }
    // view:'connected' rides inside the config JSON so no template needs editing.
    const config = { ...(result.config || {}), view: 'connected' };
    const rawId = (preview === '1' && templateIdOverride && VALID_TEMPLATES.includes(templateIdOverride))
      ? templateIdOverride
      : (config.templateId || DEFAULT_TEMPLATE);
    const templateId = VALID_TEMPLATES.includes(rawId) ? rawId : DEFAULT_TEMPLATE;
    const templatePath = path.join(TEMPLATES_DIR, `${templateId}.html`);
    const html = await ejs.renderFile(templatePath, {
      portalConfig: config,
      portalConfigJson: JSON.stringify(config),
      previewMode: preview === '1',
    });
    res.send(injectBootGate(html, config));
  } catch (err) {
    console.error('[SUCCESS RENDER ERROR]', err);
    res.sendFile(STATIC_SUCCESS_HTML);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Captive portal running on port ${PORT}`);
});
