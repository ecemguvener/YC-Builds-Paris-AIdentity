import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import {
  createPurchaseRequest,
  evaluatePurchaseRequest,
  executeApprovedPurchase,
  provisionPaymentIdentity
} from "./payments.js";

const basePolicy = {
  agentId: "agent_test",
  maxTransactionAmount: 50,
  dailyLimit: 100,
  monthlyLimit: 500,
  approvalRequiredAbove: 25,
  allowedMerchants: [] as string[],
  blockedMerchants: ["CryptoExchange"],
  blockedCategories: ["gambling", "crypto"],
  allowRecurring: false,
  createdAt: new Date(),
  updatedAt: new Date()
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluatePurchaseRequest", () => {
  it("auto-approves a small purchase within all limits", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 15 }, basePolicy, 0, 0);
    expect(decision.status).toBe("approved");
  });

  it("requires approval above the approval threshold", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "Amazon", amount: 40 }, basePolicy, 0, 0);
    expect(decision.status).toBe("requires_approval");
    expect(decision.reason).toBe("Amount requires human approval");
  });

  it("rejects a blocked merchant", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "CryptoExchange", amount: 10 }, basePolicy, 0, 0);
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toBe("Merchant is blocked");
  });

  it("rejects amounts above the per-transaction maximum", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "Amazon", amount: 75 }, basePolicy, 0, 0);
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toBe("Above max transaction amount");
  });

  it("rejects when the daily limit would be exceeded", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "Amazon", amount: 20 }, basePolicy, 90, 90);
    expect(decision.status).toBe("rejected");
    expect(decision.reason).toBe("Above daily spending limit");
  });

  it("requires approval when the merchant is not on a non-empty allow list", () => {
    const decision = evaluatePurchaseRequest(
      { merchantName: "Amazon", amount: 5 },
      { ...basePolicy, allowedMerchants: ["OpenAI"] },
      0,
      0
    );
    expect(decision.status).toBe("requires_approval");
    expect(decision.reason).toBe("Merchant not on allowed list");
  });

  it("requires approval when no policy is configured", () => {
    const decision = evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 5 }, null, 0, 0);
    expect(decision.status).toBe("requires_approval");
    expect(decision.reason).toBe("No payment policy configured");
  });

  it("rejects blocked categories and disallowed recurring payments", () => {
    expect(
      evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 5, category: "crypto" }, basePolicy, 0, 0).status
    ).toBe("rejected");
    expect(
      evaluatePurchaseRequest({ merchantName: "OpenAI", amount: 5, recurring: true }, basePolicy, 0, 0).status
    ).toBe("rejected");
  });
});

describe("executeApprovedPurchase", () => {
  it("creates mock payment links by default", async () => {
    const accountId = `acct_mock_${Date.now()}`;
    const identity = provisionPaymentIdentity(accountId);
    const purchase = createPurchaseRequest(accountId, {
      merchantName: "OpenAI",
      amount: 5,
      currency: "GBP",
      purpose: "Buy API credits"
    });

    const transaction = await executeApprovedPurchase(accountId, purchase.id);

    expect(identity.provider).toBe("mock");
    expect(transaction.provider).toBe("mock");
    expect(transaction.status).toBe("payment_link_created");
    expect(transaction.providerTransactionId).toMatch(/^mock_txn_/);
    expect(transaction.paymentUrl).toContain("https://pay.stripe.com/test/mock_");
  });

  it("fails loudly when Stripe is selected without a secret key", async () => {
    const accountId = `acct_stripe_missing_${Date.now()}`;
    const config = {
      PAYMENT_PROVIDER: "stripe"
    } as AppConfig;
    const identity = provisionPaymentIdentity(accountId, config);
    const purchase = createPurchaseRequest(accountId, {
      merchantName: "OpenAI",
      amount: 5,
      currency: "GBP",
      purpose: "Buy API credits"
    });
    await expect(executeApprovedPurchase(accountId, purchase.id, config)).rejects.toThrow("Stripe is not configured");
    expect(identity.provider).toBe("stripe");
  });

  it("creates Stripe Checkout payment links when Stripe is configured", async () => {
    const accountId = `acct_stripe_link_${Date.now()}`;
    const config = {
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_link",
      PUBLIC_APP_URL: "https://dashboard.example.com"
    } as AppConfig;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    provisionPaymentIdentity(accountId, config);
    const purchase = createPurchaseRequest(accountId, {
      merchantName: "OpenAI",
      amount: 5,
      currency: "GBP",
      purpose: "Buy API credits"
    });

    const transaction = await executeApprovedPurchase(accountId, purchase.id, config, "test-idempotency-key");

    expect(fetchMock).toHaveBeenCalledWith("https://api.stripe.com/v1/checkout/sessions", expect.objectContaining({ method: "POST" }));
    expect(transaction.provider).toBe("stripe");
    expect(transaction.providerTransactionId).toBe("cs_test_123");
    expect(transaction.status).toBe("payment_link_created");
    expect(transaction.paymentUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
  });
});
