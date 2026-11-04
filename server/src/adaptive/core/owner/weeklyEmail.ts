/**
 * The weekly numbers email to the owner (spec §12 "P0 interim: a template-generated weekly
 * numbers email (no LLM)"; decisions D6–D10 of 2026-11-04). Pure: the numbers in, the subject,
 * HTML and plain text out, in English or German.
 *
 * One email per account, one block per venue, in §12's order without the AI parts (what the
 * system changed, learnings): Snapshot (reached, messages per channel, credits) · KPI (each
 * journey's main number this week and last week, its credits and — spec §3 — the estimated
 * revenue next to them) · What happened, in numbers (visits, capture rate, busiest times) ·
 * Next (credits left at this week's pace, anything waiting on the owner). Every number comes
 * from `GET /results` (this week and the week before); nothing is made up or estimated here
 * except what the results already call an estimate.
 *
 * The week is Monday to Sunday in venue-local dates; the email goes out on the Monday after.
 */

import type { CaptureNumbers, GoalKind, Heatmap, JourneyFunnel, Money } from './dashboard';
import { addDaysIso } from './results';
import { HOUR_MS, localParts, zonedTime } from '../runtime/time';

export type WeeklyLang = 'en' | 'de';

/** The parts of one `GET /results?detail=1` venue the email reads (structural, so tests can build them). */
export interface WeeklyResults {
  card: {
    guestsStarted: number;
    cameBack: number;
    messages: { total: number; byChannel: Record<string, number>; service: number };
    creditsUsed: { total: number; byChannel: Record<string, number> };
    estimatedRevenue: { amountMinor: number; currency: string; averageSpendMinor: number } | null;
    visits: { total: number; first: number; revisits: number };
    friendsJoined?: number;
  };
  capture?: CaptureNumbers;
  heatmap?: Heatmap;
  journeys?: Array<{ journeyKey: string; name: string; goal?: GoalKind; funnel?: JourneyFunnel }>;
  waitingForCredits?: { messagesWaiting: number; lowBalance: boolean };
}

export interface WeeklyVenue {
  venueId: string;
  name: string;
  week: WeeklyResults;
  /** The week before (null: not read). */
  prev: WeeklyResults | null;
  /** The venue's Adaptive state: `on`, `paused`, `paused_by_platform` or anything else (off). */
  status: string;
  /** Turned on before the account went live and waits for the owner's Start sending. */
  needsStartSending?: boolean;
  /** Journey names in the email's language (by journey key); missing → the results' name. */
  journeyNames?: Record<string, string>;
}

export interface WeeklyInput {
  lang: WeeklyLang;
  /** Monday and Sunday of the week (YYYY-MM-DD). */
  weekStart: string;
  weekEnd: string;
  venues: WeeklyVenue[];
  /** The account's spendable credits (null: unknown). */
  creditsLeft: number | null;
  /** Credits per one unit of each currency (CreditConfig.currencies) and the one to use without an average spend. */
  creditsPerUnit: Record<string, number>;
  defaultCurrency: string;
  /** The owner's Adaptive tab. */
  dashboardUrl: string;
}

export interface WeeklyEmail {
  subject: string;
  html: string;
  text: string;
  /** No visits and no messages at any venue this week: nothing is sent (D7). */
  quiet: boolean;
}

// ── Words ────────────────────────────────────────────────────────────────────

const W = {
  en: {
    title: 'Your week with HeidiFi',
    intro: (venues: number) => (venues === 1 ? 'Here are last week’s numbers for your venue.' : `Here are last week’s numbers for your ${venues} venues.`),
    snapshot: 'Snapshot',
    kpi: 'Each journey',
    happened: 'What happened, in numbers',
    next: 'Next',
    reached: 'Guests reached',
    reachedNote: 'journeys started',
    messages: 'Messages',
    infoFree: (n: string) => `incl. ${n} free info`,
    credits: 'Credits used',
    revenue: 'Est. revenue',
    creditsWord: 'credits',
    revenueInline: 'est. revenue',
    noRevenue: 'no average spend saved',
    cost: (m: string) => `credits cost ${m}`,
    thisWeek: 'this week',
    lastWeek: 'last week',
    visits: 'Wi-Fi visits',
    visitsSplit: (n: string, r: string) => `${n} new · ${r} returning`,
    capture: 'Capture rate',
    captureSplit: (n: string, r: string) => `new guests ${n} · returning ${r}`,
    busiest: 'Busiest',
    busiestDay: 'busiest day',
    cameBack: 'Came back through a journey',
    friends: 'Friends who came with a regular’s code',
    creditsLeft: (n: string) => `Credits left: ${n}`,
    weeksLeft: (w: string) => `about ${w} at this week’s pace`,
    weeks: (n: number) => (n === 1 ? '1 week' : `${n} weeks`),
    waiting: (n: string) => `${n} waiting for credits`,
    lowBalance: 'Your credits can’t pay the next message. Add credits so journeys keep going.',
    paused: 'Paused: no messages go out until you resume.',
    pausedByHeidiFi: 'Paused by HeidiFi: contact support to find out more.',
    startSending: 'Waiting for you to start sending.',
    nothingNeeded: 'Nothing needs you. Your journeys keep running.',
    goal: { visit: 'came back', booking: 'direct bookings', rating: 'ratings', other: 'reached the goal', none: 'messages sent' } as Record<GoalKind, string>,
    perComeback: (m: string) => `${m} credits per guest who came back`,
    friendsPer100: (n: string) => `${n} friends per 100 messages`,
    stars: (a: string) => `★ ${a} average`,
    noActivity: 'No journey sent a message.',
    open: 'Open Adaptive',
    footer:
      'You get this email every Monday because Adaptive Campaigns runs at your venues. To stop it, switch off “Weekly numbers email” in Campaign Manager → Adaptive.',
    basis:
      'Counted every 15 minutes. Est. revenue = guests who came back × your average spend per visit — an estimate, not measured takings.',
    subject: (venue: string, came: string, rev: string | null, credits: string) =>
      rev ? `Your week at ${venue}: ${came} came back, ≈ ${rev}` : `Your week at ${venue}: ${came} came back, ${credits} credits`,
    venuesN: (n: number) => `your ${n} venues`,
    weekdays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
    locale: 'en-GB',
  },
  de: {
    title: 'Ihre Woche mit HeidiFi',
    intro: (venues: number) => (venues === 1 ? 'Hier sind die Zahlen der letzten Woche für Ihr Lokal.' : `Hier sind die Zahlen der letzten Woche für Ihre ${venues} Lokale.`),
    snapshot: 'Überblick',
    kpi: 'Jede Journey',
    happened: 'Was passiert ist, in Zahlen',
    next: 'Als Nächstes',
    reached: 'Erreichte Gäste',
    reachedNote: 'gestartete Journeys',
    messages: 'Nachrichten',
    infoFree: (n: string) => `inkl. ${n} kostenlose Info`,
    credits: 'Verbrauchte Credits',
    revenue: 'Gesch. Umsatz',
    creditsWord: 'Credits',
    revenueInline: 'gesch. Umsatz',
    noRevenue: 'kein Durchschnittsbetrag gespeichert',
    cost: (m: string) => `Credits kosten ${m}`,
    thisWeek: 'diese Woche',
    lastWeek: 'letzte Woche',
    visits: 'WLAN-Besuche',
    visitsSplit: (n: string, r: string) => `${n} neu · ${r} wiederkehrend`,
    capture: 'Erfassungsrate',
    captureSplit: (n: string, r: string) => `neue Gäste ${n} · wiederkehrende ${r}`,
    busiest: 'Am meisten los',
    busiestDay: 'stärkster Tag',
    cameBack: 'Über eine Journey wiedergekommen',
    friends: 'Freunde, die mit dem Code eines Stammgasts kamen',
    creditsLeft: (n: string) => `Verbleibende Credits: ${n}`,
    weeksLeft: (w: string) => `etwa ${w} beim Verbrauch dieser Woche`,
    weeks: (n: number) => (n === 1 ? '1 Woche' : `${n} Wochen`),
    waiting: (n: string) => `${n} warten auf Credits`,
    lowBalance: 'Ihre Credits reichen nicht für die nächste Nachricht. Laden Sie Credits auf, damit die Journeys weiterlaufen.',
    paused: 'Pausiert: Es gehen keine Nachrichten raus, bis Sie fortsetzen.',
    pausedByHeidiFi: 'Von HeidiFi pausiert: Bitte kontaktieren Sie den Support.',
    startSending: 'Wartet darauf, dass Sie den Versand starten.',
    nothingNeeded: 'Es gibt nichts zu tun. Ihre Journeys laufen weiter.',
    goal: { visit: 'wiedergekommen', booking: 'Direktbuchungen', rating: 'Bewertungen', other: 'Ziel erreicht', none: 'Nachrichten gesendet' } as Record<GoalKind, string>,
    perComeback: (m: string) => `${m} Credits pro wiedergekommenem Gast`,
    friendsPer100: (n: string) => `${n} Freunde pro 100 Nachrichten`,
    stars: (a: string) => `★ ${a} im Schnitt`,
    noActivity: 'Keine Journey hat eine Nachricht gesendet.',
    open: 'Adaptive öffnen',
    footer:
      'Sie erhalten diese E-Mail jeden Montag, weil Adaptive Campaigns in Ihren Lokalen läuft. Zum Abbestellen schalten Sie «Wöchentliche Zahlen per E-Mail» unter Campaign Manager → Adaptive aus.',
    basis:
      'Alle 15 Minuten gezählt. Gesch. Umsatz = wiedergekommene Gäste × Ihr Durchschnittsbetrag pro Besuch — eine Schätzung, kein gemessener Umsatz.',
    subject: (venue: string, came: string, rev: string | null, credits: string) =>
      rev ? `Ihre Woche bei ${venue}: ${came} wiedergekommen, ≈ ${rev}` : `Ihre Woche bei ${venue}: ${came} wiedergekommen, ${credits} Credits`,
    venuesN: (n: number) => `Ihren ${n} Lokalen`,
    weekdays: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'],
    locale: 'de-CH',
  },
} as const;

type Words = (typeof W)[WeeklyLang];

// ── Formatting ───────────────────────────────────────────────────────────────

function n0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 12'345 (Swiss grouping, like the cms). */
export function fmtNum(v: number): string {
  return Math.round(n0(v))
    .toLocaleString('en-US')
    .replace(/,/g, "'");
}

/** Minor units → "CHF 45" / "CHF 4.50" / "CHF 1'350". */
export function fmtMoney(minor: number, currency: string): string {
  const major = n0(minor) / 100;
  if (major > 0 && major < 100) return `${currency} ${major.toFixed(2).replace(/\.00$/, '')}`;
  return `${currency} ${fmtNum(major)}`;
}

function pct(rate: number | null | undefined): string {
  return typeof rate === 'number' && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';
}

/** "27 Oct – 2 Nov 2026" / "27. Okt. – 2. Nov. 2026" (date-only values, no time zone maths). */
export function weekRange(from: string, to: string, lang: WeeklyLang): string {
  const at = (d: string) => new Date(`${d}T12:00:00Z`);
  const day = new Intl.DateTimeFormat(W[lang].locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const year = new Intl.DateTimeFormat(W[lang].locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${day.format(at(from))} – ${year.format(at(to))}`;
}

const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function creditsMoney(credits: number, avg: { currency: string } | null, input: WeeklyInput): Money | null {
  const currency = avg?.currency ?? input.defaultCurrency;
  const perUnit = input.creditsPerUnit[currency];
  if (!currency || !(perUnit > 0)) return null;
  return { amountMinor: Math.round((credits / perUnit) * 100), currency };
}

// ── The model (what the email says) ──────────────────────────────────────────

export interface KpiLine {
  journey: string;
  /** e.g. "came back: 3" / "ratings: 4 · ★ 4.5 average". */
  now: string;
  before: string | null;
  /** "31 credits (credits cost CHF 0.31) · ≈ CHF 135 est. revenue". */
  money: string;
}

export interface VenueBlock {
  name: string;
  snapshot: Array<{ label: string; value: string; note?: string }>;
  kpis: KpiLine[];
  happened: string[];
  next: string[];
}

function journeysOf(r: WeeklyResults | null): Map<string, { name: string; goal: GoalKind; funnel: JourneyFunnel }> {
  const out = new Map<string, { name: string; goal: GoalKind; funnel: JourneyFunnel }>();
  for (const j of r?.journeys ?? []) if (j.funnel) out.set(j.journeyKey, { name: j.name, goal: j.goal ?? j.funnel.goal, funnel: j.funnel });
  return out;
}

function active(f: JourneyFunnel | undefined): boolean {
  return Boolean(f && (f.started > 0 || f.total.sent > 0 || f.total.converted > 0 || f.ratings.count > 0));
}

/** A journey's main number (spec §12's primary KPI where we count it). */
function kpiValue(key: string, goal: GoalKind, f: JourneyFunnel | undefined, venue: WeeklyResults | null, w: Words): string {
  if (!f) return '—';
  if (key === 'bring_a_friend') {
    const friends = n0(venue?.card.friendsJoined);
    const per100 = f.total.sent > 0 ? fmtNum((friends / f.total.sent) * 100) : '—';
    return `${w.friendsPer100(per100)} (${fmtNum(friends)})`;
  }
  if (goal === 'rating' || f.ratings.count > 0) {
    const stars = f.ratings.averageStars !== null ? ` · ${w.stars(String(f.ratings.averageStars))}` : '';
    return `${w.goal.rating}: ${fmtNum(f.ratings.count)}${stars}`;
  }
  if (goal === 'none') return `${w.goal.none}: ${fmtNum(f.total.sent)}`;
  return `${w.goal[goal]}: ${fmtNum(f.total.converted)}`;
}

/** The journey's credits, what they cost, and (a visit goal) the estimated revenue next to them — the funnel's own numbers. */
function moneyText(f: JourneyFunnel, goal: GoalKind, w: Words): string {
  const cost = f.total.creditsValue;
  const parts = [`${fmtNum(f.total.credits)} ${w.creditsWord}${cost ? ` (${w.cost(fmtMoney(cost.amountMinor, cost.currency))})` : ''}`];
  if (goal === 'visit') {
    parts.push(f.total.revenue ? `≈ ${fmtMoney(f.total.revenue.amountMinor, f.total.revenue.currency)} ${w.revenueInline}` : w.noRevenue);
    if (f.total.converted > 0 && f.total.credits > 0) parts.push(w.perComeback(fmtNum(f.total.credits / f.total.converted)));
  }
  return parts.join(' · ');
}

export function venueBlock(v: WeeklyVenue, input: WeeklyInput): VenueBlock {
  const w = W[input.lang];
  const c = v.week.card;
  const avg = c.estimatedRevenue ? { amountMinor: c.estimatedRevenue.averageSpendMinor, currency: c.estimatedRevenue.currency } : null;
  const revenue = c.estimatedRevenue;

  // Snapshot: reached, messages per channel, credits with the revenue next to them.
  const channels = ['sms', 'email', 'whatsapp']
    .filter((ch) => n0(c.messages.byChannel[ch]) > 0)
    .map((ch) => `${fmtNum(n0(c.messages.byChannel[ch]))} ${ch === 'sms' ? 'SMS' : ch === 'email' ? (input.lang === 'de' ? 'E-Mail' : 'email') : 'WhatsApp'}`);
  const cost = creditsMoney(c.creditsUsed.total, avg, input);
  const snapshot: VenueBlock['snapshot'] = [
    { label: w.reached, value: fmtNum(c.guestsStarted), note: w.reachedNote },
    { label: w.messages, value: fmtNum(c.messages.total), note: [channels.join(' · '), c.messages.service > 0 ? w.infoFree(fmtNum(c.messages.service)) : ''].filter(Boolean).join(' — ') || undefined },
    { label: w.credits, value: fmtNum(c.creditsUsed.total), note: cost ? w.cost(fmtMoney(cost.amountMinor, cost.currency)) : undefined },
    { label: w.revenue, value: revenue ? `≈ ${fmtMoney(revenue.amountMinor, revenue.currency)}` : '—', note: revenue ? undefined : w.noRevenue },
  ];

  // KPI: each journey with something this week or last.
  const now = journeysOf(v.week);
  const before = journeysOf(v.prev);
  const kpis: KpiLine[] = [];
  for (const [key, j] of now) {
    const b = before.get(key);
    if (!active(j.funnel) && !active(b?.funnel)) continue;
    kpis.push({
      journey: v.journeyNames?.[key] ?? j.name,
      now: kpiValue(key, j.goal, j.funnel, v.week, w),
      before: v.prev ? kpiValue(key, j.goal, b?.funnel, v.prev, w) : null,
      money: moneyText(j.funnel, j.goal, w),
    });
  }

  // What happened, in numbers.
  const happened: string[] = [];
  const prevVisits = v.prev ? n0(v.prev.card.visits.total) : null;
  happened.push(
    `${w.visits}: ${fmtNum(c.visits.total)} (${w.visitsSplit(fmtNum(c.visits.first), fmtNum(c.visits.revisits))})${prevVisits !== null ? ` · ${w.lastWeek} ${fmtNum(prevVisits)}` : ''}`,
  );
  const cap = v.week.capture;
  if (cap && cap.all.visits > 0) {
    happened.push(`${w.capture}: ${pct(cap.all.rate)} (${w.captureSplit(pct(cap.first.rate), pct(cap.returning.rate))})`);
  }
  const h = v.week.heatmap;
  if (h?.busiest && h.total > 0) {
    const day = h.busiestDay ? ` · ${w.busiestDay} ${w.weekdays[h.busiestDay.weekday - 1]}` : '';
    happened.push(`${w.busiest}: ${w.weekdays[h.busiest.weekday - 1]} ${hh(h.busiest.hour)}–${hh(h.busiest.hour + 1)}${day}`);
  }
  happened.push(`${w.cameBack}: ${fmtNum(c.cameBack)}${v.prev ? ` · ${w.lastWeek} ${fmtNum(v.prev.card.cameBack)}` : ''}`);
  if (n0(c.friendsJoined) > 0) happened.push(`${w.friends}: ${fmtNum(n0(c.friendsJoined))}`);

  // Next: what waits on the owner at this venue.
  const next: string[] = [];
  if (v.status === 'paused') next.push(w.paused);
  else if (v.status === 'paused_by_platform') next.push(w.pausedByHeidiFi);
  if (v.needsStartSending) next.push(w.startSending);
  const waiting = n0(v.week.waitingForCredits?.messagesWaiting);
  if (waiting > 0) next.push(w.waiting(fmtNum(waiting)));
  if (v.week.waitingForCredits?.lowBalance) next.push(w.lowBalance);

  return { name: v.name, snapshot, kpis, happened, next };
}

/** "Credits left: 4'200 — about 12 weeks at this week's pace". */
function creditsLine(input: WeeklyInput, w: Words): string | null {
  if (input.creditsLeft === null) return null;
  const used = input.venues.reduce((s, v) => s + n0(v.week.card.creditsUsed.total), 0);
  const left = Math.max(0, input.creditsLeft);
  const weeks = used > 0 ? Math.floor(left / used) : null;
  return `${w.creditsLeft(fmtNum(left))}${weeks !== null ? ` — ${w.weeksLeft(w.weeks(weeks))}` : ''}`;
}

export function isQuietWeek(input: Pick<WeeklyInput, 'venues'>): boolean {
  return input.venues.every((v) => n0(v.week.card.visits.total) === 0 && n0(v.week.card.messages.total) === 0);
}

// ── Rendering ────────────────────────────────────────────────────────────────

const C = { ink: '#222222', muted: '#717171', faint: '#AAAAAA', line: '#EBEBEB', bg: '#F7F7F7', brand: '#FF385C' };

function sectionTitle(t: string): string {
  return `<tr><td style="padding:18px 0 6px;font:600 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${C.faint}">${esc(t)}</td></tr>`;
}

function venueHtml(b: VenueBlock, w: Words): string {
  const tiles = b.snapshot
    .map(
      (s) =>
        `<td width="25%" valign="top" style="padding:10px 12px;border:1px solid ${C.line};border-radius:10px;background:#FFFFFF">` +
        `<div style="font:700 20px/1.2 Arial,Helvetica,sans-serif;color:${C.ink}">${esc(s.value)}</div>` +
        `<div style="font:12px/1.4 Arial,Helvetica,sans-serif;color:${C.muted}">${esc(s.label)}</div>` +
        (s.note ? `<div style="font:11px/1.4 Arial,Helvetica,sans-serif;color:${C.faint}">${esc(s.note)}</div>` : '') +
        `</td>`,
    )
    .join('<td width="8" style="font-size:0">&nbsp;</td>');
  const kpiRows = b.kpis.length
    ? b.kpis
        .map(
          (k) =>
            `<tr><td style="padding:8px 0;border-top:1px solid ${C.line};font:13px/1.5 Arial,Helvetica,sans-serif;color:${C.ink}">` +
            `<b>${esc(k.journey)}</b><br>` +
            `<span>${esc(w.thisWeek)}: ${esc(k.now)}</span>` +
            (k.before !== null ? `<span style="color:${C.muted}"> · ${esc(w.lastWeek)}: ${esc(k.before)}</span>` : '') +
            `<br><span style="color:${C.muted};font-size:12px">${esc(k.money)}</span></td></tr>`,
        )
        .join('')
    : `<tr><td style="padding:8px 0;font:13px/1.5 Arial,Helvetica,sans-serif;color:${C.muted}">${esc(w.noActivity)}</td></tr>`;
  const list = (items: string[]) =>
    items.map((t) => `<tr><td style="padding:3px 0;font:13px/1.5 Arial,Helvetica,sans-serif;color:${C.ink}">${esc(t)}</td></tr>`).join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;padding:20px;background:#FFFFFF;border:1px solid ${C.line};border-radius:14px">` +
    `<tr><td style="padding:0 0 4px;font:700 16px/1.4 Arial,Helvetica,sans-serif;color:${C.ink}">${esc(b.name)}</td></tr>` +
    sectionTitle(w.snapshot) +
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>` +
    sectionTitle(w.kpi) +
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${kpiRows}</table></td></tr>` +
    sectionTitle(w.happened) +
    `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list(b.happened)}</table></td></tr>` +
    (b.next.length ? sectionTitle(w.next) + `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${list(b.next)}</table></td></tr>` : '') +
    `</table>`
  );
}

function venueText(b: VenueBlock, w: Words): string {
  const out: string[] = [];
  out.push(b.name.toUpperCase(), '');
  out.push(`${w.snapshot}`);
  for (const s of b.snapshot) out.push(`- ${s.label}: ${s.value}${s.note ? ` (${s.note})` : ''}`);
  out.push('', w.kpi);
  if (!b.kpis.length) out.push(`- ${w.noActivity}`);
  for (const k of b.kpis) out.push(`- ${k.journey} — ${w.thisWeek}: ${k.now}${k.before !== null ? ` · ${w.lastWeek}: ${k.before}` : ''}`, `  ${k.money}`);
  out.push('', w.happened, ...b.happened.map((t) => `- ${t}`));
  if (b.next.length) out.push('', w.next, ...b.next.map((t) => `- ${t}`));
  return out.join('\n');
}

/** The email. Quiet weeks render too (the owner's preview), flagged `quiet` so the sender skips them. */
export function renderWeeklyEmail(input: WeeklyInput): WeeklyEmail {
  const w = W[input.lang];
  const blocks = input.venues.map((v) => venueBlock(v, input));
  const many = blocks.length > 1;
  const range = weekRange(input.weekStart, input.weekEnd, input.lang);

  // Subject: the account's came-back total, with the estimated revenue when every venue has an average spend.
  const came = input.venues.reduce((s, v) => s + n0(v.week.card.cameBack), 0);
  const credits = input.venues.reduce((s, v) => s + n0(v.week.card.creditsUsed.total), 0);
  const revs = input.venues.map((v) => v.week.card.estimatedRevenue);
  const oneCurrency = revs.every((r) => r && r.currency === revs[0]?.currency);
  const rev = oneCurrency && revs.length ? fmtMoney(revs.reduce((s, r) => s + n0(r?.amountMinor), 0), revs[0]!.currency) : null;
  const where = many ? w.venuesN(blocks.length) : (input.venues[0]?.name ?? '');
  const subject = w.subject(where, fmtNum(came), rev, fmtNum(credits));

  const nextAccount: string[] = [];
  const cl = creditsLine(input, w);
  if (cl) nextAccount.push(cl);
  if (!blocks.some((b) => b.next.length)) nextAccount.push(w.nothingNeeded);

  const html =
    `<!doctype html><html lang="${input.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(w.title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${C.bg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">` +
    `<tr><td style="padding:0 4px 14px"><div style="font:700 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${C.brand}">HeidiFi · Adaptive Campaigns</div>` +
    `<div style="font:700 22px/1.3 Arial,Helvetica,sans-serif;color:${C.ink};margin-top:4px">${esc(w.title)}</div>` +
    `<div style="font:14px/1.5 Arial,Helvetica,sans-serif;color:${C.muted};margin-top:2px">${esc(range)} · ${esc(w.intro(blocks.length))}</div></td></tr>` +
    `<tr><td>${blocks.map((b) => venueHtml(b, w)).join('')}</td></tr>` +
    `<tr><td style="padding:0 4px">` +
    `<div style="font:600 12px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:${C.faint};padding:4px 0 6px">${esc(w.next)}</div>` +
    nextAccount.map((t) => `<div style="font:13px/1.5 Arial,Helvetica,sans-serif;color:${C.ink};padding:2px 0">${esc(t)}</div>`).join('') +
    `<div style="padding:16px 0"><a href="${esc(input.dashboardUrl)}" style="display:inline-block;background:${C.ink};color:#FFFFFF;font:600 14px/1 Arial,Helvetica,sans-serif;padding:12px 22px;border-radius:10px;text-decoration:none">${esc(w.open)} &rarr;</a></div>` +
    `<div style="font:11px/1.5 Arial,Helvetica,sans-serif;color:${C.faint};padding:0 0 6px">${esc(w.basis)}</div>` +
    `<div style="font:11px/1.5 Arial,Helvetica,sans-serif;color:${C.faint}">${esc(w.footer)}</div>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = [
    `${w.title} — ${range}`,
    w.intro(blocks.length),
    '',
    ...blocks.map((b) => venueText(b, w) + '\n'),
    w.next,
    ...nextAccount.map((t) => `- ${t}`),
    '',
    `${w.open}: ${input.dashboardUrl}`,
    '',
    w.basis,
    w.footer,
  ].join('\n');

  return { subject, html, text, quiet: isQuietWeek(input) };
}

// ── When it goes out ─────────────────────────────────────────────────────────

/** Monday, 08:00 in the account's time zone. */
export const WEEKLY_EMAIL_HOUR = 8;

const isoDay = (p: { year: number; month: number; day: number }) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;

/**
 * The next Monday 08:00 (account zone) at or after `now − 12 h` — so a worker that starts on a
 * Monday morning still sends that day's email, and one that starts mid-week waits for next
 * Monday instead of sending a late one — and the Monday-to-Sunday week it covers.
 */
export function weeklySchedule(nowMs: number, tz: string): { sendDate: string; dueAt: number; weekStart: string; weekEnd: string } {
  const from = nowMs - 12 * HOUR_MS;
  const p = localParts(new Date(from), tz);
  const iso = p.weekday === 0 ? 7 : p.weekday;
  let sendDate = addDaysIso(isoDay(p), (8 - iso) % 7);
  const at = (d: string) => zonedTime(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10)), WEEKLY_EMAIL_HOUR, 0, tz).getTime();
  let dueAt = at(sendDate);
  if (dueAt < from) {
    sendDate = addDaysIso(sendDate, 7);
    dueAt = at(sendDate);
  }
  return { sendDate, dueAt, weekStart: addDaysIso(sendDate, -7), weekEnd: addDaysIso(sendDate, -1) };
}

/** The last complete Monday-to-Sunday week before `nowMs` (the owner's preview). */
export function lastFullWeek(nowMs: number, tz: string): { weekStart: string; weekEnd: string } {
  const p = localParts(new Date(nowMs), tz);
  const iso = p.weekday === 0 ? 7 : p.weekday;
  const weekEnd = addDaysIso(isoDay(p), -iso);
  return { weekStart: addDaysIso(weekEnd, -6), weekEnd };
}
