// set-inform command construction and output interpretation.
// Pure functions, no I/O — unit tested in test/adopt-command.test.ts.

export class InvalidUrlError extends Error {}

/**
 * Validate and normalize a controller inform URL. Appends /inform when no
 * path is given, so "http://host:8085" becomes "http://host:8085/inform".
 */
export function normalizeInformUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new InvalidUrlError('Controller URL is empty');
  // The URL is interpolated into a remote shell command — reject anything
  // that could escape it.
  if (/[\s'"`;|&<>\\$(){}]/.test(trimmed)) {
    throw new InvalidUrlError('Controller URL contains invalid characters');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidUrlError(`Not a valid URL: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError('Controller URL must start with http:// or https://');
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/inform';
  return url.toString();
}

/**
 * The two set-inform variants, in the order they should be tried:
 * mca-cli-op for current firmware, bare set-inform for older firmware.
 */
export function buildSetInformCommands(informUrl: string): [string, string] {
  const url = normalizeInformUrl(informUrl);
  return [`mca-cli-op set-inform ${url}`, `set-inform ${url}`];
}

export type ExecVerdict = 'success' | 'not-found' | 'unknown';

export function interpretExecOutput(stdout: string, stderr: string): ExecVerdict {
  const all = `${stdout}\n${stderr}`;
  if (/Adoption request sent/i.test(all)) return 'success';
  if (/not found|unknown command|command not found/i.test(all)) return 'not-found';
  return 'unknown';
}
