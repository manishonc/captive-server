# Portal Preview Mode

## How it works

Preview mode renders the captive portal with an amber banner at the top so it's clearly not a live session. It is triggered by adding `?preview=1` to the standard portal URL — there is no separate `/preview` route.

Aruba Instant On only ever appends its own params (`cmd`, `mac`, `ip`, `apmac`, `url`, `post`, etc.) when redirecting a real user, so `?preview=1` will never appear in a live WiFi session.

## URL format

```
http://<portal-host>/?apmac=<ap-mac>&preview=1
```

Example:

```
http://167.71.229.249.nip.io/?apmac=54:f0:b1:c8:7f:00&preview=1
```

## Dashboard iframe

```html
<iframe
  src="http://<portal-host>/?apmac=<ap-mac>&preview=1"
  width="390"
  height="844"
  style="border:none; border-radius:12px; box-shadow:0 4px 24px rgba(0,0,0,.15);"
  title="Portal Preview"
></iframe>
```

To update the preview when the user selects a different AP:

```javascript
const previewUrl = `http://<portal-host>/?apmac=${encodeURIComponent(selectedApmac)}&preview=1`;
document.getElementById('previewIframe').src = previewUrl;
```

## What renders differently

| Param present | Banner shown | Live auth |
|---|---|---|
| `?preview=1` | Yes — amber top bar | No |
| *(absent)* | No | Yes |

No other behaviour changes — the same Firebase splash config is fetched and rendered in both cases.
