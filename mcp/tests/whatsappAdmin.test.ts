/**
 * The WhatsApp admin tools' pure view code (tools/whatsappAdminView.ts): picking a template by id
 * or name + language, the connection strip, the list and its filters, one template in full, the
 * coverage summary ("N of 44 in use"), merging a draft change, the sending checks, masked test
 * phones, and server refusals in words.
 *
 * Run: npx tsx tests/whatsappAdmin.test.ts   (from captive-server/mcp)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WHATSAPP_ON_PHRASE,
  checksView,
  connectionView,
  coverageView,
  errorText,
  listInputSchema,
  listView,
  maskPhone,
  mergeSource,
  pickTemplate,
  recipientsView,
  sendingView,
  stepsView,
  templateDetail,
} from '../src/mcp/tools/whatsappAdminView';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

type Raw = Record<string, any>;

const id = (n: number) => `wt_${String(n).padStart(32, '0')}`;

function tpl(n: number, over: Raw = {}): Raw {
  return {
    id: id(n),
    name: 'hf_birthday_1',
    language: 'en',
    lang: 'en',
    use: { kind: 'adaptive', journeyKey: 'birthday', poolKey: 'birthday' },
    message: { journeyKey: 'birthday', poolKey: 'birthday', name: 'Birthday gift', journeyName: 'Birthday', rule: 'marketing' },
    origin: 'manual',
    stage: 'draft',
    display: 'ready',
    usable: false,
    useEnabled: true,
    dismissed: false,
    requestedCategory: 'MARKETING',
    metaCategory: null,
    metaStatus: null,
    rejectedReason: null,
    rejectedWords: null,
    checks: { ok: true, errors: 0, warnings: 1 },
    version: 3,
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...over,
  };
}

const templates = [
  tpl(1),
  tpl(2, { lang: 'de', language: 'de' }),
  tpl(3, { name: 'hf_review_ask_1', use: { kind: 'adaptive', journeyKey: 'review', poolKey: 'review_ask' }, message: { journeyKey: 'review', poolKey: 'review_ask', name: 'Review ask', journeyName: 'Review', rule: 'marketing' }, display: 'approved', usable: true, stage: 'submitted', metaStatus: 'APPROVED' }),
  tpl(4, { name: 'guest_otp', use: { kind: 'otp' }, message: null, display: 'approved', usable: false, lang: 'en' }),
  tpl(5, { name: 'hf_review_ask_2', dismissed: true, use: { kind: 'adaptive', journeyKey: 'review', poolKey: 'review_ask' }, message: null, display: 'rejected', metaStatus: 'REJECTED', rejectedReason: 'INVALID_FORMAT', rejectedWords: 'The format is wrong' }),
];

test('pickTemplate: by id, by name + lang, and words when it is ambiguous or missing', () => {
  eq(pickTemplate(templates, { templateId: id(3) }), { id: id(3) }, 'id');
  eq(pickTemplate(templates, { name: 'hf_birthday_1', lang: 'de' }), { id: id(2) }, 'name+lang');
  const amb = pickTemplate(templates, { name: 'hf_birthday_1' });
  assert('error' in amb && /en, de/.test(amb.error), `ambiguous: ${JSON.stringify(amb)}`);
  const none = pickTemplate(templates, { name: 'hf_birthday_1', lang: 'it' });
  assert('error' in none && /no it/.test(none.error), 'missing language');
  assert('error' in pickTemplate(templates, {}), 'no ref');
  assert('error' in pickTemplate(templates, { templateId: id(9) }), 'unknown id');
});

test('connection strip: number, quality, token never expires, notices, last sync', () => {
  const v = connectionView({
    wabaId: '123',
    configured: true,
    client: 'meta',
    connection: { ok: true, verifiedName: 'HeidiFi', displayPhoneNumber: '+41 44 000 00 00', quality: 'GREEN', tokenExpiresAt: null, tokenDescribed: true, notices: 'on', problems: [], checkedAt: '2026-11-10T07:00:00.000Z' },
    lastSync: { at: '2026-11-10T07:30:00.000Z', ok: true, complete: true, changes: 2, imported: 0, error: null },
    templateCount: 7,
    templateLimit: 250,
  });
  eq([v.connected, v.account, v.number, v.quality, v.tokenExpires, v.notices], [true, '123', '+41 44 000 00 00', 'GREEN', 'never', 'on'], 'strip');
  eq(v.lastSync, { at: '2026-11-10T07:30:00.000Z', ok: true, complete: true, changes: 2, imported: 0, error: null }, 'sync');
  eq(connectionView({ connection: { tokenExpiresAt: Date.UTC(2027, 0, 1) } }).tokenExpires, '2027-01-01T00:00:00.000Z', 'expiry date');
  eq(connectionView({}).tokenExpires, 'unknown', 'never checked');
  eq(connectionView({}).connected, false, 'not connected');
});

test('list: hides dismissed by default, filters ours/legacy, language, status, search', () => {
  const o = { templates, counts: { total: 5 } };
  const all = listView(o, listInputSchema.parse({}));
  eq(all.count, 4, 'dismissed hidden');
  eq(listView(o, listInputSchema.parse({ includeDismissed: true })).count, 5, 'dismissed shown');
  eq(listView(o, listInputSchema.parse({ kind: 'legacy' })).templates.map((t) => t.name), ['guest_otp'], 'legacy');
  eq(listView(o, listInputSchema.parse({ lang: 'de' })).templates.map((t) => t.templateId), [id(2)], 'lang');
  eq(listView(o, listInputSchema.parse({ status: 'approved', kind: 'ours' })).templates.map((t) => t.name), ['hf_review_ask_1'], 'status');
  eq(listView(o, listInputSchema.parse({ search: 'REVIEW' })).count, 1, 'search');
  const row = all.templates[0];
  eq([row.kind, row.status, row.inUse, row.checks], ['ours', 'ready', false, { ok: true, errors: 0, warnings: 1 }], 'row');
  const rej = listView(o, listInputSchema.parse({ includeDismissed: true, status: 'rejected' })).templates[0];
  eq(rej.metaReason, { code: 'INVALID_FORMAT', words: 'The format is wrong' }, 'Meta reason');
});

test('template detail: our text, Meta body with {{n}}, the field mapping, editable, timeline', () => {
  const d = templateDetail({
    template: {
      ...tpl(1),
      source: { body: 'Hi {{contact.firstName}}, happy birthday from {{venue.name}}!', footer: 'Reply STOP', button: { text: 'Get it', field: 'link.offer' } },
      compiled: { bodyText: 'Hi {{1}}, happy birthday from {{2}}!', footerText: 'Reply STOP', button: { text: 'Get it' }, params: [{ n: 1, field: 'contact.firstName', fallback: 'there', example: 'Anna' }, { n: 2, field: 'venue.name', fallback: null, example: 'Café Bellevue' }] },
      allowedFields: ['contact.firstName', 'venue.name'],
    },
    history: [{ at: '2026-11-09T10:00:00.000Z', kind: 'draft.created', summary: 'Draft hf_birthday_1 (en) written', actor: { kind: 'admin', label: 'manish@heidifi.ai' } }],
  });
  eq(d.metaBody, 'Hi {{1}}, happy birthday from {{2}}!', 'meta body');
  eq(d.fields.map((f) => `${f.n}=${f.field}`), ['1=contact.firstName', '2=venue.name'], 'mapping');
  eq([d.editable, d.canSendToMeta, d.version], [true, true, 3], 'flags');
  eq(d.timeline[0].by, 'manish@heidifi.ai', 'timeline');
  const approved = templateDetail({ template: { ...templates[2], source: { body: 'x' } }, history: [] });
  eq(approved.editable, false, 'approved is not editable');
  const rejected = templateDetail({ template: { ...templates[4], stage: 'submitted', source: { body: 'x' } }, history: [] });
  eq(rejected.editable, true, 'rejected is editable');
});

test('coverage: "N of 44 in use" over 11 messages × 4 languages, AI options per cell', () => {
  const messages = Array.from({ length: 11 }, (_, i) => ({
    journeyKey: i < 2 ? 'review' : `j${i}`,
    journeyName: 'J',
    poolKey: `p${i}`,
    name: `Message ${i}`,
    rule: 'marketing',
    cells: {
      en: i < 4 ? { display: 'approved', usable: true, name: `hf_p${i}_1`, templateId: id(i), count: 1, suggest: [{ kind: 'alternative', templateId: null }] } : { display: 'missing', usable: false, count: 0, suggest: [{ kind: 'new', templateId: null }] },
      de: i === 0 ? { display: 'approved', usable: true, count: 1, suggest: [] } : { display: 'missing', usable: false, count: 0, suggest: [{ kind: 'translation', templateId: id(i) }], aiPending: i === 1 },
      fr: { display: 'missing', usable: false, count: 0, suggest: [] },
      it: { display: 'missing', usable: false, count: 0, suggest: [] },
    },
  }));
  const v = coverageView({ messages, ai: { aiOn: true, budgetOk: true, runsLeft: 12, pendingCells: 1 } });
  eq(v.summary, '5 of 44 in use', 'summary');
  eq(v.messages.length, 11, 'all messages');
  eq(coverageView({ messages }, 'review').messages.length, 2, 'one journey');
  eq(coverageView({ messages }, 'review').summary, '5 of 44 in use', 'summary counts all');
  eq(v.messages[1].cells.de.aiCanWrite, [{ kind: 'translation', templateId: id(1) }], 'translate option');
  eq(v.messages[1].cells.de.aiWriting, true, 'pending');
  eq(v.ai, { on: true, budgetOk: true, runsLeftToday: 12, blocked: null, cellsBeingWritten: 1 }, 'ai');
});

test('checks: the counts, and the issues in words when the report has them', () => {
  eq(checksView({ ok: false, errors: 2, warnings: 0 }), { ok: false, errors: 2, warnings: 0 }, 'list line');
  eq(
    checksView({ ok: false, errors: 1, warnings: 1, issues: [{ code: 'T09', severity: 'error', message: 'No field at the end' }, { code: 'W05', severity: 'warning', message: 'Long' }] }),
    { ok: false, errors: 1, warnings: 1, issues: ['error T09: No field at the end', 'warning W05: Long'] },
    'full report',
  );
  eq(checksView(undefined), { ok: false, errors: 0, warnings: 0 }, 'none');
});

test('mergeSource: keeps what is not changed; null removes footer or button', () => {
  const cur = { body: 'Old', footer: 'Reply STOP', button: { text: 'Go', field: 'link.offer' } };
  eq(mergeSource(cur, { body: 'New' }), { body: 'New', footer: 'Reply STOP', button: { text: 'Go', field: 'link.offer' } }, 'body only');
  eq(mergeSource(cur, { footer: null, button: null }), { body: 'Old', footer: null, button: null }, 'remove');
  eq(mergeSource(null, { body: 'Fresh' }), { body: 'Fresh', footer: null, button: null }, 'no text yet');
});

test('sending: the switch, the three checks, readiness and the ON phrase', () => {
  const l = {
    version: 41,
    warnings: ['No alert email is set', 'WhatsApp sending is on, but: x'],
    whatsappTemplates: { autoSubmit: 'off' },
    whatsappSending: {
      mode: 'off',
      changedBy: 'u1',
      checks: [
        { key: 'worker_keys', ok: true, text: 'The adaptive-worker has the WhatsApp keys' },
        { key: 'meta_notices', ok: false, text: 'No WhatsApp message notice from Meta in the last 7 days' },
        { key: 'approved_template', ok: true, text: '4 approved templates in use' },
      ],
    },
  };
  const v = sendingView(l);
  eq([v.switch, v.readyToTurnOn, v.launchVersion, v.turnOnPhrase], ['off', false, 41, 'WHATSAPP ON'], 'view');
  eq(v.warnings, ['WhatsApp sending is on, but: x'], 'only WhatsApp warnings');
  eq(sendingView({ whatsappSending: { mode: 'on', checks: l.whatsappSending.checks.map((c) => ({ ...c, ok: true })) } }).readyToTurnOn, true, 'ready');
  eq(sendingView({}).readyToTurnOn, false, 'unknown checks are not ready');
  eq(WHATSAPP_ON_PHRASE, 'WHATSAPP ON', 'phrase');
});

test('test phones: phone numbers only, masked, never whole', () => {
  const v = recipientsView([
    { id: 'r1', kind: 'phone', value: '+41791234567', label: 'Manish', isDefault: true },
    { id: 'r2', kind: 'email', value: 'a@b.ch', label: 'mail' },
    { kind: 'phone', value: '+41790000000' },
  ]);
  eq(v, [{ recipientId: 'r1', label: 'Manish', number: '+41•••67', isDefault: true }], 'phones');
  assert(!JSON.stringify(v).includes('1234'), 'number masked');
  eq(maskPhone('12'), '•••', 'short');
  eq(recipientsView(undefined), [], 'none saved');
});

test('journey steps: each message step with its nodeId and WhatsApp templates', () => {
  const v = stepsView({
    messages: [
      { poolKey: 'birthday', name: 'Birthday gift', channels: ['sms', 'email', 'whatsapp'], steps: [{ number: 2, nodeId: 'send_gift', detail: 'On the birthday' }], whatsapp: { templates: [{ name: 'hf_birthday_1', lang: 'en' }] } },
      { poolKey: 'reminder', name: 'Reminder', channels: ['sms'], steps: [{ number: 4, nodeId: 'send_rem' }], whatsapp: null },
    ],
  });
  eq(v.map((s) => [s.nodeId, s.byWhatsApp, s.whatsappTemplates]), [['send_gift', true, ['hf_birthday_1 (en)']], ['send_rem', false, []]], 'steps');
});

test('errors: the server words plus code, blockers, issues, missing fields and the phrase', () => {
  eq(errorText(409, { ok: false, error: 'Turning WhatsApp sending on is refused: No notice', code: 'whatsapp_not_ready', blockers: ['No notice'] }), 'Turning WhatsApp sending on is refused: No notice — [whatsapp_not_ready] — Blockers: No notice', 'blockers');
  eq(errorText(400, { error: 'Type “WHATSAPP ON” to confirm', code: 'confirmation_required', confirmPhrase: 'WHATSAPP ON' }), 'Type “WHATSAPP ON” to confirm — [confirmation_required] — Phrase: WHATSAPP ON', 'phrase');
  eq(errorText(422, { error: 'Some values this message needs are missing', missing: ['link.offer'] }), 'Some values this message needs are missing — Missing: link.offer', 'missing');
  eq(errorText(400, { error: 'Bad', issues: [{ code: 'T04', message: 'Cannot go by WhatsApp' }] }), 'Bad — Issues: T04: Cannot go by WhatsApp', 'issues');
  eq(errorText(502, {}), 'Request failed (502)', 'fallback');
});

test('the view module stays pure (only zod)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'mcp', 'tools', 'whatsappAdminView.ts'), 'utf8');
  const imports = src.match(/^import .* from ['"][^'"]+['"];?$/gm) ?? [];
  eq(imports.map((l) => l.replace(/.* from ['"]([^'"]+)['"];?$/, '$1')), ['zod'], 'imports');
});

test('the tool descriptions say what costs money and what needs Manish’s word', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'mcp', 'tools', 'whatsappAdmin.ts'), 'utf8');
  const desc = (name: string) => {
    const at = src.indexOf(`'${name}',`);
    assert(at > 0, `${name} is registered`);
    return src.slice(at, at + 1200);
  };
  assert(/BILLED AI run/.test(desc('suggest_whatsapp_template')), 'suggest says billed');
  assert(/explicit OK in the chat/.test(desc('send_whatsapp_template_to_meta')) && /z\.literal\(true\)/.test(desc('send_whatsapp_template_to_meta')), 'send to Meta needs confirm');
  assert(/explicit word in the chat/.test(desc('set_whatsapp_sending')), 'ON needs Manish');
  assert(/SENDS A REAL WHATSAPP MESSAGE/.test(desc('send_whatsapp_test')), 'test send says real');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
