/**
 * A small streaming ZIP writer and reader for exports (SPEC F10). Entries are
 * stored uncompressed: evidence files are mostly compressed already, and a
 * stored ZIP can be checked file by file without unpacking. ZIP64 records are
 * added only when a size or offset needs them, so ordinary exports open in
 * every ZIP tool. No dependencies, so the offline verifier can bundle the reader.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX32 = 0xffffffff;
const enc = new TextEncoder();

class Bytes {
  private parts: number[] = [];
  u16(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: number) {
    this.u32(v % 2 ** 32);
    return this.u32(Math.floor(v / 2 ** 32));
  }
  raw(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

function dosDateTime(d: Date) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

interface Written {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  zip64: boolean;
}

export class ZipWriter {
  private offset = 0;
  private entries: Written[] = [];
  private names = new Set<string>();
  private readonly stamp: { time: number; date: number };

  constructor(
    private readonly sink: (chunk: Uint8Array) => Promise<void>,
    private readonly opts: { forceZip64?: boolean; date?: Date } = {},
  ) {
    this.stamp = dosDateTime(opts.date ?? new Date());
  }

  get bytesWritten() {
    return this.offset;
  }

  private async out(chunk: Uint8Array) {
    if (!chunk.length) return;
    await this.sink(chunk);
    this.offset += chunk.length;
  }

  /** Add one file. `onChunk` sees every byte, for hashing as it is written. */
  async add(path: string, source: Blob | Uint8Array, onChunk?: (chunk: Uint8Array) => void): Promise<{ bytes: number }> {
    if (!path || path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '')) throw new Error(`Bad ZIP path ${path}`);
    if (this.names.has(path)) throw new Error(`Duplicate ZIP path ${path}`);
    this.names.add(path);
    const name = enc.encode(path);
    const size = source instanceof Blob ? source.size : source.length;
    const zip64 = !!this.opts.forceZip64 || size >= MAX32;
    const offset = this.offset;
    const head = new Bytes()
      .u32(0x04034b50)
      .u16(zip64 ? 45 : 20)
      .u16(0x0808) // sizes in a data descriptor; UTF-8 names
      .u16(0)
      .u16(this.stamp.time)
      .u16(this.stamp.date)
      .u32(0)
      .u32(zip64 ? MAX32 : 0)
      .u32(zip64 ? MAX32 : 0)
      .u16(name.length)
      .u16(zip64 ? 20 : 0)
      .raw(name);
    if (zip64) head.u16(0x0001).u16(16).u64(0).u64(0);
    await this.out(head.done());

    let crc = 0;
    let written = 0;
    const take = async (chunk: Uint8Array) => {
      crc = crc32Update(crc, chunk);
      written += chunk.length;
      onChunk?.(chunk);
      await this.out(chunk);
    };
    if (source instanceof Blob) {
      const reader = source.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await take(value);
      }
    } else {
      await take(source);
    }
    if (written !== size) throw new Error(`${path} changed size while it was being exported`);

    const desc = new Bytes().u32(0x08074b50).u32(crc);
    if (zip64) desc.u64(size).u64(size);
    else desc.u32(size).u32(size);
    await this.out(desc.done());
    this.entries.push({ name, crc, size, offset, zip64 });
    return { bytes: size };
  }

  /** Write the central directory. Returns the total size of the ZIP. */
  async finish(): Promise<number> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const bigSize = e.zip64 || e.size >= MAX32;
      const bigOffset = !!this.opts.forceZip64 || e.offset >= MAX32;
      const extra = new Bytes();
      if (bigSize) extra.u64(e.size).u64(e.size);
      if (bigOffset) extra.u64(e.offset);
      const extraBody = extra.done();
      const cd = new Bytes()
        .u32(0x02014b50)
        .u16(45)
        .u16(bigSize || bigOffset ? 45 : 20)
        .u16(0x0808)
        .u16(0)
        .u16(this.stamp.time)
        .u16(this.stamp.date)
        .u32(e.crc)
        .u32(bigSize ? MAX32 : e.size)
        .u32(bigSize ? MAX32 : e.size)
        .u16(e.name.length)
        .u16(extraBody.length ? extraBody.length + 4 : 0)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(bigOffset ? MAX32 : e.offset)
        .raw(e.name);
      if (extraBody.length) cd.u16(0x0001).u16(extraBody.length).raw(extraBody);
      await this.out(cd.done());
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const need64 = !!this.opts.forceZip64 || count >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (need64) {
      const eocd64At = this.offset;
      await this.out(
        new Bytes().u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(cdSize).u64(cdStart).done(),
      );
      await this.out(new Bytes().u32(0x07064b50).u32(0).u64(eocd64At).u32(1).done());
    }
    await this.out(
      new Bytes()
        .u32(0x06054b50)
        .u16(0)
        .u16(0)
        .u16(need64 ? 0xffff : count)
        .u16(need64 ? 0xffff : count)
        .u32(need64 ? MAX32 : cdSize)
        .u32(need64 ? MAX32 : cdStart)
        .u16(0)
        .done(),
    );
    return this.offset;
  }
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  headerOffset: number;
}

async function slice(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

/** List a ZIP's entries from its central directory (reads only the end of the file). */
export async function readZipEntries(zip: Blob): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, zip.size - 65_557);
  const tail = await slice(zip, tailStart, zip.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end record)');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdStart = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === MAX32 || cdStart === MAX32) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('ZIP64 locator missing');
    const at = u64(tail, loc + 8);
    const rec = await slice(zip, at, at + 56);
    if (rec.getUint32(0, true) !== 0x06064b50) throw new Error('ZIP64 end record missing');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdStart = u64(rec, 48);
  }
  const cd = await slice(zip, cdStart, cdStart + cdSize);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged ZIP central directory');
    const method = cd.getUint16(p + 10, true);
    const crc = cd.getUint32(p + 16, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let headerOffset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        if (size === MAX32) (size = u64(cd, f)), (f += 8);
        if (compressedSize === MAX32) (compressedSize = u64(cd, f)), (f += 8);
        if (headerOffset === MAX32) headerOffset = u64(cd, f);
      }
      x += 4 + len;
    }
    out.push({ name, size, compressedSize, method, crc, headerOffset });
    p = xEnd + commentLen;
  }
  return out;
}

/** The stored bytes of one entry, as a Blob slice (no copying). */
export async function zipEntryBlob(zip: Blob, e: ZipEntry): Promise<Blob> {
  if (e.method !== 0) throw new Error(`${e.name} is compressed; only stored entries can be read`);
  const h = await slice(zip, e.headerOffset, e.headerOffset + 30);
  if (h.getUint32(0, true) !== 0x04034b50) throw new Error(`Damaged ZIP entry ${e.name}`);
  const start = e.headerOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  return zip.slice(start, start + e.compressedSize);
}
