/**
 * MHTML helpers. Saving the same page twice gives different bytes, because
 * the browser writes a fresh date, multipart boundary and part identifiers
 * each time. For deduplication (SPEC F3) those are replaced with fixed
 * placeholders before hashing; the stored file is never changed.
 */
export function normalizeMhtml(text: string): string {
  let out = text;
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(out)?.[1];
  if (boundary) out = out.split(boundary).join('BOUNDARY');
  // Drop the top-level header block (From, Snapshot-Content-Location, Subject, Date, ...).
  const firstPart = out.indexOf('--BOUNDARY');
  if (firstPart > 0) out = out.slice(firstPart);
  // Per-save identifiers such as <frame-0A1B...@mhtml.blink> and cid:css-1234-...@mhtml.blink.
  out = out.replace(/[a-z]+-[0-9a-f-]{8,}@mhtml\.blink/gi, 'part@mhtml.blink');
  return out;
}
