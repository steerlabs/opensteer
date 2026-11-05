import type { IntegrationDefinition } from "@opensteer/integration-core";

/**
 * How the catalog is shown to a person: which product each definition belongs
 * to, the product's name, its category and whether it is a popular pick.
 *
 * This lives beside the definitions rather than in them because a definition's
 * digest pins installations, computer-app approvals and, through its
 * auth-method labels, every connection's authorization: renaming one would
 * re-materialize installations and ask people to sign in again.
 */
export const catalogCategories = ["communication", "work", "developer", "web", "devices"] as const;
export type CatalogCategory = (typeof catalogCategories)[number];

interface CatalogProduct {
  readonly name: string;
  readonly category: CatalogCategory;
  readonly popular?: true;
  /** The definition a person adds by default first, then its alternatives. */
  readonly definitionIds: readonly [string, ...string[]];
}

/** In the order a person browses them; popular picks show in this order too. */
export const catalogProducts: readonly CatalogProduct[] = [
  { name: "Slack", category: "communication", popular: true, definitionIds: ["slack"] },
  { name: "Gmail", category: "communication", popular: true, definitionIds: ["google-gmail"] },
  { name: "Discord", category: "communication", definitionIds: ["discord"] },
  { name: "Outlook Mail", category: "communication", definitionIds: ["microsoft-outlook-mail"] },
  { name: "Microsoft Teams", category: "communication", definitionIds: ["microsoft-teams-chat"] },
  { name: "Resend", category: "communication", definitionIds: ["resend"] },
  { name: "Twilio", category: "communication", definitionIds: ["twilio-rest"] },
  { name: "Notion", category: "work", popular: true, definitionIds: ["notion-mcp", "notion"] },
  { name: "Google Calendar", category: "work", popular: true, definitionIds: ["google-calendar"] },
  { name: "Google Drive", category: "work", popular: true, definitionIds: ["google-drive"] },
  { name: "Figma", category: "work", popular: true, definitionIds: ["figma-rest"] },
  { name: "Google Docs", category: "work", definitionIds: ["google-docs"] },
  { name: "Google Sheets", category: "work", definitionIds: ["google-sheets"] },
  { name: "Google Slides", category: "work", definitionIds: ["google-slides"] },
  { name: "Google Forms", category: "work", definitionIds: ["google-forms"] },
  { name: "Google Tasks", category: "work", definitionIds: ["google-tasks"] },
  { name: "Google Contacts", category: "work", definitionIds: ["google-people"] },
  { name: "Asana", category: "work", definitionIds: ["asana-rest"] },
  { name: "monday.com", category: "work", definitionIds: ["monday-graphql"] },
  { name: "Outlook Calendar", category: "work", definitionIds: ["microsoft-outlook-calendar"] },
  { name: "Outlook Contacts", category: "work", definitionIds: ["microsoft-contacts"] },
  { name: "Microsoft To Do", category: "work", definitionIds: ["microsoft-todo"] },
  { name: "OneDrive", category: "work", definitionIds: ["microsoft-onedrive"] },
  { name: "OneNote", category: "work", definitionIds: ["microsoft-onenote"] },
  { name: "Microsoft account", category: "work", definitionIds: ["microsoft-profile"] },
  {
    name: "Linear",
    category: "developer",
    popular: true,
    definitionIds: ["linear-mcp", "linear"],
  },
  {
    name: "GitHub",
    category: "developer",
    popular: true,
    definitionIds: ["github", "github-graphql"],
  },
  {
    name: "Stripe",
    category: "developer",
    popular: true,
    definitionIds: ["stripe-mcp", "stripe-rest"],
  },
  {
    name: "Sentry",
    category: "developer",
    popular: true,
    definitionIds: ["sentry-mcp", "sentry-rest"],
  },
  { name: "GitLab", category: "developer", definitionIds: ["gitlab-graphql"] },
  { name: "Vercel", category: "developer", definitionIds: ["vercel-rest"] },
  { name: "Cloudflare", category: "developer", definitionIds: ["cloudflare-mcp"] },
  { name: "Neon", category: "developer", definitionIds: ["neon-mcp", "neon-rest"] },
  { name: "PostHog", category: "developer", definitionIds: ["posthog-rest"] },
  { name: "Axiom", category: "developer", definitionIds: ["axiom-mcp"] },
  { name: "DigitalOcean", category: "developer", definitionIds: ["digitalocean-rest"] },
  { name: "Val Town", category: "developer", definitionIds: ["val-town-rest"] },
  { name: "Context7", category: "developer", definitionIds: ["context7-mcp"] },
  { name: "DeepWiki", category: "developer", definitionIds: ["deepwiki-mcp"] },
  { name: "OpenAI", category: "web", definitionIds: ["openai-rest"] },
  { name: "Exa Search", category: "web", definitionIds: ["exa-rest"] },
  { name: "Exa Websets", category: "web", definitionIds: ["exa-websets-rest"] },
  { name: "Firecrawl", category: "web", definitionIds: ["firecrawl-rest"] },
  { name: "Browserbase", category: "web", definitionIds: ["browserbase-mcp"] },
  { name: "Spotify", category: "web", definitionIds: ["spotify-rest"] },
  { name: "AniList", category: "web", definitionIds: ["anilist-graphql"] },
  { name: "iMessage", category: "devices", definitionIds: ["apple-messages"] },
  { name: "Contacts", category: "devices", definitionIds: ["apple-contacts"] },
  { name: "Calendar", category: "devices", definitionIds: ["apple-calendar"] },
  { name: "Reminders", category: "devices", definitionIds: ["apple-reminders"] },
  { name: "Photos", category: "devices", definitionIds: ["iphone-photos"] },
  { name: "Location", category: "devices", definitionIds: ["iphone-location"] },
  { name: "Computer use", category: "devices", definitionIds: ["macos-app"] },
  { name: "Android phone", category: "devices", definitionIds: ["android-phone"] },
];

export interface CatalogPresentation {
  /** The product's default definition id. */
  readonly productId: string;
  readonly productName: string;
  /** What this definition is called: the product's name, or "Linear (GraphQL API)" for an alternative. */
  readonly title: string;
  readonly category: CatalogCategory;
  readonly popular: boolean;
  /** How this definition reaches the product, when the product offers more than one way. */
  readonly variant: string | null;
  /** Position in browsing order: by product, each product's default way in first. */
  readonly rank: number;
}

/** How a person sees one definition, or null for one this listing does not carry. */
export function catalogPresentation(
  definition: Pick<IntegrationDefinition, "adapter" | "id">,
): CatalogPresentation | null {
  const index = catalogProducts.findIndex((entry) => entry.definitionIds.includes(definition.id));
  const product = catalogProducts[index];
  if (!product) return null;
  const variant = product.definitionIds.length > 1 ? variantLabel(definition.adapter) : null;
  return {
    productId: product.definitionIds[0],
    productName: product.name,
    title:
      variant && product.definitionIds[0] !== definition.id
        ? `${product.name} (${variant})`
        : product.name,
    category: product.category,
    popular: product.popular === true,
    variant,
    rank: index + product.definitionIds.indexOf(definition.id) / product.definitionIds.length,
  };
}

function variantLabel(adapter: IntegrationDefinition["adapter"]): string {
  switch (adapter) {
    case "mcp":
      return "MCP server";
    case "graphql":
      return "GraphQL API";
    case "openapi":
      return "REST API";
    case "computer":
      return "On your device";
  }
}
