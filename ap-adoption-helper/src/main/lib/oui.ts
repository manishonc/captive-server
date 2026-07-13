// Known Ubiquiti OUIs (first 3 MAC bytes), lowercase hex without separators.
// Used only for labeling — a reply to the discovery probe is treated as a
// UniFi device regardless of OUI.
export const UBIQUITI_OUIS: ReadonlySet<string> = new Set([
  '002722',
  '0418d6',
  '18e829',
  '245a4c',
  '24a43c',
  '445fdb',
  '687251',
  '70a741',
  '744d28',
  '74ac29',
  '74fa29',
  '784558',
  '788a20',
  '802aa8',
  '9c05d6',
  'ac8ba9',
  'b4fbe4',
  'd021f9',
  'dc9fdb',
  'e063da',
  'f09fc2',
  'f492bf',
  'fcecda',
]);

export function isUbiquitiMac(mac: string): boolean {
  const normalized = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (normalized.length < 6) return false;
  return UBIQUITI_OUIS.has(normalized.slice(0, 6));
}
