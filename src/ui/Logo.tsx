import { MARK_ON_DARK, MARK_ON_LIGHT, markSvg } from '@/lib/brand';

/**
 * The EviCap mark and wordmark. `tone="auto"` follows the colour scheme; `tone="dark"` is for a
 * navy background such as the dashboard's top bar. The SVG is EviCap's own fixed drawing
 * (src/lib/brand.ts), never data from a page, so it is safe to insert as markup.
 */
export function Logo({ size = 26, tone = 'auto', wordmark = true }: { size?: number; tone?: 'auto' | 'dark'; wordmark?: boolean }) {
  return (
    <span className={`logo ${tone}`} style={{ fontSize: Math.round(size * 0.72) }}>
      <span className="on-light" dangerouslySetInnerHTML={{ __html: markSvg(MARK_ON_LIGHT, { size }) }} />
      <span className="on-dark" dangerouslySetInnerHTML={{ __html: markSvg(MARK_ON_DARK, { size }) }} />
      {wordmark && <span className="logo-word">EviCap</span>}
    </span>
  );
}
