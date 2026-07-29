/**
 * The gate every network-granting path runs before letting a guest through.
 *
 * `/create-user` only writes Firestore — the ACTUAL grants are
 * `/unifi/authorize` (controller call) and the portal's `/submit` (Aruba
 * swarm.cgi). All of them must run this, or a guest can skip the verify step
 * with a single curl. The portal UI is not a security boundary.
 *
 * Fails OPEN when the venue does not require verification, and only then.
 */

import { db } from '../firebase';
import {
  activeChannels,
  resolveVerification,
  VERIFICATION_CHANNEL_TARGET,
  type VerificationPageConfig,
} from './verificationConfig';
import { verifyVerificationToken, type TokenRejection } from './verificationToken';
import { normalizeE164, normalizeEmail } from './phone';
import { scopeKeyFor } from './guestOtp';
import type { VerifyChannel } from './guestOtp';

export interface GateOutcome {
  /** Whether the venue required verification at all. */
  required: boolean;
  /** Whether the request may proceed to grant access. */
  ok: boolean;
  /** Why it was refused — for logs and the client's error message. */
  reason?: TokenRejection | 'missing_target';
  /** Targets actually proven by a real (non-waiver) token. */
  verified: { email: boolean; phone: boolean };
  /** Which channel proved each target, for the guest doc. */
  verifiedChannel: VerifyChannel | null;
  /** Normalized E.164, when a phone was proven or parseable. */
  phoneE164: string | null;
  /** True when the server waived verification (daily budget spent). */
  bypassed: boolean;
}

function collectTokens(body: Record<string, any>): string[] {
  const out: string[] = [];
  if (typeof body?.verificationToken === 'string' && body.verificationToken.trim()) {
    out.push(body.verificationToken.trim());
  }
  if (Array.isArray(body?.verificationTokens)) {
    for (const t of body.verificationTokens) {
      if (typeof t === 'string' && t.trim()) out.push(t.trim());
    }
  }
  return out;
}

function destinationFor(channel: VerifyChannel, body: Record<string, any>): string | null {
  if (channel === 'email') return normalizeEmail(body?.email);
  return normalizeE164(String(body?.phoneCountryCode || ''), String(body?.phone || ''));
}

/** Targets that must be proven before this venue lets a guest through. */
function requiredTargets(config: VerificationPageConfig): Set<'email' | 'phone'> {
  const targets = new Set<'email' | 'phone'>();
  if (config.requirement !== 'all') return targets; // 'any' — one valid token suffices
  for (const channel of activeChannels(config)) targets.add(VERIFICATION_CHANNEL_TARGET[channel]);
  return targets;
}

export async function loadVerificationConfig(venueId: string | null) {
  let docData: Record<string, any> = {};
  if (venueId) {
    try {
      const snap = await db
        .collection('CaptivePortal_SplashScreenConfig')
        .doc(`venue_${venueId}`)
        .get();
      if (snap.exists) docData = snap.data() || {};
    } catch (err) {
      // A config read failure must not brick the venue — resolveVerification
      // over an empty doc yields enabled:false, i.e. today's behaviour.
      console.error('[VERIFY GATE CONFIG READ ERROR]', err);
    }
  }
  const loginFields =
    docData.loginPage && typeof docData.loginPage === 'object' ? docData.loginPage.fields : null;
  return resolveVerification(docData, loginFields || null);
}

export async function checkVerificationGate(args: {
  venueId: string | null;
  accessPointId: string | null;
  body: Record<string, any>;
  mac: string | null;
}): Promise<GateOutcome> {
  const empty: GateOutcome = {
    required: false,
    ok: true,
    verified: { email: false, phone: false },
    verifiedChannel: null,
    phoneE164: normalizeE164(
      String(args.body?.phoneCountryCode || ''),
      String(args.body?.phone || ''),
    ),
    bypassed: false,
  };

  const scopeKey = scopeKeyFor({ venueId: args.venueId, accessPointId: args.accessPointId });
  if (!scopeKey) return empty;

  const { effective } = await loadVerificationConfig(args.venueId);
  if (!effective.enabled) return empty;

  const allowed = activeChannels(effective);
  const tokens = collectTokens(args.body);
  if (!tokens.length) {
    return { ...empty, required: true, ok: false, reason: 'missing' };
  }

  const verified = { email: false, phone: false };
  let verifiedChannel: VerifyChannel | null = null;
  let bypassed = false;
  let lastRejection: TokenRejection | undefined;

  for (const token of tokens) {
    // The expected destination is derived from THIS request's body, so a token
    // proving one address cannot be replayed alongside a different one.
    const peekChannels = allowed;
    let accepted = false;
    for (const channel of peekChannels) {
      const verdict = verifyVerificationToken(token, {
        scopeKey,
        expectedDestination: destinationFor(channel, args.body),
        mac: args.mac,
        allowedChannels: [channel],
      });
      if (verdict.ok) {
        const target = VERIFICATION_CHANNEL_TARGET[verdict.payload.c];
        if (verdict.payload.b === 1) bypassed = true;
        else {
          verified[target] = true;
          if (!verifiedChannel) verifiedChannel = verdict.payload.c;
        }
        accepted = true;
        break;
      }
      lastRejection = verdict.reason;
    }
    if (!accepted && !lastRejection) lastRejection = 'malformed';
  }

  if (bypassed && !verified.email && !verified.phone) {
    // Server-waived: authorize, but record nothing as verified.
    return { ...empty, required: true, ok: true, bypassed: true };
  }

  if (!verified.email && !verified.phone) {
    return { ...empty, required: true, ok: false, reason: lastRejection || 'missing' };
  }

  const needed = requiredTargets(effective);
  for (const target of needed) {
    if (!verified[target]) {
      return {
        ...empty,
        required: true,
        ok: false,
        reason: 'missing_target',
        verified,
        verifiedChannel,
      };
    }
  }

  return {
    required: true,
    ok: true,
    verified,
    verifiedChannel,
    phoneE164: empty.phoneE164,
    bypassed,
  };
}

/**
 * The verified-state fields to merge onto a CaptivePortal_Users doc.
 *
 * `phoneE164` is written for EVERY guest with a parseable number, verified or
 * not — services/optOut.ts falls back to a full-collection scan on each
 * unmatched STOP precisely because this field does not exist, and a field
 * populated only on the verified subset would not fix that.
 */
export function verificationFields(outcome: GateOutcome): Record<string, unknown> {
  const now = Date.now();
  const fields: Record<string, unknown> = {};
  if (outcome.phoneE164) fields.phoneE164 = outcome.phoneE164;
  if (outcome.verified.email) {
    fields.emailVerified = true;
    fields.emailVerifiedAt = now;
  }
  if (outcome.verified.phone) {
    fields.phoneVerified = true;
    fields.phoneVerifiedAt = now;
  }
  if (outcome.verifiedChannel) fields.verifiedChannel = outcome.verifiedChannel;
  return fields;
}
