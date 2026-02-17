#!/usr/bin/env node
//
// Generates freeradius/users from portal/restaurants.json
// Run this whenever you edit restaurants.json:
//   node generate-users.js
//

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'portal', 'restaurants.json');
const usersPath = path.join(__dirname, 'freeradius', 'users');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const defaultTimeout = config.defaultSessionTimeout || 36000;
const aps = config.aps || {};

const lines = [
  '# Auto-generated from portal/restaurants.json',
  '# Run: node generate-users.js',
  '',
];

for (const [mac, entry] of Object.entries(aps)) {
  const timeout = entry.sessionTimeout || defaultTimeout;
  const slug = entry.slug || 'unknown';
  // Use . as wildcard separator so regex matches both : and - MAC formats
  const macPattern = mac.replace(/:/g, '.');
  lines.push(`# AP ${mac} → ${slug} (timeout: ${timeout}s)`);
  lines.push(`DEFAULT Called-Station-Id =~ "${macPattern}", Auth-Type := Accept`);
  lines.push(`\tSession-Timeout = ${timeout}`);
  lines.push('');
}

lines.push('# Fallback for unknown APs');
lines.push('DEFAULT Auth-Type := Accept');
lines.push(`\tSession-Timeout = ${defaultTimeout}`);
lines.push('');

fs.writeFileSync(usersPath, lines.join('\n'));
console.log(`Wrote ${usersPath}`);
