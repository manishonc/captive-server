/**
 * Release marker for the engine code. The API and the worker both report it on
 * the admin card, so a deploy that updated only one of the two shows up at once.
 * Bump it with every change to the engine's tasks, events or stored shapes.
 */
export const ENGINE_RUNTIME_VERSION = '2026-09-24.a';
