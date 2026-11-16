declare module 'virtual:evicap-verifier' {
  /** verify.html: the offline verifier as one self-contained page (tools/verifier-plugin.ts). */
  const html: string;
  export default html;
}

/** True only in `wxt build --mode e2e` (wxt.config.ts). */
declare const __EVICAP_E2E__: boolean;
