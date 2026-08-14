import cron from 'node-cron';
import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { sendApOfflineAlert, sendApRecoveryAlert } from '../services/brevo';
import { adoptRegisteredPendingDevices } from '../services/unifiAdoption';
import { reconcilePendingWifi } from '../services/apProvisioning';

const BACK_ONLINE_GRACE_MS = 5 * 60_000;
const ALERT_COOLDOWN_MS = 12 * 60 * 60_000; // 12 hours between offline alerts

async function getTenantEmail(tenantUserId: string): Promise<string | null> {
  if (!tenantUserId) return null;
  try {
    const user = await db.collection('Users').doc(tenantUserId).get();
    return (user.data()?.email as string) ?? null;
  } catch {
    return null;
  }
}

async function runCheck(): Promise<void> {
  const now = Date.now();
  const snap = await db.collection('CaptivePortal_AccessPoints').get();

  for (const doc of snap.docs) {
    try {
      const ap = doc.data();
      if (ap.alertsEnabled === false) continue;
      if (!ap.lastSeen) continue;

      const thresholdMs = (ap.offlineThresholdMinutes ?? 60) * 60_000;
      const lastSeenMs: number = ap.lastSeen.toMillis();
      const age = now - lastSeenMs;

      if (age > thresholdMs && ap.status !== 'offline') {
        const lastAlertMs: number = ap.lastAlertSentAt?.toMillis() ?? 0;
        const inCooldown = (now - lastAlertMs) < ALERT_COOLDOWN_MS;

        await doc.ref.update({
          status: 'offline',
          lastOfflineAt: FieldValue.serverTimestamp(),
          ...(inCooldown ? {} : { lastAlertSentAt: FieldValue.serverTimestamp() }),
        });

        if (!inCooldown) {
          const email = await getTenantEmail(ap.tenantUserId);
          if (email) {
            await sendApOfflineAlert(email, ap.name, ap.venueName || 'your venue', new Date(lastSeenMs));
          }
          console.log('[AP MONITOR] Alert sent — marked offline:', ap.name, ap.mac);
        } else {
          console.log('[AP MONITOR] In cooldown, no alert — marked offline:', ap.name, ap.mac);
        }
        continue;
      }

      if (age <= BACK_ONLINE_GRACE_MS && ap.status === 'offline') {
        await doc.ref.update({ status: 'online' });
        const email = await getTenantEmail(ap.tenantUserId);
        if (email) {
          await sendApRecoveryAlert(email, ap.name, ap.venueName || 'your venue');
        }
        console.log('[AP MONITOR] Marked online:', ap.name, ap.mac);
      }
    } catch (err) {
      console.error('[AP MONITOR] Error processing AP:', doc.id, err);
    }
  }
}

export function startApMonitor(): void {
  cron.schedule('*/5 * * * *', async () => {
    await runCheck().catch((err) => console.error('[AP MONITOR ERROR]', err));

    // Separate try/catch: a controller outage must never affect the Firestore-only
    // alert sweep above. The reconciler is non-throwing by contract, but the alert
    // sweep stays isolated regardless.
    try {
      const sweep = await adoptRegisteredPendingDevices();
      if (sweep.adopted.length > 0 || sweep.failed.length > 0) {
        console.log('[AP ADOPT] sweep:', JSON.stringify(sweep));
      }
    } catch (err) {
      console.error('[AP ADOPT] sweep error:', err);
    }

    // Finish the WiFi step for self-serve access points that were adopted but never had it
    // applied. The WiFi apply is deliberately deferred until the device reports connected
    // (an AP group written with a not-yet-adopted MAC can be silently dropped by the
    // controller, leaving an SSID that broadcasts nowhere), and the installer's app polls
    // for that — but only while it is open. This is what covers the laptop being closed
    // mid-provision, and without it that venue's WiFi never comes up at all.
    try {
      const wifi = await reconcilePendingWifi();
      if (wifi.applied > 0) console.log('[AP RECONCILE]', JSON.stringify(wifi));
    } catch (err) {
      console.error('[AP RECONCILE] error:', err);
    }
  });
  console.log('[AP MONITOR] Started — checking every 5 minutes');
}
