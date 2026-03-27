import { useState, useCallback } from "react";
import { json } from "@remix-run/node";
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
import {
  CONFIG_METAFIELD_KEY,
  DEFAULT_TIERS,
  getAppInstallationMetafields,
  getDiscountNodeMetafield,
  parseSetupConfig,
  parseTierConfig,
  saveJsonMetafield,
} from "../tiered-rewards.server";

const UI_VERSION = "TMP-2026-03-27-1";

function getRewardCodeByDescendingIndex(index, total) {
  return `REWARDS${total - index}`;
}

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

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const appInstallation = await getAppInstallationMetafields(admin);
  const setup = parseSetupConfig(appInstallation?.setup?.value);
  const discountNodeId =
    normalizeDiscountNodeId(params?.id) || setup.discountNodeId || null;
  const runtimeMetafield = await getDiscountNodeMetafield(admin, discountNodeId);
  const appMetafield = appInstallation?.config;
  const metafield = runtimeMetafield || appMetafield;

  const tiers = [...(parseTierConfig(metafield?.value).tiers || DEFAULT_TIERS)].sort(
    (a, b) => b.minSubtotal - a.minSubtotal
  );

  return json({
    tiers,
    discountNodeId,
  });
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const tiersJson = formData.get("tiers");
  const appInstallation = await getAppInstallationMetafields(admin);
  const setup = parseSetupConfig(appInstallation?.setup?.value);
  const discountNodeId =
    normalizeDiscountNodeId(params?.id) || setup.discountNodeId || null;

  let tiers;
  try {
    tiers = JSON.parse(tiersJson);
  } catch {
    return json({ error: "Invalid tier data" }, { status: 400 });
  }

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

  tiers.sort((a, b) => b.minSubtotal - a.minSubtotal);

  const configValue = JSON.stringify({ tiers });
  const appInstallationId = appInstallation?.id;

  if (!appInstallationId) {
    return json(
      { error: "Could not find the current app installation." },
      { status: 400 }
    );
  }

  const appSave = await saveJsonMetafield(
    admin,
    appInstallationId,
    CONFIG_METAFIELD_KEY,
    configValue
  );

  if (!appSave.ok) {
    return json({ error: appSave.error }, { status: 400 });
  }

  let discountNodeSaved = null;
  let warning = null;
  if (discountNodeId) {
    const nodeSave = await saveJsonMetafield(
      admin,
      discountNodeId,
      CONFIG_METAFIELD_KEY,
      configValue
    );
    discountNodeSaved = nodeSave.ok;
    if (!nodeSave.ok) {
      warning = `Saved app defaults, but discount runtime sync failed: ${nodeSave.error}`;
    }
  } else {
    warning =
      "Saved app defaults, but no live automatic discount is linked yet. Reinstall or re-auth the app to run automatic setup.";
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
    const validTiers = tiers.filter(
      (tier) =>
        tier.minSubtotal > 0 && tier.percentage > 0 && tier.percentage <= 100
    );

    if (validTiers.length === 0) {
      setError("You need at least one valid tier.");
      return;
    }

    const thresholds = validTiers.map((tier) => tier.minSubtotal);
    if (new Set(thresholds).size !== thresholds.length) {
      setError("Each tier must have a unique minimum subtotal.");
      return;
    }

    setError(null);
    const formData = new FormData();
    formData.set("tiers", JSON.stringify(validTiers));
    submit(formData, { method: "POST" });
  }, [tiers, submit]);

  const sortedTiers = [...tiers]
    .filter((tier) => tier.minSubtotal > 0 && tier.percentage > 0)
    .sort((a, b) => b.minSubtotal - a.minSubtotal);

  const referenceRows = sortedTiers.map((tier, index) => {
    const rewardCode = getRewardCodeByDescendingIndex(index, sortedTiers.length);
    return [
      rewardCode,
      `$${tier.minSubtotal.toLocaleString()} +`,
      `${tier.percentage}%`,
    ];
  });

  return (
    <Page
      title="Tiered Rewards Settings"
      subtitle="Configure automatic discount tiers based on cart subtotal. The threshold uses the full cart subtotal, but the discount applies only to eligible collection products."
    >
      <Layout>
        <Layout.Section>
          <Banner title={`UI Version: ${UI_VERSION}`} tone="info">
            <p>Automatic discount setup now runs after install/auth.</p>
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Banner title="Canada shopper logic active" tone="info">
            <p>
              Customers tagged with <strong>Canada Shopper</strong> or{" "}
              <strong>MD-CAN Shopper</strong> use the Canada tier table:
              REWARDS1 at 6% for $7,500+ and REWARDS2 at 10% for $15,000+.
            </p>
          </Banner>
        </Layout.Section>

        {actionData?.success && !isSaving && !error && (
          <Layout.Section>
            <Banner title="Tier settings saved." tone="success">
              <p>
                App defaults were updated
                {actionData?.syncStatus?.discountNodeAttempted
                  ? actionData?.syncStatus?.discountNodeSaved
                    ? ", and the live automatic discount is in sync."
                    : ", but live discount sync failed."
                  : "."}
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
            <Banner title="Automatic discount not linked yet" tone="warning">
              <p>
                This store does not have a linked live automatic discount yet.
                Reinstall or re-auth the app to run one-time setup.
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

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Discount Tiers
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Each tier defines a minimum cart subtotal and the discount
                percentage to apply to eligible collection products. The
                highest qualifying tier wins. Cart subtotal is evaluated after
                BSS B2B pricing adjustments.
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
                      label={`Tier ${index + 1} - Min Subtotal ($)`}
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
                applies only to eligible collection products once the cart
                reaches the tier subtotal.
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

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                How It Works
              </Text>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  <strong>Storefront orders:</strong> The discount is applied
                  automatically at checkout. No promo code is needed because the
                  function evaluates the full cart subtotal and applies the
                  highest qualifying tier only to eligible collection products.
                </Text>
                <Text as="p" variant="bodyMd">
                  <strong>Admin / Draft orders:</strong> When CS creates an
                  order through Shopify admin, the automatic discount function
                  can apply the correct tier discount based on the order
                  subtotal.
                </Text>
                <Text as="p" variant="bodyMd">
                  <strong>BSS B2B pricing:</strong> The tier evaluation happens
                  after BSS B2B catalog pricing has been applied.
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
