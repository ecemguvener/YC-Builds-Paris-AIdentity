import { MockPaymentProvider } from './mockProvider.js';
import { StripeIssuingProvider } from './stripeProvider.js';

const cache = new Map();

/**
 * Resolve a payment provider by name. Defaults to the configured
 * PAYMENT_PROVIDER, or "mock". Providers are cached per process.
 */
export function getProvider(name = process.env.PAYMENT_PROVIDER || 'mock') {
  if (cache.has(name)) return cache.get(name);
  let provider;
  switch (name) {
    case 'stripe':
      provider = new StripeIssuingProvider();
      break;
    case 'mock':
    default:
      provider = new MockPaymentProvider();
      break;
  }
  cache.set(name, provider);
  return provider;
}
