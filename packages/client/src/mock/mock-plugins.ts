import {
  hostApi,
  pluginDetailPageMax,
  pluginDetailPreview,
  pluginsInstalledPageMax,
  pluginRunsMax,
  pluginScheduleApprovalsPageMax,
  rpcSuccess,
  type ConnectedAccountView,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type InstalledPluginView,
  type PluginAccountReviewView,
  type PluginCatalogEntryView,
  type PluginChange,
  type PluginCommand,
  type PluginCommandResult,
  type PluginConsentView,
  type PluginEngineStateView,
  type PluginLocalToolSummaryView,
  type PluginLocalToolView,
  type PluginRequirementTarget,
  type PluginScheduledRunView,
  type PluginSummaryView,
  type PluginWebhookSetupView,
  type PluginWorkflowRunView,
  type pluginReads,
} from "@opensteer/protocol";
import { IntegrationAuthorizationAttemptIdSchema } from "@opensteer/integration-core";
import { prepareAppHtml } from "@opensteer/shared/appFrame";
import { HostClientRequestError } from "../host/client.js";
import { mockNotesServer } from "./mock-integration-fixtures.js";
import type { PluginOAuthMethods, PluginOAuthStatus } from "../plugins/sign-in.js";
import { pluginWorkflowRunLive } from "../plugins/runs.js";

export type MockSignInCommand = Extract<
  HostApiCommand,
  { type: `plugin.authorization.${string}` | `plugin.oauthApp.${string}` }
>;
type MockSignInResult = Extract<HostApiCommandOutput, { type: MockSignInCommand["type"] }>;
export function isMockSignInCommand(command: HostApiCommand): command is MockSignInCommand {
  return (
    command.type.startsWith("plugin.authorization.") || command.type.startsWith("plugin.oauthApp.")
  );
}

/**
 * The plugin side of the mock Host: a catalog of a few hundred entries for
 * paging and search, installed plugins in every state a person can meet, and
 * schedules, versions, workflows and webhooks to act on. `?mock-plugins=` picks
 * `empty`, `unavailable`, `unsupported` (the sandbox can't run on this
 * computer's macOS), `error`, `local-only` (no public address for webhooks) or
 * `many` (more installed plugins than one page).
 */
export type MockPluginScenario =
  "default" | "empty" | "unavailable" | "unsupported" | "error" | "local-only" | "many";
export const mockPluginScenarios = [
  "empty",
  "unavailable",
  "unsupported",
  "error",
  "local-only",
  "many",
] as const satisfies readonly MockPluginScenario[];

const digest = (seed: string) =>
  Array.from({ length: 64 }, (_, index) =>
    ((seed.charCodeAt(index % seed.length) + index * 7) % 16).toString(16),
  ).join("");

const catalogCategories = [
  [
    "Engineering",
    [
      "Linear",
      "GitHub",
      "GitLab",
      "Sentry",
      "Vercel",
      "Netlify",
      "Render",
      "Fly",
      "Railway",
      "Datadog",
      "PagerDuty",
      "CircleCI",
      "Buildkite",
      "Postman",
      "Supabase",
      "Neon",
      "PlanetScale",
      "Cloudflare",
      "Fastly",
      "Docker Hub",
    ],
  ],
  [
    "Productivity",
    [
      "Notion",
      "Todoist",
      "Asana",
      "Trello",
      "ClickUp",
      "Airtable",
      "Coda",
      "Miro",
      "Calendly",
      "Cal.com",
      "Toggl",
      "Harvest",
      "Evernote",
      "Obsidian Sync",
      "Raindrop",
      "Readwise",
      "Things",
      "TickTick",
      "Basecamp",
      "Monday",
    ],
  ],
  [
    "Communication",
    [
      "Slack",
      "Discord",
      "Resend",
      "Postmark",
      "SendGrid",
      "Mailgun",
      "Twilio",
      "Vonage",
      "Intercom",
      "Front",
      "Zendesk",
      "Help Scout",
      "Crisp",
      "Loom",
      "Zoom",
      "Whereby",
      "Telegram Bot",
      "Matrix",
      "Mattermost",
      "Pushover",
    ],
  ],
  [
    "Finance",
    [
      "Stripe",
      "Paddle",
      "Lemon Squeezy",
      "Mercury",
      "Brex",
      "Ramp",
      "QuickBooks",
      "Xero",
      "Wise",
      "Plaid",
      "Chargebee",
      "Recurly",
      "FreshBooks",
      "Wave",
      "Expensify",
      "Bill.com",
      "Gusto",
      "Rippling",
      "Deel",
      "Pilot",
    ],
  ],
  [
    "Marketing",
    [
      "HubSpot",
      "Mailchimp",
      "ConvertKit",
      "Beehiiv",
      "Buttondown",
      "Ghost",
      "Webflow",
      "Framer",
      "Plausible",
      "Fathom",
      "PostHog",
      "Mixpanel",
      "Amplitude",
      "Segment",
      "Customer.io",
      "Klaviyo",
      "Buffer",
      "Typefully",
      "Hootsuite",
      "Later",
    ],
  ],
  [
    "Data",
    [
      "Snowflake",
      "BigQuery",
      "Redshift",
      "ClickHouse",
      "MotherDuck",
      "Metabase",
      "Hex",
      "Mode",
      "dbt Cloud",
      "Fivetran",
      "Airbyte",
      "Census",
      "Hightouch",
      "Pinecone",
      "Weaviate",
      "Qdrant",
      "Algolia",
      "Typesense",
      "Elastic",
      "OpenSearch",
    ],
  ],
  [
    "Media",
    [
      "TMDB",
      "Spotify",
      "YouTube",
      "Vimeo",
      "Mux",
      "Cloudinary",
      "Unsplash",
      "Pexels",
      "Figma",
      "Canva",
      "Dribbble",
      "Behance",
      "SoundCloud",
      "Bandcamp",
      "Last.fm",
      "Letterboxd",
      "Goodreads",
      "Pocket Casts",
      "Podchaser",
      "Giphy",
    ],
  ],
] as const;
const verbs = ["Read", "Search", "Create", "Update", "Sync"] as const;

function buildCatalog(): PluginCatalogEntryView[] {
  const entries: PluginCatalogEntryView[] = [];
  for (const [, names] of catalogCategories)
    for (const name of names)
      entries.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
        name,
        description: `${name} for your agents: read and change what's in your ${name} account.`,
        icon: null,
        auth: [
          { method: "apiKey", kind: "secrets", label: "API key" },
          ...(name.length % 3 === 0
            ? []
            : [{ method: "oauth", kind: "oauth2" as const, label: "Sign in" }]),
        ],
      });
  // Long-tail wrappers so paging reaches a few hundred entries.
  for (let index = 0; index < 160; index += 1) {
    const base = catalogCategories[index % catalogCategories.length]![1][index % 20]!;
    const verb = verbs[index % verbs.length]!;
    entries.push({
      id: `${base.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-${verb.toLowerCase()}-${index}`,
      name: `${base} ${verb} ${Math.floor(index / 35) + 1}`,
      description: `A focused ${verb.toLowerCase()} toolkit for ${base}.`,
      icon: null,
      auth: [{ method: "apiKey", kind: "secrets", label: "API key" }],
    });
  }
  return entries;
}

interface MockRequirement {
  readonly name: string;
  readonly scope: "app" | "user";
  readonly provider: string;
  readonly providerName: string;
  readonly sites: readonly string[];
  readonly credential: "sealed" | "value";
  readonly cardinality: "one" | "many";
}
interface MockPlugin {
  id: string;
  name: string;
  author: "catalog" | "agent";
  access: "all" | "read-only" | "off";
  activeVersion: string | null;
  versions: { id: string; createdAt: string; author: "catalog" | "agent" }[];
  requirements: MockRequirement[];
  /** account ids by requirement name; a `stale` link was reviewed against an older declaration. */
  links: { requirement: string; account: string; stale?: boolean }[];
  tools: { name: string; description: string; readOnly: boolean }[];
  skills: { name: string; description: string }[];
  schedules: InstalledPluginView["schedules"];
  workflows: InstalledPluginView["workflows"];
  webhooks: InstalledPluginView["webhooks"];
  hasPage: boolean;
  importWarnings?: string[];
  apiKeyOnly?: true;
}

function consentOf(plugin: MockPlugin, requirement: MockRequirement): PluginConsentView {
  return {
    digest: digest(`${plugin.id}:${requirement.name}:${requirement.sites.join(",")}`),
    sites: [...requirement.sites],
    credential: requirement.credential,
  };
}

const linearTools = [
  ["list_issues", "List issues by team, state, assignee or label.", true],
  ["get_issue", "Read one issue with its comments and history.", true],
  ["search_issues", "Search issue titles and descriptions.", true],
  ["create_issue", "Create an issue in a team.", false],
  ["update_issue", "Change an issue's state, assignee, priority or labels.", false],
  ["comment_on_issue", "Add a comment to an issue.", false],
  ["list_projects", "List projects and their progress.", true],
  ["list_cycles", "List a team's cycles.", true],
  ["list_labels", "List the labels a team uses.", true],
  ["create_label", "Add a label to a team.", false],
  ["list_users", "List people in the workspace.", true],
  ["archive_issue", "Archive an issue.", false],
  ["link_pull_request", "Attach a pull request to an issue.", false],
  ["list_comments", "Read an issue's comments.", true],
] as const;

/** Agent-written helpers, enough that the installed list pages. */
function manyPlugins(): MockPlugin[] {
  return Array.from({ length: 120 }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return {
      id: `plg_helper_${n}`,
      name: `Helper ${n}`,
      author: "agent",
      access: "all",
      activeVersion: `ver_helper_${n}`,
      versions: [{ id: `ver_helper_${n}`, createdAt: "2026-11-01T08:00:00.000Z", author: "agent" }],
      requirements: [],
      links: [],
      tools: [{ name: "run", description: "Run the helper.", readOnly: false }],
      skills: [],
      schedules: [],
      workflows: [],
      webhooks: [],
      hasPage: false,
    };
  });
}

/** Mock cursors are offsets, refused for any other listing as the Host refuses them. */
function mockPage<T>(items: readonly T[], scope: string, cursor: string | undefined, max: number) {
  let offset = 0;
  if (cursor) {
    const [from, at] = cursor.split("@");
    offset = Number(at);
    if (from !== scope || !Number.isInteger(offset) || offset < 0)
      throw refusal("bad_request", "This list changed. Open it again.", "plugin-cursor-stale");
  }
  const page = items.slice(offset, offset + max);
  const next = offset + page.length;
  return { items: page, cursor: next < items.length ? `${scope}@${next}` : null };
}
const byName = <T extends { readonly name: string }>(items: readonly T[]) =>
  [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const newestFirst = <T extends { readonly createdAt: string | null; readonly id: string }>(
  items: readonly T[],
) =>
  [...items].sort(
    (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id),
  );

function seedPlugins(): MockPlugin[] {
  const linearReq: MockRequirement = {
    name: "linear",
    scope: "app",
    provider: "linear",
    providerName: "Linear",
    sites: ["https://api.linear.app"],
    credential: "sealed",
    cardinality: "one",
  };
  return [
    {
      id: "plg_linear",
      name: "Linear",
      author: "catalog",
      access: "all",
      activeVersion: "ver_linear_3",
      versions: [
        { id: "ver_linear_3", createdAt: "2026-11-12T10:00:00.000Z", author: "catalog" },
        { id: "ver_linear_2", createdAt: "2026-11-02T09:00:00.000Z", author: "agent" },
        { id: "ver_linear_1", createdAt: "2026-10-20T15:30:00.000Z", author: "catalog" },
      ],
      requirements: [linearReq],
      links: [{ requirement: "linear", account: "acc_linear_work" }],
      tools: linearTools.map(([name, description, readOnly]) => ({ name, description, readOnly })),
      skills: [
        { name: "triage", description: "How to triage new issues the way this team does." },
        { name: "weekly-report", description: "Write the Friday report from closed issues." },
      ],
      schedules: [
        {
          name: "Sync assigned issues",
          tool: "list_issues",
          timing: { kind: "interval", milliseconds: 15 * 60_000 },
          settings: {
            id: "sch_linear_sync",
            enabled: true,
            approvalMode: "automatic",
            nextAt: "2026-11-16T21:15:00.000Z",
            running: false,
            accountRequired: null,
          },
        },
        {
          name: "Close stale issues",
          tool: "update_issue",
          timing: { kind: "cron", expression: "0 9 * * 1", timezone: "Europe/London" },
          settings: {
            id: "sch_linear_stale",
            enabled: true,
            approvalMode: "browser",
            nextAt: "2026-11-17T09:00:00.000Z",
            running: false,
            accountRequired: null,
          },
        },
      ],
      workflows: [
        {
          name: "Import backlog",
          description: "Copies a CSV backlog into Linear issues, one step per row.",
          inputSchema: {
            type: "object",
            properties: { team: { type: "string", title: "Team key" } },
            required: ["team"],
          },
        },
      ],
      webhooks: [
        {
          id: "whk_linear_issues",
          name: "Issue changes",
          status: "active",
          failure: null,
          account: "acc_linear_work",
          createdAt: "2026-11-02T09:05:00.000Z",
        },
        {
          id: "whk_linear_projects",
          name: "Project updates",
          status: "setup-required",
          failure: null,
          account: "acc_linear_work",
          createdAt: "2026-11-16T18:00:00.000Z",
        },
      ],
      hasPage: true,
    },
    {
      id: "plg_github",
      name: "GitHub",
      author: "catalog",
      access: "all",
      activeVersion: "ver_github_1",
      versions: [{ id: "ver_github_1", createdAt: "2026-11-14T08:00:00.000Z", author: "catalog" }],
      requirements: [
        {
          name: "github",
          scope: "app",
          provider: "github",
          providerName: "GitHub",
          sites: ["https://api.github.com", "https://uploads.github.com"],
          credential: "sealed",
          cardinality: "one",
        },
      ],
      links: [],
      tools: [],
      skills: [],
      schedules: [],
      workflows: null,
      webhooks: [],
      hasPage: false,
    },
    {
      id: "plg_stripe",
      name: "Stripe",
      author: "catalog",
      access: "read-only",
      activeVersion: "ver_stripe_1",
      versions: [{ id: "ver_stripe_1", createdAt: "2026-11-10T08:00:00.000Z", author: "catalog" }],
      requirements: [
        {
          name: "stripe",
          scope: "app",
          provider: "stripe",
          providerName: "Stripe",
          sites: ["https://api.stripe.com"],
          credential: "sealed",
          cardinality: "one",
        },
      ],
      links: [{ requirement: "stripe", account: "acc_stripe_live" }],
      tools: [
        { name: "list_payments", description: "List recent payments.", readOnly: true },
        { name: "get_customer", description: "Read a customer.", readOnly: true },
        { name: "refund_payment", description: "Refund a payment.", readOnly: false },
      ],
      skills: [],
      schedules: [],
      workflows: [],
      webhooks: [
        {
          id: "whk_stripe_payments",
          name: "Payment events",
          status: "setup-required",
          failure: null,
          account: "acc_stripe_live",
          createdAt: "2026-11-16T19:30:00.000Z",
        },
      ],
      hasPage: false,
    },
    {
      id: "plg_weather",
      name: "Weather notes",
      author: "agent",
      access: "off",
      activeVersion: "ver_weather_64",
      // An agent iterating on its own plugin: more versions than one page.
      versions: Array.from({ length: 64 }, (_, index) => ({
        id: `ver_weather_${64 - index}`,
        createdAt: new Date(Date.UTC(2026, 10, 15, 19) - index * 20 * 60_000).toISOString(),
        author: "agent" as const,
      })),
      requirements: [],
      links: [],
      tools: [{ name: "forecast", description: "Today's forecast for a city.", readOnly: true }],
      skills: [],
      schedules: [],
      workflows: [],
      webhooks: [],
      hasPage: false,
    },
    {
      id: "plg_invoices",
      name: "Invoice parser",
      author: "agent",
      access: "all",
      activeVersion: null,
      versions: [],
      requirements: [],
      links: [],
      tools: [],
      skills: [],
      schedules: [],
      workflows: null,
      webhooks: [],
      hasPage: false,
    },
    {
      id: "plg_resend",
      name: "Resend",
      author: "agent",
      access: "all",
      activeVersion: "ver_resend_2",
      versions: [
        { id: "ver_resend_2", createdAt: "2026-11-16T11:00:00.000Z", author: "agent" },
        { id: "ver_resend_1", createdAt: "2026-11-09T11:00:00.000Z", author: "catalog" },
      ],
      requirements: [
        {
          name: "resend",
          scope: "app",
          provider: "resend",
          providerName: "Resend",
          sites: [],
          credential: "value",
          cardinality: "one",
        },
      ],
      links: [{ requirement: "resend", account: "acc_resend", stale: true }],
      tools: [],
      skills: [],
      schedules: [],
      workflows: null,
      webhooks: [],
      hasPage: false,
    },
  ];
}

const seedAccounts: ConnectedAccountView[] = [
  { id: "acc_linear_work", provider: "linear", label: "Work workspace" },
  { id: "acc_linear_home", provider: "linear", label: "Side projects" },
  { id: "acc_stripe_live", provider: "stripe", label: "Live account" },
  { id: "acc_resend", provider: "resend", label: "Transactional key" },
  { id: "acc_github_old", provider: "github", label: "Personal token" },
];

/** How each seeded manual webhook is set up at its service, as a plugin declares it. */
const seedWebhookSetups: Record<
  string,
  {
    instructions: string;
    stateSchema: NonNullable<PluginWebhookSetupView["stateSchema"]>;
    secret: "provider" | string;
  }
> = {
  whk_linear_projects: {
    instructions:
      "In Linear, open Settings → API → Webhooks, add a webhook with the address below for Project updates, then paste the signing secret Linear shows and your workspace ID here.",
    stateSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          title: "Workspace ID",
          description: "Shown in Linear under Settings → Workspace.",
        },
      },
      required: ["workspace"],
    },
    secret: "provider",
  },
  whk_stripe_payments: {
    instructions:
      "In the Stripe dashboard, open Developers → Webhooks, add an endpoint with the address below, choose the payment events, and set the signing secret below. Then come back and press Done.",
    stateSchema: { type: "object", properties: {} },
    secret: "whsec_mock_5f2c9a1e7b3d4c8a",
  },
};

const studio = { id: "rnr_33333333-3333-4333-8333-333333333333", name: "Alex's MacBook Pro" };
/**
 * Device data apps and a local server, as the Host lists them beside plugins,
 * with the collision-safe names the Host gives agents.
 */
const seedLocalTools: Omit<PluginLocalToolView, "access" | "toolCount" | "readOnlyToolCount">[] = [
  {
    id: "app_device_con_calendar",
    kind: "device-app",
    name: "local-calendar-alex-s-macbook-pro-8c41d7e2",
    title: "Apple Calendar on Alex's MacBook Pro",
    computer: studio,
    unavailable: null,
    tools: [
      { name: "list_events", readOnly: true },
      { name: "create_event", readOnly: false },
      { name: "update_event", readOnly: false },
      { name: "delete_event", readOnly: false },
    ],
  },
  {
    id: "app_device_con_reminders",
    kind: "device-app",
    name: "local-reminders-alex-s-macbook-pro-1f6e93a0",
    title: "Apple Reminders on Alex's MacBook Pro",
    computer: studio,
    unavailable: null,
    tools: [
      { name: "list_reminders", readOnly: true },
      { name: "create_reminder", readOnly: false },
      { name: "update_reminder", readOnly: false },
    ],
  },
  {
    id: "app_device_con_photos",
    kind: "device-app",
    name: "local-photos-alex-s-iphone-5a2c8e1f",
    title: "Photos on Alex's iPhone",
    computer: { id: "rnr_44444444-4444-4444-8444-444444444444", name: "Alex's iPhone" },
    unavailable: "Alex's iPhone is offline. Open Opensteer on it to share its apps again.",
    tools: [],
  },
  {
    id: `app_server_${mockNotesServer.serverId}`,
    kind: "local-server",
    name: "local-notes-search-d93b0f6a",
    title: "Notes search",
    computer: { id: "rnr_11111111-1111-4111-8111-111111111111", name: "Home Mac" },
    unavailable: null,
    tools: [
      { name: "search_notes", readOnly: true },
      { name: "append_note", readOnly: false },
    ],
  },
];

export const mockPluginRequests = {
  account: { pluginId: "plg_github", pluginName: "GitHub", requirement: "github" },
  approval: {
    pluginId: "plg_linear",
    pluginName: "Linear",
    tool: "update_issue",
    arguments: { id: "ENG-412", state: "Done", assignee: "sam@example.com", priority: 2 },
  },
  input: {
    pluginId: "plg_linear",
    pluginName: "Linear",
    tool: "create_issue",
    message: "Which team should the new issue go to?",
    schema: {
      type: "object",
      properties: {
        team: {
          type: "string",
          title: "Team",
          oneOf: [
            { const: "ENG", title: "Engineering" },
            { const: "DES", title: "Design" },
            { const: "OPS", title: "Operations" },
          ],
        },
        title: { type: "string", title: "Title", description: "A short summary." },
        priority: { type: "integer", title: "Priority", description: "0 (none) to 4 (low)." },
        notify: { type: "boolean", title: "Tell the team in Slack" },
      },
      required: ["team", "title"],
    },
  },
} as const;
export function mockPluginAccountConsent(): PluginConsentView {
  const plugin = seedPlugins().find((entry) => entry.id === mockPluginRequests.account.pluginId)!;
  return consentOf(plugin, plugin.requirements[0]!);
}

const noPublicAddress =
  "No public callback address is currently available. Webhooks cannot be received; enable Connect or use a public Host address.";

function refusal(code: "not_found" | "conflict" | "bad_request", message: string, reason?: string) {
  return new HostClientRequestError({
    code,
    message,
    status: code === "not_found" ? 404 : code === "conflict" ? 409 : 400,
    ...(reason ? { reason } : {}),
  });
}

export class MockPlugins {
  readonly #removingWebhooks = new Set<string>();
  readonly catalog = buildCatalog();
  plugins: MockPlugin[];
  accounts: ConnectedAccountView[];
  scenario: MockPluginScenario;
  engine: PluginEngineStateView;
  readonly #engineListeners = new Set<(engine: PluginEngineStateView) => void>();
  readonly #changed: (change?: PluginChange) => void;
  readonly #accountLinked: (target: PluginRequirementTarget) => void;
  #started: Promise<void> | undefined;
  #nextId = 0;
  #runs: PluginScheduledRunView[] = [
    {
      id: "run_linear_stale_1",
      schedule: "Close stale issues",
      status: "awaiting-approval",
      scheduledAt: "2026-11-16T09:00:00.000Z",
      expiresAt: "2026-11-17T09:00:00.000Z",
      failure: null,
      approval: {
        tool: "update_issue",
        arguments: {
          ids: ["ENG-101", "ENG-133"],
          state: "Canceled",
          reason: "No activity in 90 days",
        },
      },
    },
    {
      id: "run_linear_sync_9",
      schedule: "Sync assigned issues",
      status: "succeeded",
      scheduledAt: "2026-11-16T20:45:00.000Z",
      expiresAt: null,
      failure: null,
      approval: null,
    },
    {
      id: "run_linear_sync_8",
      schedule: "Sync assigned issues",
      status: "failed",
      scheduledAt: "2026-11-16T20:30:00.000Z",
      expiresAt: null,
      failure: "Linear answered 503",
      approval: null,
    },
  ];
  /**
   * Runs as they were started; the Host lists them live first, then newest.
   * GitHub's run outlived the account link its current declarations need.
   */
  #workflowRuns: Record<string, PluginWorkflowRunView[]> = {
    plg_linear: [
      ["wfr_0a1", "complete", "2026-11-15T12:00:00.000Z"],
      ["wfr_1b7", "complete", "2026-11-14T09:30:00.000Z"],
      ["wfr_2c4", "errored", "2026-11-13T16:10:00.000Z"],
      ["wfr_3d9", "complete", "2026-11-12T08:00:00.000Z"],
      ["wfr_4e2", "terminated", "2026-11-11T19:45:00.000Z"],
      ["wfr_5f6", "complete", "2026-11-10T07:20:00.000Z"],
      ["wfr_6a8", "running", "2026-11-16T20:10:00.000Z"],
      ["wfr_7b1", "complete", "2026-11-09T11:00:00.000Z"],
      ["wfr_8c3", "complete", "2026-11-08T10:00:00.000Z"],
    ].map(([id, status, createdAt]) => ({
      id: id!,
      workflow: "Import backlog",
      status: status as PluginWorkflowRunView["status"],
      createdAt: createdAt!,
      failure: status === "errored" ? "Row 14 has no title" : null,
    })),
    plg_github: [
      {
        id: "wfr_9d0",
        workflow: "Mirror issues",
        status: "running",
        createdAt: "2026-11-13T08:00:00.000Z",
        failure: null,
      },
    ],
  };
  readonly #webhookSetups = new Map(Object.entries(seedWebhookSetups));

  constructor(options: {
    readonly changed: (change?: PluginChange) => void;
    readonly accountLinked: (target: PluginRequirementTarget) => void;
    readonly scenario?: MockPluginScenario;
  }) {
    this.#changed = options.changed;
    this.#accountLinked = options.accountLinked;
    const fromAddress =
      typeof globalThis.location?.search === "string"
        ? new URLSearchParams(globalThis.location.search).get("mock-plugins")
        : null;
    this.scenario =
      options.scenario ??
      mockPluginScenarios.find((scenario) => scenario === fromAddress) ??
      "default";
    this.plugins =
      this.scenario === "empty"
        ? []
        : this.scenario === "many"
          ? [...seedPlugins(), ...manyPlugins()]
          : seedPlugins();
    this.accounts = this.scenario === "empty" ? [] : [...seedAccounts];
    this.engine =
      this.scenario === "unavailable"
        ? { status: "unavailable", reason: "The plugin engine stopped three times in a row." }
        : this.scenario === "unsupported"
          ? {
              status: "unavailable",
              reason: "Plugins are unavailable: workerd cannot run on this darwin/arm64 system",
              unavailable: { code: "unsupported-system", minimumMacOS: "13.5" },
            }
          : { status: "idle" };
  }

  subscribeEngine(listener: (engine: PluginEngineStateView) => void) {
    this.#engineListeners.add(listener);
    return () => {
      this.#engineListeners.delete(listener);
    };
  }
  #setEngine(engine: PluginEngineStateView) {
    this.engine = engine;
    // A frame arrives after the read that caused it went out, as over a socket.
    setTimeout(() => {
      for (const listener of this.#engineListeners) listener(engine);
    }, 0);
  }
  /** The first read starts the engine, which takes a moment, as the real one does. */
  async #ready() {
    if (this.engine.status === "unavailable")
      throw refusal(
        "conflict",
        this.engine.reason ?? "The plugin engine is unavailable.",
        "plugin-engine-unavailable",
      );
    if (this.scenario === "error")
      throw refusal("conflict", "The plugin engine answered with an error.");
    this.#started ??= (async () => {
      this.#setEngine({ status: "starting" });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      this.#setEngine({ status: "ready" });
    })();
    await this.#started;
  }
  #plugin(id: string) {
    const plugin = this.plugins.find((entry) => entry.id === id);
    if (!plugin) throw refusal("not_found", "That plugin isn't installed anymore.");
    return plugin;
  }
  #id(prefix: string) {
    this.#nextId += 1;
    return `${prefix}_${Date.now().toString(36)}${this.#nextId}`;
  }

  #readiness(plugin: MockPlugin, requirement: MockRequirement) {
    const links = plugin.links.filter((link) => link.requirement === requirement.name);
    return links.some((link) => link.stale)
      ? "consent-needs-review"
      : !links.length && requirement.cardinality === "one"
        ? "required-but-missing"
        : "usable";
  }

  summary(plugin: MockPlugin): PluginSummaryView {
    const linked = plugin.requirements.filter((r) =>
      plugin.links.some((link) => link.requirement === r.name),
    );
    const readiness = plugin.requirements.map((r) => this.#readiness(plugin, r));
    const accountReadiness = readiness.includes("consent-needs-review")
      ? "consent-needs-review"
      : readiness.includes("required-but-missing")
        ? "required-but-missing"
        : "usable";
    return {
      id: plugin.id,
      name: plugin.name,
      slug: plugin.id.replace(/^plg_/u, ""),
      icon: null,
      author: plugin.author,
      access: plugin.access,
      activeVersion: plugin.activeVersion,
      status:
        plugin.activeVersion === null
          ? "not-built"
          : accountReadiness === "usable"
            ? "ready"
            : "needs-account",
      accountReadiness,
      accounts: { required: plugin.requirements.length, linked: linked.length },
    };
  }

  detail(plugin: MockPlugin): InstalledPluginView {
    const ready = plugin.requirements.every((r) => this.#readiness(plugin, r) === "usable");
    return {
      plugin: this.summary(plugin),
      requirements: plugin.requirements.map((r) => ({
        name: r.name,
        scope: r.scope,
        provider: r.provider,
        providerName: r.providerName,
        cardinality: r.cardinality,
        readiness: this.#readiness(plugin, r),
        consent: plugin.activeVersion ? consentOf(plugin, r) : null,
        links: plugin.links
          .filter((link) => link.requirement === r.name)
          .map((link) => ({
            account: this.accounts.find((account) => account.id === link.account) ?? {
              id: link.account,
              provider: r.provider,
              label: link.account,
            },
            current: !link.stale,
          })),
      })),
      ...(plugin.importWarnings ? { importWarnings: plugin.importWarnings } : {}),
      tools:
        ready && plugin.activeVersion
          ? byName(plugin.tools).slice(0, pluginDetailPreview.tools)
          : null,
      toolCount: ready && plugin.activeVersion ? plugin.tools.length : 0,
      skills:
        ready && plugin.activeVersion
          ? byName(plugin.skills).slice(0, pluginDetailPreview.skills)
          : null,
      skillCount: ready && plugin.activeVersion ? plugin.skills.length : 0,
      versions: this.versions(plugin).slice(0, pluginDetailPreview.versions),
      versionCount: plugin.versions.length,
      schedules: plugin.schedules,
      workflows: ready ? plugin.workflows : null,
      webhooks: plugin.webhooks,
      // The Host's own sentences for background work that can't run.
      backgroundUnavailable:
        plugin.access === "off"
          ? "This plugin is off. Its schedules, webhooks and workflows cannot run."
          : plugin.links.some((link) => link.stale)
            ? "Review and link the changed account declaration before this plugin can run."
            : null,
      webhookUnavailable:
        this.scenario === "local-only" && plugin.webhooks.length ? noPublicAddress : null,
      page: plugin.hasPage
        ? {
            reference: { kind: "plugin", pluginId: plugin.id },
            // As on the Host: only turning the plugin off closes its page.
            unavailable: plugin.access === "off" ? "Turn this plugin on to open its page." : null,
          }
        : null,
    };
  }

  versions(plugin: MockPlugin) {
    return newestFirst(plugin.versions).map((version) => ({
      id: version.id,
      createdAt: version.createdAt,
      active: version.id === plugin.activeVersion,
      author: version.author,
    }));
  }

  /** The order the Host lists installed plugins in: those needing the person first. */
  installedOrder() {
    return this.plugins
      .map((plugin) => this.summary(plugin))
      .sort(
        (a, b) =>
          Number(a.status === "ready") - Number(b.status === "ready") ||
          a.name.localeCompare(b.name),
      );
  }

  review(target: PluginRequirementTarget): PluginAccountReviewView {
    const plugin = this.#plugin(target.pluginId);
    const requirement = plugin.requirements.find(
      (r) => r.name === target.requirement && r.scope === target.scope,
    );
    if (!requirement)
      throw refusal(
        "conflict",
        "This plugin no longer asks for that account.",
        "plugin-consent-changed",
      );
    return {
      plugin: { id: plugin.id, name: plugin.name, author: plugin.author },
      requirement: {
        name: requirement.name,
        scope: requirement.scope,
        provider: requirement.provider,
        providerName: requirement.providerName,
        cardinality: requirement.cardinality,
      },
      consent: consentOf(plugin, requirement),
      signIn: requirement.provider !== "resend" && !plugin.apiKeyOnly,
      methods: [
        {
          method: "apiKey",
          label: "API key",
          fields: [
            {
              name: "token",
              title: requirement.provider === "github" ? "Personal access token" : "API key",
              description: `Create one in your ${requirement.providerName} settings.`,
              type: "string",
              choices: null,
              required: true,
              plain: false,
            },
            ...(requirement.provider === "github"
              ? [
                  {
                    name: "baseUrl",
                    title: "Enterprise server",
                    description: "Leave empty for github.com.",
                    type: "string" as const,
                    choices: null,
                    required: false,
                    plain: true,
                  },
                ]
              : []),
          ],
        },
      ],
      accounts: this.accounts.filter((account) => account.provider === requirement.provider),
      linked: plugin.links
        .filter((link) => link.requirement === requirement.name)
        .map((link) => link.account),
    };
  }

  /* ---- Sign-in ---- */

  readonly #connections = new Map<string, PluginRequirementTarget>();
  readonly #attempts = new Map<
    string,
    {
      readonly target: PluginRequirementTarget;
      readonly connection: string;
      readonly startedAt: number;
      readonly expiresAt: string;
      status: PluginOAuthStatus["status"];
      account: string | null;
    }
  >();
  /** OAuth apps the person saved, by issuer. */
  readonly #apps: { id: string; issuer: string; clientId: string; hasSecret: boolean }[] = [];

  #issuer(target: PluginRequirementTarget) {
    return `https://${this.review(target).requirement.provider}.example/oauth`;
  }
  /** What a connection offers now; its review digest changes whenever that does. */
  #methods(connection: string): Omit<PluginOAuthMethods, "type"> {
    const target = this.#connections.get(connection);
    if (!target) throw refusal("not_found", "Plugin sign-in is unavailable or expired");
    const review = this.review(target);
    const provider = review.requirement.provider;
    const issuer = this.#issuer(target);
    const clients = this.#apps
      .filter((app) => app.issuer === issuer)
      .map((app) => ({
        id: app.id,
        issuer,
        clientId: app.clientId,
        source: "manual",
        hasSecret: app.hasSecret,
        createdAt: "2026-11-16T12:00:00.000Z",
      }));
    const setup = {
      kind: "oauth2",
      grant: "authorization_code",
      mode: provider === "linear" ? "automatic" : "client-required",
      scopes: provider === "github" ? ["repo", "read:user"] : ["read", "write"],
      resource: { value: null, source: "none" },
      issuer,
      clients,
      // Stripe has no one-click app here: it signs in only with an app of the person's own.
      ...(provider === "stripe"
        ? { oneClickUnavailable: "no-provider-app" }
        : { firstParty: { label: "Opensteer" } }),
    };
    return {
      connection,
      consent: review.consent,
      redirectUri: "https://accounts.opensteer.com/v1/oauth-broker/callback/plugin",
      methods: [
        {
          method: "oauth",
          oneClick: provider !== "stripe",
          review: digest(`${connection}:${JSON.stringify(clients)}`)
            .slice(0, 43)
            .replace(/[^A-Za-z0-9_-]/gu, "A"),
          setup,
        },
      ],
    };
  }
  /** `?mock-plugin-signin=` ends sign-ins as `denied`, `failed`, `expired` or `slow`, or refuses them. */
  #signInScenario() {
    return typeof globalThis.location?.search === "string"
      ? new URLSearchParams(globalThis.location.search).get("mock-plugin-signin")
      : null;
  }
  #attemptStatus(id: string, returned = false): PluginOAuthStatus {
    const attempt = this.#attempts.get(id);
    if (!attempt) throw refusal("not_found", "Plugin sign-in is unavailable or expired");
    const scenario = this.#signInScenario();
    const due =
      returned || Date.now() - attempt.startedAt >= (scenario === "slow" ? 60_000 : 2_500);
    if (attempt.status === "launched" && due) {
      if (scenario === "denied") attempt.status = "denied";
      else if (scenario === "failed") attempt.status = "failed";
      else if (scenario === "expired") attempt.status = "expired";
      else {
        const account: ConnectedAccountView = {
          id: this.#id("acc"),
          provider: this.review(attempt.target).requirement.provider,
          label: "Signed in just now",
        };
        this.accounts.push(account);
        this.#link(attempt.target, account.id);
        attempt.status = "completed";
        attempt.account = account.id;
      }
    }
    return {
      attemptId: IntegrationAuthorizationAttemptIdSchema.parse(id),
      connection: attempt.connection,
      account: attempt.account,
      expiresAt: attempt.expiresAt,
      status: attempt.status,
      failureCode: attempt.status === "failed" ? "scope-escalation" : null,
    };
  }

  signInReads(): Pick<
    HostApiHandlers,
    "plugin.authorization.get" | "plugin.authorization.methods"
  > {
    return {
      "plugin.authorization.get": async ({ attemptId }) =>
        rpcSuccess(this.#attemptStatus(attemptId)),
      "plugin.authorization.methods": async ({ connection }) =>
        rpcSuccess(this.#methods(connection)),
    };
  }

  async signInCommand(command: MockSignInCommand): Promise<MockSignInResult> {
    await this.#ready();
    switch (command.type) {
      case "plugin.authorization.prepare": {
        const target = {
          pluginId: command.input.plugin,
          requirement: command.input.requirement,
          scope: command.input.scope,
        };
        this.review(target);
        const connection = `con_${crypto.randomUUID()}`;
        this.#connections.set(connection, target);
        return { type: command.type, ...this.#methods(connection) };
      }
      case "plugin.authorization.begin": {
        const input = command.input;
        const offered = this.#methods(input.connection);
        const method = offered.methods.find((entry) => entry.method === input.method);
        if (this.#signInScenario() === "account-link")
          throw refusal(
            "conflict",
            "Link this Host to Opensteer Account before starting sign-in remotely",
            "plugin-account-link-required",
          );
        if (
          !method ||
          method.review !== input.review ||
          offered.consent.digest !== input.consent.digest ||
          this.#signInScenario() === "changed"
        )
          throw refusal(
            "conflict",
            "Sign-in scopes or client configuration changed. Review them again.",
            "plugin-consent-changed",
          );
        const target = this.#connections.get(input.connection)!;
        this.#connections.delete(input.connection);
        const client = input.client;
        if (client && "clientId" in client && client.save)
          this.#apps.push({
            id: this.#id("oac"),
            issuer: this.#issuer(target),
            clientId: client.clientId,
            hasSecret: client.clientSecret !== undefined,
          });
        const attemptId = IntegrationAuthorizationAttemptIdSchema.parse(
          `ioa_${crypto.randomUUID()}`,
        );
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        this.#attempts.set(attemptId, {
          target,
          connection: input.connection,
          startedAt: Date.now(),
          expiresAt,
          status: "launched",
          account: null,
        });
        return {
          type: command.type,
          attemptId,
          connection: input.connection,
          expiresAt,
          launchTicket: "t".repeat(43),
        };
      }
      case "plugin.authorization.return":
        return { type: command.type, ...this.#attemptStatus(command.attemptId, true) };
      case "plugin.authorization.cancel": {
        const attempt = this.#attempts.get(command.attemptId);
        if (attempt?.status === "launched") attempt.status = "cancelled";
        return { type: command.type, ...this.#attemptStatus(command.attemptId) };
      }
      case "plugin.oauthApp.save": {
        const app = {
          id: this.#id("oac"),
          issuer: command.input.issuer,
          clientId: command.input.clientId,
          hasSecret: command.input.clientSecret !== undefined,
        };
        this.#apps.push(app);
        return {
          type: command.type,
          client: {
            id: app.id,
            issuer: app.issuer,
            clientId: app.clientId,
            hasSecret: app.hasSecret,
          },
        };
      }
      case "plugin.oauthApp.remove": {
        const index = this.#apps.findIndex((app) => app.id === command.client);
        if (index >= 0) this.#apps.splice(index, 1);
        return { type: command.type };
      }
    }
  }

  readonly #localAccess = new Map<string, PluginLocalToolView["access"]>();
  readonly #removedLocal = new Set<string>();
  /** A local server removed on its own page leaves the list. */
  removeLocal(id: string): void {
    this.#removedLocal.add(id);
  }
  local(): PluginLocalToolView[] {
    return seedLocalTools
      .filter((tool) => !this.#removedLocal.has(tool.id))
      .map((tool) => ({
        ...tool,
        toolCount: tool.tools.length,
        readOnlyToolCount: tool.tools.filter(({ readOnly }) => readOnly).length,
        access: this.#localAccess.get(tool.id) ?? "all",
      }));
  }
  localSummaries(): PluginLocalToolSummaryView[] {
    return this.local().map(({ tools: _tools, ...tool }) => tool);
  }

  #link(target: PluginRequirementTarget, accountId: string) {
    const plugin = this.#plugin(target.pluginId);
    const requirement = plugin.requirements.find((r) => r.name === target.requirement);
    plugin.links = [
      ...plugin.links.filter(
        (link) =>
          link.requirement !== target.requirement ||
          (requirement?.cardinality === "many" && link.account !== accountId),
      ),
      { requirement: target.requirement, account: accountId },
    ];
    this.#accountLinked(target);
    this.#changed();
  }

  reads(): Pick<HostApiHandlers, keyof typeof pluginReads> {
    return {
      "plugins.page.view": async ({ pluginId, theme }) => {
        await this.#ready();
        const plugin = this.#plugin(pluginId);
        if (!plugin.hasPage || plugin.access === "off")
          throw refusal("not_found", "Plugin page is unavailable");
        const document = prepareAppHtml(
          `<!doctype html><html style="font:16px system-ui;padding:24px"><head><title>Plugin page</title></head><body><h1>${plugin.name}</h1><p>Your plugin's page opens here.</p><label>Find an issue <input placeholder="Search issues"></label><p>Connected to your work account</p></body></html>`,
          theme,
        );
        return rpcSuccess({
          path: "/mock-plugin-page",
          entryUrl: `data:text/html,${encodeURIComponent(document)}`,
        });
      },
      "plugins.installed.list": async () => {
        const local = this.scenario === "empty" ? [] : this.localSummaries();
        // Local tools never wait on the engine: until it is ready the list goes without
        // plugins, and a change notice follows once it can say.
        if (this.engine.status !== "ready") {
          if (this.scenario === "error") await this.#ready();
          if (this.engine.status !== "unavailable" && !this.#started)
            void this.#ready().then(
              () => this.#changed(),
              () => this.#changed(),
            );
          return rpcSuccess({
            engine: this.engine.status === "idle" ? { status: "starting" } : this.engine,
            plugins: null,
            cursor: null,
            local,
          });
        }
        const page = mockPage(
          this.installedOrder(),
          "installed",
          undefined,
          pluginsInstalledPageMax,
        );
        return rpcSuccess({ engine: this.engine, plugins: page.items, cursor: page.cursor, local });
      },
      "plugins.installed.page": async ({ cursor }) => {
        await this.#ready();
        const page = mockPage(this.installedOrder(), "installed", cursor, pluginsInstalledPageMax);
        return rpcSuccess({ plugins: page.items, cursor: page.cursor });
      },
      "plugins.local.get": async ({ id }) => {
        const tool =
          this.scenario === "empty" ? undefined : this.local().find((entry) => entry.id === id);
        if (!tool)
          throw refusal(
            "not_found",
            "This isn't available to agents anymore. It may have been removed on its device.",
          );
        return rpcSuccess(tool);
      },
      "plugins.get": async ({ pluginId }) => {
        await this.#ready();
        return rpcSuccess(
          hostApi["plugins.get"].success.parse(this.detail(this.#plugin(pluginId))),
        );
      },
      "plugins.tools.list": async ({ pluginId, cursor }) => {
        await this.#ready();
        const plugin = this.#plugin(pluginId);
        const tools = this.detail(plugin).tools === null ? [] : byName(plugin.tools);
        const page = mockPage(
          tools,
          `tools:${pluginId}:${plugin.activeVersion}`,
          cursor,
          pluginDetailPageMax,
        );
        return rpcSuccess({ tools: page.items, cursor: page.cursor });
      },
      "plugins.skills.list": async ({ pluginId, cursor }) => {
        await this.#ready();
        const plugin = this.#plugin(pluginId);
        const skills = this.detail(plugin).skills === null ? [] : byName(plugin.skills);
        const page = mockPage(
          skills,
          `skills:${pluginId}:${plugin.activeVersion}`,
          cursor,
          pluginDetailPageMax,
        );
        return rpcSuccess({ skills: page.items, cursor: page.cursor });
      },
      "plugins.versions.list": async ({ pluginId, cursor }) => {
        await this.#ready();
        const plugin = this.#plugin(pluginId);
        const page = mockPage(
          this.versions(plugin),
          `versions:${pluginId}`,
          cursor,
          pluginDetailPageMax,
        );
        return rpcSuccess({ versions: page.items, cursor: page.cursor });
      },
      "plugins.catalog.list": async ({ search, cursor, limit }) => {
        await this.#ready();
        const text = search?.trim().toLocaleLowerCase() ?? "";
        const matched = text
          ? this.catalog.filter((entry) =>
              `${entry.id} ${entry.name}`.toLocaleLowerCase().includes(text),
            )
          : this.catalog;
        const offset = cursor ? Number(cursor.split(":")[1]) : 0;
        if (cursor && (cursor.split(":")[0] !== text || !Number.isInteger(offset)))
          throw refusal("bad_request", "Catalog changed or cursor is invalid; restart the listing");
        const items = matched.slice(offset, offset + (limit ?? 30));
        const next = offset + items.length;
        // A weak link takes a moment per page; enough to see the loading row.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return rpcSuccess({
          items,
          cursor: next < matched.length ? `${text}:${next}` : null,
          catalog: "listed" as const,
        });
      },
      "plugins.catalog.get": async ({ catalogId }) => {
        const entry = this.catalog.find((candidate) => candidate.id === catalogId);
        if (!entry) throw refusal("not_found", "Catalog entry not found");
        return rpcSuccess(entry);
      },
      "plugins.accounts.list": async () => {
        await this.#ready();
        const requirements = this.plugins.flatMap((plugin) => plugin.requirements);
        return rpcSuccess({
          accounts: this.accounts
            .map((account) => ({
              ...account,
              providerName:
                requirements.find((r) => r.provider === account.provider)?.providerName ??
                `${account.provider[0]!.toLocaleUpperCase()}${account.provider.slice(1).replace(/[-_]+/gu, " ")}`,
              links: this.plugins
                .filter((plugin) => plugin.links.some((link) => link.account === account.id))
                .map((plugin) => ({ pluginId: plugin.id, pluginName: plugin.name }))
                .sort((a, b) => a.pluginName.localeCompare(b.pluginName)),
            }))
            .sort(
              (a, b) =>
                a.providerName.localeCompare(b.providerName) || a.label.localeCompare(b.label),
            ),
        });
      },
      "plugins.account.review": async (target) => {
        await this.#ready();
        return rpcSuccess(this.review(target));
      },
      "plugins.schedule.runs": async ({ pluginId, cursor, pending }) => {
        await this.#ready();
        this.#plugin(pluginId);
        const runs = pluginId === "plg_linear" ? this.#runs : [];
        const page = mockPage(
          runs.filter(({ status }) => status === "awaiting-approval"),
          `approvals:${pluginId}`,
          cursor,
          pluginScheduleApprovalsPageMax,
        );
        return rpcSuccess({
          pending: page.items,
          cursor: page.cursor,
          runs: cursor
            ? []
            : (pending ? runs.filter(({ status }) => status === "awaiting-approval") : runs).slice(
                0,
                pluginRunsMax,
              ),
        });
      },
      "plugins.workflow.runs": async ({ pluginId, workflow, cursor, runIds }) => {
        await this.#ready();
        this.#plugin(pluginId);
        // As the Host pages: newest first by creation, unfinished runs added to the first page.
        const runs = newestFirst(
          (this.#workflowRuns[pluginId] ?? []).filter(
            (run) => workflow === undefined || run.workflow === workflow,
          ),
        );
        if (runIds)
          return rpcSuccess({ runs: runs.filter(({ id }) => runIds.includes(id)), cursor: null });
        const lane = cursor
          ? []
          : runs.filter(pluginWorkflowRunLive).slice(0, Math.floor(pluginRunsMax / 2));
        const page = mockPage(
          runs,
          `runs:${pluginId}:${workflow ?? ""}`,
          cursor,
          pluginRunsMax - lane.length,
        );
        return rpcSuccess({
          runs: [...lane, ...page.items.filter((run) => !lane.includes(run))],
          cursor: page.cursor,
        });
      },
      "plugins.webhook.setup.get": async ({ pluginId, webhookId }) => {
        const webhook = this.#plugin(pluginId).webhooks.find((entry) => entry.id === webhookId);
        if (!webhook) throw refusal("not_found", "That webhook is gone.");
        const setup = this.#webhookSetups.get(webhook.id);
        const step = this.#removingWebhooks.has(webhook.id)
          ? "remove"
          : webhook.status === "setup-required"
            ? "configure"
            : "done";
        return rpcSuccess({
          unavailable: this.scenario === "local-only" ? noPublicAddress : null,
          step,
          webhook,
          callbackUrl: `https://hooks.opensteer.example/hooks/v1/plugins/${pluginId}/${webhook.id}`,
          instructions:
            step === "remove"
              ? "Remove this webhook in the service settings, then confirm below."
              : step === "configure"
                ? (setup?.instructions ?? null)
                : null,
          revision: step === "configure" ? "mock-webhook-1" : null,
          stateSchema: step === "configure" ? (setup?.stateSchema ?? {}) : null,
          signingSecret:
            step === "configure" && setup && setup.secret !== "provider" ? setup.secret : null,
        });
      },
    };
  }

  async command(command: PluginCommand): Promise<PluginCommandResult> {
    // A local tool's access is a Host setting; it never waits on the engine.
    if (
      command.type === "plugins.access.set" &&
      seedLocalTools.some(({ id }) => id === command.pluginId)
    ) {
      this.#localAccess.set(command.pluginId, command.access);
      this.#changed();
      return { type: command.type, access: command.access };
    }
    await this.#ready();
    switch (command.type) {
      case "plugins.install": {
        const source = command.source;
        const entry =
          source.kind === "catalog"
            ? this.catalog.find((candidate) => candidate.id === source.catalogId)
            : null;
        if (source.kind === "catalog" && !entry)
          throw refusal("not_found", "Catalog entry not found");
        const name = entry?.name ?? (source.kind === "catalog" ? source.catalogId : source.name);
        if (source.kind !== "catalog" && source.url.includes("broken"))
          return {
            type: command.type,
            result: {
              status: "build-error",
              message: `index.ts(12,3): ${name} declares a tool without an input schema.`,
            },
          };
        await new Promise((resolve) => setTimeout(resolve, 900));
        const id = this.#id("plg");
        const versionId = this.#id("ver");
        const provider = (entry?.id ?? id).split("-")[0]!;
        const needsAccount = entry ? entry.auth.length > 0 : source.kind === "openapi";
        const warnings =
          source.kind === "openapi" && source.url.includes("partial")
            ? ["GET /restricted — Unsupported authentication: legacy (oauth2)."]
            : undefined;
        this.plugins.push({
          id,
          name,
          author: source.kind === "catalog" ? "catalog" : "agent",
          access: "all",
          activeVersion: versionId,
          versions: [
            {
              id: versionId,
              createdAt: new Date().toISOString(),
              author: source.kind === "catalog" ? "catalog" : "agent",
            },
          ],
          requirements: needsAccount
            ? [
                {
                  name: source.kind === "openapi" ? "service" : provider,
                  scope: source.kind === "openapi" ? "user" : "app",
                  provider,
                  providerName: name,
                  sites: [
                    source.kind === "openapi"
                      ? new URL(source.url).origin
                      : `https://api.${provider}.example`,
                  ],
                  credential: "sealed",
                  cardinality: "one",
                },
              ]
            : [],
          links: [],
          tools: [{ name: "search", description: `Search ${name}.`, readOnly: true }],
          skills: [],
          schedules: [],
          workflows: [],
          webhooks: [],
          hasPage: false,
          ...(warnings ? { importWarnings: warnings } : {}),
          ...(source.kind === "openapi" ? { apiKeyOnly: true as const } : {}),
        });
        this.#changed();
        return {
          type: command.type,
          result: {
            status: "installed",
            pluginId: id,
            versionId,
            ...(warnings ? { warnings } : {}),
          },
        };
      }
      case "plugins.version.activate": {
        const plugin = this.#plugin(command.pluginId);
        if (!plugin.versions.some((version) => version.id === command.versionId))
          throw refusal("not_found", "That version is no longer kept.");
        plugin.activeVersion = command.versionId;
        this.#changed();
        return { type: command.type };
      }
      case "plugins.remove": {
        const plugin = this.#plugin(command.pluginId);
        // The engine's own refusals: background work must be cleaned up first.
        if (plugin.webhooks.some((webhook) => webhook.status !== "stopped"))
          throw refusal(
            "conflict",
            "Remove this plugin's webhook subscriptions before removing the plugin.",
            "plugin-webhooks-active",
          );
        if (
          (this.#workflowRuns[plugin.id] ?? []).some((run) =>
            ["queued", "running"].includes(run.status),
          )
        )
          throw refusal(
            "conflict",
            "Stop this plugin's workflow runs before removing the plugin.",
            "plugin-workflows-active",
          );
        this.plugins = this.plugins.filter((entry) => entry.id !== command.pluginId);
        this.#changed();
        return { type: command.type };
      }
      case "plugins.access.set":
        this.#plugin(command.pluginId).access = command.access;
        this.#changed();
        return { type: command.type, access: command.access };
      case "plugins.account.create": {
        const values = Object.values(command.fields);
        if (values.some((value) => typeof value === "string" && value.startsWith("bad")))
          throw refusal("bad_request", "The key fields are invalid.", "plugin-key-invalid");
        const account: ConnectedAccountView = {
          id: this.#id("acc"),
          provider: command.provider,
          label: command.label ?? `${command.provider} key`,
        };
        this.accounts.push(account);
        if (command.link) this.#checkedLink(command.link, account.id);
        this.#changed();
        return { type: command.type, account };
      }
      case "plugins.account.remove":
        this.accounts = this.accounts.filter((account) => account.id !== command.accountId);
        for (const plugin of this.plugins)
          plugin.links = plugin.links.filter((link) => link.account !== command.accountId);
        this.#changed();
        return { type: command.type };
      case "plugins.account.link":
        this.#checkedLink(command, command.accountId);
        return { type: command.type };
      case "plugins.account.unlink": {
        const plugin = this.#plugin(command.pluginId);
        plugin.links = plugin.links.filter(
          (link) => link.requirement !== command.requirement || link.account !== command.accountId,
        );
        this.#changed();
        return { type: command.type };
      }
      case "plugins.schedule.configure": {
        const schedule = this.#plugin(command.pluginId).schedules.find(
          (entry) => entry.name === command.schedule,
        );
        if (!schedule) throw refusal("not_found", "That schedule is gone.");
        schedule.settings = {
          id: schedule.settings?.id ?? this.#id("sch"),
          enabled: command.enabled,
          approvalMode: command.approvalMode ?? schedule.settings?.approvalMode ?? "automatic",
          nextAt: command.enabled ? new Date(Date.now() + 15 * 60_000).toISOString() : null,
          running: false,
          accountRequired: null,
        };
        this.#changed({ pluginId: command.pluginId, categories: ["schedules"] });
        return { type: command.type };
      }
      case "plugins.schedule.answer": {
        const run = this.#runs.find((entry) => entry.id === command.runId);
        if (!run || run.status !== "awaiting-approval")
          throw refusal("conflict", "That run isn't waiting anymore.");
        this.#runs = this.#runs.map((entry) =>
          entry.id === run.id
            ? {
                ...entry,
                status: command.action === "accept" ? "succeeded" : "denied",
                approval: null,
              }
            : entry,
        );
        this.#changed({ pluginId: command.pluginId, categories: ["scheduledRuns"] });
        return { type: command.type };
      }
      case "plugins.workflow.start": {
        const runId = this.#id("wfr");
        this.#workflowRuns[command.pluginId] = [
          ...(this.#workflowRuns[command.pluginId] ?? []),
          {
            id: runId,
            workflow: command.workflow,
            status: "queued",
            createdAt: new Date().toISOString(),
            failure: null,
          },
        ];
        this.#changed({ pluginId: command.pluginId, categories: ["workflowRuns"] });
        return { type: command.type, runId };
      }
      case "plugins.workflow.stop":
        this.#workflowRuns[command.pluginId] = (this.#workflowRuns[command.pluginId] ?? []).map(
          (run) => (run.id === command.runId ? { ...run, status: "terminated" } : run),
        );
        this.#changed({ pluginId: command.pluginId, categories: ["workflowRuns"] });
        return { type: command.type };
      case "plugins.webhook.setup.complete": {
        const webhook = this.#plugin(command.pluginId).webhooks.find(
          (entry) => entry.id === command.webhookId,
        );
        if (!webhook) throw refusal("not_found", "That webhook is gone.");
        if (webhook.status === "active") return { type: command.type };
        if (webhook.status !== "setup-required" || command.revision !== "mock-webhook-1")
          throw refusal("conflict", "Webhook setup changed. Open it again.");
        // The engine's own checks: a provider's secret must come with it, a generated one never.
        const setup = this.#webhookSetups.get(webhook.id);
        const state = command.state as Record<string, unknown> | null;
        const required = (setup?.stateSchema.required as string[] | undefined) ?? [];
        if (
          (setup?.secret === "provider") !== (command.secret !== undefined) ||
          typeof state !== "object" ||
          state === null ||
          required.some((field) => typeof state[field] !== "string" || state[field] === "")
        )
          throw refusal("bad_request", "The service rejected that setup.", "plugin-invalid");
        webhook.status = "active";
        this.#changed({ pluginId: command.pluginId, categories: ["webhooks"] });
        return { type: command.type };
      }
      case "plugins.webhook.remove": {
        const webhook = this.#plugin(command.pluginId).webhooks.find(
          (entry) => entry.id === command.webhookId,
        );
        if (!webhook) throw refusal("not_found", "That webhook is gone.");
        webhook.status = "stopping";
        this.#removingWebhooks.add(webhook.id);
        this.#changed({ pluginId: command.pluginId, categories: ["webhooks"] });
        return { type: command.type };
      }
      case "plugins.webhook.removal.confirm": {
        const plugin = this.#plugin(command.pluginId);
        if (!this.#removingWebhooks.has(command.webhookId))
          throw refusal("conflict", "Remove the webhook before confirming its cleanup.");
        plugin.webhooks = plugin.webhooks.filter((entry) => entry.id !== command.webhookId);
        this.#removingWebhooks.delete(command.webhookId);
        this.#changed({ pluginId: command.pluginId, categories: ["webhooks"] });
        return { type: command.type };
      }
    }
  }

  /**
   * Removes every plugin the way a person must on the Host: stop live
   * workflow runs and clean up webhooks first, through the same commands.
   */
  async removeEverything() {
    const idempotencyKey = () => this.#id("key");
    for (const plugin of this.plugins) {
      for (const live of (this.#workflowRuns[plugin.id] ?? []).filter((entry) =>
        ["queued", "running"].includes(entry.status),
      ))
        await this.command({
          type: "plugins.workflow.stop",
          idempotencyKey: idempotencyKey(),
          pluginId: plugin.id,
          runId: live.id,
        });
      for (const webhook of plugin.webhooks.filter((entry) => entry.status !== "stopped")) {
        for (const type of ["plugins.webhook.remove", "plugins.webhook.removal.confirm"] as const)
          await this.command({
            type,
            idempotencyKey: idempotencyKey(),
            pluginId: plugin.id,
            webhookId: webhook.id,
          });
      }
      await this.command({
        type: "plugins.remove",
        idempotencyKey: idempotencyKey(),
        pluginId: plugin.id,
      });
    }
  }

  /** The service confirmed a webhook's setup on its own: background work the Host publishes. */
  confirmWebhookInBackground(pluginId: string, webhookId: string) {
    const webhook = this.#plugin(pluginId).webhooks.find((entry) => entry.id === webhookId);
    if (!webhook) throw new Error(`No webhook ${webhookId}`);
    webhook.status = "active";
    this.#changed();
  }

  #checkedLink(
    input: PluginRequirementTarget & { readonly consent: PluginConsentView },
    accountId: string,
  ) {
    const review = this.review(input);
    if (review.consent.digest !== input.consent.digest)
      throw refusal(
        "conflict",
        "Plugin declaration changed since review",
        "plugin-consent-changed",
      );
    if (
      !this.accounts.some(
        (account) => account.id === accountId && account.provider === review.requirement.provider,
      )
    )
      throw refusal("bad_request", "Account provider does not match the requirement");
    this.#link(input, accountId);
  }
}
