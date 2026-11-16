/**
 * Civil Digital's Lemon Squeezy store (SPEC §9). Fill these in from the Lemon
 * Squeezy dashboard once the store and the EviCap Pro product exist:
 *
 * - storeId: Settings → Stores, the store's ID number
 * - productId: Products → EviCap Pro, the ID number in its page address
 * - checkoutMonthly / checkoutYearly: each variant's "Share" link
 *   (https://<store>.lemonsqueezy.com/buy/<variant-uuid>)
 * - customerPortal: the store's customer portal ("My Orders") address
 *
 * While storeId or productId is null, online purchase is switched off:
 * Settings → Plan offers invoice licences only, and Lemon Squeezy keys are
 * refused without any network request.
 */
export interface LemonConfig {
  storeId: number | null;
  productId: number | null;
  checkoutMonthly: string | null;
  checkoutYearly: string | null;
  customerPortal: string | null;
  apiBase: string;
}

const PRODUCTION: LemonConfig = {
  storeId: null,
  productId: null,
  checkoutMonthly: null,
  checkoutYearly: null,
  customerPortal: 'https://app.lemonsqueezy.com/my-orders',
  apiBase: 'https://api.lemonsqueezy.com/v1/licenses',
};

/** Test builds (`wxt build --mode e2e`) use a fake store served by the e2e tests. */
const E2E: LemonConfig = {
  storeId: 999,
  productId: 4242,
  checkoutMonthly: 'https://example.test/buy/monthly',
  checkoutYearly: 'https://example.test/buy/yearly',
  customerPortal: 'https://example.test/my-orders',
  apiBase: 'http://127.0.0.1:0/v1/licenses', // replaced by the test through chrome.storage.local "e2eLemonApi"
};

export const LEMON: LemonConfig = __EVICAP_E2E__ ? E2E : PRODUCTION;

export function onlinePurchaseReady(c: LemonConfig = LEMON): boolean {
  return c.storeId !== null && c.productId !== null;
}
