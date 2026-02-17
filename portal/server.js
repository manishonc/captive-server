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

// POST /submit — log guest data, return auto-submit form to Aruba cloud auth
app.post('/submit', (req, res) => {
  const { name, email, mac, ip, url, post } = req.body;

  console.log('[GUEST SUBMIT]', JSON.stringify({
    name,
    email,
    mac,
    ip,
    post,
    timestamp: new Date().toISOString()
  }));

  const switchUrl = `https://${post}/swarm.cgi`;
  const redirectUrl = url || 'http://www.google.com';

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
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Captive portal running on port ${PORT}`);
});
