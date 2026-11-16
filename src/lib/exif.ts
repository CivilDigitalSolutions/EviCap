/**
 * Read-only EXIF reader (SPEC F6 step 3). It parses a copy of the metadata for
 * display; the original image bytes are never changed. Supports JPEG (APP1),
 * PNG (eXIf chunk) and WebP (EXIF chunk), and flags XMP and IPTC blocks.
 */

export interface ExifResult {
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'other';
  tags: Record<string, string | number>;
  gps: { latitude: number; longitude: number; altitude?: number } | null;
  hasXmp: boolean;
  hasIptc: boolean;
}

const IFD0: Record<number, string> = {
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x011a: 'XResolution',
  0x011b: 'YResolution',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
};
const EXIF_IFD: Record<number, string> = {
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISO',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9010: 'OffsetTime',
  0x9011: 'OffsetTimeOriginal',
  0x920a: 'FocalLength',
  0xa002: 'PixelXDimension',
  0xa003: 'PixelYDimension',
  0xa420: 'ImageUniqueID',
  0xa430: 'CameraOwnerName',
  0xa431: 'BodySerialNumber',
  0xa433: 'LensMake',
  0xa434: 'LensModel',
};
const GPS_IFD: Record<number, string> = {
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude',
  0x0007: 'GPSTimeStamp',
  0x001d: 'GPSDateStamp',
};
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

type Value = string | number | number[];

function readTiff(view: DataView, start: number, length: number) {
  const end = Math.min(view.byteLength, start + length);
  const order = view.getUint16(start);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) return null;
  const u16 = (o: number) => view.getUint16(start + o, le);
  const u32 = (o: number) => view.getUint32(start + o, le);
  const i32 = (o: number) => view.getInt32(start + o, le);
  if (u16(2) !== 42) return null;

  const value = (type: number, count: number, offset: number): Value | null => {
    const size = (TYPE_SIZE[type] ?? 0) * count;
    if (!size) return null;
    const at = size <= 4 ? offset : u32(offset);
    if (start + at + size > end) return null;
    if (type === 2) {
      let s = '';
      for (let i = 0; i < count; i++) {
        const c = view.getUint8(start + at + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    const out: number[] = [];
    for (let i = 0; i < Math.min(count, 64); i++) {
      const o = at + i * (TYPE_SIZE[type] ?? 1);
      if (type === 1 || type === 7) out.push(view.getUint8(start + o));
      else if (type === 3) out.push(u16(o));
      else if (type === 4) out.push(u32(o));
      else if (type === 9) out.push(i32(o));
      else if (type === 5) out.push(u32(o + 4) ? u32(o) / u32(o + 4) : 0);
      else if (type === 10) out.push(i32(o + 4) ? i32(o) / i32(o + 4) : 0);
    }
    if (type === 7) return out.length > 16 ? `(${count} bytes)` : out.join(' ');
    return out.length === 1 ? out[0]! : out;
  };

  const readIfd = (offset: number, names: Record<number, string>, into: Record<string, Value>) => {
    if (offset < 8 || start + offset + 2 > end) return {} as Record<number, number>;
    const n = u16(offset);
    const pointers: Record<number, number> = {};
    for (let i = 0; i < n && i < 500; i++) {
      const e = offset + 2 + i * 12;
      if (start + e + 12 > end) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (tag === 0x8769 || tag === 0x8825) {
        pointers[tag] = u32(e + 8);
        continue;
      }
      const name = names[tag];
      if (!name) continue;
      const v = value(type, count, e + 8);
      if (v !== null && v !== '') into[name] = v;
    }
    return pointers;
  };

  const raw: Record<string, Value> = {};
  const ptr = readIfd(u32(4), IFD0, raw);
  if (ptr[0x8769]) readIfd(ptr[0x8769], EXIF_IFD, raw);
  const gpsRaw: Record<string, Value> = {};
  if (ptr[0x8825]) readIfd(ptr[0x8825], GPS_IFD, gpsRaw);
  return { raw, gpsRaw };
}

function dms(v: Value | undefined): number | null {
  if (!Array.isArray(v) || v.length < 3) return typeof v === 'number' ? v : null;
  return v[0]! + v[1]! / 60 + v[2]! / 3600;
}

export function readExif(bytes: Uint8Array): ExifResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: ExifResult = { format: 'other', tags: {}, gps: null, hasXmp: false, hasIptc: false };
  const tiffs: { start: number; length: number }[] = [];
  const ascii = (o: number, n: number) =>
    o + n <= bytes.length ? String.fromCharCode(...bytes.subarray(o, o + n)) : '';

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    result.format = 'jpeg';
    let o = 2;
    while (o + 4 <= bytes.length && bytes[o] === 0xff) {
      const marker = bytes[o + 1]!;
      if (marker === 0xda || marker === 0xd9) break; // start of scan / end
      const len = view.getUint16(o + 2);
      if (marker === 0xe1) {
        if (ascii(o + 4, 6) === 'Exif\0\0') tiffs.push({ start: o + 10, length: len - 8 });
        else if (ascii(o + 4, 28).startsWith('http://ns.adobe.com/xap/1.0/')) result.hasXmp = true;
      }
      if (marker === 0xed && ascii(o + 4, 13) === 'Photoshop 3.0') result.hasIptc = true;
      o += 2 + len;
    }
  } else if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') {
    result.format = 'png';
    let o = 8;
    while (o + 12 <= bytes.length) {
      const len = view.getUint32(o);
      const type = ascii(o + 4, 4);
      if (type === 'eXIf') tiffs.push({ start: o + 8, length: len });
      if (type === 'iTXt' && ascii(o + 8, 17) === 'XML:com.adobe.xmp') result.hasXmp = true;
      if (type === 'IEND') break;
      o += 12 + len;
    }
  } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    result.format = 'webp';
    let o = 12;
    while (o + 8 <= bytes.length) {
      const type = ascii(o, 4);
      const len = view.getUint32(o + 4, true);
      if (type === 'EXIF') {
        const skip = ascii(o + 8, 6) === 'Exif\0\0' ? 6 : 0;
        tiffs.push({ start: o + 8 + skip, length: len - skip });
      }
      if (type === 'XMP ') result.hasXmp = true;
      o += 8 + len + (len % 2);
    }
  } else if (ascii(0, 3) === 'GIF') {
    result.format = 'gif';
  }

  for (const t of tiffs) {
    try {
      const parsed = readTiff(view, t.start, t.length);
      if (!parsed) continue;
      for (const [k, v] of Object.entries(parsed.raw)) {
        result.tags[k] = Array.isArray(v) ? v.map((n) => +n.toFixed(6)).join(', ') : v;
      }
      const lat = dms(parsed.gpsRaw.GPSLatitude);
      const lon = dms(parsed.gpsRaw.GPSLongitude);
      if (lat !== null && lon !== null) {
        const south = parsed.gpsRaw.GPSLatitudeRef === 'S';
        const west = parsed.gpsRaw.GPSLongitudeRef === 'W';
        const alt = typeof parsed.gpsRaw.GPSAltitude === 'number' ? parsed.gpsRaw.GPSAltitude : undefined;
        result.gps = {
          latitude: +(south ? -lat : lat).toFixed(7),
          longitude: +(west ? -lon : lon).toFixed(7),
          ...(alt !== undefined ? { altitude: +alt.toFixed(2) } : {}),
        };
      }
    } catch {
      /* malformed EXIF: show what we have */
    }
  }
  return result;
}
