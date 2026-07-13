// electron-builder afterPack hook: ad-hoc sign the macOS bundle.
// We ship without a Developer ID certificate; Apple Silicon refuses to run
// binaries with no signature at all, so an ad-hoc signature is required.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // Universal builds pack each arch into a *-temp dir first, then merge.
  // Signing the temp apps would make their file hashes differ and break the
  // merge — only sign the final output.
  if (context.appOutDir.endsWith('-temp')) return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  console.log(`  • ad-hoc signing ${appName}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
};
