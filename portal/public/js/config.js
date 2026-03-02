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

// Apply branding immediately (synchronous, no flash)
document.documentElement.style.setProperty('--primary', CONFIG.primaryColor);
document.body.style.background = CONFIG.backgroundColor;

// Logo
var _logoEls = document.querySelectorAll('.logo-wrap img');
if (CONFIG.logoUrl) _logoEls.forEach(function(el) { el.src = CONFIG.logoUrl; });

// Text
document.querySelector('.section-heading').textContent = CONFIG.title;
document.querySelector('.section-sub').textContent     = CONFIG.subtitle;

// Conditional fields
if (!CONFIG.collectName) {
  ['firstName', 'lastName'].forEach(function(id) {
    var fg = document.getElementById(id).closest('.field-group');
    if (fg) fg.style.display = 'none';
  });
}
if (!CONFIG.collectEmail) {
  var emailFg = document.getElementById('email').closest('.field-group');
  if (emailFg) emailFg.style.display = 'none';
}

// Footer links
if (!CONFIG.showPrivacyPolicy)  document.getElementById('privacyLink').style.display = 'none';
if (!CONFIG.showTermsOfService) document.getElementById('termsLink').style.display   = 'none';

// DEBUG badge — hidden, remove once pipeline is verified
// var _src = (typeof window.PORTAL_CONFIG !== 'undefined') ? 'firebase' : 'default';
// var _badge = document.getElementById('configDebugBadge');
// _badge.style.cssText = 'font-size:10px;text-align:left;color:#555;margin:0 0 12px;font-family:monospace;background:#f5f5f5;border:1px solid #ddd;border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-all';
// _badge.textContent = '[source: ' + _src + ']\n' + JSON.stringify(CONFIG, null, 2);
