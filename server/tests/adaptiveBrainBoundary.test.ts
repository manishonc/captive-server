/**
 * PR F2a — who may reach the model, and what the AI code may reach. Reads the source's imports
 * with the TypeScript parser (runtime ones only: `import type`, `export type` and imports whose
 * every name is a type load nothing), no Firestore.
 *
 * Run: npx tsx tests/adaptiveBrainBoundary.test.ts   (from captive-server/server)
 *
 *  - The API process (src/server.ts) never loads an AI SDK or the code that calls a model: only
 *    the worker does (worker/main.ts → brain/lane.ts → brain/run.ts → the client).
 *  - Only brain/modelClient.ts imports an AI SDK, and only the Anthropic one: one way to a model.
 *  - The AI code reaches only an allowlist of files (today's reach: a new one is a decision, not
 *    an accident) — never the send path, the send adapters, the credit wallet or any other code
 *    that messages people (OTP, renewal mails, opt-outs, usage debits, the auto top-up call); it
 *    reaches the Brevo sender only through engine/alerts.ts (HeidiFi's alert emails). The send
 *    path never reaches the AI code ("the AI never sits in the sending path").
 *  - The AI code touches only its own collections (and the settings, the task queue, the alerts),
 *    and schedules only `agent_run` tasks.
 *  - No file on those paths imports a module whose name is worked out at run time, or hands
 *    `require` around (the walk couldn't follow it).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
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

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

interface Imports {
  specs: string[];
  /** import(x) / require(x) with a name that isn't a literal, or `require` handed around. */
  dynamic: number;
}

const parsed = new Map<string, Imports>();

/** Runtime import specifiers in a source text: declarations, re-exports, `import x = require`, import(), require(). */
function importsOfText(fileName: string, text: string): Imports {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Imports = { specs: [], dynamic: 0 };
  const lit = (n: ts.Node | undefined): string | null => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const everyNameAType = Boolean(clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly));
      if (!clause?.isTypeOnly && !everyNameAType) {
        const s = lit(node.moduleSpecifier);
        if (s) out.specs.push(s);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier) {
        const s = lit(node.moduleSpecifier);
        if (s) out.specs.push(s);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const s = lit(node.moduleReference.expression);
        if (s) out.specs.push(s);
      }
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isMemberRequire = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require';
      if (isImport || isRequire) {
        const s = lit(node.arguments[0]);
        if (s) out.specs.push(s);
        else out.dynamic += 1;
      } else if (isMemberRequire) {
        out.dynamic += 1; // module.require(x): not followed
      }
    } else if (ts.isIdentifier(node) && (node.text === 'require' || node.text === 'createRequire')) {
      const p = node.parent;
      const called = ts.isCallExpression(p) && p.expression === node;
      // `require.main`, `require.resolve(…)` load nothing; `module.require` is counted above.
      // `require.main`, `require.resolve(…)` load nothing; `require.call(…)` / `.apply` / `.bind` do.
      const harmless = ts.isPropertyAccessExpression(p) && p.expression === node && ['main', 'resolve', 'cache', 'extensions'].includes(p.name.text);
      const nameOfMember = ts.isPropertyAccessExpression(p) && p.name === node;
      if (node.text === 'createRequire' || (!called && !harmless && !nameOfMember)) out.dynamic += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function importsOf(file: string): Imports {
  let found = parsed.get(file);
  if (!found) {
    found = importsOfText(file, readFileSync(file, 'utf8'));
    parsed.set(file, found);
  }
  return found;
}

function resolveSpec(from: string, spec: string): string {
  if (!spec.startsWith('.')) return spec; // a package
  const base = resolve(dirname(from), spec);
  for (const cand of [`${base}.ts`, join(base, 'index.ts'), base]) if (existsSync(cand) && statSync(cand).isFile()) return cand;
  return `${base} (unresolved)`;
}

/** Everything a file loads, transitively (packages by name); files in `stopAt` are reached but not walked into. */
function reach(entry: string, stopAt: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.startsWith(SRC) && existsSync(f) && !stopAt.has(f)) stack.push(...importsOf(f).specs.map((s) => resolveSpec(f, s)));
  }
  return seen;
}

const rel = (f: string) => (f.startsWith(SRC) ? relative(SRC, f) : f);
const src = (p: string) => join(SRC, p);

/** Packages that talk to a model (any provider): only the Anthropic SDK, only in the model client. */
const AI_PACKAGES = [
  '@anthropic-ai/',
  'openai',
  'ai',
  '@ai-sdk/',
  '@google/generative-ai',
  '@google/genai',
  '@mistralai/',
  'cohere-ai',
  'groq-sdk',
  'ollama',
  'replicate',
  '@huggingface/inference',
  '@aws-sdk/client-bedrock-runtime',
  '@langchain/',
  'langchain',
];
const isAiPackage = (f: string) => !f.startsWith(SRC) && AI_PACKAGES.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p || f.startsWith(`${p}/`)));
const isAnthropicSdk = (f: string) => f === '@anthropic-ai/sdk' || f.startsWith('@anthropic-ai/sdk/');

const MODEL_CODE = ['adaptive/brain/modelClient.ts', 'adaptive/brain/run.ts', 'adaptive/brain/lane.ts', 'adaptive/brain/sandboxModel.ts'].map(src);
const SENDING = [
  'adaptive/engine/sendPath.ts',
  'adaptive/send/dispatch.ts',
  'adaptive/send/adapters/index.ts',
  'adaptive/send/adapters/brevo.ts',
  'adaptive/send/adapters/twilio.ts',
  'adaptive/send/adapters/sandbox.ts',
  'services/credits.ts',
  'services/usage.ts',
  'services/twilio.ts',
  'services/whatsapp.ts',
  'services/campaigns.ts',
  'services/brevo.ts',
  'services/autoRefillTrigger.ts',
  'services/otpMessages.ts',
  'services/guestOtp.ts',
  'services/optOut.ts',
  'services/renewalEmails.ts',
].map(src);
const ALERTS = src('adaptive/engine/alerts.ts');

/** What the AI code may load today. A file added here is a reviewed decision. */
const BRAIN_MAY_REACH = new Set([
  ...[
    'adaptive/brain/budget.ts',
    'adaptive/brain/checks.ts',
    'adaptive/brain/gate.ts',
    'adaptive/brain/jobs/ping.ts',
    // PR W2: the WhatsApp template writer — its pure core, and the registry's store for its apply
    // (never the Meta client, the context (it reaches the opt-out code), submit or sync: see below).
    'adaptive/brain/jobs/waTemplateWriter.ts',
    'adaptive/core/whatsapp/aiBrief.ts',
    'adaptive/core/whatsapp/checks.ts',
    'adaptive/core/whatsapp/status.ts',
    'adaptive/core/whatsapp/template.ts',
    'adaptive/core/registry/index.ts',
    'adaptive/core/registry/mergeFields.ts',
    'adaptive/core/registry/nodes.ts',
    'adaptive/core/registry/slots.ts',
    'adaptive/core/registry/triggers.ts',
    'adaptive/core/render.ts',
    'adaptive/core/schemas.ts',
    'adaptive/whatsapp/aiDrafts.ts',
    'adaptive/whatsapp/store.ts',
    'adaptive/api/errors.ts',
    'adaptive/api/http.ts',
    'adaptive/brain/lane.ts',
    'adaptive/brain/modelClient.ts',
    'adaptive/brain/models.ts',
    'adaptive/brain/privacy.ts',
    'adaptive/brain/registry.ts',
    'adaptive/brain/run.ts',
    'adaptive/brain/sandboxModel.ts',
    'adaptive/brain/tasks.ts',
    'adaptive/brain/types.ts',
    'adaptive/core/checksum.ts',
    'adaptive/core/constants.ts',
    'adaptive/core/issues.ts',
    'adaptive/core/runtime/hold.ts',
    'adaptive/core/runtime/ids.ts',
    'adaptive/core/runtime/phoneCountry.ts',
    'adaptive/core/runtime/time.ts',
    // HeidiFi's alert emails (only Brevo, and only through here: see below).
    'adaptive/engine/alerts.ts',
    'adaptive/engine/clock.ts',
    'adaptive/queue/firestoreQueue.ts',
    // Pure text rendering, for the alert emails' HTML.
    'adaptive/send/compose.ts',
    'adaptive/store/agents.ts',
    'adaptive/store/collections.ts',
    'adaptive/store/engineSettings.ts',
    'adaptive/store/serialize.ts',
    'adaptive/store/time.ts',
    'firebase.ts',
    'services/brevo.ts',
    'services/poweredBy.ts',
  ].map(src),
  '@anthropic-ai/sdk',
  '@anthropic-ai/sdk/helpers/zod',
  '@getbrevo/brevo',
  'crypto',
  'firebase-admin/app',
  'firebase-admin/firestore',
  'zod',
]);

/** The collections the AI code's files may name (`COL.<key>`). */
const BRAIN_COLLECTIONS = new Set(['agents', 'agentRuns', 'agentUsage', 'sandboxModelCalls', 'sandboxModelAnswers', 'journeyTasks', 'config', 'alerts', 'tenantUsers', 'whatsappTemplates', 'whatsappLog']);
/** A file allowed to name a subcollection through its own constant (the template timeline). */
const SUBCOLLECTION_OK: Readonly<Record<string, string>> = { [src('adaptive/whatsapp/store.ts')]: 'HISTORY' };

test('the files this test names exist (so it checks something)', () => {
  for (const f of [...MODEL_CODE, ...SENDING, ALERTS, src('server.ts'), src('adaptive/worker/main.ts')]) assert(existsSync(f), `missing ${rel(f)}`);
  for (const f of BRAIN_MAY_REACH) if (f.startsWith(SRC)) assert(existsSync(f), `allowlisted but missing: ${rel(f)}`);
});

test('the parser sees every kind of runtime import, and no type-only one', () => {
  const found = importsOf(src('adaptive/brain/modelClient.ts')).specs;
  assert(found.includes('@anthropic-ai/sdk') && found.includes('@anthropic-ai/sdk/helpers/zod'), 'the lazy SDK imports');
  const code = [
    'export type X = { a: 1 };',
    "import { y } from './a';",
    "export { z } from './b';",
    "import q = require('./c');",
    'const t = import(`./d`);',
    "const r = require('./e');",
    "export * from './f';",
    "import type { T } from './no1';",
    "import { type U } from './no2';",
    "export type { V } from './no3';",
    "import type W = require('./no4');",
    "if (require.main === module) void require.resolve('./no5');",
    "const name = './x'; const u = import(name); const v = require(`./${name}`);",
  ].join('\n');
  const got = importsOfText('sample.ts', code);
  assert(JSON.stringify(got.specs) === JSON.stringify(['./a', './b', './c', './d', './e', './f']), `specs ${JSON.stringify(got.specs)}`);
  assert(got.dynamic === 2, `computed imports ${got.dynamic}`);
  const handed = importsOfText('handed.ts', "const r = require; r('./x'); module.require('./y'); import { createRequire } from 'module'; require.call(null, './z');");
  assert(handed.dynamic === 4, `require handed around, module.require, createRequire, require.call: ${handed.dynamic}`);
  const keys = colKeysIn(ts.createSourceFile('k.ts', "COL.a; COL?.b; COL['c']; const { d, e: f } = COL; const g = COL; COL[x];", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  assert(JSON.stringify(keys) === JSON.stringify(['a', 'b', 'c', 'd', 'e', null, null]), `COL keys: ${JSON.stringify(keys)}`);
});

test('the worker reaches the model client and the SDK (the walk works)', () => {
  const r = reach(src('adaptive/worker/main.ts'));
  assert(r.has(src('adaptive/brain/modelClient.ts')), 'worker → model client');
  assert([...r].some(isAnthropicSdk), 'worker → the SDK');
});

test('the API process never loads an AI SDK or the code that calls a model', () => {
  const r = reach(src('server.ts'));
  const sdk = [...r].filter(isAiPackage);
  assert(!sdk.length, `server.ts reaches ${sdk.join(', ')}`);
  const model = MODEL_CODE.filter((f) => r.has(f));
  assert(!model.length, `server.ts reaches ${model.map(rel).join(', ')}`);
  // The admin routes are part of the API; they only schedule a task.
  assert(r.has(src('adaptive/service/agentsAdmin.ts')), 'the admin AI routes are in the API');
});

test('only brain/modelClient.ts imports an AI SDK, and only the Anthropic one', () => {
  const importers = allFiles(SRC).filter((f) => importsOf(f).specs.some((s) => isAiPackage(s)));
  assert(importers.length === 1 && importers[0] === src('adaptive/brain/modelClient.ts'), `importers: ${importers.map(rel).join(', ')}`);
  const other = importsOf(importers[0]).specs.filter((s) => isAiPackage(s) && !isAnthropicSdk(s));
  assert(!other.length, `another provider: ${other.join(', ')}`);
});

test('the AI code reaches only its allowlist (a new file is a decision, not an accident)', () => {
  const brainFiles = allFiles(src('adaptive/brain'));
  assert(brainFiles.length >= 10, 'brain files found');
  const reached = new Set(brainFiles.flatMap((f) => [...reach(f)]));
  const extra = [...reached].filter((f) => !BRAIN_MAY_REACH.has(f));
  assert(!extra.length, `not on the allowlist: ${extra.map(rel).join(', ')}`);
});

test('the AI code never reaches the send path, the wallet or other messaging code (Brevo only through the alerts)', () => {
  for (const f of allFiles(src('adaptive/brain'))) {
    const bad = SENDING.filter((s) => reach(f, new Set([ALERTS])).has(s));
    assert(!bad.length, `${rel(f)} reaches ${bad.map(rel).join(', ')}`);
  }
  // The alerts themselves send only HeidiFi's / owners' alert emails (never a guest message).
  const fromAlerts = SENDING.filter((s) => s !== src('services/brevo.ts') && reach(ALERTS).has(s));
  assert(!fromAlerts.length, `engine/alerts.ts reaches ${fromAlerts.map(rel).join(', ')}`);
});

/** The `COL` keys a file uses (`COL.x`, `COL?.x`, `COL['x']`, `const { x } = COL`); `null` for a computed one. */
function colKeysIn(sf: ts.SourceFile): Array<string | null> {
  const keys: Array<string | null> = [];
  const isCol = (e: ts.Expression) => ts.isIdentifier(e) && e.text === 'COL';
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && isCol(n.expression)) keys.push(n.name.text);
    else if (ts.isElementAccessExpression(n) && isCol(n.expression)) {
      const a = n.argumentExpression;
      keys.push(ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? a.text : null);
    } else if (ts.isVariableDeclaration(n) && n.initializer && isCol(n.initializer) && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) keys.push(ts.isIdentifier(el.propertyName ?? el.name) ? (el.propertyName ?? (el.name as ts.Identifier)).getText(sf) : null);
    } else if (ts.isVariableDeclaration(n) && n.initializer && isCol(n.initializer) && ts.isIdentifier(n.name)) {
      keys.push(null); // COL handed around under another name
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return keys;
}

test('the AI code names only its own collections, and creates only agent_run tasks and its own alerts', () => {
  const reached = new Set(allFiles(src('adaptive/brain')).flatMap((f) => [...reach(f)]));
  const files = [...reached].filter((f) => f.startsWith(SRC) && existsSync(f) && f !== src('adaptive/store/collections.ts'));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const keys = colKeysIn(sf).filter((k) => k === null || !BRAIN_COLLECTIONS.has(k));
    assert(!keys.length, `${rel(f)} names ${[...new Set(keys.map((k) => k ?? '(a computed key)'))].join(', ')}`);
    const literals: string[] = [];
    const findLiterals = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.startsWith('CaptivePortal_')) literals.push(n.text);
      // `db.collection('…')` / `.doc('a/b')` with a literal: every collection goes through COL.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['collection', 'collectionGroup'].includes(n.expression.name.text)) {
        const a = n.arguments[0];
        const sub = SUBCOLLECTION_OK[f];
        if (a && !(ts.isPropertyAccessExpression(a) && ts.isIdentifier(a.expression) && a.expression.text === 'COL') && !(sub && ts.isIdentifier(a) && a.text === sub)) literals.push(a.getText(sf));
      }
      ts.forEachChild(n, findLiterals);
    };
    findLiterals(sf);
    assert(!literals.length, `${rel(f)} names a collection outside COL (${literals.join(', ')})`);
  }
  for (const f of allFiles(src('adaptive/brain'))) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const kinds: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'kind' && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))) {
        kinds.push(n.initializer.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const bad = kinds.filter((k) => !['agent_run', 'agent_budget', 'agent_failing'].includes(k));
    assert(!bad.length, `${rel(f)} uses kind ${bad.join(', ')} (a task or an alert the AI code may not create)`);
    // Its alerts go to HeidiFi only (an owner audience mails a person).
    const audiences: string[] = [];
    const findAudience = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'audience') audiences.push(n.initializer.getText(sf));
      ts.forEachChild(n, findAudience);
    };
    findAudience(sf);
    const other = audiences.filter((a) => a !== "'heidifi'");
    assert(!other.length, `${rel(f)} raises an alert for ${other.join(', ')} (HeidiFi only)`);
  }
});

test('PR W2: the AI code never reaches the Meta client, the template context, submit, sync or the connection', () => {
  const reached = new Set(allFiles(src('adaptive/brain')).flatMap((f) => [...reach(f)]));
  const banned = ['context.ts', 'meta.ts', 'source.ts', 'sandbox.ts', 'submit.ts', 'sync.ts', 'connection.ts', 'hints.ts', 'aiRequests.ts'].map((x) => src(`adaptive/whatsapp/${x}`));
  const bad = banned.filter((f) => reached.has(f));
  assert(!bad.length, `the AI code reaches ${bad.map(rel).join(', ')}`);
});

test('only the model client names the relay (one way to a model)', () => {
  const users = allFiles(SRC).filter((f) => /RELAY_PATH|model-relay/.test(readFileSync(f, 'utf8')));
  assert(users.length === 1 && users[0] === src('adaptive/brain/modelClient.ts'), `named in: ${users.map(rel).join(', ')}`);
});

test('the send path never reaches the AI code', () => {
  for (const f of [src('adaptive/engine/sendPath.ts'), src('adaptive/send/dispatch.ts')]) {
    const bad = [...reach(f)].filter((x) => x.startsWith(src('adaptive/brain/')));
    assert(!bad.length, `${rel(f)} reaches ${bad.map(rel).join(', ')}`);
  }
});

test('nothing unresolved or computed on the way (a moved file or a computed import would hide a load)', () => {
  const files = [...new Set([...reach(src('adaptive/worker/main.ts')), ...reach(src('server.ts'))])];
  const missing = files.filter((f) => f.endsWith('(unresolved)'));
  assert(!missing.length, `unresolved: ${missing.map(rel).join(', ')}`);
  const computed = files.filter((f) => f.startsWith(SRC) && existsSync(f) && importsOf(f).dynamic > 0);
  assert(!computed.length, `computed imports in: ${computed.map(rel).join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
