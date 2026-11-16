import { describe, expect, it } from 'vitest';
import { createStreamingSha256, sha256, sha256Blob } from '../src/lib/hash';
import { canonicalize } from '../src/lib/jcs';

describe('RFC 8785 canonical JSON', () => {
  it('matches the RFC 8785 §3.2.2 example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3)', () => {
    const input = { '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '😀': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis' };
    // Read the keys from the output text: JSON.parse would reorder number-like keys.
    const out = canonicalize(input);
    const keys = [...out.matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`));
    expect(keys).toEqual(['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ']);
  });

  it('omits undefined members, normalises -0 and rejects non-finite numbers', () => {
    expect(canonicalize({ b: 1, a: undefined, c: -0 })).toBe('{"b":1,"c":0}');
    expect(() => canonicalize({ x: Infinity })).toThrow();
    expect(() => canonicalize({ x: NaN })).toThrow();
  });

  it('gives the same output regardless of key order', () => {
    expect(canonicalize({ a: 1, b: { d: 2, c: 3 } })).toBe(canonicalize({ b: { c: 3, d: 2 }, a: 1 }));
  });
});

describe('SHA-256 (NIST test vectors)', () => {
  const vectors: [string, string][] = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ];

  it.each(vectors)('hashes %j', async (input, hex) => {
    expect(await sha256(input)).toBe(`sha256:${hex}`);
  });

  it('streaming hash equals one-shot hash, for one million "a"', async () => {
    const h = await createStreamingSha256();
    const chunk = new TextEncoder().encode('a'.repeat(1000));
    for (let i = 0; i < 1000; i++) h.update(chunk);
    expect(h.digest()).toBe('sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    expect(h.bytes).toBe(1_000_000);
  });

  it('hashes a Blob by streaming', async () => {
    expect(await sha256Blob(new Blob(['abc']))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
