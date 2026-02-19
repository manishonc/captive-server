const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Load restaurant config
const restaurantsPath = path.join(__dirname, 'restaurants.json');
let aps = {};
try {
  const config = JSON.parse(fs.readFileSync(restaurantsPath, 'utf8'));
  aps = config.aps || {};
} catch (err) {
  console.error('[WARN] Could not load restaurants.json, all requests will use default template:', err.message);
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve per-restaurant static assets: /static/<slug>/* → templates/<slug>/*
app.use('/static/:slug', (req, res, next) => {
  const slug = req.params.slug.replace(/[^a-z0-9_-]/gi, '');
  const templateDir = path.join(__dirname, 'templates', slug);
  express.static(templateDir)(req, res, next);
});

// GET / — look up restaurant by apmac, serve its template
app.get('/', (req, res) => {
  const { cmd, mac, ip, network, apmac, site, post, url } = req.query;
  if (cmd) {
    console.log('[PORTAL HIT]', JSON.stringify({ cmd, mac, ip, network, apmac, site, post, url, timestamp: new Date().toISOString() }));
  }

  const apConfig = apmac && aps[apmac];
  const slug = (apConfig && apConfig.slug) || 'default';
  const templateFile = path.join(__dirname, 'templates', slug, 'index.html');

  // Fall back to default if the resolved template doesn't exist
  if (slug !== 'default' && !fs.existsSync(templateFile)) {
    console.warn(`[WARN] Template not found for slug "${slug}", falling back to default`);
    return res.sendFile(path.join(__dirname, 'templates', 'default', 'index.html'));
  }

  res.sendFile(templateFile);
});

// POST /api/create-user — proxy to server service to persist user in Firestore
app.post('/api/create-user', (req, res) => {
  const http = require('http');
  const payload = JSON.stringify(req.body);
  const proxyReq = http.request({
    hostname: process.env.SERVER_HOST || 'server',
    port: 4000,
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

// POST /submit — log guest data, return auto-submit form to Aruba cloud auth
app.post('/submit', (req, res) => {
  const { name, email, mac, ip, url, post } = req.body;
  const ua = req.headers['user-agent'] || '';
  const isAndroid = /Android/i.test(ua);

  console.log('[GUEST SUBMIT]', JSON.stringify({
    name,
    email,
    mac,
    ip,
    post,
    platform: isAndroid ? 'android' : 'other',
    timestamp: new Date().toISOString()
  }));

  const switchUrl = `https://${post}/swarm.cgi`;
  const portalDomain = process.env.PORTAL_DOMAIN || req.headers.host;
  const redirectUrl = `http://${portalDomain}/success`;

  if (isAndroid) {
    // Android closes the CNA the instant it detects internet (right when swarm.cgi
    // authenticates), so any success page shown AFTER auth is never seen.
    // Fix: show the destination info FIRST with a 5-second countdown, THEN submit
    // to swarm.cgi. The user sees "open askheidi.app" before the CNA closes.
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
    .url-box span{font-size:20px;font-weight:700;color:#667eea;letter-spacing:.5px}
    .hint{font-size:12px;color:#aaa;margin-bottom:20px}
    button{width:100%;padding:14px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer}
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
    <div class="url-box"><span>askheidi.app</span></div>
    <p class="hint" id="hint">Activating connection in <strong id="n">5</strong>s&hellip;</p>
    <button id="btn" onclick="connect()">Connect Now</button>
  </div>

  <form id="f" method="POST" action="${switchUrl}" style="display:none">
    <input type="hidden" name="cmd" value="authenticate">
    <input type="hidden" name="user" value="${email}">
    <input type="hidden" name="password" value="guest">
    <input type="hidden" name="url" value="https://askheidi.app/">
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
  <form id="loginForm" method="POST" action="${switchUrl}">
    <input type="hidden" name="cmd" value="authenticate" />
    <input type="hidden" name="user" value="${email}" />
    <input type="hidden" name="password" value="guest" />
    <input type="hidden" name="url" value="${redirectUrl}" />
  </form>
  <script>document.getElementById('loginForm').submit();</script>
</body>
</html>`);
  }
});

// GET /success — shown after authentication, lets user open real browser
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'success', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Captive portal running on port ${PORT}`);
});
