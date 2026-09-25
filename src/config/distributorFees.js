// Distributor pricing — the single source of truth for every amount the
// booking flow charges. All amounts are paise, inclusive of 18% GST.
//
// Two plans:
// - booking: ₹1,180 now to reserve the pincode (lead → 'paid'), then ₹5,900
//   later via the "Complete Payment for Existing PIN" flow (→ 'activated').
//   Total ₹7,080 (₹6,000 + ₹1,080 GST).
// - full: ₹6,490 once, KYC collected up front (→ 'activated' directly on
//   approval). ₹5,500 + ₹990 GST — ₹590 cheaper than the booking plan.
//
// `total` is snapshotted onto lead.totalDistributorFee when the plan is
// chosen, so a future price change never alters what an existing lead owes.
// A booking-plan lead can't switch to the full plan later (business rule).
export const DISTRIBUTOR_PLANS = {
  booking: {
    total: 708000,
    firstStage: 'booking',
    firstAmount: 118000,
  },
  full: {
    total: 649000,
    firstStage: 'full',
    firstAmount: 649000,
  },
};

export const isValidPlan = (plan) => Object.prototype.hasOwnProperty.call(DISTRIBUTOR_PLANS, plan);

// Leads created before plans existed have no `plan` field — they're all
// booking-plan leads.
export const planOf = (lead) => lead.plan || 'booking';

export const gstBreakdown = (totalPaise) => {
  const baseAmount = Math.round(totalPaise / 1.18);
  return { baseAmount, gstAmount: totalPaise - baseAmount, totalAmount: totalPaise };
};

// Public shape returned to the checkout so the frontend never hardcodes
// amounts that could drift from what the backend actually charges.
export const publicPlans = () => ({
  booking: {
    ...gstBreakdown(DISTRIBUTOR_PLANS.booking.firstAmount),
    total: DISTRIBUTOR_PLANS.booking.total,
    finalAmount: DISTRIBUTOR_PLANS.booking.total - DISTRIBUTOR_PLANS.booking.firstAmount,
  },
  full: {
    ...gstBreakdown(DISTRIBUTOR_PLANS.full.firstAmount),
    total: DISTRIBUTOR_PLANS.full.total,
  },
});
