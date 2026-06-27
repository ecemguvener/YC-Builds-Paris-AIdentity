/**
 * Stripe Issuing adapter — test-mode placeholder for "later".
 *
 * Intentionally NOT wired to the network in the MVP. It reads secrets from the
 * environment (never hard-coded) and throws a clear error if selected without
 * configuration, so we fail loud rather than silently fall back.
 *
 * To finish this adapter:
 *   1. `npm i stripe`
 *   2. `const stripe = new Stripe(process.env.STRIPE_API_KEY)`
 *   3. createCard -> stripe.issuing.cards.create({ cardholder, currency, type: 'virtual' })
 *   4. charge     -> use a test authorization / PaymentIntent against the card.
 * The agent still only ever sees last4 — the card object never leaves the server.
 */
export class StripeIssuingProvider {
  constructor() {
    this.apiKey = process.env.STRIPE_API_KEY;
    this.cardholderId = process.env.STRIPE_ISSUING_CARDHOLDER_ID;
    if (!this.apiKey) {
      throw new Error(
        'STRIPE_API_KEY is not set. Set it in .env or use PAYMENT_PROVIDER=mock for the MVP.',
      );
    }
  }

  get name() {
    return 'stripe';
  }

  async createCard() {
    throw new Error('Stripe Issuing adapter not implemented yet — use PAYMENT_PROVIDER=mock.');
  }

  async charge() {
    throw new Error('Stripe Issuing adapter not implemented yet — use PAYMENT_PROVIDER=mock.');
  }
}
