/**
 * PR W1 — who may reach Meta about templates, read from the source's imports (runtime imports only,
 * with the TypeScript parser). No Firestore.
 *
 * Run: npx tsx tests/adaptiveWhatsAppBoundary.test.ts   (from captive-server/server)
 *
 *  - The WhatsApp template core (`adaptive/core/whatsapp/*`) is pure: no firebase, no services, no
 *    network code, nothing outside `adaptive/core`.
 *  - Only `adaptive/whatsapp/source.ts` imports the real Meta client (`meta.ts`) and the sandbox Meta.
 *  - The store (`whatsapp/store.ts`), the webhook hint (`whatsapp/hints.ts`) and the shared change
 *    logic (`whatsapp/apply.ts`, `whatsapp/context.ts`) never reach a Meta client: what Meta says
 *    comes in as arguments; the webhook can't make the server call Meta.
 *  - The WhatsApp webhook route reaches the template code only through `hints.ts` (no submit, no
 *    sync, no Meta client) — and never the old sender for templates.
 *  - The template code never reaches the AI (brain) or the Adaptive send path.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import ts from 'typescript';

const SRC = resolve(__dirname, '../src');
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Runtime import specifiers: declarations (not type-only), re-exports, import(), require(). */
function importsOf(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const lit = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const allTypes = Boolean(clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
      if (!clause?.isTypeOnly && !allTypes) {
        const s = lit(node.moduleSpecifier);
        if (s) out.push(s);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier) {
        const s = lit(node.moduleSpecifier);
        if (s) out.push(s);
      }
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) {
        const s = lit(node.arguments[0]);
        out.push(s ?? '<computed>');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function resolveSpec(from: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  const base = resolve(dirname(from), spec);
  for (const cand of [`${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(cand) && statSync(cand).isFile()) return cand;
  return `${base} (unresolved)`;
}

function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.startsWith(SRC) && existsSync(f) && statSync(f).isFile()) stack.push(...importsOf(f).map((s) => resolveSpec(f, s)));
  }
  return seen;
}

const src = (p: string) => join(SRC, p);
const rel = (f: string) => (f.startsWith(SRC) ? relative(SRC, f) : f);

const META = src('adaptive/whatsapp/meta.ts');
const SANDBOX = src('adaptive/whatsapp/sandbox.ts');
const SOURCE = src('adaptive/whatsapp/source.ts');
const OLD_SENDER = src('services/whatsapp.ts');
const CORE = ['template.ts', 'checks.ts', 'status.ts', 'pools.ts', 'aiBrief.ts', 'auto.ts'].map((f) => src(`adaptive/core/whatsapp/${f}`));
const NO_META = ['store.ts', 'hints.ts', 'apply.ts', 'context.ts', 'log.ts', 'aiDrafts.ts', 'aiRequests.ts', 'autoViews.ts'].map((f) => src(`adaptive/whatsapp/${f}`)).filter((f) => existsSync(f));
/** The code that calls a model (only the worker loads it): never reached from the template code. */
const MODEL_CODE = ['run.ts', 'lane.ts', 'modelClient.ts', 'sandboxModel.ts'].map((f) => src(`adaptive/brain/${f}`));

console.log('\nWhatsApp templates — import boundaries (PR W1)\n');

test('the files this test names exist (so it checks something)', () => {
  for (const f of [META, SANDBOX, SOURCE, OLD_SENDER, ...CORE, ...NO_META, src('routes/whatsappWebhook.ts'), src('server.ts')]) assert(existsSync(f), `missing ${rel(f)}`);
});

test('the core is pure: nothing outside adaptive/core, no packages but zod', () => {
  for (const f of CORE) {
    for (const r of reach(f)) {
      if (r === f) continue;
      if (!r.startsWith(SRC)) assert(r === 'zod', `${rel(f)} loads the package ${r}`);
      else assert(r.startsWith(src('adaptive/core/')), `${rel(f)} reaches ${rel(r)}`);
    }
  }
});

test('only source.ts imports the Meta client and the sandbox Meta', () => {
  const walk = (dir: string): string[] => {
    const { readdirSync } = require('fs') as typeof import('fs');
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  };
  for (const f of walk(SRC)) {
    if (f === SOURCE || f === META || f === SANDBOX) continue;
    const direct = importsOf(f).map((s) => resolveSpec(f, s));
    if (f.endsWith('service/whatsappAdmin.ts')) {
      // The dev routes reach the sandbox's decide/fault helpers (they refuse outside the sandbox).
      assert(!direct.includes(META), `${rel(f)} imports meta.ts`);
      continue;
    }
    assert(!direct.includes(META) && !direct.includes(SANDBOX), `${rel(f)} imports the Meta client directly`);
  }
});

test('the store, the hint, the change logic and the context never reach a Meta client', () => {
  for (const f of NO_META) {
    const r = reach(f);
    for (const bad of [META, SANDBOX, SOURCE, OLD_SENDER]) assert(!r.has(bad), `${rel(f)} reaches ${rel(bad)}`);
  }
});

test('the WhatsApp webhook reaches the template code only through hints.ts', () => {
  const direct = importsOf(src('routes/whatsappWebhook.ts')).map((s) => resolveSpec(src('routes/whatsappWebhook.ts'), s));
  const templateCode = direct.filter((f) => f.startsWith(src('adaptive/whatsapp/')));
  assert(templateCode.length === 1 && templateCode[0] === src('adaptive/whatsapp/hints.ts'), `webhook imports ${templateCode.map(rel).join(', ')}`);
  const r = reach(src('adaptive/whatsapp/hints.ts'));
  for (const bad of ['submit.ts', 'sync.ts', 'connection.ts', 'meta.ts', 'sandbox.ts', 'source.ts'].map((x) => src(`adaptive/whatsapp/${x}`))) assert(!r.has(bad), `hints reaches ${rel(bad)}`);
});

test('the template code never reaches the code that calls a model, an AI SDK or the Adaptive send path (PR W2: it may queue a run)', () => {
  const entries = ['sync.ts', 'submit.ts', 'connection.ts', 'hints.ts', 'aiRequests.ts'].map((x) => src(`adaptive/whatsapp/${x}`)).concat(src('service/whatsappAdmin.ts'), src('jobs/whatsappTemplates.ts'));
  for (const e of entries) {
    const r = reach(e);
    for (const f of r) {
      // From PR W2 the tab queues writer runs (brain/tasks.ts) and reads the writer's settings and
      // usage: the pure AI files only — the model is called by the worker alone.
      assert(!MODEL_CODE.includes(f), `${rel(e)} reaches ${rel(f)}`);
      assert(!/^@anthropic-ai\/|^openai$|^@ai-sdk\//.test(f), `${rel(e)} loads ${f}`);
      assert(f !== src('adaptive/engine/sendPath.ts') && f !== src('adaptive/send/dispatch.ts'), `${rel(e)} reaches ${rel(f)}`);
      assert(!f.includes('(unresolved)') && f !== '<computed>', `${rel(e)}: unresolved import ${f}`);
    }
  }
});

test('submit, the connection and the webhook hint never reach the AI at all (only the tab and the tick queue runs)', () => {
  for (const e of ['submit.ts', 'connection.ts', 'hints.ts'].map((x) => src(`adaptive/whatsapp/${x}`))) {
    const bad = [...reach(e)].filter((f) => f.startsWith(src('adaptive/brain/')));
    assert(!bad.length, `${rel(e)} reaches ${bad.map(rel).join(', ')}`);
  }
});

test('the API process starts the template job', () => {
  assert(reach(src('server.ts')).has(src('jobs/whatsappTemplates.ts')), 'server.ts does not start the job');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
