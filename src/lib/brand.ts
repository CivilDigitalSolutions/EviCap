/**
 * EviCap's brand: the colours from the brand board and the shield-and-lens mark,
 * drawn here once so the icons, the app, the report and the verifier all match.
 */

export const BRAND = {
  navy: '#14213d', // Primary Navy
  teal: '#006d77', // Security Teal
  white: '#ffffff', // Investigation White
  grey: '#edf2f4', // Data Grey
  /** Teal lightened for use on navy or dark backgrounds, where the brand teal is too dark to see. */
  tealOnDark: '#4fb3bc',
} as const;

export interface MarkColours {
  /** The shield outline, or the shield's fill when `filled` is set. */
  shield: string;
  /** The inner line on the right of the shield. */
  inner: string;
  /** The inner hook at the top left. */
  hook: string;
  /** The lens ring. */
  ring: string;
  /** The aperture inside the lens. */
  aperture: string;
  /** The aperture's blade lines. */
  blades: string;
}

export const MARK_ON_LIGHT: MarkColours = {
  shield: BRAND.navy,
  inner: BRAND.teal,
  hook: BRAND.navy,
  ring: BRAND.navy,
  aperture: BRAND.teal,
  blades: BRAND.white,
};

export const MARK_ON_DARK: MarkColours = {
  shield: BRAND.white,
  inner: BRAND.tealOnDark,
  hook: BRAND.white,
  ring: BRAND.white,
  aperture: BRAND.tealOnDark,
  blades: BRAND.navy,
};

/** For the app icon: a solid navy shield, so it shows on light and dark browser toolbars alike. */
export const MARK_ICON: MarkColours = {
  shield: BRAND.navy,
  inner: BRAND.tealOnDark,
  hook: BRAND.white,
  ring: BRAND.white,
  aperture: BRAND.tealOnDark,
  blades: BRAND.navy,
};

const f = (n: number) => +n.toFixed(2);

/** The six blade lines of a camera aperture, centred on (cx, cy). */
function blades(cx: number, cy: number, r: number, len: number) {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
  return pts
    .map(([x, y], i) => {
      const [nx, ny] = pts[(i + 1) % 6]!;
      const dx = x - nx;
      const dy = y - ny;
      const d = Math.hypot(dx, dy);
      return `M${f(x)} ${f(y)}L${f(x + (dx / d) * len)} ${f(y + (dy / d) * len)}`;
    })
    .join('');
}

const SHIELD = 'M50 6L88 18V52C88 78 70 96 50 106C30 96 12 78 12 52V18Z';

/**
 * The mark as an SVG string (viewBox 100 × 112). `filled` draws a solid shield, for icons.
 * `simple` leaves out the inner lines and blades, for the 16 and 32 px icons where they would blur.
 */
export function markSvg(
  c: MarkColours = MARK_ON_LIGHT,
  { filled = false, simple = false, size, title }: { filled?: boolean; simple?: boolean; size?: number; title?: string } = {},
): string {
  const dims = size ? ` width="${f((size * 100) / 112)}" height="${size}"` : '';
  const label = title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true"';
  const parts = [
    filled
      ? `<path d="${SHIELD}" fill="${c.shield}" stroke="${c.shield}" stroke-width="6" stroke-linejoin="round"/>`
      : `<path d="${SHIELD}" fill="none" stroke="${c.shield}" stroke-width="8" stroke-linejoin="round"/>`,
  ];
  if (!simple) {
    parts.push(
      `<path d="M50 22L74 29.5V52C74 67 64 79 50 87" fill="none" stroke="${c.inner}" stroke-width="7" stroke-linejoin="round"/>`,
      `<path d="M26 46V29.5L40 25" fill="none" stroke="${c.hook}" stroke-width="7" stroke-linejoin="round"/>`,
    );
  }
  parts.push(
    `<circle cx="50" cy="57" r="${simple ? 19 : 16}" fill="none" stroke="${c.ring}" stroke-width="${simple ? 8 : 6}"/>`,
    `<circle cx="50" cy="57" r="${simple ? 11 : 10.5}" fill="${c.aperture}"/>`,
  );
  if (!simple) parts.push(`<path d="${blades(50, 57, 4, 7)}" stroke="${c.blades}" stroke-width="1.8" stroke-linecap="round"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 112"${dims}${label}>${parts.join('')}</svg>`;
}
