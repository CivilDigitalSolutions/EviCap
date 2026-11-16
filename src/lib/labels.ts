import type { CaptureRecord } from './types';

/** A short human name for a capture, e.g. "full page" or "tab recording". */
export function captureLabel(c: Pick<CaptureRecord, 'type' | 'method' | 'meta'>): string {
  if (c.type === 'screenshot') {
    const mode = String(c.meta.mode ?? 'screenshot');
    const names: Record<string, string> = {
      context: 'in-context screenshot',
      full: 'full-page screenshot',
      visible: 'screenshot of visible area',
      region: 'screenshot of a region',
      element: 'screenshot of an element',
    };
    return names[mode] ?? 'screenshot';
  }
  if (c.type === 'video') return c.method.startsWith('tabCapture') ? 'tab recording' : String(c.meta.kind ?? 'video');
  if (c.type === 'image') return c.meta.kind === 'background' ? 'background image' : 'image';
  if (c.type === 'auto') return 'automatic page capture';
  if (c.type === 'forensic') return 'forensic page capture';
  return c.type;
}
