/**
 * Deterministic ids (02-firestore-schema §1): the same inputs always give the
 * same id, so enrolling twice, scheduling twice or receiving a webhook twice
 * can never create a second document.
 */

import { hashId } from '../checksum';

export const instanceIdFor = (venueId: string, contactId: string, journeyKey: string, entryKey: string) =>
  hashId('ji', `${venueId}:${contactId}:${journeyKey}:${entryKey}`);

export const sendKeyFor = (instanceId: string, nodeId: string) => hashId('js', `${instanceId}:${nodeId}`);

export const taskIdFor = (dedupeKey: string) => hashId('jt', dedupeKey);

export const eventIdFor = (source: string, externalKey: string) => hashId('ev', `${source}:${externalKey}`);

export const visitIdFor = (connectEventId: string) => hashId('vi', connectEventId);

/** One booking of one feed. The feed id is `venue_{venueId}`, so a delete and re-add keeps the stay ids. */
export const stayIdFor = (feedId: string, uid: string) => hashId('st', `${feedId}:${uid}`);

/** Tasks are spread over 16 shards so several workers can split the queue later. */
export const SHARDS = 16;

export function shardOf(taskId: string): number {
  let h = 0;
  for (let i = 0; i < taskId.length; i += 1) h = (h * 31 + taskId.charCodeAt(i)) >>> 0;
  return h % SHARDS;
}

/** Minute bucket for the connect hook: the UniFi double call lands on the same id. */
export function minuteBucket(ms: number): number {
  return Math.floor(ms / 60_000);
}
