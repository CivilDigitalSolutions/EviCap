/**
 * Card subscriptions (SPEC §9.2): Stripe Managed Payments, with Civil
 * Digital's licence service (service/) turning a paid subscription into an
 * EviCap licence key.
 *
 * - checkoutMonthly / checkoutYearly: the Stripe Payment Links
 * - serviceUrl: where the licence service is deployed (Cloudflare Worker).
 *   While it is null, online purchase is switched off: Settings → Plan offers
 *   invoice licences only, and subscription keys are not renewed online.
 * - customerPortal: where buyers manage or cancel (Stripe's Onelink).
 */
export interface BillingConfig {
  checkoutMonthly: string | null;
  checkoutYearly: string | null;
  serviceUrl: string | null;
  customerPortal: string | null;
}

const PRODUCTION: BillingConfig = {
  checkoutMonthly: 'https://buy.stripe.com/cNi7sNfpn8qd0KG3csbZe00',
  checkoutYearly: 'https://buy.stripe.com/00w14p7WV5e1fFAaEUbZe01',
  serviceUrl: null,
  customerPortal: 'https://app.link.com',
};

/** Test builds (`wxt build --mode e2e`) use a fake service started by the e2e tests. */
const E2E: BillingConfig = {
  checkoutMonthly: 'https://example.test/buy/monthly',
  checkoutYearly: 'https://example.test/buy/yearly',
  serviceUrl: 'http://127.0.0.1:0', // replaced by the test through chrome.storage.local "e2eLicenceService"
  customerPortal: 'https://example.test/my-orders',
};

export const BILLING: BillingConfig = __EVICAP_E2E__ ? E2E : PRODUCTION;

export function onlinePurchaseReady(c: BillingConfig = BILLING): boolean {
  return !!c.serviceUrl && !!(c.checkoutMonthly || c.checkoutYearly);
}
