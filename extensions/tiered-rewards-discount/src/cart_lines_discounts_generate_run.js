const DEFAULT_TIERS = [
  { minSubtotal: 15000, percentage: 20 },
  { minSubtotal: 7500, percentage: 16 },
  { minSubtotal: 3500, percentage: 10 },
  { minSubtotal: 1000, percentage: 6 },
];

const CANADA_TIERS = [
  { minSubtotal: 15000, percentage: 10 },
  { minSubtotal: 7500, percentage: 6 },
];

function isCanadaShopper(input) {
  return input?.cart?.buyerIdentity?.customer?.hasAnyTag === true;
}

function getConfiguredTiers(input) {
  if (isCanadaShopper(input)) {
    return CANADA_TIERS;
  }

  const fallbackTiers = DEFAULT_TIERS;
  const raw = input?.discount?.metafield?.value;
  if (!raw) return fallbackTiers;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.tiers) || parsed.tiers.length === 0) {
      return fallbackTiers;
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

    return tiers.length ? tiers : fallbackTiers;
  } catch {
    return fallbackTiers;
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

function getEligibleCartLineTargets(lines) {
  return lines
    .filter((line) => {
      const merchandise = line?.merchandise;
      if (merchandise?.__typename !== "ProductVariant") return false;
      return merchandise?.product?.inAnyCollection === true;
    })
    .map((line) => ({
      cartLine: {
        id: line.id,
      },
    }));
}

export function cartLinesDiscountsGenerateRun(input) {
  const discountClasses = input?.discount?.discountClasses || [];
  if (!discountClasses.includes("PRODUCT")) {
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
  const eligibleTargets = getEligibleCartLineTargets(input?.cart?.lines || []);

  if (eligibleTargets.length === 0) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message: `${rewardCode}: ${tier.percentage}% off eligible products on orders $${thresholdLabel}+`,
              targets: eligibleTargets,
              value: {
                percentage: {
                  value: tier.percentage,
                },
              },
            },
          ],
          selectionStrategy: "ALL",
        },
      },
    ],
  };
}
