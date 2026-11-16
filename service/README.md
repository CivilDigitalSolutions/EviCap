# EviCap licence service

A Cloudflare Worker that turns a paid Stripe subscription into an EviCap licence key (SPEC §9.2). It stores nothing.

| Route | What it does |
|---|---|
| `GET /success?session_id=…` | Where the Stripe Payment Links send the buyer after paying. Checks the Checkout Session and shows a signed licence key to paste into EviCap. |
| `POST /refresh` `{"key": "EVICAP1-…"}` | Called by the extension about once a day. Checks the subscription with Stripe and returns a renewed key, or `{"status": "ended"}`. |

Keys last until the end of the paid period plus 14 days, so a short outage here doesn't affect anyone.

## Deploy (once)

You need a Cloudflare account (the free plan is enough) and access to the Civil Digital Services Stripe account.

1. **Stripe restricted key.** In the Stripe Dashboard: Developers → API keys → *Create restricted key*. Name it `EviCap licence service`, and give **Read** access to *Checkout Sessions* and *Subscriptions* only. Copy the `rk_live_…` key.

2. **Deploy the Worker** from this folder:

   ```bash
   cd service
   npx wrangler login
   npx wrangler deploy
   ```

   Note the address it prints, such as `https://evicap-licence.<your-subdomain>.workers.dev`.

3. **Secrets:**

   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   ```

   Paste the `rk_live_…` key. Then:

   ```bash
   npx wrangler secret put SIGNING_KEY_JWK < ../tools/keys/service-signing-key.private.jwk
   ```

4. **Payment Links.** For both EviCap Pro Payment Links, set *After payment* → *Don't show confirmation page* → redirect to:

   ```
   https://evicap-licence.<your-subdomain>.workers.dev/success?session_id={CHECKOUT_SESSION_ID}
   ```

5. **Extension.** Set `serviceUrl` in `src/lib/billing-config.ts` to the Worker's address, then build and release.

## Check it

- Open the Worker's address: it should say "EviCap licence service".
- Buy a monthly subscription with a real card, check the key page appears, paste the key into EviCap, then refund and cancel it in the Stripe Dashboard. After cancelling, *Check now* in EviCap should report that the subscription has ended.

## Keys

`tools/keys/service-signing-key.private.jwk` is this service's signing key. Its public half is `SERVICE_KEY` in `src/lib/licence.ts`. Keep an offline backup. If it leaks, anyone can make subscription keys: make a new one with `node tools/issue-licence.ts init-service` (after moving the old file away), update `SERVICE_KEY`, release the extension, and replace the `SIGNING_KEY_JWK` secret.

## If a buyer loses their key

Find their payment in the Stripe Dashboard, copy the Checkout Session ID (`cs_live_…`), and send them `https://<service>/success?session_id=cs_live_…`.
