import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const UI_VERSION = "TMP-2026-03-26-2";

const DEFAULT_TIERS = [
  { minSubtotal: 1000, percentage: 6 },
  { minSubtotal: 3500, percentage: 10 },
  { minSubtotal: 7500, percentage: 16 },
  { minSubtotal: 15000, percentage: 20 },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <Page>
      <TitleBar title="Tiered Rewards" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Tiered rewards discount is live
                </Text>
                <InlineStack gap="200">
                  <Badge tone="info">UI {UI_VERSION}</Badge>
                  <Badge tone="success">Active</Badge>
                </InlineStack>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                This app applies an automatic order discount based on cart
                subtotal tiers. Highest qualifying tier wins.
              </Text>
              <InlineStack gap="300">
                <Button url="shopify:admin/discounts" target="_top">
                  Open Discounts
                </Button>
                <Button url="/app/tier-settings" variant="primary">
                  Open Tier Settings
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Current Tier Targets
              </Text>
              <List type="bullet">
                {DEFAULT_TIERS.map((tier) => (
                  <List.Item key={tier.minSubtotal}>
                    ${tier.minSubtotal.toLocaleString()}+ : {tier.percentage}%
                  </List.Item>
                ))}
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
