---
name: add-portal-template
description: >
  Use this skill whenever the user wants to add a new captive portal template to this project.
  Triggers include: "add a template", "create a template", "new portal template", "add this template",
  providing a React component/HTML file and asking to add it to the portal, or describing a visual
  design and asking to turn it into a portal page.
  Handles three input modes: (1) React component pasted in, (2) raw HTML pasted in,
  (3) description only — no file provided.
---

# Add Captive Portal Template

This skill adds a new splash-screen template to the captive portal and registers it in the CMS.
Every template touches **4 files** across two repos. Nothing else should change.

---

## Repos & paths

| Repo | Root |
|------|------|
| Portal | `/Users/manishonc/Desktop/SwissOpenAI/captive-server` |
| CMS | `/Users/manishonc/Desktop/SwissOpenAI/cms` |

---

## Step 0 — Gather inputs

Before writing any code, confirm:

1. **Template ID** — short kebab-case slug (e.g. `vacation`, `hotel-dark`, `coffee-shop`).
   Ask if not provided.
2. **Display name** — human-readable (e.g. "Vacation Rental"). Derive from ID if obvious.
3. **Category** — one of `"airbnb"` | `"restaurant"` | `"other"`. Ask if not obvious.
4. **Input type** — detect automatically:
   - Has `import React` / JSX / hooks → **React component**
   - Has `<!DOCTYPE` or `<html` → **raw HTML**
   - Neither → **description only** (generate from scratch)

---

## Step 1 — Detect input type and plan conversion

### If input is a React component

The portal has no React, Tailwind, Framer Motion, or Lucide. Convert as follows:

| React pattern | Portal equivalent |
|---------------|-------------------|
| Tailwind classes | Inline CSS / `<style>` block |
| `motion/react` animations | CSS `transition` / `@keyframes` |
| `lucide-react` icons | Inline SVG (copy path data from Lucide source) |
| `useState` / hooks | Vanilla JS variables + DOM manipulation |
| JSX conditional renders | `style="display:none"` + JS `classList.add('hidden')` |
| `onClick` handlers | `onclick="..."` attributes or `addEventListener` |
| Template-specific auth (PIN, password, etc.) | **Replace entirely** with the standard 2-step form (see Step 2) |

Keep all visual design decisions: colors, layout, border-radius, shadows, background images, icons.

### If input is raw HTML

- Check if it already follows the EJS template pattern (has PORTAL_CONFIG block, same DOM IDs).
- If not, adapt it: add EJS blocks, replace any custom auth with the standard form, ensure all required DOM IDs exist.

### If input is description only

Design and generate the full template from scratch based on the description. Use the classic.html as a structural reference and apply the described visual style.

---

## Step 2 — Template structure requirements (non-negotiable)

Every template **must** have these exact DOM IDs and elements so `config.js`, `country-selector.js`,
and `form-logic.js` work without modification.

### Required DOM IDs

```
Form fields:   firstName, lastName, email, phone
Phone widget:  phoneWrapper, countryBtn, countryDropdown, countrySearch, countryList,
               selectedFlag, selectedCode
Steps:         step1, step2
Error msgs:    step1Error, step2Error
Buttons:       btnNext, btnAccept, btnDecline
Hidden form:   portalForm, f_firstName, f_lastName, f_email, f_phone, f_phoneCountryCode,
               f_mac, f_ip, f_url, f_post, f_apmac
Footer links:  privacyLink, termsLink
Modal:         ppModal, ppTitle, ppContent
```

### Required CSS classes (queried by config.js)

```
.section-heading  → maps to CONFIG.title   (property name / main heading)
.section-sub      → maps to CONFIG.subtitle (location / subheading)
.logo-wrap        → must exist with an <img src="/headerLogo.png"> inside
                    (can be display:none if the design doesn't use a logo)
.step             → each step div
.step.hidden      → hides a step (toggled by form-logic.js)
```

### Required EJS blocks (top of `<head>`)

```html
<% if (portalConfig) { %>
<script>window.PORTAL_CONFIG = <%- portalConfigJson %>;</script>
<% } %>
```

### backgroundColor suppression (for designs with non-white backgrounds)

If the template has a full-screen background image or dark background, add this immediately after
the PORTAL_CONFIG block to prevent config.js from painting a white body over it:

```html
<script>
  if (window.PORTAL_CONFIG && window.PORTAL_CONFIG.backgroundColor === '#ffffff') {
    window.PORTAL_CONFIG = Object.assign({}, window.PORTAL_CONFIG, { backgroundColor: '' });
  }
</script>
```

### Preview banner (after `<body>` open)

```html
<% if (typeof previewMode !== 'undefined' && previewMode) { %>
<div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#f59e0b;color:#000;
            text-align:center;font-size:12px;font-weight:700;padding:6px;letter-spacing:.5px;">
  &#9888; PREVIEW MODE — not a live session
</div>
<% } %>
```

### Scripts (end of `<body>`)

```html
<script>window.PREVIEW_MODE = <%= typeof previewMode !== 'undefined' && previewMode ? 'true' : 'false' %>;</script>
<script src="/js/config.js"></script>
<script src="/js/country-selector.js"></script>
<script src="/js/form-logic.js"></script>
```

### Hidden Aruba form (inside `#step2`)

```html
<form id="portalForm" action="/submit" method="POST" style="display:none">
  <input type="hidden" id="f_firstName"        name="firstName">
  <input type="hidden" id="f_lastName"         name="lastName">
  <input type="hidden" id="f_email"            name="email">
  <input type="hidden" id="f_phone"            name="phone">
  <input type="hidden" id="f_phoneCountryCode" name="phoneCountryCode" value="+44">
  <input type="hidden" id="f_mac"              name="mac">
  <input type="hidden" id="f_ip"               name="ip">
  <input type="hidden" id="f_url"              name="url">
  <input type="hidden" id="f_post"             name="post">
  <input type="hidden" id="f_apmac"            name="apmac">
</form>
```

### Standard consent step (`#step2`)

The consent text and buttons are standardised — do not change them across templates:

```html
<div id="step2" class="step hidden">
  <h2 class="consent-heading">We care about your privacy</h2>
  <p class="consent-sub">Stay in touch with us and find out more about the best offers</p>
  <div class="consent-box">
    <p>I consent to the collection and use of my personal data, provided via WiFi portal
    registration, by this venue for marketing purposes...</p>
    <p>I also consent to receiving marketing communications from this venue via email or other
    electronic means...</p>
  </div>
  <p class="error-msg" id="step2Error"></p>
  <button class="btn-primary" id="btnAccept" onclick="submitConsent(true)">Accept</button>
  <button class="btn-text" id="btnDecline" onclick="submitConsent(false)">
    I don't want to stay in touch.
  </button>
  <!-- hidden Aruba form goes here -->
</div>
```

### CSS variable for primary color

Always declare `:root { --primary: <default-hex>; }` and use `var(--primary)` on buttons,
focus rings, and accent elements. config.js will override this with the venue's saved color.

---

## Step 3 — Phone country selector markup

The phone field must use this exact structure (IDs are referenced by `country-selector.js`):

```html
<div class="phone-wrap" id="phoneWrapper">
  <button type="button" class="country-btn" id="countryBtn"
          aria-haspopup="listbox" aria-expanded="false">
    <span id="selectedFlag">🇬🇧</span>
    <span id="selectedCode">+44</span>
    <span class="caret">▼</span>
  </button>
  <div id="countryDropdown" class="country-dropdown" role="listbox">
    <input type="text" id="countrySearch" class="country-search"
           placeholder="Search country…" autocomplete="off">
    <div id="countryList" class="country-list"></div>
  </div>
  <input type="tel" id="phone" placeholder="7911 123456" autocomplete="tel-national">
</div>
```

The dropdown CSS classes that must exist: `.country-dropdown`, `.country-dropdown.open`,
`.country-search`, `.country-list`, `.country-option`, `.opt-flag`, `.opt-name`, `.opt-code`,
`.country-btn`, `.country-btn.open`.

---

## Step 4 — The 4 files to create/edit

### File 1 (CREATE): `portal/public/templates/{id}.html`

Write the complete EJS template following all requirements above.

### File 2 (EDIT): `portal/server.js` line ~16

```js
// Add the new id to the array:
const VALID_TEMPLATES = ['classic', 'minimal', 'dark', 'vacation', '{id}'];
```

### File 3 (EDIT): `cms/app/api/captive-portal/splash-screen/route.js` line ~5

```js
// Add the new id to the array:
const VALID_TEMPLATE_IDS = ['classic', 'minimal', 'dark', 'vacation', '{id}'];
```

Without this change, any CMS PUT saving this templateId silently falls back to `'classic'`.

### File 4 (EDIT): `cms/lib/splash-screen-templates.ts`

Append to `SPLASH_SCREEN_TEMPLATES` array (before the closing `]`):

```ts
{
  id: "{id}",
  name: "{Display Name}",
  description: "{One sentence — what it looks like and what venue type it suits}",
  category: "airbnb" | "restaurant" | "other",   // pick one
  searchKeywords: [
    // 8–14 keywords: visual descriptors, use cases, synonyms
  ],
  pages: [
    { label: "Login", description: "{What the login screen shows}" },
    { label: "Success", description: "Confirmation screen after connecting" },
  ],
},
```

---

## Step 5 — Verify

After writing all 4 files:

1. Confirm `{id}` appears in `VALID_TEMPLATES` (server.js) and `VALID_TEMPLATE_IDS` (route.js).
2. Confirm `.section-heading` and `.section-sub` exist in the template.
3. Confirm all required DOM IDs are present (grep the new .html file).
4. Confirm the hidden `#portalForm` with all `f_*` inputs is inside `#step2`.
5. Confirm the 3 script tags appear at the end of `<body>`.
6. Tell the user: **preview URL** → `http://localhost:3000/?preview=1&templateId={id}`

---

## Quick reference: CONFIG fields

| Field | Type | How used in template |
|-------|------|----------------------|
| `title` | string | `.section-heading` textContent |
| `subtitle` | string | `.section-sub` textContent |
| `primaryColor` | hex | `--primary` CSS variable |
| `backgroundColor` | hex | `body` background (suppress if design uses image/dark bg) |
| `logoUrl` | string | `.logo-wrap img` src |
| `collectName` | bool | Shows/hides firstName + lastName fields |
| `collectEmail` | bool | Shows/hides email field |
| `showMarketingOptIn` | bool | If false, skips consent step entirely |
| `showPrivacyPolicy` | bool | Shows/hides #privacyLink |
| `showTermsOfService` | bool | Shows/hides #termsLink |

---

## Notes

- **No CDN icon libraries** — use inline SVG for all icons.
- **No external CSS frameworks** — pure CSS only in a `<style>` block.
- **Background images** from Unsplash are fine; use the original URL from the design if provided.
  Add a dark/neutral `body` background color as a fallback for when the image fails to load.
- **`color-mix()` for hover states** is fine: `color-mix(in srgb, var(--primary) 80%, black)`.
- **`-webkit-backdrop-filter`** alongside `backdrop-filter` for iOS Safari compatibility.
- The `configDebugBadge` `<p>` element (display:none) in step1 is optional but harmless to include.
