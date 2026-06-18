// ── 0. Portal branding config (injected server-side; fallback for direct loads) ──
var CONFIG = (typeof window.PORTAL_CONFIG !== 'undefined') ? window.PORTAL_CONFIG : {
  title: 'Connect to WiFi',
  subtitle: 'Enter your details to get online',
  logoUrl: '',
  primaryColor: '#1c2b4a',
  backgroundColor: '#ffffff',
  collectEmail: true,
  collectName: true,
  showMarketingOptIn: true,
  showPrivacyPolicy: true,
  showTermsOfService: true,
};

// Apply branding to the DOM. Safe to call repeatedly (used for live CMS preview).
function applyPortalConfig(cfg) {
  // Colors
  document.documentElement.style.setProperty('--primary', cfg.primaryColor);
  document.body.style.background = cfg.backgroundColor;

  // Logo
  if (cfg.logoUrl) {
    document.querySelectorAll('.logo-wrap img').forEach(function(el) { el.src = cfg.logoUrl; });
  }

  // Text
  var headingEl = document.querySelector('.section-heading');
  if (headingEl) headingEl.textContent = cfg.title;
  var subEl = document.querySelector('.section-sub');
  if (subEl) subEl.textContent = cfg.subtitle;

  // Conditional fields
  if (!cfg.collectName) {
    ['firstName', 'lastName'].forEach(function(id) {
      var el = document.getElementById(id);
      var fg = el && el.closest('.field-group');
      if (fg) fg.style.display = 'none';
    });
  }
  if (!cfg.collectEmail) {
    var emailEl = document.getElementById('email');
    var emailFg = emailEl && emailEl.closest('.field-group');
    if (emailFg) emailFg.style.display = 'none';
  }

  // Footer links
  if (!cfg.showPrivacyPolicy) {
    var pl = document.getElementById('privacyLink');
    if (pl) pl.style.display = 'none';
  }
  if (!cfg.showTermsOfService) {
    var tl = document.getElementById('termsLink');
    if (tl) tl.style.display = 'none';
  }
}

// Apply immediately (synchronous, no flash)
applyPortalConfig(CONFIG);

// ── Live preview: accept config pushed from the CMS editor (preview mode only) ──
// Gated on PREVIEW_MODE so live guest sessions never accept external messages.
// The payload is display-only (title/subtitle/colors) on a page already flagged
// "PREVIEW MODE" and never shown to real guests, so when no explicit allowlist is
// configured we accept any origin — this prevents the live preview from silently
// breaking when the CMS is served from an unanticipated origin. Set
// window.ALLOWED_CMS_ORIGINS (array) to lock it down.
if (window.PREVIEW_MODE) {
  var ALLOWED_CMS_ORIGINS = window.ALLOWED_CMS_ORIGINS;
  window.addEventListener('message', function (e) {
    if (Array.isArray(ALLOWED_CMS_ORIGINS) && ALLOWED_CMS_ORIGINS.length &&
        ALLOWED_CMS_ORIGINS.indexOf(e.origin) === -1) {
      console.warn('[heidifi preview] ignored message from disallowed origin:', e.origin);
      return;
    }
    var d = e.data;
    if (!d || d.type !== 'heidifi:splash-preview' || !d.config) return;
    // Only fields applyable without a reload; templateId is handled via iframe reload.
    ['title', 'subtitle', 'primaryColor', 'backgroundColor', 'logoUrl'].forEach(function (k) {
      if (d.config[k] !== undefined) CONFIG[k] = d.config[k];
    });
    applyPortalConfig(CONFIG);
    console.log('[heidifi preview] applied live config from', e.origin);
  });
  console.log('[heidifi preview] live preview listener attached');
}

// DEBUG badge — hidden, remove once pipeline is verified
// var _src = (typeof window.PORTAL_CONFIG !== 'undefined') ? 'firebase' : 'default';
// var _badge = document.getElementById('configDebugBadge');
// _badge.style.cssText = 'font-size:10px;text-align:left;color:#555;margin:0 0 12px;font-family:monospace;background:#f5f5f5;border:1px solid #ddd;border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-all';
// _badge.textContent = '[source: ' + _src + ']\n' + JSON.stringify(CONFIG, null, 2);
