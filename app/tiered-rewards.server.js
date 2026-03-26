export const METAFIELD_NAMESPACE = "tiered-rewards";
export const CONFIG_METAFIELD_KEY = "config";
export const SETUP_METAFIELD_KEY = "setup";
export const DISCOUNT_TITLE = "REWARDS";

export const DEFAULT_TIERS = [
  { minSubtotal: 15000, percentage: 20 },
  { minSubtotal: 7500, percentage: 16 },
  { minSubtotal: 3500, percentage: 10 },
  { minSubtotal: 1000, percentage: 6 },
];

export async function getAppInstallationMetafields(admin) {
  const response = await admin.graphql(
    `query TieredRewardsAppInstallation(
      $namespace: String!
      $configKey: String!
      $setupKey: String!
    ) {
      currentAppInstallation {
        id
        config: metafield(namespace: $namespace, key: $configKey) {
          id
          value
        }
        setup: metafield(namespace: $namespace, key: $setupKey) {
          id
          value
        }
      }
    }`,
    {
      variables: {
        namespace: METAFIELD_NAMESPACE,
        configKey: CONFIG_METAFIELD_KEY,
        setupKey: SETUP_METAFIELD_KEY,
      },
    }
  );

  const data = await response.json();
  return data?.data?.currentAppInstallation || null;
}

export function parseTierConfig(value) {
  if (!value) return { tiers: DEFAULT_TIERS };

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed?.tiers) && parsed.tiers.length > 0) {
      return parsed;
    }
  } catch {
    return { tiers: DEFAULT_TIERS };
  }

  return { tiers: DEFAULT_TIERS };
}

export function parseSetupConfig(value) {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function getDiscountNodeMetafield(admin, discountNodeId) {
  if (!discountNodeId) return null;

  const response = await admin.graphql(
    `query TieredRewardsDiscountNode(
      $discountNodeId: ID!
      $namespace: String!
      $key: String!
    ) {
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
        discountNodeId,
        namespace: METAFIELD_NAMESPACE,
        key: CONFIG_METAFIELD_KEY,
      },
    }
  );

  const data = await response.json();
  return data?.data?.discountNode?.metafield || null;
}

export async function getDiscountFunctionId(admin) {
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
  const match = nodes.find((node) => {
    const title = (node?.title || "").toLowerCase();
    const apiType = (node?.apiType || "").toLowerCase();
    return apiType.includes("discount") && title.includes("tier");
  });
  return match?.id || null;
}

export async function createAutomaticAppDiscount(admin, functionId) {
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
          title: DISCOUNT_TITLE,
          functionId,
          discountClasses: ["PRODUCT"],
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
      error: userErrors.map((error) => error.message).join(", "),
    };
  }

  const discountNodeId = payload?.automaticAppDiscount?.discountId;
  if (!discountNodeId) {
    return { ok: false, error: "Shopify did not return a discount node ID." };
  }

  return { ok: true, discountNodeId };
}

export async function saveJsonMetafield(admin, ownerId, key, value) {
  const response = await admin.graphql(
    `mutation SetTieredRewardsMetafield($metafields: [MetafieldsSetInput!]!) {
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
            key,
            type: "json",
            value,
            ownerId,
          },
        ],
      },
    }
  );

  const result = await response.json();
  const userErrors = result?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    return {
      ok: false,
      error: userErrors.map((error) => error.message).join(", "),
    };
  }

  return { ok: true };
}

export async function ensureTieredRewardsSetup(admin) {
  const appInstallation = await getAppInstallationMetafields(admin);
  const appInstallationId = appInstallation?.id;

  if (!appInstallationId) {
    return { ok: false, error: "Could not find the current app installation." };
  }

  const existingSetup = parseSetupConfig(appInstallation?.setup?.value);
  if (existingSetup.discountNodeId) {
    return {
      ok: true,
      discountNodeId: existingSetup.discountNodeId,
      created: false,
    };
  }

  const functionId = await getDiscountFunctionId(admin);
  if (!functionId) {
    return {
      ok: false,
      error: "Could not find the tiered rewards discount function in Shopify Functions.",
    };
  }

  const createResult = await createAutomaticAppDiscount(admin, functionId);
  if (!createResult.ok) {
    return createResult;
  }

  const discountNodeId = createResult.discountNodeId;
  const config =
    parseTierConfig(appInstallation?.config?.value) || { tiers: DEFAULT_TIERS };
  const configValue = JSON.stringify({ tiers: config.tiers || DEFAULT_TIERS });

  const appConfigSave = await saveJsonMetafield(
    admin,
    appInstallationId,
    CONFIG_METAFIELD_KEY,
    configValue
  );
  if (!appConfigSave.ok) {
    return appConfigSave;
  }

  const nodeConfigSave = await saveJsonMetafield(
    admin,
    discountNodeId,
    CONFIG_METAFIELD_KEY,
    configValue
  );
  if (!nodeConfigSave.ok) {
    return nodeConfigSave;
  }

  const setupValue = JSON.stringify({
    discountNodeId,
    createdAt: new Date().toISOString(),
  });
  const setupSave = await saveJsonMetafield(
    admin,
    appInstallationId,
    SETUP_METAFIELD_KEY,
    setupValue
  );
  if (!setupSave.ok) {
    return setupSave;
  }

  return { ok: true, discountNodeId, created: true };
}
