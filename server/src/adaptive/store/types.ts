/**
 * Document shapes as stored (02-firestore-schema + the PR 1 additions in the
 * plan). Times are Firestore Timestamps on read; writes pass Dates.
 */

import type { Timestamp } from 'firebase-admin/firestore';
import type {
  ChannelContent,
  I18n,
  JourneyDefinition,
  JourneyTemplateHeader,
  Offer,
  PlaybookContent,
  SlotValue,
} from '../core/schemas';
import type { Channel, PlaybookIcon, PlaybookKind, VenueType } from '../core/constants';
import type { ValidationReport } from '../core/issues';

export type StoredTime = Timestamp | Date | null;

export interface StoredValidation extends ValidationReport {
  checkedAt: StoredTime;
}

export interface PlaybookHeaderDoc {
  key: string;
  kind: PlaybookKind;
  status: 'draft' | 'published' | 'deprecated';
  name: I18n;
  summary: I18n;
  icon: PlaybookIcon;
  venueTypes: VenueType[];
  sortOrder: number;
  latestVersion: number;
  publishedVersion: number | null;
  createdAt: StoredTime;
  createdBy: string;
  updatedAt: StoredTime;
  updatedBy: string;
  schemaVersion: number;
}

export interface PlaybookVersionDoc extends PlaybookContent {
  version: number;
  state: 'draft' | 'published';
  basedOnVersion: number | null;
  engineVersion: string;
  validation: StoredValidation | null;
  checksum: string | null;
  changelog: string;
  createdAt: StoredTime;
  createdBy: string;
  updatedAt: StoredTime;
  updatedBy: string;
  publishedAt: StoredTime;
  publishedBy: string | null;
  schemaVersion: number;
}

export interface JourneyTemplateHeaderDoc extends JourneyTemplateHeader {
  status: 'draft' | 'published' | 'deprecated';
  latestVersion: number;
  publishedVersion: number | null;
  createdAt: StoredTime;
  createdBy: string;
  updatedAt: StoredTime;
  updatedBy: string;
  schemaVersion: number;
}

export interface JourneyTemplateVersionDoc {
  version: number;
  state: 'draft' | 'published';
  definition: JourneyDefinition;
  engineVersion: string;
  checksum: string | null;
  validation: StoredValidation | null;
  changelog: string;
  createdAt: StoredTime;
  createdBy: string;
  publishedAt: StoredTime;
  publishedBy: string | null;
  schemaVersion: number;
}

export interface VariantDoc {
  scope: 'platform' | 'venue';
  tenantUserId: string | null;
  venueId: string | null;
  poolKey: string;
  journeyKey: string | null;
  purpose: 'marketing' | 'service';
  status: 'draft' | 'pending_approval' | 'active' | 'paused' | 'retired';
  origin: 'platform' | 'owner' | 'ai';
  name: string;
  letter: string;
  parentVariantId: string | null;
  generation: number;
  axes: { hook: string; length: string; tone: string; emoji: boolean };
  baseLocale: string;
  channels: ChannelContent;
  locales: Partial<Record<string, ChannelContent>>;
  mergeFieldsUsed: string[];
  contentHash: string;
  lint: { status: 'pending' | 'passed' | 'failed'; issues: unknown[]; linterVersion: string | null };
  approval: { by: string; at: StoredTime } | null;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  createdBy: string;
  schemaVersion: number;
}

export interface OverlapInfo {
  legacyOnConnectChannels: Channel[];
  automations: Array<{ campaignId: string; name: string }>;
  acknowledgedAt: StoredTime;
  acknowledgedBy: string | null;
}

export interface AdaptiveVenueDoc {
  tenantUserId: string;
  venueId: string;
  status: 'off' | 'on' | 'paused' | 'paused_by_platform';
  activePlaybookKey: string | null;
  activeInstallId: string | null;
  activatedAt: StoredTime;
  activatedBy: string | null;
  utility: { enabled: boolean; installId: string | null; enabledAt: StoredTime; enabledBy: string | null };
  businessType: VenueType;
  timezone: string | null;
  avgSpendPerVisit: { amountMinor: number; currency: string } | null;
  overlap: OverlapInfo;
  estimate: { creditsPerMonth: number; revenuePerMonthMinor: number; currency: string; computedAt: StoredTime } | null;
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}

export interface VenueJourneyConfigDoc {
  enabled: boolean;
  templateVersion: number;
  slots: Record<string, SlotValue>;
}

export interface VenuePlaybookDoc {
  tenantUserId: string;
  venueId: string;
  playbookKey: string;
  kind: PlaybookKind;
  playbookVersion: number;
  state: 'setup' | 'active' | 'inactive';
  configVersion: number;
  journeys: Record<string, VenueJourneyConfigDoc>;
  offerMenu: Offer[];
  lastEditedBy: string;
  lastEditedAt: StoredTime;
  lastEditSource: 'owner' | 'platform';
  createdAt: StoredTime;
  updatedAt: StoredTime;
  schemaVersion: number;
}

export interface VenuePlaybookVersionDoc {
  playbookVersion: number;
  journeys: Record<string, VenueJourneyConfigDoc>;
  offerMenu: Offer[];
  author: { kind: 'owner' | 'platform' | 'system'; uid: string };
  applyToInFlight: boolean;
  note: string;
  createdAt: StoredTime;
  schemaVersion: number;
}
