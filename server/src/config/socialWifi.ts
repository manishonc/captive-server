// Social WiFi integration config
// Fill in WEBHOOK_SECRET and AP map after creating venues + virtual APs in CMS

export const SOCIAL_WIFI_WEBHOOK_SECRET = '4ab0fd2fb13d318e3d04aa1b949483922e2708a64e26bd0f37558b34566e0565';

// Social WiFi venue ID (from their dashboard) → CaptivePortal_AccessPoints doc ID
export const SOCIAL_WIFI_AP_MAP: Record<string, string> = {
  'c5216f64-2c37-496b-a2fc-ddd671ad8a8b': 'oWjP4xDoUYAeTB74NGGj',
  'indiangourmetrestaurantinterlaken-rvv5_4g': 'NkwNkpbGnDuYIuTjCYPL',
};
