/**
 * Tool manifest exposed to the AI Agent Hub.
 *
 * The agent can ONLY call these tools. It has no access to card details, the
 * provider, or the database — it requests a purchase and (if approved) executes
 * it. Every other decision is made server-side by the payment module.
 */
export const toolManifest = [
  {
    name: 'payments.requestPurchase',
    description:
      'Request permission for an AI agent to buy something using its payment identity.',
    endpoint: { method: 'POST', path: '/tools/payments/request-purchase' },
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        merchant_name: { type: 'string' },
        merchant_url: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        purpose: { type: 'string' },
      },
      required: ['agent_id', 'merchant_name', 'amount', 'currency', 'purpose'],
    },
  },
  {
    name: 'payments.requestPurchaseFromText',
    description:
      "Request a purchase from a natural-language instruction (e.g. 'Buy £15 of OpenAI credits'). The text is parsed into a structured request and evaluated by the same policy engine.",
    endpoint: { method: 'POST', path: '/tools/payments/request-purchase-from-text' },
    input_schema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['agent_id', 'prompt'],
    },
  },
  {
    name: 'payments.executePurchase',
    description: 'Execute an already approved purchase request.',
    endpoint: { method: 'POST', path: '/tools/payments/:requestId/execute' },
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
      },
      required: ['request_id'],
    },
  },
];
