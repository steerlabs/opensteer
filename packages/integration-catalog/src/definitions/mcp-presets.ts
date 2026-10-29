import type { IntegrationDefinition } from "@opensteer/integration-core";
import { remoteMcpPreset, secretInput } from "./preset-helpers.js";

export const mcpPresetIntegrations: readonly IntegrationDefinition[] = [
  remoteMcpPreset({
    auth: { kind: "none" },
    description: "Search and read documentation for public GitHub repositories through DeepWiki.",
    endpoint: "https://mcp.deepwiki.com/mcp",
    id: "deepwiki-mcp",
    name: "DeepWiki MCP",
    provider: "deepwiki",
  }),
  remoteMcpPreset({
    auth: { kind: "none" },
    description: "Current library documentation and code examples through Context7.",
    endpoint: "https://mcp.context7.com/mcp",
    id: "context7-mcp",
    name: "Context7 MCP",
    provider: "context7",
  }),
  remoteMcpPreset({
    auth: {
      inputs: [secretInput("Browserbase API key")],
      kind: "api-key",
      placements: [{ carrier: "query", name: "browserbaseApiKey", variable: "apiKey" }],
    },
    description:
      "Cloud browser sessions, navigation, extraction, and automation through Browserbase.",
    endpoint: "https://mcp.browserbase.com/mcp",
    id: "browserbase-mcp",
    name: "Browserbase MCP",
    provider: "browserbase",
    setupUrl: "https://www.browserbase.com/settings",
  }),
  remoteMcpPreset({
    auth: { kind: "mcp-oauth" },
    description:
      "Manage Neon projects, branches, databases, and SQL through Neon's managed MCP server.",
    endpoint: "https://mcp.neon.tech/mcp",
    id: "neon-mcp",
    name: "Neon MCP",
    provider: "neon",
  }),
  remoteMcpPreset({
    auth: { kind: "mcp-oauth" },
    description:
      "Query datasets, dashboards, monitors, and event data through Axiom's managed MCP server.",
    endpoint: "https://mcp.axiom.co/mcp",
    id: "axiom-mcp",
    name: "Axiom MCP",
    provider: "axiom",
  }),
  remoteMcpPreset({
    auth: { kind: "mcp-oauth" },
    description:
      "Payments, customers, subscriptions, invoices, and Stripe documentation through Stripe MCP.",
    endpoint: "https://mcp.stripe.com",
    id: "stripe-mcp",
    name: "Stripe MCP",
    provider: "stripe",
  }),
  remoteMcpPreset({
    auth: { kind: "mcp-oauth" },
    description:
      "Issues, projects, teams, cycles, and comments through Linear's managed MCP server.",
    endpoint: "https://mcp.linear.app/mcp",
    id: "linear-mcp",
    name: "Linear MCP",
    provider: "linear",
  }),
  remoteMcpPreset({
    auth: { kind: "mcp-oauth" },
    description:
      "Pages, databases, blocks, comments, and search through Notion's managed MCP server.",
    endpoint: "https://mcp.notion.com/mcp",
    id: "notion-mcp",
    name: "Notion MCP",
    provider: "notion",
  }),
  remoteMcpPreset({
    auth: { kind: "mcp-oauth" },
    description: "Issues, releases, projects, traces, and error investigation through Sentry MCP.",
    endpoint: "https://mcp.sentry.dev/mcp",
    id: "sentry-mcp",
    name: "Sentry MCP",
    provider: "sentry",
  }),
  remoteMcpPreset({
    auth: { kind: "mcp-oauth" },
    description: "Cloudflare's full API through its managed search-and-execute MCP server.",
    endpoint: "https://mcp.cloudflare.com/mcp",
    id: "cloudflare-mcp",
    name: "Cloudflare MCP",
    provider: "cloudflare",
  }),
];
