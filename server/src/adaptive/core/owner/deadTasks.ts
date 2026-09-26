/**
 * What a dead signal task was, for the admin's dead list and its retry (PR D). Pure.
 *
 * A task that dies has its guest details removed (a connect or a text holds the guest's number
 * or address until it is done). For a STOP, START, reply or old-style unsubscribe that was all
 * it had: nothing can be applied again, and a dead STOP means a guest who said no may still get
 * texts until the phone network's own STOP handling blocks the number. Those rows are urgent.
 */

export type DetailLessSignal = 'sms_stop' | 'sms_start' | 'sms_reply' | 'legacy_unsubscribe' | 'consent_without_guest';

export interface SignalEventFacts {
  type: string;
  source?: unknown;
  contactId?: unknown;
}

/** The kind of signal that can't be retried once its guest details are gone (null: it can). */
export function detailLessSignal(e: SignalEventFacts): DetailLessSignal | null {
  const source = typeof e.source === 'string' ? e.source : '';
  const hasContact = typeof e.contactId === 'string' && e.contactId.length > 0;
  if (e.type === 'consent.revoked' && source === 'sms_keyword') return 'sms_stop';
  if (e.type === 'consent.granted' && source === 'sms_keyword') return 'sms_start';
  if (e.type === 'consent.revoked' && !hasContact) return 'legacy_unsubscribe';
  if (e.type === 'consent.granted' && !hasContact) return 'consent_without_guest';
  if (e.type === 'message.replied') return 'sms_reply';
  return null;
}

/** Rows the admin must look at first: a guest's "no" that was never applied. */
export function isUrgent(kind: DetailLessSignal | null): boolean {
  return kind === 'sms_stop' || kind === 'legacy_unsubscribe';
}

const URGENT_NOTE: Partial<Record<DetailLessSignal, string>> = {
  sms_stop: 'A STOP by SMS was not applied, and the number was removed.',
  legacy_unsubscribe: 'An email unsubscribe was not applied, and the address was removed.',
};

export function urgentNote(kind: DetailLessSignal | null): string | null {
  return kind ? URGENT_NOTE[kind] ?? null : null;
}

/** Why the retry is refused (409), in plain words. */
export function refusalText(kind: DetailLessSignal): string {
  switch (kind) {
    case 'sms_stop':
      return "This STOP lost the guest's number when it failed, so nothing can be applied again from here. Twilio refuses further SMS to a number that texted STOP, and the engine blocks the number when Twilio reports that.";
    case 'legacy_unsubscribe':
      return "This unsubscribe lost the guest's address when it failed, so nothing can be applied again from here. The guest record keeps its own unsubscribe flag, which the engine reads at the guest's next Wi-Fi login.";
    case 'sms_start':
      return "This START lost the guest's number when it failed: a retry would change nothing (the guest can text START again).";
    case 'sms_reply':
      return "This reply lost the guest's number when it failed: a retry would change nothing.";
    default:
      return "This consent change lost the guest's details when it failed: a retry would change nothing.";
  }
}
