import 'fake-indexeddb/auto';

// Minimal chrome.* stub for unit tests of library code.
function area() {
  let data: Record<string, unknown> = {};
  return {
    async get(key?: string | string[]) {
      if (key === undefined) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items: Record<string, unknown>) {
      data = { ...data, ...structuredClone(items) };
    },
    async clear() {
      data = {};
    },
  };
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area(), session: area(), onChanged: { addListener() {} } },
  runtime: {
    getManifest: () => ({ version: '0.0.0-test' }),
    sendMessage: async () => undefined,
  },
};
