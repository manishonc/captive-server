/**
 * The email design's colours, worked out from the venue's three brand colours (Branding page).
 * Readable whatever the brand: text on a brand fill is white or dark ink, whichever reads better,
 * and when neither reaches 4.5:1 the fill moves a little, never the text. Pure.
 */

export const WHITE = '#FFFFFF';
const BLACK = '#000000';

export function hex2rgb(hex: string): [number, number, number] {
  const h = String(hex).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

export function rgb2hex(rgb: readonly number[]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** `t` is the share of `b` (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  return rgb2hex(A.map((v, i) => v + (B[i] - v) * t));
}

export function luminance(hex: string): number {
  const c = hex2rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` moved toward black or white (away from `bg`), just far enough to reach `min` on `bg`. */
export function ensure(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = luminance(bg) > 0.179 ? BLACK : WHITE;
  for (let t = 0.03; t < 1; t += 0.03) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}

/** A brand colour used as a fill and the text on it, at least 4.5:1. */
export function fillPair(color: string, ink: string): { fill: string; on: string; moved: boolean } {
  const on = contrast(WHITE, color) >= contrast(ink, color) ? WHITE : ink;
  if (contrast(on, color) >= 4.5) return { fill: color, on, moved: false };
  const toward = on === WHITE ? BLACK : WHITE;
  for (let t = 0.03; t < 1; t += 0.03) {
    const f = mix(color, toward, t);
    if (contrast(on, f) >= 4.5) return { fill: f, on, moved: true };
  }
  return { fill: toward, on, moved: true };
}

export interface BrandColors {
  primary: string;
  secondary: string;
  accent: string;
}

/** Every colour the Voucher design uses, for one theme. */
export interface DesignTokens {
  /** The slip (a light paper in light mode). */
  paper: string;
  /** The page around the slip: the brand's background colour, or a light tint of the primary. */
  ground: string;
  ink: string;
  /** Secondary text on the slip and on the page (both at least 4.5:1). */
  ink2: string;
  ink2Ground: string;
  line: string;
  lineStrong: string;
  /** Button fill and its text. */
  fill: string;
  on: string;
  /** The brand colour as text on the slip (the offer value, links), at least 4.5:1. */
  btext: string;
  btextGround: string;
  /** Stars: the accent when it stands out (3:1), else the primary. */
  star: string;
}

const INK_BASE = '#16181B';

export function tokens(brand: BrandColors, theme: 'light' | 'dark'): DesignTokens {
  const { primary: p, secondary: s, accent: a } = brand;
  if (theme === 'dark') {
    const ground = mix('#0F1011', p, 0.06);
    const paper = mix('#1F2023', p, 0.05);
    const ink = mix('#F4F2EF', p, 0.05);
    const pair = fillPair(p, INK_BASE);
    // A button that would vanish into the dark page (a near-black or navy brand) is lightened just enough.
    const btn = contrast(pair.fill, ground) < 1.8 ? fillPair(ensure(pair.fill, ground, 2.6), INK_BASE) : pair;
    return {
      paper,
      ground,
      ink,
      ink2: ensure(mix(ink, paper, 0.36), paper, 4.6),
      ink2Ground: ensure(mix(ink, ground, 0.36), ground, 4.6),
      line: mix(ink, paper, 0.82),
      lineStrong: mix(ink, paper, 0.62),
      fill: btn.fill,
      on: btn.on,
      btext: ensure(p, paper, 4.5),
      btextGround: ensure(p, ground, 4.5),
      star: ensure(contrast(a, paper) >= 3 ? a : p, paper, 3),
    };
  }
  const paper = WHITE;
  const ink = mix(INK_BASE, p, 0.1);
  const ground = contrast(ink, s) >= 10 && luminance(s) < 0.96 ? s : mix(p, WHITE, 0.9);
  const brandPair = fillPair(p, ink);
  // A very light brand colour (white, yellow, cyan) would leave a button with no visible shape on the
  // white slip or the light page: it is darkened just enough to stand out, its text picked again.
  const faint = Math.min(contrast(brandPair.fill, paper), contrast(brandPair.fill, ground)) < 1.8;
  const pair = faint ? fillPair(ensure(brandPair.fill, luminance(ground) < luminance(paper) ? ground : paper, 2.6), ink) : brandPair;
  const ink2 = ensure(mix(ink, paper, 0.4), paper, 4.6);
  return {
    paper,
    ground,
    ink,
    ink2,
    ink2Ground: ensure(ink2, ground, 4.6),
    line: mix(ink, paper, 0.87),
    lineStrong: mix(ink, paper, 0.6),
    fill: pair.fill,
    on: pair.on,
    btext: ensure(p, paper, 4.5),
    btextGround: ensure(p, ground, 4.5),
    star: contrast(a, paper) >= 3 ? a : contrast(p, paper) >= 3 ? p : ensure(p, paper, 3),
  };
}
