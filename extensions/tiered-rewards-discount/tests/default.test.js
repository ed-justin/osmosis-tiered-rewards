import { describe, it, expect } from "vitest";
import { run } from "../src/run";
import noDiscounts from "./fixtures/no-discounts.json";

/**
 * Helper to build a cart input with a given subtotal
 */
function buildInput(subtotal, metafieldValue = null) {
  return {
    cart: {
      lines: [
        {
          id: "gid://shopify/CartLine/1",
          quantity: 1,
          merchandise: {
            __typename: "ProductVariant",
            id: "gid://shopify/ProductVariant/1",
            product: {
              id: "gid://shopify/Product/1",
            },
          },
          cost: {
            amountPerQuantity: {
              amount: subtotal.toString(),
              currencyCode: "USD",
            },
            totalAmount: {
              amount: subtotal.toString(),
              currencyCode: "USD",
            },
          },
        },
      ],
      cost: {
        subtotalAmount: {
          amount: subtotal.toString(),
          currencyCode: "USD",
        },
      },
    },
    discountNode: {
      metafield: metafieldValue ? { value: metafieldValue } : null,
    },
  };
}

describe("Tiered Rewards Discount", () => {
  // ── No discount scenarios ─────────────────────────────────────────

  it("returns no discounts when cart subtotal is below $1,000", () => {
    const result = run(noDiscounts);
    expect(result.discounts).toHaveLength(0);
  });

  it("returns no discounts when cart subtotal is $999.99", () => {
    const result = run(buildInput(999.99));
    expect(result.discounts).toHaveLength(0);
  });

  // ── Tier 1: $1,000+ → 6% ─────────────────────────────────────────

  it("applies 6% discount at exactly $1,000", () => {
    const result = run(buildInput(1000));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("6");
  });

  it("applies 6% discount at $3,499.99", () => {
    const result = run(buildInput(3499.99));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("6");
  });

  // ── Tier 2: $3,500+ → 10% ────────────────────────────────────────

  it("applies 10% discount at exactly $3,500", () => {
    const result = run(buildInput(3500));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("10");
  });

  it("applies 10% discount at $7,499.99", () => {
    const result = run(buildInput(7499.99));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("10");
  });

  // ── Tier 3: $7,500+ → 16% ────────────────────────────────────────

  it("applies 16% discount at exactly $7,500", () => {
    const result = run(buildInput(7500));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("16");
  });

  it("applies 16% discount at $14,999.99", () => {
    const result = run(buildInput(14999.99));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("16");
  });

  // ── Tier 4: $15,000+ → 20% ───────────────────────────────────────

  it("applies 20% discount at exactly $15,000", () => {
    const result = run(buildInput(15000));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("20");
  });

  it("applies 20% discount at $50,000", () => {
    const result = run(buildInput(50000));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("20");
  });

  // ── Custom tier configuration via metafield ───────────────────────

  it("uses custom tiers from metafield when provided", () => {
    const customConfig = JSON.stringify({
      tiers: [
        { minSubtotal: 500, percentage: 5 },
        { minSubtotal: 2000, percentage: 15 },
      ],
    });
    const result = run(buildInput(600, customConfig));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("5");
  });

  it("falls back to defaults on malformed metafield", () => {
    const result = run(buildInput(1000, "not-valid-json"));
    expect(result.discounts).toHaveLength(1);
    expect(result.discounts[0].value.percentage.value).toBe("6");
  });

  // ── Discount message ──────────────────────────────────────────────

  it("includes a descriptive discount message", () => {
    const result = run(buildInput(3500));
    expect(result.discounts[0].message).toContain("10%");
    expect(result.discounts[0].message).toContain("3,500");
  });
});
