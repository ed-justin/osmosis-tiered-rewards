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

// Temporary marketing promotion. When enabled via the `bfPromo.enabled` flag in
// the discount config metafield, these tables fully REPLACE the normal reward
// tiers (a clean override). Every band is >= the normal reward, so nobody is
// downgraded. The `code` is surfaced in the discount line label for reporting.
const BF_PROMO_TIERS = [
  { minSubtotal: 5000, percentage: 25, code: "BF25" },
  { minSubtotal: 2000, percentage: 20, code: "BF20" },
  { minSubtotal: 1000, percentage: 10, code: "BF10" },
];

const BF_PROMO_CANADA_TIERS = [
  { minSubtotal: 5000, percentage: 15, code: "BF15-CAN" },
  { minSubtotal: 2000, percentage: 10, code: "BF10-CAN" },
];

function isBfPromoActive(input) {
  const raw = input?.discount?.metafield?.value;
  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw);
    return parsed?.bfPromo?.enabled === true;
  } catch {
    return false;
  }
}

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

function getEligibleCartLineTargets(lines, excludeVariantId) {
  return lines
    .filter((line) => {
      const merchandise = line?.merchandise;
      if (merchandise?.__typename !== "ProductVariant") return false;
      if (excludeVariantId && merchandise.id === excludeVariantId) return false;
      return merchandise?.product?.inAnyCollection === true;
    })
    .map((line) => ({
      cartLine: {
        id: line.id,
      },
    }));
}

function parseGwpConfig(input) {
  const raw = input?.discount?.metafield?.value;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const gwp = parsed?.gwp;
    if (!gwp || gwp.enabled !== true) return null;

    const minSubtotalUsd = Number(gwp.minSubtotalUsd);
    const giftVariantId =
      typeof gwp.giftVariantId === "string" && gwp.giftVariantId.length > 0
        ? gwp.giftVariantId
        : null;

    if (!Number.isFinite(minSubtotalUsd) || minSubtotalUsd <= 0) return null;
    if (!giftVariantId) return null;

    return { minSubtotalUsd, giftVariantId };
  } catch {
    return null;
  }
}

function findGwpLine(lines, giftVariantId) {
  return lines.find(
    (line) =>
      line?.merchandise?.__typename === "ProductVariant" &&
      line.merchandise.id === giftVariantId,
  );
}

export function cartLinesDiscountsGenerateRun(input) {
  const discountClasses = input?.discount?.discountClasses || [];
  if (!discountClasses.includes("PRODUCT")) {
    return { operations: [] };
  }

  const enteredCodes = input?.enteredDiscountCodes || [];
  if (enteredCodes.length > 0) {
    return { operations: [] };
  }

  const presentmentSubtotal = Number(input?.cart?.cost?.subtotalAmount?.amount || 0);
  if (!Number.isFinite(presentmentSubtotal) || presentmentSubtotal <= 0) {
    return { operations: [] };
  }

  // Tier thresholds are defined in the shop's default currency (USD), but
  // cart.cost.subtotalAmount.amount is in the buyer's presentment currency.
  // Convert back to shop currency using Shopify Markets' configured rate so
  // GBP/CAD/EUR shoppers are evaluated against the same USD thresholds.
  const rate = Number(input?.presentmentCurrencyRate);
  const conversionRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const subtotal = presentmentSubtotal / conversionRate;

  const lines = input?.cart?.lines || [];
  const operations = [];

  // GWP: if enabled and the configured gift variant is in the cart at the
  // configured USD threshold, discount that line to 100%. Resolved first so
  // the gift line can be excluded from tier targets (avoids stacking a tier %
  // discount on top of a 100% off, which would otherwise produce a confusing
  // discount breakdown).
  const gwpConfig = parseGwpConfig(input);
  const gwpLine =
    gwpConfig && subtotal >= gwpConfig.minSubtotalUsd
      ? findGwpLine(lines, gwpConfig.giftVariantId)
      : null;

  if (gwpLine) {
    const gwpThresholdLabel = Math.round(gwpConfig.minSubtotalUsd).toLocaleString("en-US");
    operations.push({
      productDiscountsAdd: {
        candidates: [
          {
            message: `Free gift on orders $${gwpThresholdLabel}+`,
            targets: [{ cartLine: { id: gwpLine.id } }],
            value: {
              percentage: { value: 100 },
            },
          },
        ],
        selectionStrategy: "ALL",
      },
    });
  }

  // When the BF promo is toggled on, its tables fully replace the normal reward
  // tiers (Canada shoppers still get their own table). Otherwise fall back to
  // the configured/default reward tiers.
  const bfActive = isBfPromoActive(input);
  const tiers = bfActive
    ? isCanadaShopper(input)
      ? BF_PROMO_CANADA_TIERS
      : BF_PROMO_TIERS
    : getConfiguredTiers(input);
  const tier = findMatchingTier(subtotal, tiers);
  if (tier) {
    const thresholdLabel = Math.round(tier.minSubtotal).toLocaleString("en-US");
    const rewardCode = bfActive ? tier.code : getRewardCode(tier, tiers);
    const eligibleTargets = getEligibleCartLineTargets(
      lines,
      gwpLine ? gwpConfig.giftVariantId : null,
    );

    if (eligibleTargets.length > 0) {
      operations.push({
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
      });
    }
  }

  return { operations };
}
