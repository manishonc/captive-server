/**
 * Campaign write validation for the MCP tools.
 *
 * PORT — KEEP RULES IN SYNC with cms/app/api/captive-portal/_lib/campaigns.js
 * (the authority for CMS routes). Field rules, limits and error codes are
 * intentionally identical so API clients and the AI see the same contract
 * regardless of which surface they write through.
 *
 * Blocks emails: bodyFormat 'blocks' validates designJson against the
 * vendored EmailDesignV1 schema and re-renders `body` server-side.
 */

import { randomUUID } from 'crypto';
import { validateEmailDesign } from '../emailBlocks/schema';
import { renderEmailBlocks } from '../emailBlocks/render';

export const COLLECTION = 'CaptivePortal_Campaigns';

export const CAMPAIGN_TYPES = ['broadcast', 'automation'] as const;
export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'active',
  'paused',
  'archived',
] as const;
export const EDITABLE_STATUSES = ['draft', 'paused'];
export const CHANNELS = ['email', 'sms', 'whatsapp'];
const WIFI_EVENTS = ['onConnect', 'onReconnect', 'onDisconnect'];
const TRIGGER_KINDS = ['wifiEvent', 'dateRelative'];
const DATE_ANCHORS = ['firstSignIn', 'lastSession'];
const ENTITY_TYPES = ['listing', 'restaurant'];
const ENGAGEMENT_FILTERS = ['any', 'opened', 'clicked'];
const SCHEDULE_MODES = ['now', 'scheduled'];

const MAX_NAME_LENGTH = 150;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_SUBJECT_LENGTH = 200;
const MAX_EMAIL_BODY_LENGTH = 200000;
const MAX_SMS_CONTENT_LENGTH = 1600;
const MAX_DESIGN_JSON_BYTES = 200000;
const EMAIL_BODY_FORMATS = ['html', 'text', 'blocks'];
const MAX_WHATSAPP_TEMPLATE_NAME_LENGTH = 512;
const MAX_WHATSAPP_LANGUAGE_CODE_LENGTH = 16;
const MAX_MESSAGES_PER_CHANNEL = 20;
const MAX_VENUE_IDS = 500;
// CMS delay limits (lib/captive-portal-constants): 0 minutes .. 30 days.
const MIN_DELAY_MINUTES = 0;
const MAX_DELAY_MINUTES = 43200;

export interface ValidationError {
  error: string;
  field?: string | null;
  code: string;
}

type Raw = Record<string, unknown>;

const err = (error: string, field: string | null, code: string): ValidationError => ({
  error,
  field,
  code,
});

function genId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

const UNSUBSCRIBE_RE = /\{\{\s*unsubscribeUrl\s*\}\}/i;

/**
 * Minimal unsubscribe backstop for MCP writes. The blocks renderer always
 * emits the {{unsubscribeUrl}} footer; raw HTML/text bodies that lack an
 * unsubscribe affordance are REJECTED here (unlike the CMS, which injects
 * the footer) — the AI's skill prompt requires the token, so rejection
 * produces a clear, machine-readable error the model can fix.
 */
function hasUnsubscribe(body: string): boolean {
  if (UNSUBSCRIBE_RE.test(body)) return true;
  return /<a\b[^>]*>[^<]*?(unsubscribe|unsub|opt[\s-]?out)/i.test(body) ||
    /\bhref\s*=\s*["'][^"']*(unsubscribe|unsub|opt[\s-]?out)/i.test(body);
}

function validateMessage(
  rawMsg: unknown,
  index: number,
  allowedChannels: string[] | undefined,
): { message: Raw } | ValidationError {
  if (!rawMsg || typeof rawMsg !== 'object') {
    return err('Each message must be an object', `messages[${index}]`, 'invalid_message');
  }
  const raw = rawMsg as Raw;
  const channel = String(raw.channel ?? '').toLowerCase();
  if (!CHANNELS.includes(channel)) {
    return err(`Invalid channel "${raw.channel}"`, `messages[${index}].channel`, 'invalid_channel');
  }
  if (allowedChannels && !allowedChannels.includes(channel)) {
    return err(
      `Message channel "${channel}" is not in the campaign's channels`,
      `messages[${index}].channel`,
      'channel_not_enabled',
    );
  }

  const delayMinutes = raw.delayMinutes;
  if (
    typeof delayMinutes !== 'number' ||
    !Number.isFinite(delayMinutes) ||
    delayMinutes < MIN_DELAY_MINUTES ||
    delayMinutes > MAX_DELAY_MINUTES
  ) {
    return err(
      `delayMinutes must be ${MIN_DELAY_MINUTES}-${MAX_DELAY_MINUTES}`,
      `messages[${index}].delayMinutes`,
      'invalid_delay',
    );
  }

  const id =
    typeof raw.id === 'string' && raw.id.trim().length >= 8 ? raw.id.trim().slice(0, 32) : genId();

  const entry: Raw = { id, channel, delayMinutes };

  if (channel === 'email') {
    entry.subject = String(raw.subject ?? '').slice(0, MAX_SUBJECT_LENGTH);
    entry.body = String(raw.body ?? '').slice(0, MAX_EMAIL_BODY_LENGTH);
    const bodyFormat = raw.bodyFormat === undefined || raw.bodyFormat === null ? 'html' : raw.bodyFormat;
    if (!EMAIL_BODY_FORMATS.includes(bodyFormat as string)) {
      return err('Invalid bodyFormat', `messages[${index}].bodyFormat`, 'invalid_body_format');
    }
    entry.bodyFormat = bodyFormat;

    if (bodyFormat === 'blocks') {
      const designResult = validateEmailDesign(raw.designJson);
      if (!designResult.ok) {
        return err(
          `Invalid email design: ${designResult.error}`,
          `messages[${index}].designJson${designResult.path ? `.${designResult.path}` : ''}`,
          'invalid_design',
        );
      }
      entry.body = renderEmailBlocks(designResult.design);
      if ((entry.body as string).length > MAX_EMAIL_BODY_LENGTH) {
        return err(
          `Rendered email exceeds ${MAX_EMAIL_BODY_LENGTH} characters`,
          `messages[${index}].designJson`,
          'design_too_large',
        );
      }
    } else if (!hasUnsubscribe(entry.body as string)) {
      return err(
        'Email body must contain an unsubscribe link — include an anchor with href {{unsubscribeUrl}} (or use bodyFormat "blocks", which adds it automatically)',
        `messages[${index}].body`,
        'missing_unsubscribe',
      );
    }

    if (raw.designJson !== undefined && raw.designJson !== null) {
      let serialized: string;
      try {
        serialized = JSON.stringify(raw.designJson);
      } catch {
        return err('designJson must be JSON-serializable', `messages[${index}].designJson`, 'invalid_design');
      }
      if (serialized.length > MAX_DESIGN_JSON_BYTES) {
        return err(
          `designJson exceeds ${MAX_DESIGN_JSON_BYTES} bytes`,
          `messages[${index}].designJson`,
          'design_too_large',
        );
      }
      entry.designJson = raw.designJson;
    }
  } else if (channel === 'whatsapp') {
    entry.templateName = String(raw.templateName ?? '').trim().slice(0, MAX_WHATSAPP_TEMPLATE_NAME_LENGTH);
    entry.languageCode =
      String(raw.languageCode ?? '').trim().slice(0, MAX_WHATSAPP_LANGUAGE_CODE_LENGTH) || 'en_US';
    entry.content = String(raw.content ?? '').slice(0, MAX_SMS_CONTENT_LENGTH);
    if (raw.variables !== undefined) {
      if (!Array.isArray(raw.variables)) {
        return err('variables must be an array', `messages[${index}].variables`, 'invalid_variables');
      }
      entry.variables = raw.variables;
    }
  } else {
    entry.content = String(raw.content ?? '').slice(0, MAX_SMS_CONTENT_LENGTH);
  }

  return { message: entry };
}

function validateMessages(
  rawMessages: unknown,
  allowedChannels: string[] | undefined,
): { messages: Raw[] } | ValidationError {
  if (rawMessages === undefined) return { messages: [] };
  if (!Array.isArray(rawMessages)) {
    return err('messages must be an array', 'messages', 'invalid_messages');
  }
  const perChannelCount: Record<string, number> = { email: 0, sms: 0, whatsapp: 0 };
  const messages: Raw[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const result = validateMessage(rawMessages[i], i, allowedChannels);
    if ('error' in result) return result;
    const channel = result.message.channel as string;
    perChannelCount[channel] += 1;
    if (perChannelCount[channel] > MAX_MESSAGES_PER_CHANNEL) {
      return err(`Max ${MAX_MESSAGES_PER_CHANNEL} messages per channel`, `messages[${i}]`, 'too_many_messages');
    }
    messages.push(result.message);
  }
  return { messages };
}

function validateSegment(rawSegment: unknown): { segment: Raw } | ValidationError {
  const segment: Raw = {
    venueIds: [],
    optInRequired: true, // consent is always enforced; never settable to false
    engagement: 'any',
  };
  if (rawSegment === undefined || rawSegment === null) return { segment };
  if (typeof rawSegment !== 'object') {
    return err('segment must be an object', 'segment', 'invalid_segment');
  }
  const raw = rawSegment as Raw;

  if (raw.venueIds !== undefined) {
    if (!Array.isArray(raw.venueIds)) {
      return err('segment.venueIds must be an array', 'segment.venueIds', 'invalid_venue_ids');
    }
    if (raw.venueIds.length > MAX_VENUE_IDS) {
      return err(`Max ${MAX_VENUE_IDS} venues`, 'segment.venueIds', 'too_many_venues');
    }
    segment.venueIds = raw.venueIds
      .filter((v): v is string => typeof v === 'string' && !!v.trim())
      .map((v) => v.trim().slice(0, 128));
  }

  if (raw.entityType !== undefined && raw.entityType !== null) {
    if (!ENTITY_TYPES.includes(raw.entityType as string)) {
      return err('Invalid segment.entityType', 'segment.entityType', 'invalid_entity_type');
    }
    segment.entityType = raw.entityType;
  }

  for (const dateField of ['signedUpAfter', 'signedUpBefore'] as const) {
    const val = raw[dateField];
    if (val !== undefined && val !== null && val !== '') {
      const d = new Date(val as string);
      if (Number.isNaN(d.getTime())) {
        return err(`Invalid segment.${dateField}`, `segment.${dateField}`, 'invalid_date');
      }
      segment[dateField] = d.toISOString();
    }
  }

  if (raw.engagement !== undefined && raw.engagement !== null) {
    if (!ENGAGEMENT_FILTERS.includes(raw.engagement as string)) {
      return err('Invalid segment.engagement', 'segment.engagement', 'invalid_engagement');
    }
    segment.engagement = raw.engagement;
  }

  return { segment };
}

function validateTrigger(rawTrigger: unknown): { trigger: Raw } | ValidationError {
  if (rawTrigger === undefined || rawTrigger === null) {
    return err('Automation campaigns require a trigger', 'trigger', 'missing_trigger');
  }
  if (typeof rawTrigger !== 'object') {
    return err('trigger must be an object', 'trigger', 'invalid_trigger');
  }
  const raw = rawTrigger as Raw;
  const kind = raw.kind as string;
  if (!TRIGGER_KINDS.includes(kind)) {
    return err('Invalid trigger.kind', 'trigger.kind', 'invalid_trigger_kind');
  }
  const trigger: Raw = { kind };

  if (kind === 'wifiEvent') {
    if (!WIFI_EVENTS.includes(raw.wifiEvent as string)) {
      return err('Invalid trigger.wifiEvent', 'trigger.wifiEvent', 'invalid_wifi_event');
    }
    trigger.wifiEvent = raw.wifiEvent;
  } else {
    const dr = raw.dateRelative as Raw | undefined;
    if (!dr || typeof dr !== 'object') {
      return err('trigger.dateRelative is required', 'trigger.dateRelative', 'missing_date_relative');
    }
    if (!DATE_ANCHORS.includes(dr.anchor as string)) {
      return err('Invalid trigger.dateRelative.anchor', 'trigger.dateRelative.anchor', 'invalid_anchor');
    }
    const offsetDays = Number(dr.offsetDays);
    if (!Number.isFinite(offsetDays) || offsetDays < 0 || offsetDays > 3650) {
      return err('offsetDays must be 0-3650', 'trigger.dateRelative.offsetDays', 'invalid_offset');
    }
    trigger.dateRelative = { anchor: dr.anchor, offsetDays: Math.round(offsetDays) };
  }

  return { trigger };
}

function validateSchedule(rawSchedule: unknown): { schedule: Raw } | ValidationError {
  const schedule: Raw = { mode: 'now' };
  if (rawSchedule === undefined || rawSchedule === null) return { schedule };
  if (typeof rawSchedule !== 'object') {
    return err('schedule must be an object', 'schedule', 'invalid_schedule');
  }
  const raw = rawSchedule as Raw;
  const mode = (raw.mode as string) || 'now';
  if (!SCHEDULE_MODES.includes(mode)) {
    return err('Invalid schedule.mode', 'schedule.mode', 'invalid_schedule_mode');
  }
  schedule.mode = mode;
  if (mode === 'scheduled') {
    const d = new Date(raw.sendAt as string);
    if (!raw.sendAt || Number.isNaN(d.getTime())) {
      return err('schedule.sendAt is required when mode is "scheduled"', 'schedule.sendAt', 'invalid_send_at');
    }
    schedule.sendAt = d.toISOString();
  }
  return { schedule };
}

/**
 * Validate a create/update payload into a normalized, storable campaign body.
 * Mirrors cms `_lib/campaigns.js` validateCampaignInput.
 */
export function validateCampaignInput(
  body: unknown,
  { isCreate }: { isCreate?: boolean } = {},
): { campaign: Raw } | ValidationError {
  if (!body || typeof body !== 'object') {
    return err('Request body must be an object', null, 'invalid_body');
  }
  const raw = body as Raw;
  const campaign: Raw = {};

  if (isCreate || raw.name !== undefined) {
    const name = String(raw.name ?? '').trim();
    if (!name) return err('name is required', 'name', 'missing_name');
    campaign.name = name.slice(0, MAX_NAME_LENGTH);
  }

  if (raw.description !== undefined) {
    campaign.description = String(raw.description ?? '').slice(0, MAX_DESCRIPTION_LENGTH);
  } else if (isCreate) {
    campaign.description = '';
  }

  if (isCreate || raw.type !== undefined) {
    if (!CAMPAIGN_TYPES.includes(raw.type as (typeof CAMPAIGN_TYPES)[number])) {
      return err('type must be "broadcast" or "automation"', 'type', 'invalid_type');
    }
    campaign.type = raw.type;
  }
  const effectiveType = campaign.type as string | undefined;

  if (isCreate || raw.channels !== undefined) {
    const rawChannels = Array.isArray(raw.channels) ? raw.channels : [];
    campaign.channels = rawChannels.filter((c): c is string => CHANNELS.includes(c as string));
  }
  const allowedChannels = campaign.channels as string[] | undefined;

  if (isCreate || raw.segment !== undefined) {
    const result = validateSegment(raw.segment);
    if ('error' in result) return result;
    campaign.segment = result.segment;
  }

  if (isCreate || raw.messages !== undefined) {
    const result = validateMessages(raw.messages, allowedChannels);
    if ('error' in result) return result;
    campaign.messages = result.messages;
  }

  if (effectiveType === 'automation') {
    if (isCreate || raw.trigger !== undefined) {
      const result = validateTrigger(raw.trigger);
      if ('error' in result) return result;
      campaign.trigger = result.trigger;
    }
  } else if (effectiveType === 'broadcast') {
    if (isCreate || raw.schedule !== undefined) {
      const result = validateSchedule(raw.schedule);
      if ('error' in result) return result;
      campaign.schedule = result.schedule;
    }
  }

  return { campaign };
}
