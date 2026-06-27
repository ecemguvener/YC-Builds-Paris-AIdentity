/**
 * Pure decision function — no I/O, fully unit-testable.
 *
 * Returns one of:
 *   { status: "approved",          reason }
 *   { status: "requires_approval", reason }
 *   { status: "rejected",          reason }
 *
 * Order matters: hard rejections first, then escalations, then auto-approve.
 *
 * @param {{merchant_name:string, amount:number, category?:string, recurring?:boolean}} request
 * @param {object|null} policy
 * @param {number} spendingToday   successful spend so far today
 * @param {number} spendingMonth   successful spend so far this month
 */
export function evaluatePurchaseRequest(request, policy, spendingToday, spendingMonth) {
  if (!policy) {
    return { status: 'requires_approval', reason: 'No payment policy configured' };
  }

  if (typeof request.amount !== 'number' || Number.isNaN(request.amount) || request.amount <= 0) {
    return { status: 'rejected', reason: 'Invalid amount' };
  }

  if (request.amount > policy.max_transaction_amount) {
    return { status: 'rejected', reason: 'Above max transaction amount' };
  }

  if (spendingToday + request.amount > policy.daily_limit) {
    return { status: 'rejected', reason: 'Above daily spending limit' };
  }

  if (spendingMonth + request.amount > policy.monthly_limit) {
    return { status: 'rejected', reason: 'Above monthly spending limit' };
  }

  if (policy.blocked_merchants.includes(request.merchant_name)) {
    return { status: 'rejected', reason: 'Merchant is blocked' };
  }

  if (request.category && policy.blocked_categories.includes(request.category)) {
    return { status: 'rejected', reason: 'Category is blocked' };
  }

  if (request.recurring && !policy.allow_recurring) {
    return { status: 'rejected', reason: 'Recurring payments are not allowed' };
  }

  if (
    policy.allowed_merchants.length > 0 &&
    !policy.allowed_merchants.includes(request.merchant_name)
  ) {
    return { status: 'requires_approval', reason: 'Merchant not on allowed list' };
  }

  if (request.amount > policy.approval_required_above) {
    return { status: 'requires_approval', reason: 'Amount requires human approval' };
  }

  return { status: 'approved', reason: 'Auto-approved by policy' };
}
