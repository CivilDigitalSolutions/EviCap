/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Everything EviCap hashes or signs is serialised with this function, so the
 * same data always produces the same bytes on any machine.
 *
 * - Object keys are sorted by UTF-16 code units (JavaScript's default sort).
 * - Numbers use the ECMAScript shortest round-trip form, which is what RFC 8785
 *   specifies. Non-finite numbers are rejected.
 * - Strings use JSON.stringify escaping, which matches RFC 8785.
 * - `undefined` object members are omitted, as in JSON.stringify.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite number');
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
        return canonicalize((obj as { toJSON: () => unknown }).toJSON());
      }
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
    }
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
