/**
 * Every place a journey can start respects the Start-sending hold (PR D, D-D1 / D-D13).
 * A source scan of server/src/adaptive (comments stripped first) that pins:
 *  - `enrolForEvent(` has exactly three callers: engine/route.ts ×2 (connect, visit end)
 *    and stays/moments.ts ×1 (stay moments). Each gets its mode from `venueModeFor(`,
 *    never a bare `modeFor(`, with an `off → return` before the call;
 *  - `linkStayOnConnect(` is called once, in the connect path, after that hold check;
 *  - `recordConnect(` gets the held-checked mode, and only a new visit doc stores it as `startMode`;
 *  - the visit end judges the mode by the visit's start (`startedAt`, `startMode`), not the clock;
 *  - the login hook writes nothing for a held venue.
 *
 * Run: npx tsx tests/adaptiveHoldCallers.test.ts   (from captive-server/server)
 *
 * No Firestore, no credentials. The source is only read as text (fs + path).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Reading the source ───────────────────────────────────────────────────────

const ROOT = join(__dirname, '../src/adaptive');
const BEFORE_REGEX_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/**
 * Comments become spaces (newlines kept, so every index stays where it was). With
 * `literals`, the insides of strings, template text and regex literals are blanked too,
 * so the brackets and names found afterwards are code.
 */
function blank(src: string, literals: boolean): string {
  const out = src.split('');
  const wipe = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  const tpl: number[] = []; // open `${` interpolations: brace depth inside each
  const template = (from: number): number => {
    let j = from;
    while (j < src.length) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === '`') {
        if (literals) wipe(from, j);
        return j + 1;
      }
      if (src[j] === '$' && src[j + 1] === '{') {
        if (literals) wipe(from, j);
        tpl.push(0);
        return j + 2;
      }
      j += 1;
    }
    return j;
  };
  let prev = '';
  let word = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const nl = src.indexOf('\n', i);
      const e = nl === -1 ? src.length : nl;
      wipe(i, e);
      i = e;
      continue;
    }
    if (c === '/' && n === '*') {
      const k = src.indexOf('*/', i + 2);
      const e = k === -1 ? src.length : k + 2;
      wipe(i, e);
      i = e;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (literals) wipe(i + 1, j);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '`') {
      i = template(i + 1);
      prev = '`';
      continue;
    }
    if (c === '{' && tpl.length) tpl[tpl.length - 1] += 1;
    if (c === '}' && tpl.length) {
      if (tpl[tpl.length - 1] === 0) {
        tpl.pop();
        i = template(i + 1);
        prev = '`';
        continue;
      }
      tpl[tpl.length - 1] -= 1;
    }
    if (c === '/' && (prev === '' || '([{,;:=!&|?+-*%<>~^}'.includes(prev) || (/[\w$]/.test(prev) && BEFORE_REGEX_WORDS.has(word)))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j += 1;
      }
      if (literals) wipe(i + 1, j);
      i = j + 1;
      prev = '/';
      word = '';
      continue;
    }
    if (!/\s/.test(c)) {
      word = /[\w$]/.test(c) ? (i > 0 && /[\w$]/.test(src[i - 1]) ? word + c : c) : '';
      prev = c;
    }
    i += 1;
  }
  return out.join('');
}

interface Source {
  rel: string;
  /** Comments stripped (strings kept). */
  code: string;
  /** Comments and literal contents blanked: same indices as `code`. */
  masked: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SOURCES: Source[] = walk(ROOT).map((file) => {
  const raw = readFileSync(file, 'utf8');
  return { rel: relative(ROOT, file).split(sep).join('/'), code: blank(raw, false), masked: blank(raw, true) };
});

function source(rel: string): Source {
  const s = SOURCES.find((x) => x.rel === rel);
  if (!s) throw new Error(`${rel} not found under src/adaptive`);
  return s;
}

function lineOf(s: Source, at: number): number {
  return s.code.slice(0, at).split('\n').length;
}

function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

function closing(masked: string, open: number): number {
  const o = masked[open];
  const c = PAIRS[o];
  if (!c) throw new Error(`no bracket at ${open}`);
  let depth = 0;
  for (let j = open; j < masked.length; j += 1) {
    if (masked[j] === o) depth += 1;
    else if (masked[j] === c) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  throw new Error(`no closing ${c} for the ${o} at ${open}`);
}

/** Where a return type annotation ends: the body's `{`. */
function typeEnd(masked: string, from: number): number {
  let angle = 0;
  let paren = 0;
  let square = 0;
  let seen = false;
  for (let j = from; j < masked.length; j += 1) {
    const ch = masked[j];
    if (ch === '{') {
      if (seen && !angle && !paren && !square) return j;
      j = closing(masked, j);
      seen = true;
      continue;
    }
    if (ch === '<') angle += 1;
    else if (ch === '>' && masked[j - 1] !== '=') angle -= 1;
    else if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '[') square += 1;
    else if (ch === ']') square -= 1;
    if (!/\s/.test(ch)) seen = true;
  }
  return masked.length;
}

interface Fn {
  name: string;
  paramsOpen: number;
  bodyStart: number;
  bodyEnd: number;
}

function functionsIn(s: Source): Fn[] {
  const out: Fn[] = [];
  for (const m of s.masked.matchAll(/(?<![\w$])function\s*\*?\s*([\w$]*)\s*(?:<[^()]*>)?\s*\(/g)) {
    const paramsOpen = m.index! + m[0].length - 1;
    let j = closing(s.masked, paramsOpen) + 1;
    while (/\s/.test(s.masked[j] ?? '')) j += 1;
    if (s.masked[j] === ':') j = typeEnd(s.masked, j + 1);
    if (s.masked[j] !== '{') continue; // an overload or a function type
    out.push({ name: m[1], paramsOpen, bodyStart: j, bodyEnd: closing(s.masked, j) });
  }
  return out;
}

function functionNamed(s: Source, name: string): Fn {
  const fns = functionsIn(s).filter((f) => f.name === name);
  assertEqual(fns.length, 1, `${s.rel}: functions named ${name}`);
  return fns[0];
}

/** The innermost named or anonymous `function` whose body holds `at`. */
function enclosing(s: Source, at: number): Fn {
  const around = functionsIn(s).filter((f) => f.bodyStart < at && at < f.bodyEnd);
  if (!around.length) throw new Error(`${s.rel}:${lineOf(s, at)} is not inside a function`);
  return around.reduce((a, b) => (b.bodyStart > a.bodyStart ? b : a));
}

/** Brace depth of `at` inside a function body (1 = directly in the body). */
function depthIn(s: Source, fn: Fn, at: number): number {
  let depth = 0;
  for (let j = fn.bodyStart; j < at; j += 1) {
    if (s.masked[j] === '{') depth += 1;
    else if (s.masked[j] === '}') depth -= 1;
  }
  return depth;
}

/** The top-level comma-separated parts inside the bracket at `open`. */
function parts(s: Source, open: number): Array<[number, number]> {
  const close = closing(s.masked, open);
  const out: Array<[number, number]> = [];
  let depth = 0;
  let from = open + 1;
  for (let j = open + 1; j < close; j += 1) {
    const ch = s.masked[j];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push([from, j]);
      from = j + 1;
    }
  }
  if (s.masked.slice(from, close).trim()) out.push([from, close]);
  return out;
}

function text(s: Source, [a, b]: [number, number]): string {
  return s.code.slice(a, b).trim();
}

/** The arguments of the call whose name starts at `at`. */
function callArgs(s: Source, at: number): Array<[number, number]> {
  const open = s.masked.indexOf('(', at);
  return parts(s, open);
}

/** The properties of the object literal an argument is: key → value range. */
function objectProps(s: Source, arg: [number, number]): Map<string, [number, number]> {
  const open = s.masked.indexOf('{', arg[0]);
  assert(open !== -1 && open < arg[1] && !s.masked.slice(arg[0], open).trim(), `${s.rel}:${lineOf(s, arg[0])}: the argument is an object literal`);
  const props = new Map<string, [number, number]>();
  for (const p of parts(s, open)) {
    const raw = s.masked.slice(p[0], p[1]);
    const lead = raw.length - raw.trimStart().length;
    const kv = /^([\w$]+)\s*:\s*/.exec(raw.trimStart());
    if (kv) props.set(kv[1], [p[0] + lead + kv[0].length, p[1]]);
    else if (/^[\w$]+$/.test(raw.trim())) props.set(raw.trim(), [p[0] + lead, p[0] + lead + raw.trim().length]);
  }
  return props;
}

/** Where the statement starting at `from` ends (`;` at depth 0, or the end of its block). */
function statementEnd(s: Source, from: number): number {
  let depth = 0;
  for (let j = from; j < s.masked.length; j += 1) {
    const ch = s.masked[j];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return j;
      depth -= 1;
    } else if (ch === ';' && depth === 0) return j;
  }
  return s.masked.length;
}

interface Decl {
  name: string;
  at: number;
  init: [number, number];
}

function declsIn(s: Source, fn: Fn, name: string): Decl[] {
  const re = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${name}\\s*(?::[^=;]*)?=(?![=>])`, 'g');
  const out: Decl[] = [];
  re.lastIndex = fn.bodyStart;
  for (let m = re.exec(s.masked); m && m.index < fn.bodyEnd; m = re.exec(s.masked)) {
    const start = m.index + m[0].length;
    out.push({ name, at: m.index, init: [start, statementEnd(s, start)] });
  }
  return out;
}

/** Plain assignments `name = …` in a function (not declarations): the assigned text. */
function assignmentsIn(s: Source, fn: Fn, name: string): Array<{ at: number; value: string }> {
  const re = new RegExp(`(?<![\\w$.])${name}\\s*=(?![=>])`, 'g');
  const out: Array<{ at: number; value: string }> = [];
  re.lastIndex = fn.bodyStart;
  for (let m = re.exec(s.masked); m && m.index < fn.bodyEnd; m = re.exec(s.masked)) {
    if (/(?:const|let|var)\s+$/.test(s.masked.slice(Math.max(0, m.index - 12), m.index))) continue;
    const start = m.index + m[0].length;
    out.push({ at: m.index, value: text(s, [start, statementEnd(s, start)]) });
  }
  return out;
}

/** Follows a variable through the initializers of the same function (declared before `before`). */
function chainOf(s: Source, fn: Fn, name: string, before: number): Decl[] {
  const seen = new Set<string>();
  const chain: Decl[] = [];
  const visit = (v: string, limit: number, depth: number) => {
    if (seen.has(v) || depth > 5) return;
    seen.add(v);
    const decl = declsIn(s, fn, v).filter((d) => d.at < limit).pop();
    if (!decl) return;
    chain.push(decl);
    const init = s.masked.slice(decl.init[0], decl.init[1]);
    for (const m of init.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) visit(m[1], decl.at, depth + 1);
  };
  visit(name, before, 0);
  return chain;
}

const VENUE_MODE_CALL = /(?<![\w$])venueModeFor\s*\(/;
const BARE_MODE_CALL = /(?<![\w$])modeFor\s*\(/;

/** `if (v === 'off') return` directly in the function body: its index, or -1. */
function offReturn(s: Source, fn: Fn, v: string): number {
  const re = new RegExp(`if\\s*\\(\\s*${v}\\s*===\\s*(['"])off\\1\\s*\\)\\s*return\\b`, 'g');
  re.lastIndex = fn.bodyStart;
  for (let m = re.exec(s.code); m && m.index < fn.bodyEnd; m = re.exec(s.code)) {
    if (depthIn(s, fn, m.index) === 1) return m.index;
  }
  return -1;
}

type RefKind = 'definition' | 'import' | 'call' | 'other';
interface Ref {
  src: Source;
  at: number;
  kind: RefKind;
}

function importRanges(s: Source): Array<[number, number]> {
  return [...s.masked.matchAll(/(?<![\w$.])import\s+[^;'"()]*?\bfrom\s*(['"])[^'"\n]*\1/g)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
}

/** Every mention of `name` in code, sorted into its definition, imports, calls and anything else. */
function refsTo(name: string): Ref[] {
  const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
  const out: Ref[] = [];
  for (const s of SOURCES) {
    const imports = importRanges(s);
    for (const m of s.masked.matchAll(re)) {
      const at = m.index!;
      let kind: RefKind;
      if (/(?<![\w$])function\s*\*?\s*$/.test(s.masked.slice(Math.max(0, at - 40), at))) kind = 'definition';
      else if (imports.some(([a, b]) => a <= at && at < b)) kind = 'import';
      else if (/^\s*\(/.test(s.masked.slice(at + name.length, at + name.length + 40))) kind = 'call';
      else kind = 'other';
      out.push({ src: s, at, kind });
    }
  }
  return out;
}

function where(r: Ref): string {
  return `${r.src.rel}:${lineOf(r.src, r.at)}`;
}

function callsOf(name: string): Ref[] {
  return refsTo(name).filter((r) => r.kind === 'call');
}

/** Counts per file, e.g. { 'engine/route.ts': 2 }. */
function perFile(refs: Ref[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of [...refs].sort((a, b) => a.src.rel.localeCompare(b.src.rel))) out[r.src.rel] = (out[r.src.rel] ?? 0) + 1;
  return out;
}

/**
 * The hold behind the `mode` a call passes: the variable is declared in the calling
 * function, it comes from exactly one `venueModeFor(` variable, that variable is followed
 * by an `off → return` directly in the function body before the call, and later
 * assignments only make it `'test'`.
 */
function holdBehind(r: Ref, prop = 'mode'): { fn: Fn; modeVar: string; holdVar: string; hold: Decl; off: number } {
  const s = r.src;
  const fn = enclosing(s, r.at);
  const args = callArgs(s, r.at);
  assertEqual(args.length, 1, `${where(r)}: one argument`);
  const value = objectProps(s, args[0]).get(prop);
  assert(value, `${where(r)}: passes \`${prop}\``);
  const modeVar = text(s, value);
  assert(/^[A-Za-z_$][\w$]*$/.test(modeVar), `${where(r)}: \`${prop}\` is a variable (got ${modeVar})`);
  assertEqual(declsIn(s, fn, modeVar).length, 1, `${where(r)}: declarations of ${modeVar} in ${fn.name}`);
  const chain = chainOf(s, fn, modeVar, r.at);
  assert(chain.length && chain[0].name === modeVar, `${where(r)}: ${modeVar} is computed in ${fn.name}`);
  const holds = chain.filter((d) => VENUE_MODE_CALL.test(s.masked.slice(d.init[0], d.init[1])));
  assertEqual(holds.map((d) => d.name), [holds[0]?.name ?? '(venueModeFor)'], `${where(r)}: ${modeVar} comes from one venueModeFor variable`);
  const hold = holds[0];
  const off = offReturn(s, fn, hold.name);
  assert(off > hold.at && off < r.at, `${where(r)}: \`if (${hold.name} === 'off') return\` directly in ${fn.name}, after ${hold.name} and before the call`);
  for (const d of chain.filter((c) => c.name === modeVar || c.name === hold.name)) {
    for (const a of assignmentsIn(s, fn, d.name)) {
      assertEqual(a.value, "'test'", `${s.rel}:${lineOf(s, a.at)}: ${d.name} is only ever changed to 'test'`);
    }
  }
  return { fn, modeVar, holdVar: hold.name, hold, off };
}

// ── The scanner itself ───────────────────────────────────────────────────────

test('the comment stripper blanks comments, keeps strings, and keeps every index', () => {
  const raw = [
    "const url = 'http://x.ch/*not a comment*/'; // enrolForEvent(",
    '/* enrolForEvent( */ const re = /\\/\\/ enrolForEvent\\(/g;',
    'const t = `a ${ { b: 1 }.b } // not a comment ${`inner ${c}`}`;',
    'x = a / b / c; foo(); // tail',
    "if (ok) return /it's/.test(y);",
  ].join('\n');
  const code = blank(raw, false);
  const masked = blank(raw, true);
  assertEqual([code.length, masked.length], [raw.length, raw.length], 'same length');
  assertEqual([code.split('\n').length, masked.split('\n').length], [5, 5], 'same lines');
  assert(code.includes("'http://x.ch/*not a comment*/'"), 'a URL in a string stays');
  assert(code.includes('// not a comment'), 'a // inside template text stays');
  assert(!/enrolForEvent\(\s*$/m.test(code.split('\n')[0]), 'a line comment goes');
  assert(!code.includes('/* enrolForEvent( */'), 'a block comment goes');
  assert(!code.includes('tail'), 'a trailing comment goes');
  assert(!masked.includes('enrolForEvent') && !masked.includes('http') && !masked.includes("it's"), `literals blanked: ${masked}`);
  for (const kept of ['foo();', 'x = a / b / c;', '{ b: 1 }.b', '${c}', 'return /', '.test(y);']) assert(masked.includes(kept), `code kept: ${kept}`);
});

test('the scan sees the adaptive source and its functions', () => {
  assert(SOURCES.length > 50, `files found: ${SOURCES.length}`);
  for (const rel of ['engine/route.ts', 'engine/enrol.ts', 'stays/moments.ts', 'stays/link.ts', 'identity/visits.ts', 'ingest/connect.ts', 'store/engineSettings.ts']) source(rel);
  const route = source('engine/route.ts');
  const names = functionsIn(route).map((f) => f.name);
  for (const n of ['routeEvent', 'handleConnect', 'signupBreakerTripped', 'handleVisitEnd']) assert(names.includes(n), `route.ts has ${n} (${names})`);
  const visitEnd = functionNamed(route, 'handleVisitEnd');
  assertEqual([route.code[visitEnd.bodyStart], route.code[visitEnd.bodyEnd]], ['{', '}'], 'a body runs brace to brace');
  assertEqual(refsTo('enrolForEvent').filter((r) => r.kind === 'definition').map((r) => r.src.rel), ['engine/enrol.ts'], 'one definition, in enrol.ts');
});

// ── enrolForEvent: the only three ways a journey starts ─────────────────────

test('enrolForEvent is called exactly 3 times: route.ts ×2, moments.ts ×1', () => {
  const calls = callsOf('enrolForEvent');
  assertEqual(perFile(calls), { 'engine/route.ts': 2, 'stays/moments.ts': 1 }, `calls (${calls.map(where)})`);
  const fns = calls.map((r) => `${r.src.rel} ${enclosing(r.src, r.at).name}`).sort();
  assertEqual(fns, ['engine/route.ts handleConnect', 'engine/route.ts handleVisitEnd', 'stays/moments.ts handleStayTrigger'], 'calling functions');
});

test('enrolForEvent, linkStayOnConnect and recordConnect are never passed along, aliased or re-exported', () => {
  for (const name of ['enrolForEvent', 'linkStayOnConnect', 'recordConnect']) {
    const refs = refsTo(name);
    const other = refs.filter((r) => r.kind === 'other');
    assertEqual(other.map(where), [], `${name}: mentions that are not its definition, an import or a call`);
    assertEqual(refs.filter((r) => r.kind === 'definition').length, 1, `${name}: definitions`);
    for (const s of SOURCES) {
      for (const [a, b] of importRanges(s)) {
        assert(!new RegExp(`(?<![\\w$])${name}\\s+as\\s`).test(s.masked.slice(a, b)), `${s.rel}:${lineOf(s, a)}: ${name} imported under another name`);
      }
      assert(!new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*(?<![\\w$])${name}(?![\\w$])[^}]*\\}`).test(s.masked), `${s.rel}: re-exports ${name}`);
    }
  }
});

test('each enrolForEvent call gets its mode from venueModeFor, after an off → return', () => {
  const sites = callsOf('enrolForEvent').map((r) => {
    const h = holdBehind(r);
    const body = r.src.masked.slice(h.fn.bodyStart, h.fn.bodyEnd);
    assert(!BARE_MODE_CALL.test(body), `${where(r)}: ${h.fn.name} calls a bare modeFor(`);
    return `${r.src.rel} ${h.fn.name}: mode=${h.modeVar} from ${h.holdVar}`;
  });
  assertEqual(sites.sort(), [
    'engine/route.ts handleConnect: mode=mode from mode',
    'engine/route.ts handleVisitEnd: mode=mode from mode',
    'stays/moments.ts handleStayTrigger: mode=mode from current',
  ], 'where each mode comes from');
  for (const rel of ['engine/route.ts', 'stays/moments.ts']) {
    const s = source(rel);
    const imported = importRanges(s).map((r) => s.masked.slice(r[0], r[1])).join('\n');
    assert(/(?<![\w$])venueModeFor(?![\w$])/.test(imported), `${rel} imports venueModeFor`);
    assert(!/(?<![\w$])modeFor(?![\w$])/.test(imported), `${rel} imports no bare modeFor`);
    assert(!BARE_MODE_CALL.test(s.masked), `${rel} calls no bare modeFor(`);
  }
});

test("a stay moment's mode is the stricter of the link's mode and venueModeFor: never upgraded to live", () => {
  const s = source('stays/moments.ts');
  const call = callsOf('enrolForEvent').find((r) => r.src === s)!;
  const fn = enclosing(s, call.at);
  const [mode] = declsIn(s, fn, 'mode');
  assertEqual(squash(text(s, mode.init)), 'stricter(stay.linkMode,current)', 'mode = stricter(stay.linkMode, current)');
  const strict = functionNamed(s, 'stricter');
  const params = parts(s, strict.paramsOpen).map((p) => /^[\w$]+/.exec(text(s, p))![0]);
  assertEqual(params, ['linkMode', 'current'], 'stricter(linkMode, current)');
  const body = s.code.slice(strict.bodyStart + 1, strict.bodyEnd);
  let run: (a: string | null, b: string) => unknown;
  try {
    run = new Function(...params, body) as typeof run;
  } catch (err) {
    throw new Error(`stricter's body is not plain JS any more (${(err as Error).message}): ${body.trim()}`);
  }
  const rows: Array<[string | null, string, string]> = [
    [null, 'live', 'live'],
    [null, 'test', 'test'],
    ['live', 'live', 'live'],
    ['live', 'test', 'test'],
    ['test', 'live', 'test'],
    ['test', 'test', 'test'],
  ];
  for (const [link, current, want] of rows) assertEqual(run(link, current), want, `stricter(${link}, ${current})`);
});

test("venueModeFor is judged at the event's own time with the venue's doc, never the worker clock", () => {
  const got: Record<string, string> = {};
  for (const r of callsOf('enrolForEvent')) {
    const s = r.src;
    const fn = enclosing(s, r.at);
    const holds = callsOf('venueModeFor').filter((v) => v.src === s && v.at > fn.bodyStart && v.at < fn.bodyEnd);
    assertEqual(holds.length, 1, `${s.rel} ${fn.name}: venueModeFor calls`);
    const args = callArgs(s, holds[0].at);
    assertEqual(args.length, 3, `${s.rel} ${fn.name}: venueModeFor arguments`);
    assertEqual([text(s, args[0]), text(s, args[1])], ['env.settings', 'ctx.adaptive'], `${s.rel} ${fn.name}: settings and the venue's doc`);
    const at = text(s, args[2]);
    const decl = /^[A-Za-z_$][\w$]*$/.test(at) ? declsIn(s, fn, at).filter((d) => d.at < holds[0].at).pop() : undefined;
    const resolved = decl ? text(s, decl.init) : at;
    assert(!/(?<![\w$])now(?![\w$])/.test(resolved), `${s.rel} ${fn.name}: judged at ${resolved}, not the clock`);
    got[fn.name] = squash(resolved);
  }
  assertEqual(got.handleConnect, 'event.occurredAt', 'connect: at the connect');
  assertEqual(got.handleStayTrigger, 'Math.max(p.momentAt,stay.linkedAt??p.momentAt)', 'stay moment: the later of the moment and the link');
  assert(/(?<![\w$])visit\.startedAt(?![\w$])/.test(got.handleVisitEnd ?? ''), `visit end: at the visit's start (${got.handleVisitEnd})`);
  const s = source('stays/moments.ts');
  const fn = functionNamed(s, 'handleStayTrigger');
  const [occurredAt] = declsIn(s, fn, 'occurredAt');
  assertEqual(squash(text(s, occurredAt.init)), got.handleStayTrigger, 'the moment is enrolled at the same time the hold was judged');
});

// ── linkStayOnConnect ───────────────────────────────────────────────────────

test('linkStayOnConnect is called once, in handleConnect, after the hold and only on a fresh, untripped connect', () => {
  const calls = callsOf('linkStayOnConnect');
  assertEqual(perFile(calls), { 'engine/route.ts': 1 }, `calls (${calls.map(where)})`);
  const r = calls[0];
  const h = holdBehind(r);
  assertEqual([h.fn.name, h.modeVar, h.holdVar], ['handleConnect', 'mode', 'mode'], 'held-checked mode');
  const enrol = callsOf('enrolForEvent').find((e) => e.src === r.src && enclosing(e.src, e.at).name === 'handleConnect')!;
  assertEqual(holdBehind(enrol).off, h.off, 'the same hold check as the connect enrolment');
  const body = r.src.code.slice(h.fn.bodyStart, h.fn.bodyEnd);
  assert(/if\s*\(\s*!\s*tripped\s*&&\s*fresh\s*\)\s*(?:await\s+)?linkStayOnConnect\s*\(/.test(body), 'if (!tripped && fresh) await linkStayOnConnect(');
  const props = objectProps(r.src, callArgs(r.src, r.at)[0]);
  assertEqual(text(r.src, props.get('at')!), 'event.occurredAt', 'linked at the connect time the hold was judged at');
  const returns = [...body.matchAll(/(?<![\w$])return\b/g)].map((m) => h.fn.bodyStart + m.index!);
  const firstAfterHold = returns.filter((at) => at > h.hold.at)[0];
  assertEqual(firstAfterHold, h.off + body.slice(h.off - h.fn.bodyStart).indexOf('return'), 'the first return after venueModeFor is the hold');
});

test("linkStayOnConnect's mode can't be off, and it is frozen as the stay's linkMode", () => {
  const s = source('stays/link.ts');
  assert(/interface\s+LinkArgs\s*\{[^}]*(?<![\w$])mode\s*:\s*RunMode\s*;/.test(s.masked), 'LinkArgs.mode: RunMode');
  const types = source('core/runtime/types.ts');
  assert(/type\s+RunMode\s*=\s*'test'\s*\|\s*'live'\s*;/.test(types.code), "RunMode = 'test' | 'live' (no 'off')");
  const fn = functionNamed(s, 'linkStayOnConnect');
  const body = s.code.slice(fn.bodyStart, fn.bodyEnd);
  assertEqual([...body.matchAll(/(?<![\w$])linkMode\s*:\s*([^,}]+)/g)].map((m) => m[1].trim()), ['a.mode'], 'linkMode written from the mode it got');
});

// ── recordConnect and the visit's startMode ─────────────────────────────────

test('recordConnect is called once, with the held-checked mode of the connect', () => {
  const calls = callsOf('recordConnect');
  assertEqual(perFile(calls), { 'engine/route.ts': 1 }, `calls (${calls.map(where)})`);
  const h = holdBehind(calls[0]);
  assertEqual([h.fn.name, h.modeVar, h.holdVar], ['handleConnect', 'mode', 'mode'], 'held-checked mode');
  const props = objectProps(calls[0].src, callArgs(calls[0].src, calls[0].at)[0]);
  assertEqual(text(calls[0].src, props.get('occurredAt')!), 'event.occurredAt', 'the visit starts at the connect time the hold was judged at');
});

test('a new visit doc stores startMode from the connect; a joined visit never changes it', () => {
  const s = source('identity/visits.ts');
  assert(/interface\s+ConnectInput\s*\{[^}]*(?<![\w$])mode\?\s*:\s*'test'\s*\|\s*'live'\s*\|\s*null\s*;/.test(s.code), "ConnectInput.mode?: 'test' | 'live' | null");
  const fn = functionNamed(s, 'recordConnect');
  const uses = [...s.masked.matchAll(/(?<![\w$])startMode(?![\w$])/g)].map((m) => m.index!);
  assertEqual(uses.length, 1, 'startMode mentions in visits.ts');
  assert(uses[0] > fn.bodyStart && uses[0] < fn.bodyEnd, 'inside recordConnect');
  assert(/^startMode\s*:\s*input\.mode(?![\w$])/.test(s.code.slice(uses[0])), 'startMode: input.mode');
  const [visit] = declsIn(s, fn, 'visit');
  assert(visit && visit.init[0] < uses[0] && uses[0] < visit.init[1], 'startMode is part of the new visit doc');
  const doc = squash(text(s, visit.init));
  for (const field of ["status:'open'", 'startedAt:at', 'startEventId:input.connectEventId']) assert(doc.includes(field), `the new visit doc has ${field}`);
  assert(/tx\.set\(\s*visits\.doc\(\s*visitId\s*\)\s*,\s*visit\s*\)/.test(s.code.slice(fn.bodyStart, fn.bodyEnd)), 'tx.set(visits.doc(visitId), visit)');
  const writers: string[] = [];
  for (const src of SOURCES) {
    const re = /(?<![\w$?])startMode\s*:(?!:)|\.startMode\s*=(?![=])|['"]startMode['"]/g;
    for (const m of src.code.matchAll(re)) {
      const before = src.code.slice(Math.max(0, m.index! - 1), m.index!);
      if (/[?]/.test(before)) continue;
      writers.push(`${src.rel}:${lineOf(src, m.index!)}`);
    }
  }
  assertEqual(writers, [`identity/visits.ts:${lineOf(s, uses[0])}`], 'the only place startMode is written');
  assert(/(?<![\w$])startMode\?\s*:\s*'test'\s*\|\s*'live'\s*\|\s*null\s*;/.test(source('store/engineTypes.ts').code), "VisitDoc.startMode?: 'test' | 'live' | null");
});

// ── The visit end ────────────────────────────────────────────────────────────

test("the visit end judges the mode by the visit's start, not the clock", () => {
  const s = source('engine/route.ts');
  const fn = functionNamed(s, 'handleVisitEnd');
  const body = s.code.slice(fn.bodyStart, fn.bodyEnd);
  assert(/(?<![\w$])vSnap\s*=\s*await\s+db\s*\.\s*collection\(\s*COL\.visits\s*\)\s*\.\s*doc\(\s*payload\.visitId\s*\)\s*\.\s*get\(\s*\)/.test(body), 'the visit doc is read by payload.visitId');
  assert(/(?<![\w$])visit\s*=\s*vSnap\.data\(\)/.test(body), 'visit = vSnap.data()');
  const holds = callsOf('venueModeFor').filter((v) => v.src === s && v.at > fn.bodyStart && v.at < fn.bodyEnd);
  assertEqual(holds.length, 1, 'venueModeFor calls in handleVisitEnd');
  const at = text(s, callArgs(s, holds[0].at)[2]);
  assertEqual(at, 'startedAt', 'judged at startedAt');
  const [startedAt] = declsIn(s, fn, 'startedAt');
  const init = text(s, startedAt.init);
  assert(/^tsMs\(\s*visit\.startedAt\s*\)/.test(init), `startedAt = tsMs(visit.startedAt) … (got ${init})`);
  assert(!/(?<![\w$])now(?![\w$])/.test(init), `no clock in ${init}`);
  assertEqual(squash(init), 'tsMs(visit.startedAt)??payload.lastSeenAt', 'the visit start, else its last connect (never now)');
  const [mode] = declsIn(s, fn, 'mode');
  assert(VENUE_MODE_CALL.test(s.masked.slice(mode.init[0], mode.init[1])), 'mode = venueModeFor(…)');
  assert(mode.at > startedAt.at, 'startedAt is set before the hold is judged');
});

test('the visit end applies the hold before its test-run rules, and a test visit stays a test', () => {
  const s = source('engine/route.ts');
  const fn = functionNamed(s, 'handleVisitEnd');
  const call = callsOf('enrolForEvent').find((r) => r.src === s && enclosing(s, r.at).name === 'handleVisitEnd')!;
  const h = holdBehind(call);
  const firstIn = (re: RegExp) => {
    re.lastIndex = fn.bodyStart;
    const m = re.exec(s.masked);
    return m && m.index < fn.bodyEnd ? m.index : -1;
  };
  const startMode = firstIn(/(?<![\w$])visit\.startMode(?![\w$])/g);
  const liveSince = firstIn(/(?<![\w$])accountLiveSince\s*\(/g);
  assert(startMode > h.off, 'visit.startMode is read, after the off → return');
  assert(liveSince === -1 || liveSince > h.off, 'accountLiveSince is only asked after the off → return');
  assert(startMode < call.at, 'startMode is read before the enrolment');
  const body = s.code.slice(fn.bodyStart, fn.bodyEnd);
  assert(/if\s*\(\s*visit\.startMode\s*===\s*'test'\s*\)\s*mode\s*=\s*'test'\s*;/.test(body), "if (visit.startMode === 'test') mode = 'test'");
  const assigns = assignmentsIn(s, fn, 'mode').map((a) => a.value);
  assert(assigns.length >= 1 && assigns.every((v) => v === "'test'"), `mode is only changed to 'test' (${assigns})`);
});

// ── The login hook ───────────────────────────────────────────────────────────

test('the login hook writes nothing for a held venue', () => {
  const s = source('ingest/connect.ts');
  const fn = functionNamed(s, 'adaptiveOnConnect');
  const body = s.code.slice(fn.bodyStart, fn.bodyEnd);
  const hold = /if\s*\(\s*venueModeFor\s*\(\s*settings\s*,\s*venue\s*,\s*occurredAt\s*\)\s*===\s*'off'\s*\)\s*return\b/.exec(body);
  assert(hold, "if (venueModeFor(settings, venue, occurredAt) === 'off') return");
  const holdAt = fn.bodyStart + hold.index;
  assertEqual(depthIn(s, fn, holdAt), 1, 'directly in the hook body');
  const firstWrite = fn.bodyStart + body.search(/(?<![\w$])db\s*\.\s*batch\s*\(|\.\s*(?:create|set|update)\s*\(/);
  assert(firstWrite > holdAt, 'no write before the hold check');
  const [occurredAt] = declsIn(s, fn, 'occurredAt');
  assert(occurredAt && occurredAt.at < holdAt, 'occurredAt is set before the hold check');
  assert(/occurredAt\s*:\s*new\s+Date\(\s*occurredAt\s*\)/.test(body), 'the event is written at the time the hold was judged');
});

// ── Purity ───────────────────────────────────────────────────────────────────

test('this test is pure: it only reads files and loads no firebase', () => {
  const self = readFileSync(__filename, 'utf8');
  const runtime = [...self.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assertEqual(runtime.sort(), ['fs', 'path'], 'runtime imports');
  const own = blank(self, true);
  assert(!/(?<![\w$.])require\s*\(/.test(own) && !/(?<![\w$.])import\s*\(/.test(own), 'no require() or import()');
  const cache = typeof require !== 'undefined' ? Object.keys(require.cache ?? {}) : [];
  assert(!cache.some((k) => /[\\/]src[\\/]firebase\.ts$/.test(k)), 'firebase.ts was not loaded');
  assert(!cache.some((k) => /[\\/]src[\\/]adaptive[\\/]/.test(k)), 'no adaptive module was loaded');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
