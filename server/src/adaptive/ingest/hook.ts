/**
 * The one safe way for existing code (guest login, webhooks, unsubscribe) to hand
 * something to Adaptive.
 *
 * Express 4 doesn't catch a failed async route and the server has no
 * `unhandledRejection` handler, so an uncaught Adaptive error could crash Node and
 * stop every Wi-Fi login. `runAdaptiveHook` catches BOTH an immediate throw
 * (while building the arguments, or in a non-async function) and a later
 * rejection, logs it, and returns straight away — the caller never waits.
 */

export function runAdaptiveHook(label: string, fn: () => unknown): void {
  try {
    Promise.resolve(fn()).catch((err: unknown) => {
      console.error(`[ADAPTIVE HOOK ${label}]`, (err as Error)?.message || err);
    });
  } catch (err) {
    console.error(`[ADAPTIVE HOOK ${label}]`, (err as Error)?.message || err);
  }
}
