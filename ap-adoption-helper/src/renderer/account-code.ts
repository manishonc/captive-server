// Setup-code helpers for the renderer.
//
// A near-duplicate of src/main/lib/account-code.ts, and deliberately so: the renderer is a
// classic script with no module loader (see renderer.ts), so it cannot import from main. The
// alternative — round-tripping every keystroke through IPC just to format a dash — would make
// typing feel laggy for no benefit.
//
// No imports or exports in this file: that is what makes tsc emit a plain global script.
//
// KEEP IN SYNC with src/main/lib/account-code.ts. test/account-code.test.ts fails if the two
// alphabet literals drift apart.

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_CONFUSABLE = 'ILO01';

type RendererCodeProblem = 'empty' | 'too_short' | 'too_long' | 'confusable' | 'bad_char';

interface RendererCodeCheck {
  value: string;
  ok: boolean;
  problem?: RendererCodeProblem;
}

/** Strip separators and uppercase. Never drops characters — dropping shifts the code. */
function normalizeAccountCode(input: string): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}

/** Display form `H7K2-M9QX`, formatted progressively as the person types. */
function formatAccountCode(input: string): string {
  const v = normalizeAccountCode(input).slice(0, CODE_LENGTH);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}

/** Confusables are reported before length — see the main-process copy for why. */
function checkAccountCode(input: string): RendererCodeCheck {
  const value = normalizeAccountCode(input);
  if (!value) return { value, ok: false, problem: 'empty' };
  const chars = value.split('');
  if (chars.some((c) => CODE_CONFUSABLE.indexOf(c) !== -1)) {
    return { value, ok: false, problem: 'confusable' };
  }
  if (chars.some((c) => CODE_ALPHABET.indexOf(c) === -1)) {
    return { value, ok: false, problem: 'bad_char' };
  }
  if (value.length > CODE_LENGTH) return { value, ok: false, problem: 'too_long' };
  if (value.length < CODE_LENGTH) return { value, ok: false, problem: 'too_short' };
  return { value, ok: true };
}
