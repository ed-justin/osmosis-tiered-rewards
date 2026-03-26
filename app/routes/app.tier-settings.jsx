import { useState, useCallback } from "react";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  DataTable,
  Badge,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

/**
 * ─── METAFIELD CONFIG ──────────────────────────────────────────────────
 * Tier configuration is stored as a JSON metafield on the shop.
 * The discount function reads from discount node metafields, but we
 * manage the "source of truth" on the shop and sync it when saving.
 */
const METAFIELD_NAMESPACE = "tiered-rewards";
const METAFIELD_KEY = "config";

const DEFAULT_TIERS = [
  { minSubtotal: 15000, percentage: 20 },
  { minSubtotal: 7500, percentage: 16 },
  { minSubtotal: 3500, percentage: 10 },
  { minSubtotal: 1000, percentage: 6 },
];
const UI_VERSION = "TMP-2026-03-26-2";

function getRewardCodeByDescendingIndex(index, total) {
  return `REWARDS${total - index}`;
}

// ─── LOADER ──────────────────────────────────────────────────────────────
export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const discountNodeId = normalizeDiscountNodeId(params?.id);

  // Read discount-node metafield first (runtime source), then app-installation fallback.
  const response = discountNodeId
    ? await admin.graphql(
        `query TierSettingsLoaderWithNode(
          $namespace: String!
          $key: String!
          $discountNodeId: ID!
        ) {
          currentAppInstallation {
            metafield(namespace: $namespace, key: $key) {
              id
              value
            }
          }
          discountNode(id: $discountNodeId) {
            id
            metafield(namespace: $namespace, key: $key) {
              id
              value
            }
          }
        }`,
        {
          variables: {
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            discountNodeId,
          },
        }
      )
    : await admin.graphql(
        `query TierSettingsLoaderAppOnly($namespace: String!, $key: String!) {
          currentAppInstallation {
            metafield(namespace: $namespace, key: $key) {
              id
              value
            }
          }
        }`,
        {
          variables: {
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
          },
        }
      );

  const data = await response.json();
  const runtimeMetafield = data?.data?.discountNode?.metafield;
  const appMetafield = data?.data?.currentAppInstallation?.metafield;
  const metafield = runtimeMetafield || appMetafield;

  let tiers = DEFAULT_TIERS;
  if (metafield?.value) {
    try {
      const parsed = JSON.parse(metafield.value);
      if (Array.isArray(parsed.tiers) && parsed.tiers.length > 0) {
        tiers = parsed.tiers;
      }
    } catch (e) {
      // Use defaults
    }
  }

  // Sort descending by minSubtotal for display
  tiers.sort((a, b) => b.minSubtotal - a.minSubtotal);

  return json({
    tiers,
    metafieldId: metafield?.id || null,
    discountNodeId: discountNodeId || null,
  });
};

// ─── ACTION ──────────────────────────────────────────────────────────────
export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const tiersJson = formData.get("tiers");
  const intent = formData.get("intent");
  const discountNodeId = normalizeDiscountNodeId(params?.id);

  let tiers;
  try {
    tiers = JSON.parse(tiersJson);
  } catch (e) {
    return json({ error: "Invalid tier data" }, { status: 400 });
  }

  // Validate tiers
  for (const tier of tiers) {
    if (
      typeof tier.minSubtotal !== "number" ||
      typeof tier.percentage !== "number" ||
      tier.minSubtotal <= 0 ||
      tier.percentage <= 0 ||
      tier.percentage > 100
    ) {
      return json(
        {
          error:
            "All tiers must have a positive minimum subtotal and a percentage between 0 and 100.",
        },
        { status: 400 }
      );
    }
  }

  // Sort descending
  tiers.sort((a, b) => b.minSubtotal - a.minSubtotal);

  const configValue = JSON.stringify({ tiers });

  if (intent === "create_discount") {
    const functionId = await getDiscountFunctionId(admin);
    if (!functionId) {
      return json(
        {
          error:
            "Could not find the tiered rewards discount function in Shopify Functions.",
        },
        { status: 400 }
      );
    }

    const createResult = await createAutomaticAppDiscount(admin, functionId);
    if (!createResult.ok) {
      return json({ error: createResult.error }, { status: 400 });
    }

    const createdDiscountNodeId = createResult.discountNodeId;

    // Save both app defaults and runtime node config after creation.
    const appInstallationId = await getAppInstallationId(admin);
    const appSave = await saveTierConfigMetafield(
      admin,
      appInstallationId,
      configValue
    );
    if (!appSave.ok) {
      return json({ error: appSave.error }, { status: 400 });
    }

    const nodeSave = await saveTierConfigMetafield(
      admin,
      createdDiscountNodeId,
      configValue
    );
    if (!nodeSave.ok) {
      return json(
        {
          error: `Discount created, but tier sync failed: ${nodeSave.error}`,
        },
        { status: 400 }
      );
    }

    const shortId = createdDiscountNodeId.split("/").pop();
    return redirect(`/app/tier-settings/${shortId}`);
  }

  const appInstallationId = await getAppInstallationId(admin);
  const appSave = await saveTierConfigMetafield(
    admin,
    appInstallationId,
    configValue
  );

  if (!appSave.ok) {
    return json({ error: appSave.error }, { status: 400 });
  }

  let discountNodeSaved = null;
  let warning = null;
  if (discountNodeId) {
    const nodeSave = await saveTierConfigMetafield(
      admin,
      discountNodeId,
      configValue
    );
    discountNodeSaved = nodeSave.ok;
    if (!nodeSave.ok) {
      warning = `Saved app defaults, but discount runtime sync failed: ${nodeSave.error}`;
    }
  }

  return json({
    success: true,
    tiers,
    syncStatus: {
      appInstallationSaved: true,
      discountNodeAttempted: Boolean(discountNodeId),
      discountNodeSaved,
      warning,
    },
  });
};

function normalizeDiscountNodeId(idParam) {
  if (!idParam || typeof idParam !== "string") return null;
  if (idParam.startsWith("gid://")) return idParam;
  if (/^\d+$/.test(idParam)) {
    return `gid://shopify/DiscountAutomaticNode/${idParam}`;
  }
  if (idParam.startsWith("DiscountAutomaticNode/")) {
    return `gid://shopify/${idParam}`;
  }
  return null;
}

async function getAppInstallationId(admin) {
  const response = await admin.graphql(`
    {
      currentAppInstallation {
        id
      }
    }
  `);
  const data = await response.json();
  return data.data.currentAppInstallation.id;
}

async function getDiscountFunctionId(admin) {
  const response = await admin.graphql(`
    {
      shopifyFunctions(first: 50) {
        nodes {
          id
          title
          apiType
        }
      }
    }
  `);
  const data = await response.json();
  const nodes = data?.data?.shopifyFunctions?.nodes || [];
  const match = nodes.find((n) => {
    const title = (n?.title || "").toLowerCase();
    const apiType = (n?.apiType || "").toLowerCase();
    return apiType.includes("discount") && title.includes("tier");
  });
  return match?.id || null;
}

async function createAutomaticAppDiscount(admin, functionId) {
  const startsAt = new Date().toISOString();
  const response = await admin.graphql(
    `mutation CreateTieredRewardsDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
      discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
        automaticAppDiscount {
          discountId
          title
          status
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        automaticAppDiscount: {
          title: "REWARDS",
          functionId,
          discountClasses: ["ORDER"],
          startsAt,
          combinesWith: {
            orderDiscounts: true,
            productDiscounts: true,
            shippingDiscounts: true,
          },
        },
      },
    }
  );
  const data = await response.json();
  const payload = data?.data?.discountAutomaticAppCreate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length > 0) {
    return {
      ok: false,
      error: userErrors.map((e) => e.message).join(", "),
    };
  }
  const discountNodeId = payload?.automaticAppDiscount?.discountId;
  if (!discountNodeId) {
    return { ok: false, error: "Shopify did not return a discount node ID." };
  }
  return { ok: true, discountNodeId };
}

async function saveTierConfigMetafield(admin, ownerId, configValue) {
  const response = await admin.graphql(
    `mutation SetTierConfig($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "json",
            value: configValue,
            ownerId,
          },
        ],
      },
    }
  );

  const result = await response.json();
  const userErrors = result?.data?.metafieldsSet?.userErrors || [];

  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e) => e.message).join(", ") };
  }

  return { ok: true };
}

// ─── COMPONENT ───────────────────────────────────────────────────────────
export default function TierSettings() {
  const { tiers: savedTiers, discountNodeId } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [tiers, setTiers] = useState(savedTiers);
  const [error, setError] = useState(null);

  const handleTierChange = useCallback(
    (index, field, value) => {
      const updated = [...tiers];
      updated[index] = {
        ...updated[index],
        [field]: value === "" ? "" : parseFloat(value) || 0,
      };
      setTiers(updated);
    },
    [tiers]
  );

  const addTier = useCallback(() => {
    setTiers([...tiers, { minSubtotal: 0, percentage: 0 }]);
  }, [tiers]);

  const removeTier = useCallback(
    (index) => {
      setTiers(tiers.filter((_, i) => i !== index));
    },
    [tiers]
  );

  const handleSave = useCallback(() => {
    // Validate before submitting
    const validTiers = tiers.filter(
      (t) => t.minSubtotal > 0 && t.percentage > 0 && t.percentage <= 100
    );

    if (validTiers.length === 0) {
      setError("You need at least one valid tier.");
      return;
    }

    // Check for duplicate thresholds
    const thresholds = validTiers.map((t) => t.minSubtotal);
    if (new Set(thresholds).size !== thresholds.length) {
      setError("Each tier must have a unique minimum subtotal.");
      return;
    }

    setError(null);
    const formData = new FormData();
    formData.set("tiers", JSON.stringify(validTiers));
    submit(formData, { method: "POST" });
  }, [tiers, submit]);

  const handleCreateDiscount = useCallback(() => {
    const validTiers = tiers.filter(
      (t) => t.minSubtotal > 0 && t.percentage > 0 && t.percentage <= 100
    );
    if (validTiers.length === 0) {
      setError("You need at least one valid tier.");
      return;
    }
    const thresholds = validTiers.map((t) => t.minSubtotal);
    if (new Set(thresholds).size !== thresholds.length) {
      setError("Each tier must have a unique minimum subtotal.");
      return;
    }
    setError(null);
    const fd = new FormData();
    fd.set("intent", "create_discount");
    fd.set("tiers", JSON.stringify(validTiers));
    submit(fd, { method: "POST" });
  }, [tiers, submit]);

  // Build the data table rows for the "CS Quick Reference" card
  const sortedTiers = [...tiers]
    .filter((t) => t.minSubtotal > 0 && t.percentage > 0)
    .sort((a, b) => b.minSubtotal - a.minSubtotal);

  const referenceRows = sortedTiers.map((tier, i) => {
    const rewardCode = getRewardCodeByDescendingIndex(i, sortedTiers.length);
    const rangeLabel = `$${tier.minSubtotal.toLocaleString()} +`;
    return [rewardCode, rangeLabel, `${tier.percentage}%`];
  });

  return (
    <Page
      title="Tiered Rewards Settings"
      subtitle="Configure automatic discount tiers based on cart subtotal. Discounts evaluate after BSS B2B catalog pricing, excluding tax and shipping."
    >
      <Layout>
        <Layout.Section>
          <Banner title={`UI Version: ${UI_VERSION}`} tone="info">
            <p>Use this temporary marker to confirm the latest deployment.</p>
          </Banner>
        </Layout.Section>

        {/* ── Success / Error banners ────────────────────────────────── */}
        {actionData?.success && !isSaving && !error && (
          <Layout.Section>
            <Banner
              title="Tier settings saved."
              tone="success"
            >
              <p>
                App defaults were updated
                {actionData?.syncStatus?.discountNodeAttempted
                  ? actionData?.syncStatus?.discountNodeSaved
                    ? ", and runtime discount node config is in sync."
                    : ", but runtime discount node sync failed."
                  : ". Open this page from a discount details URL to sync runtime config automatically."}
              </p>
            </Banner>
          </Layout.Section>
        )}
        {actionData?.syncStatus?.warning && !isSaving && (
          <Layout.Section>
            <Banner title="Partial sync warning" tone="warning">
              <p>{actionData.syncStatus.warning}</p>
            </Banner>
          </Layout.Section>
        )}
        {!discountNodeId && (
          <Layout.Section>
            <Banner title="Runtime sync note" tone="info">
              <p>
                You are editing default app tiers only. To sync a specific live
                automatic discount runtime config, open this page from that
                discount's details route.
              </p>
            </Banner>
          </Layout.Section>
        )}
        {error && (
          <Layout.Section>
            <Banner
              title="There was a problem"
              tone="critical"
              onDismiss={() => setError(null)}
            >
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        )}
        {actionData?.error && (
          <Layout.Section>
            <Banner title="Save failed" tone="critical">
              <p>{actionData.error}</p>
            </Banner>
          </Layout.Section>
        )}

        {/* ── Tier Configuration ─────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Discount Tiers
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Each tier defines a minimum cart subtotal and the discount
                percentage to apply. The highest qualifying tier wins. Cart
                subtotal is evaluated after BSS B2B pricing adjustments.
              </Text>

              <Divider />

              {tiers.map((tier, index) => (
                <InlineStack key={index} gap="300" align="center" blockAlign="end">
                  <Box width="110px">
                    <Text as="p" variant="bodyMd">
                      {getRewardCodeByDescendingIndex(index, tiers.length)}
                    </Text>
                  </Box>
                  <Box width="240px">
                    <TextField
                      label={`Tier ${index + 1} — Min Subtotal ($)`}
                      type="number"
                      value={tier.minSubtotal.toString()}
                      onChange={(value) =>
                        handleTierChange(index, "minSubtotal", value)
                      }
                      prefix="$"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="180px">
                    <TextField
                      label="Discount %"
                      type="number"
                      value={tier.percentage.toString()}
                      onChange={(value) =>
                        handleTierChange(index, "percentage", value)
                      }
                      suffix="%"
                      autoComplete="off"
                      min={1}
                      max={100}
                    />
                  </Box>
                  <Button
                    tone="critical"
                    variant="plain"
                    onClick={() => removeTier(index)}
                    disabled={tiers.length <= 1}
                  >
                    Remove
                  </Button>
                </InlineStack>
              ))}

              <InlineStack gap="300">
                <Button onClick={addTier}>+ Add tier</Button>
                {!discountNodeId && (
                  <Button
                    variant="secondary"
                    onClick={handleCreateDiscount}
                    loading={isSaving}
                  >
                    Create Shopify discount
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={handleSave}
                  loading={isSaving}
                >
                  Save settings
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── CS Quick Reference Card ────────────────────────────────── */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  CS Quick Reference
                </Text>
                <Badge tone="info">Active</Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                Use this table when creating manual/draft orders. The discount
                applies automatically at checkout for storefront orders.
              </Text>
              {referenceRows.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "text", "text"]}
                  headings={["Reward", "Cart Subtotal", "Discount"]}
                  rows={referenceRows}
                />
              ) : (
                <Text as="p" tone="subdued">
                  No valid tiers configured yet.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── How It Works ───────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                How It Works
              </Text>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  <strong>Storefront orders:</strong> The discount is applied
                  automatically at checkout. No promo code is needed — the
                  function evaluates the cart subtotal and applies the highest
                  qualifying tier.
                </Text>
                <Text as="p" variant="bodyMd">
                  <strong>Admin / Draft orders:</strong> When CS creates an
                  order through Shopify admin, the automatic discount function
                  fires on draft orders as well. The correct tier discount will
                  be applied based on the order subtotal.
                </Text>
                <Text as="p" variant="bodyMd">
                  <strong>BSS B2B pricing:</strong> The tier evaluation happens
                  after BSS B2B catalog pricing has been applied. If a B2B
                  customer has a $100 product priced at $70 via their tier, the
                  $70 price is what counts toward the subtotal threshold.
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
