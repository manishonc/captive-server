# Adding a New Restaurant

Each restaurant/location gets its own captive portal design, identified by the AP MAC address.

## Step 1: Find the AP MAC address

The Aruba Instant On AP sends its MAC address as the `apmac` query parameter when redirecting guests to the captive portal. You can find it in:

- The Aruba Instant On management portal (under AP details)
- The portal logs: `docker compose logs portal` — look for `[PORTAL HIT]` entries, the `apmac` field is the MAC

The format is lowercase with colons, e.g. `aa:bb:cc:dd:ee:ff`.

## Step 2: Pick a slug

Choose a short, URL-safe name for the restaurant. Use lowercase letters, numbers, and hyphens only.

Examples: `pizza-place`, `cafe-downtown`, `burger-joint`

## Step 3: Register the MAC in `restaurants.json`

Edit `portal/restaurants.json` and add the MAC-to-slug mapping:

```json
{
  "54:f0:b1:c8:7f:00": "default",
  "aa:bb:cc:dd:ee:ff": "pizza-place"
}
```

## Step 4: Create the template

Create a directory for the restaurant and add an `index.html`:

```bash
mkdir portal/templates/pizza-place
```

Then create `portal/templates/pizza-place/index.html`. You have full design freedom — the only requirement is that the HTML must include:

### Required form

A `<form>` that POSTs to `/submit` with these fields:

```html
<form action="/submit" method="POST">
  <!-- Visible fields (guest fills these in) -->
  <input type="text" name="name" required>
  <input type="email" name="email" required>

  <!-- Hidden fields (populated by JavaScript) -->
  <input type="hidden" id="mac" name="mac">
  <input type="hidden" id="ip" name="ip">
  <input type="hidden" id="url" name="url">
  <input type="hidden" id="post" name="post">

  <button type="submit">Connect</button>
</form>
```

### Required JavaScript

JS that reads the Aruba query params into the hidden fields:

```html
<script>
  const params = new URLSearchParams(window.location.search);
  document.getElementById('mac').value = params.get('mac') || '';
  document.getElementById('ip').value = params.get('ip') || '';
  document.getElementById('url').value = params.get('url') || '';
  document.getElementById('post').value = params.get('post') || '';
</script>
```

### Static assets (optional)

Put any CSS, images, or JS files in the same template folder:

```
portal/templates/pizza-place/
├── index.html
├── style.css
└── logo.png
```

Reference them using the `/static/<slug>/` path:

```html
<link rel="stylesheet" href="/static/pizza-place/style.css">
<img src="/static/pizza-place/logo.png">
```

## Step 5: Deploy

Rebuild and restart on your VPS:

```bash
docker compose up -d --build
```

## Step 6: Test

```bash
# Should serve the pizza-place template
curl "http://YOUR_SERVER/?apmac=aa:bb:cc:dd:ee:ff"

# Should still serve the default template
curl "http://YOUR_SERVER/?apmac=54:f0:b1:c8:7f:00"

# Unknown MACs fall back to default
curl "http://YOUR_SERVER/?apmac=xx:xx:xx:xx:xx:xx"
```

## Quick reference

| What | Where |
|------|-------|
| MAC mapping | `portal/restaurants.json` |
| Templates | `portal/templates/<slug>/index.html` |
| Static assets | `portal/templates/<slug>/` (served at `/static/<slug>/`) |
| Default fallback | `portal/templates/default/index.html` |
