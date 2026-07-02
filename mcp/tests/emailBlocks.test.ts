/**
 * Golden-fixture parity test for the vendored email-blocks renderer.
 *
 * The fixture pair (basic.json / basic.html) is copied from
 * cms/tests/fixtures/email-blocks — identical input must produce identical
 * output in both repos. If this fails after an intentional renderer change,
 * re-sync the vendored files AND the fixtures from the CMS repo.
 *
 * Run: npx tsx tests/emailBlocks.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEmailDesign } from '../src/emailBlocks/schema';
import { renderEmailBlocks } from '../src/emailBlocks/render';
import { sanitizeTextHtml } from '../src/emailBlocks/sanitize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'email-blocks');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const goldenDesign = JSON.parse(readFileSync(join(FIXTURE_DIR, 'basic.json'), 'utf8'));
const goldenHtml = readFileSync(join(FIXTURE_DIR, 'basic.html'), 'utf8');

test('golden design validates', () => {
  const result = validateEmailDesign(goldenDesign);
  assert(result.ok, `expected ok, got: ${!result.ok ? result.error : ''}`);
});

test('renderer output matches the CMS golden HTML byte-for-byte', () => {
  const result = validateEmailDesign(goldenDesign);
  assert(result.ok, 'golden design must validate');
  assert(
    renderEmailBlocks(result.design) === goldenHtml,
    'DRIFT: vendored renderer differs from cms/lib/email-blocks — re-sync both files and fixtures',
  );
});

test('unsubscribe link always present', () => {
  const result = validateEmailDesign(goldenDesign);
  assert(result.ok, 'golden design must validate');
  assert(renderEmailBlocks(result.design).includes('href="{{unsubscribeUrl}}"'), 'missing unsubscribe');
});

test('sanitizer escapes scripts', () => {
  const out = sanitizeTextHtml('<p>hi</p><script>alert(1)</script>');
  assert(!out.includes('<script>'), 'script tag survived');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
