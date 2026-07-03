const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const ejs = require('ejs');

const app = express();
const PORT = 3000;
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '4000', 10);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
// redirect:false — /success is a real route now; without it the static layer
// 301s the bare /success (a directory in public/) before the route can run.
app.use(express.static(path.join(__dirname, 'public'), { index: false, redirect: false }));

const PORTAL_HTML = path.join(__dirname, 'public', 'index.html');
const TEMPLATES_DIR = path.join(__dirname, 'public', 'templates');
const VALID_TEMPLATES = ['classic', 'minimal', 'dark', 'vacation', 'coffee-shop', 'restaurant-dark', 'hotel-luxury', 'restaurant-fine-dining', 'restaurant-casual', 'restaurant-fast-food', 'coffee-artisan', 'coffee-modern', 'airbnb-mountain', 'airbnb-beach', 'spa-wellness', 'coworking', 'bar-lounge', 'airbnb-loft', 'airbnb-countryside', 'airbnb-coastal', 'airbnb-lakehouse', 'airbnb-desert', 'airbnb-city-night', 'airbnb-scandi', 'airbnb-boho', 'airbnb-passport', 'airbnb-bento', 'aurora-glass', 'neon-pulse', 'brutalist-bold', 'neumorphic-soft', 'art-deco', 'editorial-serif'];
const DEFAULT_TEMPLATE = 'classic';

// Fetch splash config from backend (server-to-server, not CNA-side)
function fetchSplashConfig(apmac) {
  return new Promise((resolve) => {
    const reqPath = '/splash-config' + (apmac ? '?apmac=' + encodeURIComponent(apmac) : '');
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
  const { cmd, mac, ip, network, apmac, ap, id, site, post, url, preview, templateId: templateIdOverride } = req.query;
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
    const result = await fetchSplashConfig(resolvedApmac);
    const apRegistered = !resolvedApmac || !result || result.registered !== false;

    if (!apRegistered) {
      return res.sendFile(path.join(__dirname, 'public', 'unregistered.html'));
    }

    const config = (result && result.config) || null;
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
    res.send(html);
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

// GET /api/privacy-policy — proxies to backend GET /privacy-policy
app.get('/api/privacy-policy', (_req, res) => proxyGet('/privacy-policy', res));

// GET /api/terms — proxies to backend GET /terms
app.get('/api/terms', (_req, res) => proxyGet('/terms', res));

// POST /api/unifi-authorize — proxy to server POST /unifi/authorize (UniFi guest access)
app.post('/api/unifi-authorize', (req, res) => {
  const useHttps = SERVER_PORT === 443;
  const http = require(useHttps ? 'https' : 'http');
  const payload = JSON.stringify(req.body);
  const proxyReq = http.request({
    hostname: process.env.SERVER_HOST || 'server',
    port: SERVER_PORT,
    path: '/unifi/authorize',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', (err) => {
    console.error('[UNIFI PROXY ERROR]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach server' });
  });
  proxyReq.write(payload);
  proxyReq.end();
});

// POST /api/create-user — proxy to server service to persist user in Firestore
app.post('/api/create-user', (req, res) => {
  const useHttps = SERVER_PORT === 443;
  const http = require(useHttps ? 'https' : 'http');
  const payload = JSON.stringify(req.body);
  const proxyReq = http.request({
    hostname: process.env.SERVER_HOST || 'server',
    port: SERVER_PORT,
    path: '/create-user',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', (err) => {
    console.error('[PROXY ERROR]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach server' });
  });
  proxyReq.write(payload);
  proxyReq.end();
});

// POST /api/connected-form — proxy to server to store connected-page form answers
app.post('/api/connected-form', (req, res) => {
  const useHttps = SERVER_PORT === 443;
  const http = require(useHttps ? 'https' : 'http');
  const payload = JSON.stringify(req.body);
  const proxyReq = http.request({
    hostname: process.env.SERVER_HOST || 'server',
    port: SERVER_PORT,
    path: '/connected-form',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      res.status(proxyRes.statusCode).set('Content-Type', 'application/json').send(data);
    });
  });
  proxyReq.on('error', (err) => {
    console.error('[CONNECTED FORM PROXY ERROR]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach server' });
  });
  proxyReq.write(payload);
  proxyReq.end();
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  try {
    const result = await fetchSplashConfig(apmac);
    const config = (result && result.config) || {};
    const cp = config.connectedPage || {};
    if (typeof cp.buttonUrl === 'string' && /^https:\/\//i.test(cp.buttonUrl)) {
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
  const redirectUrl = `http://${portalDomain}/success`
    + `?apmac=${encodeURIComponent(apmac || '')}&mac=${encodeURIComponent(mac || '')}`;

  if (isAndroid) {
    // Android closes the CNA the instant it detects internet (right when swarm.cgi
    // authenticates), so any success page shown AFTER auth is never seen.
    // Fix: show the destination info FIRST with a 5-second countdown, THEN submit
    // to swarm.cgi. The user sees "open heidifi.ai" before the CNA closes.
    res.send(`<!DOCTYPE html>
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
      document.getElementById('btn').textContent = 'Connecting\u2026';
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
</html>`);
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
    <input type="hidden" name="url" value="${escapeHtml(redirectUrl)}" />
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
  const { apmac, ap, preview, templateId: templateIdOverride } = req.query;
  const resolvedApmac = apmac || ap;
  try {
    const result = await fetchSplashConfig(resolvedApmac);
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
    res.send(html);
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
