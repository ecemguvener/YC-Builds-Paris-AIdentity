import { randomBytes } from 'node:crypto';

/**
 * Fake payment provider for the MVP / demo.
 *
 * The agent NEVER sees anything in here — card ids and last4 stay server-side.
 * `charge()` always succeeds (deterministic happy path), which keeps the demo
 * predictable. To exercise the "declined"/"failed" branches, see the optional
 * merchant-name conventions below.
 */
export class MockPaymentProvider {
  get name() {
    return 'mock';
  }

  async createCard(agentId) {
    return {
      provider_card_id: `mock_card_${agentId}`,
      // In a real provider this comes back from card issuance; never the full PAN.
      card_last4: '4242',
    };
  }

  async charge({ merchantName, amount, currency }) {
    const txnId = `mock_txn_${randomBytes(6).toString('hex')}`;

    // Demo hooks: let a test force non-happy paths via the merchant name.
    if (/_DECLINE$/i.test(merchantName)) {
      return {
        provider_transaction_id: txnId,
        status: 'declined',
        reason: `Mock decline for ${merchantName}`,
      };
    }
    if (/_FAIL$/i.test(merchantName)) {
      return {
        provider_transaction_id: txnId,
        status: 'failed',
        reason: `Mock provider error for ${merchantName}`,
      };
    }

    return {
      provider_transaction_id: txnId,
      status: 'successful',
      reason: `Mock payment successful to ${merchantName} for ${amount} ${currency}`,
    };
  }
}
