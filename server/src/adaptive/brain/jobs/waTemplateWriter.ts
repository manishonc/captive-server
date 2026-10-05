/**
 * The WhatsApp template writer (PR W2): one platform template for one Adaptive message in one
 * language — a new one, a translation of the English one, an alternative, or a fix after Meta
 * rejected one. Its runs come from "Suggest with AI" (a person: `manual`), the daily gap-fill
 * (`schedule`) and, from W2b, the AI fixes Auto asks for (`schedule`).
 *
 * The brief (its package) holds no personal data: the message's purpose and rule, the fields and
 * what they mean, today's wording of that message, the other templates' bodies (built by the API,
 * whatsapp/aiRequests.ts). The answer is checked like any template (T01–T22) plus the writer's own
 * checks (core/whatsapp/aiBrief.ts); a passed answer becomes a draft (`origin: 'ai'`) — once, in
 * the run's own transaction (whatsapp/aiDrafts.ts). A rejected one writes nothing but a log row.
 *
 * It messages nobody and sends nothing to Meta (Auto, W2b, does that from the API), so it never
 * waits on the guest-sending pause (Manish, 2026-10-05).
 */

import type { AgentJob, ApplyDecision } from '../types';
import { scanPackage } from '../privacy';
import { parseWriterParams, sandboxWriterAnswer, writerAnswerSchema, writerChecks, type WriterAnswer, type WriterBrief, type WriterLocal } from '../../core/whatsapp/aiBrief';

/**
 * The registry side (whatsapp/aiDrafts.ts reads and writes Firestore): loaded when a run gets that
 * far (the worker), never when the registry is — so the registry and this job stay pure at load
 * (the pure tests and the admin API read their labels and defaults without Firestore).
 */
const drafts = () => import('../../whatsapp/aiDrafts');

const hasContactData = (text: string) => scanPackage(text).length > 0;

const SYSTEM = [
  'You write WhatsApp message templates for HeidiFi, a Swiss Wi-Fi marketing platform for restaurants, cafés and holiday rentals.',
  'A template is sent by a venue to a guest who agreed to hear from it. Meta (WhatsApp) reviews every template before it may be used.',
  '',
  'Rules for the body:',
  '- Write in the language and tone the brief gives. At most three short sentences. Natural, warm, never pushy.',
  '- Always name the venue with {{venue.name}}.',
  '- Use only the fields the brief lists, each at most once, written exactly as its "write" form shows. Every field except {{venue.name}} needs a natural fallback after `| default:` in the same language (replace "…" with words that read well when the value is unknown). Dates keep their `| date:"d.M."` format.',
  '- Never start or end the body with a field. Never put two fields next to each other, not even with only a comma, space or other punctuation between them: write "Hi {{contact.firstName | default:"there"}}, thanks for coming back to {{venue.name}}", not "…to {{venue.name}}, {{contact.firstName | default:"there"}}!".',
  '- Write at least three words of your own for every field you use (a field and its default don’t count): the more fields, the longer the text. Meta rejects templates that are mostly fields. Use only the fields the message needs.',
  '- A default is what a guest sees when the value is unknown: words in the template’s language, never "…" or a placeholder.',
  '- No links, web addresses, email addresses or phone numbers in the body: the link travels only in the button.',
  '- No "STOP" or opt-out text in the body: HeidiFi adds the opt-out footer itself.',
  '- Never invent offers, prices, discounts, numbers, dates, times or claims the brief doesn’t give: every number in your text (and in a default) must appear in the brief’s wording or templates.',
  '- For a UTILITY (service) message: inform only. No promotion, no invitation to come back, no offer words, no emoji, and none of the words in "avoidWords" (Meta reads them as promotion), even in a harmless phrase such as "feel free".',
  '- Don’t repeat the text of an existing template of this message.',
  '',
  'The button: when the brief has a button, write its label (a short call to action in the same language, as few words as fit). When it has none, the label is null.',
  '',
  'The category: give the category the brief asks for, and in "categoryReason" one sentence on why the text fits it.',
  'In "reasoning" and "categoryReason" never quote counts, lengths or other numbers.',
  'Answer only with the JSON the schema asks for.',
].join('\n');

const INSTRUCTIONS = [
  'Below is the brief in JSON. "task" is what to write:',
  '- "new": a new template for the message.',
  '- "translation": the English template ("english") in the brief’s language — the same meaning and fields, natural wording.',
  '- "alternative": a different wording for the message (not a copy of any "existingBodies").',
  '- "fix": a rewrite of "current" that addresses Meta’s rejection ("rejection"); change only what the rejection needs.',
  '"wording" is how the venue’s SMS/email for this message reads today, for meaning and tone only (not to copy word for word, and it may break the rules above, e.g. fields side by side or a field at the end: follow the rules, not its shape).',
].join('\n');

export const waTemplateWriterJob: AgentJob<WriterBrief, WriterAnswer> = {
  key: 'wa_template_writer',
  label: 'WhatsApp template writer',
  description:
    'Writes a WhatsApp template for one message in one language (new, translation, alternative, or a fix after Meta rejected one) as a draft for the WhatsApp tab. Runs on "Suggest with AI" (needs the AI switch only) and, with Scheduled runs on, in the daily gap-fill that fills missing templates and for the fixes WhatsApp Auto asks for after Meta rejects an AI template.',
  scope: 'platform',
  defaults: {
    enabled: false,
    model: 'anthropic/claude-opus-5.5',
    fallbackModel: 'anthropic/claude-sonnet-5.5',
    effort: 'medium',
    maxRunsPerDay: 10,
    maxOutputTokens: 4000,
    promptVersion: 'wa-writer-v1',
  },
  prompts: {
    'wa-writer-v1': { system: SYSTEM, instructions: INSTRUCTIONS },
  },
  outputSchema: writerAnswerSchema,
  cacheSystem: true,
  waitsOnSendingPause: false,
  buildInput(ctx) {
    const p = parseWriterParams(ctx.params);
    // The precheck skips a run whose params don't read: this never happens in a run that got here.
    if (!p) throw new Error('The writer run’s params could not be read');
    const b = p.brief;
    return {
      pkg: b,
      secrets: [],
      summary: `${b.task} · ${b.message.journey} → ${b.message.name} · ${b.language.toUpperCase()} · ${p.local.requestedBy}`,
      local: p.local,
    };
  },
  check(out, pkg, local) {
    return writerChecks(out, pkg, local as WriterLocal, hasContactData);
  },
  reasoningOf: (out) => `${out.reasoning}\n${out.categoryReason}`,
  sandboxAnswer: (pkg) => sandboxWriterAnswer(pkg),
  precheck: async (ctx) => (await drafts()).precheckWriter(ctx.params),
  async apply(tx, args): Promise<ApplyDecision> {
    return (await drafts()).applyWriterAnswer(tx, { runId: args.runId, taskId: args.taskId, out: args.out, local: args.local as WriterLocal, model: args.modelUsed, promptVersion: args.promptVersion });
  },
  report: async (r) => (await drafts()).reportWriterRun(r),
};
