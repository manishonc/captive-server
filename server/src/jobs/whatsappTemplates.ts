/**
 * WhatsApp templates (PR W1) — the API server's 2-minute tick: keeps the template registry equal
 * to Meta, takes over or puts back a submit Meta never answered, emails template alerts and the
 * 08:00 summary. It runs here, not in the adaptive worker, because this process holds the WhatsApp
 * token. Idle until "Check connection" has found the WhatsApp Business Account; one run at a time
 * (a Firestore lease — deploys can overlap two containers). See adaptive/whatsapp/sync.ts.
 */

import cron from 'node-cron';
import { runWhatsAppTemplateTick } from '../adaptive/whatsapp/sync';

export function startWhatsAppTemplateJob(): void {
  cron.schedule('*/2 * * * *', () => {
    runWhatsAppTemplateTick().catch((err) => console.error('[WA TEMPLATES TICK ERROR]', (err as Error)?.name ?? 'Error', (err as { code?: unknown })?.code ?? ''));
  });
  console.log('[WA TEMPLATES] Started — Meta template sync every 2 minutes (idle until Check connection)');
}
