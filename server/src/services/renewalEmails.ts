/**
 * The renewal email sequence, fired by the subscription expiry job.
 *
 *   expiringSoon   T-7 days   heads-up, renew now
 *   graceStarted   day 0      subscription expired, N days to renew
 *   graceMidpoint  day 7      reminder, 8 days left
 *   graceFinal     day 13     final warning, 2 days left
 *   deactivated    day 15     account deactivated, pay to restore
 *   reactivated    on payment confirmation
 *
 * Which stage is due is decided by `dueRenewalEmail` in
 * services/subscriptionState.ts and recorded on the subscription doc, so the
 * job can run as often as it likes without ever sending the same stage twice.
 *
 * Every deadline is a real date ("4 Sep 2026"), never "when your trial ends" —
 * and the numbers here are the same ones the CMS billing panel shows, because
 * both read the stored `graceEndsAt`.
 */

import { sendEmail } from './brevo';
import { GRACE_PERIOD_DAYS, type RenewalEmailStage } from './subscriptionState';

const BRAND_NAME = 'HeidiFi';
const ACCENT = '#0B7A70';
const WARNING = '#8A5A0B';
const DANGER = '#B42318';

const PORTAL_URL = process.env.CMS_DASHBOARD_URL ?? 'https://portal.heidifi.ai';
const BILLING_URL = `${PORTAL_URL}/captive-venue?view=billing`;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "4 Sep 2026" — the format the billing surfaces use. */
export function formatDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export interface RenewalEmailContext {
  planName?: string | null;
  endsAt?: Date | string | null;
  graceEndsAt?: Date | string | null;
  daysLeft?: number | null;
  graceDays?: number;
}

interface StageContent {
  accent: string;
  subject: string;
  heading: string;
  body: string[];
  cta: string;
}

/**
 * Copy for one stage, as data — so a warning's wording and its severity colour
 * cannot drift apart, and so the whole sequence can be read in one place.
 */
export function stageContent(
  stage: RenewalEmailStage,
  ctx: Required<Omit<RenewalEmailContext, 'planName'>> & { planName: string },
): StageContent | null {
  const plan = ctx.planName;
  switch (stage) {
    case 'expiringSoon':
      return {
        accent: ACCENT,
        subject: `Your ${BRAND_NAME} subscription renews on ${ctx.endsAt}`,
        heading: 'A quick heads-up',
        body: [
          `${plan} renews on ${ctx.endsAt}. Nothing to do if your payment details are up to date — this is just so the charge is not a surprise.`,
          'If you need to change plan or update your card, now is the easy moment.',
        ],
        cta: 'Review billing',
      };
    case 'graceStarted':
      return {
        accent: WARNING,
        subject: `Your ${BRAND_NAME} subscription has expired — ${plural(ctx.graceDays, 'day')} to renew`,
        heading: 'Your subscription has expired',
        body: [
          `${plan} ended on ${ctx.endsAt}. Your account is still fully working, and everything stays exactly as you left it.`,
          `You have until ${ctx.graceEndsAt} to renew. After that the account is deactivated until payment.`,
        ],
        cta: 'Renew now',
      };
    case 'graceMidpoint':
      return {
        accent: WARNING,
        subject: `${plural(ctx.daysLeft ?? 0, 'day')} left to renew your ${BRAND_NAME} subscription`,
        heading: `${plural(ctx.daysLeft ?? 0, 'day')} left to renew`,
        body: [
          `${plan} expired on ${ctx.endsAt} and your account is running on grace time until ${ctx.graceEndsAt}.`,
          'Renewing takes a minute and nothing is interrupted.',
        ],
        cta: 'Renew now',
      };
    case 'graceFinal':
      return {
        accent: DANGER,
        subject: `Final notice: ${plural(ctx.daysLeft ?? 0, 'day')} before your ${BRAND_NAME} account is deactivated`,
        heading: `Final notice — ${plural(ctx.daysLeft ?? 0, 'day')} left`,
        body: [
          `${plan} expired on ${ctx.endsAt}. On ${ctx.graceEndsAt} the account will be deactivated: your Wi-Fi splash pages stop serving and campaigns stop sending.`,
          'Nothing is deleted, and renewing restores everything immediately — but it is worth not letting it get that far.',
        ],
        cta: 'Renew now',
      };
    case 'deactivated':
      return {
        accent: DANGER,
        subject: `Your ${BRAND_NAME} account has been deactivated`,
        heading: 'Your account has been deactivated',
        body: [
          `${plan} expired on ${ctx.endsAt} and the grace period ended on ${ctx.graceEndsAt}, so the account is now on hold.`,
          'Your venues, guest data and campaigns are all still here, untouched. Paying restores full access straight away.',
        ],
        cta: 'Pay and restore access',
      };
    case 'reactivated':
      return {
        accent: ACCENT,
        subject: `Your ${BRAND_NAME} account is active again`,
        heading: 'You are all set',
        body: [
          `Payment received — ${plan} is active again and everything is back on.`,
          ctx.endsAt ? `Your next renewal is ${ctx.endsAt}.` : '',
        ].filter(Boolean),
        cta: 'Open dashboard',
      };
    default:
      return null;
  }
}

export function renderHtml(content: StageContent): string {
  const paragraphs = content.body
    .map(
      (line) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#717171">${escapeHtml(line)}</p>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F7F7F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #EBEBEB;border-radius:18px;padding:32px">
    <p style="margin:0 0 20px;font-size:16px;font-weight:800;letter-spacing:-0.02em;color:#222">${BRAND_NAME}</p>
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:800;letter-spacing:-0.02em;color:${content.accent}">${escapeHtml(content.heading)}</h1>
    ${paragraphs}
    <a href="${BILLING_URL}" style="display:inline-block;margin-top:10px;padding:14px 24px;border-radius:13px;background:${ACCENT};color:#fff;font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(content.cta)}</a>
    <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#AAA">You are receiving this because you have a ${BRAND_NAME} subscription. Questions? Just reply to this email.</p>
  </div>
</body></html>`;
}

/**
 * Send one stage of the sequence.
 *
 * Returns false when nothing was sent — including the case where Brevo is not
 * configured, which `sendEmail` reports by returning null rather than throwing.
 * The caller must not record a stage as sent on a false, or a tenant would be
 * deactivated having been warned only in our logs.
 *
 * These are transactional account notices, not marketing, so they carry no
 * unsubscribe link: a tenant cannot opt out of being told their account is
 * about to be deactivated.
 */
export async function sendRenewalEmail(
  to: string,
  stage: RenewalEmailStage,
  ctx: RenewalEmailContext,
): Promise<boolean> {
  const content = stageContent(stage, {
    planName: ctx.planName || 'Your plan',
    endsAt: formatDate(ctx.endsAt) ?? 'recently',
    graceEndsAt: formatDate(ctx.graceEndsAt) ?? 'shortly',
    daysLeft: ctx.daysLeft ?? 0,
    graceDays: ctx.graceDays ?? GRACE_PERIOD_DAYS,
  });
  if (!content) return false;

  const messageId = await sendEmail(to, content.subject, renderHtml(content), 0);
  return messageId !== null;
}
