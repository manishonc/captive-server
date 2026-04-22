// Social WiFi integration config
// Fill in WEBHOOK_SECRET and AP map after creating venues + virtual APs in CMS

export const SOCIAL_WIFI_WEBHOOK_SECRET = 'REPLACE_WITH_YOUR_SECRET';

// Social WiFi venue ID (from their dashboard) → CaptivePortal_AccessPoints doc ID
// Steps to get the AP doc IDs:
//   1. Create venues in CMS with externalSource: "social_wifi"
//   2. Create one access point per venue (any MAC, e.g. "sw-venue-1")
//   3. Copy the generated Firestore doc IDs here
export const SOCIAL_WIFI_AP_MAP: Record<string, string> = {
  'SOCIAL_WIFI_VENUE_ID_1': 'CAPTIVE_PORTAL_AP_DOC_ID_1',
  'SOCIAL_WIFI_VENUE_ID_2': 'CAPTIVE_PORTAL_AP_DOC_ID_2',
};
