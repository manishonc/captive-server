// In-memory app log: ring buffer plus listeners that stream lines to the UI.

type LogListener = (line: string) => void;

const MAX_LINES = 1000;
const lines: string[] = [];
const listeners = new Set<LogListener>();

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  for (const listener of listeners) {
    try {
      listener(line);
    } catch {
      // a broken listener must never break logging
    }
  }
  console.log(line);
}

export function getLogLines(): string[] {
  return [...lines];
}

export function onLog(listener: LogListener): void {
  listeners.add(listener);
}
