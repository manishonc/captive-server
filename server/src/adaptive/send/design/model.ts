/** The filled-in email the Voucher design draws (send/design/voucher.ts). */

export interface Action {
  label: string;
  href: string;
}

export interface FactRow {
  label: string;
  value: string;
  /** A password, door code or other code: set in a code font. */
  code?: boolean;
}

export type Feature =
  | { kind: 'offer'; value: string | null; label: string; untilLabel: string | null; untilDate: string | null; action: Action | null }
  | { kind: 'rating'; href: string; low: string; high: string; aria: (n: number) => string }
  | { kind: 'info'; lead: { label: string; value: string; sub: string | null }; rows: FactRow[]; stub: FactRow[]; action: Action | null }
  | { kind: 'code'; label: string; code: string };

export interface EmailModel {
  heading: string | null;
  /** Paragraphs before the slip (the note). */
  before: string[];
  /** Paragraphs after it. */
  after: string[];
  feature: Feature | null;
  /** The action when no slip carries it. */
  action: Action | null;
  image: { src: string; alt: string } | null;
  /** The closing line; the venue name always follows it. Null: no sign-off at all. */
  signoff: string | null;
}
