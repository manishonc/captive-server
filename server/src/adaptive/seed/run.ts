/**
 * CLI for the Adaptive Campaigns seed.
 *
 *   npx tsx src/adaptive/seed/run.ts            # dry run: what would be created
 *   npx tsx src/adaptive/seed/run.ts --apply    # create what is missing
 *   node dist/adaptive/seed/run.js --apply      # same, inside the built container
 *
 * Uses the server's usual Firebase credentials (FIREBASE_* env). The server also
 * runs the same seed once at boot, so this is only needed for local/emulator use
 * or to inspect what the seed would do.
 */

import { ensureAdaptiveSeed } from './ensureSeed';

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await ensureAdaptiveSeed({ dryRun: !apply });
  if (result.problems.length) {
    console.error('The seed definitions have problems — nothing was written:');
    for (const p of result.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const verb = apply ? 'Created' : 'Would create';
  console.log(`${verb} (${result.created.length}):`);
  for (const label of result.created) console.log(`  + ${label}`);
  console.log(`Already there (${result.skipped.length}):`);
  for (const label of result.skipped) console.log(`  = ${label}`);
  if (result.failed.length) {
    console.error('Failed:');
    for (const f of result.failed) console.error(`  ! ${f.label}: ${f.error}`);
    process.exit(1);
  }
  if (!apply) console.log('\nDry run only. Re-run with --apply to write.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
