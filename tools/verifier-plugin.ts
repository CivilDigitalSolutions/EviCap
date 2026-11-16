import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rolldown } from 'rolldown';
import type { Plugin } from 'vite';

/**
 * Builds the offline verifier (src/verifier) into one self-contained HTML
 * string and exposes it to the extension as `virtual:evicap-verifier`. Every
 * export writes that string to verify.html (SPEC F11).
 */
export async function buildVerifierHtml(root = process.cwd()): Promise<{ html: string; files: string[] }> {
  const bundle = await rolldown({ input: resolve(root, 'src/verifier/standalone.ts'), platform: 'browser', logLevel: 'warn' });
  try {
    const { output } = await bundle.generate({ format: 'iife', minify: true });
    const chunk = output[0];
    const code = chunk.code.replace(/<\/script/gi, '<\\/script');
    const template = readFileSync(resolve(root, 'src/verifier/template.html'), 'utf8');
    if (!template.includes('/*VERIFIER*/')) throw new Error('verifier template has no /*VERIFIER*/ marker');
    return {
      html: template.replace('/*VERIFIER*/', () => code),
      files: [...Object.keys(chunk.modules), resolve(root, 'src/verifier/template.html')],
    };
  } finally {
    await bundle.close();
  }
}

export function verifierPlugin(): Plugin {
  const id = 'virtual:evicap-verifier';
  const resolved = `\0${id}`;
  return {
    name: 'evicap-verifier',
    resolveId(source) {
      return source === id ? resolved : undefined;
    },
    async load(loadId) {
      if (loadId !== resolved) return undefined;
      const { html, files } = await buildVerifierHtml();
      for (const f of files) if (!f.startsWith('\0')) this.addWatchFile(f);
      return `export default ${JSON.stringify(html)};`;
    },
  };
}
