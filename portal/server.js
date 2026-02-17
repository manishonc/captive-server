const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET / — serve portal, log Aruba Instant On query params
app.get('/', (req, res) => {
  const { cmd, mac, ip, network, apmac, site, post, url } = req.query;
  if (cmd) {
    console.log('[PORTAL HIT]', JSON.stringify({ cmd, mac, ip, network, apmac, site, post, url, timestamp: new Date().toISOString() }));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
