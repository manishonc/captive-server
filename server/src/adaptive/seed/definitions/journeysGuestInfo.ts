/**
 * Guest info pack (PRD §6.3): utility messages every venue type can use. They
 * need no marketing opt-in and cost no credits, and never carry offers (V14).
 */

import { t, type JourneySeed } from './types';

const ALL = ['restaurant', 'cafe', 'airbnb', 'other'] as const;

export const wifiInfoCard: JourneySeed = {
  header: {
    key: 'wifi_info_card',
    name: t('Wi-Fi & info card', 'WLAN- & Infokarte'),
    description: t('Right after guests connect: Wi-Fi details and your house info.', 'Direkt nach dem Verbinden: WLAN-Details und deine Hausinfos.'),
    purpose: 'service',
    venueTypes: [...ALL],
    availability: 'available',
    kpi: 'hub_views',
    requiredCapabilities: [],
    display: { icon: 'wifi', when: t('Right after they connect', 'Direkt nach dem Verbinden') },
  },
  changelog: 'First version: one info card on the first visit',
  definition: {
    entry: {
      trigger: { type: 'visit.started', config: { visitNumber: { eq: 1 } } },
      requires: [],
      reentry: { mode: 'never' },
    },
    channelLadder: ['email', 'whatsapp', 'sms'],
    pools: {
      wifi_info: { name: t('Wi-Fi & info card', 'WLAN- & Infokarte'), purpose: 'service', channels: ['email', 'whatsapp', 'sms'], requiredLocales: ['en', 'de'], whatsappCategory: 'utility' },
    },
    start: 's',
    nodes: {
      s: {
        type: 'send',
        config: { purpose: 'service', pool: 'wifi_info', channel: 'auto', timing: { mode: 'now' }, urgent: true },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      { nodeId: 's', pool: 'wifi_info', channel: 'email', when: t('Right after she connects', 'Direkt nach dem Verbinden'), why: t('Useful info, not marketing — no opt-in needed and no credits.', 'Nützliche Infos, kein Marketing – ohne Einwilligung und ohne Credits.') },
    ],
  },
};

export const checkoutReminder: JourneySeed = {
  header: {
    key: 'checkout_reminder',
    name: t('Checkout reminder', 'Check-out-Erinnerung'),
    description: t('The day before checkout: time and instructions.', 'Am Tag vor dem Check-out: Zeit und Hinweise.'),
    purpose: 'service',
    venueTypes: [...ALL],
    availability: 'available',
    kpi: null,
    requiredCapabilities: ['stays'],
    display: { icon: 'door', when: t('Day before checkout, 17:00', 'Tag vor dem Check-out, 17:00') },
  },
  changelog: 'First version: one reminder the day before checkout',
  definition: {
    entry: {
      trigger: { type: 'stay.window', config: { requireConnect: true, anchor: 'checkOutAt', offsetDays: -1, at: '17:00' } },
      requires: [],
      reentry: { mode: 'after_exit' },
    },
    exitOn: [{ event: 'stay.cancelled' }],
    channelLadder: ['email', 'whatsapp', 'sms'],
    pools: {
      checkout_info: { name: t('Checkout reminder', 'Check-out-Erinnerung'), purpose: 'service', channels: ['email', 'whatsapp', 'sms'], requiredLocales: ['en', 'de'], whatsappCategory: 'utility' },
    },
    start: 's',
    nodes: {
      s: {
        type: 'send',
        config: { purpose: 'service', pool: 'checkout_info', channel: 'auto', timing: { mode: 'now' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      { nodeId: 's', pool: 'checkout_info', channel: 'email', when: t('Day before checkout, 17:00', 'Tag vor dem Check-out, 17:00'), why: t('So checkout is easy. Only sent for stays.', 'Damit der Check-out einfach ist. Nur bei Aufenthalten.') },
    ],
  },
};

export const GUEST_INFO_JOURNEYS: JourneySeed[] = [wifiInfoCard, checkoutReminder];
