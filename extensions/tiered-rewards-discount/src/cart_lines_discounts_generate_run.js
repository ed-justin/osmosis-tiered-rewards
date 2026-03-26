const DEFAULT_TIERS = [
  { minSubtotal: 15000, percentage: 20 },
  { minSubtotal: 7500, percentage: 16 },
  { minSubtotal: 3500, percentage: 10 },
  { minSubtotal: 1000, percentage: 6 },
];

function getConfiguredTiers(input) {
  const raw = input?.discount?.metafield?.value;
  if (!raw) return DEFAULT_TIERS;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.tiers) || parsed.tiers.length === 0) {
      return DEFAULT_TIERS;
    }

    const tiers = parsed.tiers
      .filter(
        (tier) =>
          typeof tier?.minSubtotal === "number" &&
          Number.isFinite(tier.minSubtotal) &&
          tier.minSubtotal > 0 &&
          typeof tier?.percentage === "number" &&
          Number.isFinite(tier.percentage) &&
          tier.percentage > 0 &&
          tier.percentage <= 100,
      )
      .map((tier) => ({
        minSubtotal: tier.minSubtotal,
        percentage: tier.percentage,
      }))
      .sort((a, b) => b.minSubtotal - a.minSubtotal);

    return tiers.length ? tiers : DEFAULT_TIERS;
  } catch {
    return DEFAULT_TIERS;
  }
}

function findMatchingTier(subtotal, tiers) {
  return tiers.find((tier) => subtotal >= tier.minSubtotal);
}

function getRewardCode(tier, tiers) {
  const ascendingTiers = [...tiers].sort((a, b) => a.minSubtotal - b.minSubtotal);
  const index = ascendingTiers.findIndex(
    (candidate) =>
      candidate.minSubtotal === tier.minSubtotal &&
      candidate.percentage === tier.percentage,
  );

  return `REWARDS${index + 1}`;
}

export function cartLinesDiscountsGenerateRun(input) {
  const discountClasses = input?.discount?.discountClasses || [];
  if (!discountClasses.includes("ORDER")) {
    return { operations: [] };
  }

  const subtotal = Number(input?.cart?.cost?.subtotalAmount?.amount || 0);
  if (!Number.isFinite(subtotal) || subtotal <= 0) {
    return { operations: [] };
  }

  const tiers = getConfiguredTiers(input);
  const tier = findMatchingTier(subtotal, tiers);
  if (!tier) {
    return { operations: [] };
  }

  const thresholdLabel = Math.round(tier.minSubtotal).toLocaleString("en-US");
  const rewardCode = getRewardCode(tier, tiers);

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: `${rewardCode}: ${tier.percentage}% off orders $${thresholdLabel}+`,
              targets: [
                {
                  orderSubtotal: {
                    excludedCartLineIds: [],
                  },
                },
              ],
              value: {
                percentage: {
                  value: tier.percentage,
                },
              },
            },
          ],
          selectionStrategy: "FIRST",
        },
      },
    ],
  };
}
