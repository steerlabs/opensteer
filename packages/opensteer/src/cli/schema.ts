import { getAllBrowserBrands } from "../local-browser/browser-brands.js";

interface CliOptionDefinition {
  readonly name: string;
  readonly description: string;
  readonly kind: "boolean" | "string" | "number" | "json" | "json-object" | "enum";
  readonly valueLabel?: string;
  readonly values?: readonly string[];
  readonly multiple?: boolean;
  readonly internalName?: string;
}

interface CliPositionalDefinition {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly variadic?: boolean;
}

export interface CliCommandDefinition {
  readonly name: string;
  readonly summary: string;
  readonly description?: string;
  readonly options?: readonly CliOptionDefinition[];
  readonly positionals?: readonly CliPositionalDefinition[];
  readonly subcommands?: readonly CliCommandDefinition[];
  readonly defaultSubcommand?: string;
  readonly id?: string;
  readonly examples?: readonly string[];
}

type ParsedOptionValue =
  | boolean
  | string
  | number
  | unknown
  | readonly boolean[]
  | readonly string[]
  | readonly number[]
  | readonly unknown[];

export interface ParsedCliInvocation {
  readonly commandId: string;
  readonly command: CliCommandDefinition;
  readonly commandPath: readonly string[];
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, ParsedOptionValue>>;
}

export type CliParseResult =
  | {
      readonly kind: "command";
      readonly invocation: ParsedCliInvocation;
    }
  | {
      readonly kind: "help";
      readonly command: CliCommandDefinition;
      readonly commandPath: readonly string[];
      readonly text: string;
    };

const HELP_OPTION: CliOptionDefinition = {
  name: "help",
  description: "Show this help",
  kind: "boolean",
};

const SESSION_NAME_OPTION: CliOptionDefinition = {
  name: "name",
  description: 'Session name (default: "default")',
  kind: "string",
  valueLabel: "name",
};

const ROOT_DIR_OPTION: CliOptionDefinition = {
  name: "root-dir",
  description: "Project root directory (default: process.cwd())",
  kind: "string",
  valueLabel: "path",
};

const OUTPUT_OPTION: CliOptionDefinition = {
  name: "output",
  description: "Write JSON output to a file instead of stdout",
  kind: "string",
  valueLabel: "path",
};

const DESCRIPTION_OPTION: CliOptionDefinition = {
  name: "description",
  description: "Persist or replay a semantic description",
  kind: "string",
  valueLabel: "text",
};

const SELECTOR_OPTION: CliOptionDefinition = {
  name: "selector",
  description: "Target element by CSS selector",
  kind: "string",
  valueLabel: "css",
};

const NETWORK_TAG_OPTION: CliOptionDefinition = {
  name: "network-tag",
  description: "Label network traffic triggered by this action",
  kind: "string",
  valueLabel: "tag",
};

const SESSION_OPTIONS = [SESSION_NAME_OPTION, ROOT_DIR_OPTION] as const;
const ACTION_TARGET_OPTIONS = [
  SESSION_NAME_OPTION,
  ROOT_DIR_OPTION,
  SELECTOR_OPTION,
  DESCRIPTION_OPTION,
] as const;
const PROFILE_SYNC_BROWSER_VALUES = getAllBrowserBrands().map((brand) => brand.id);
const PROFILE_SYNC_STRATEGY_VALUES = ["auto", "attach", "headless", "managed-relaunch"] as const;

function createRecipeCommandDefinition(input: {
  readonly name: "recipe" | "auth-recipe";
  readonly groupSummary: string;
  readonly writeSummary: string;
  readonly getSummary: string;
  readonly listSummary: string;
  readonly runSummary: string;
  readonly payloadLabel: string;
}): CliCommandDefinition {
  return {
    name: input.name,
    summary: input.groupSummary,
    defaultSubcommand: "list",
    subcommands: [
      {
        name: "write",
        id: `${input.name}.write`,
        summary: input.writeSummary,
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "id",
            description: "Optional recipe id",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "key",
            description: "Recipe key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "version",
            description: "Recipe version",
            kind: "string",
            valueLabel: "version",
          },
          {
            name: "tags",
            description: "Comma-separated tags",
            kind: "string",
            valueLabel: "tags",
          },
          {
            name: "payload",
            description: `Inline ${input.payloadLabel} payload JSON object`,
            kind: "json-object",
            valueLabel: "json",
          },
          {
            name: "payload-file",
            description: `Path to ${input.payloadLabel} payload JSON file`,
            kind: "string",
            valueLabel: "path",
            internalName: "payloadFile",
          },
          {
            name: "provenance-source",
            description: "Provenance source label",
            kind: "string",
            valueLabel: "source",
            internalName: "provenanceSource",
          },
          {
            name: "provenance-source-id",
            description: "Provenance source id",
            kind: "string",
            valueLabel: "id",
            internalName: "provenanceSourceId",
          },
          {
            name: "provenance-captured-at",
            description: "Provenance capture timestamp (ms)",
            kind: "number",
            valueLabel: "ms",
            internalName: "provenanceCapturedAt",
          },
          {
            name: "provenance-notes",
            description: "Provenance notes",
            kind: "string",
            valueLabel: "text",
            internalName: "provenanceNotes",
          },
        ],
      },
      {
        name: "get",
        id: `${input.name}.get`,
        summary: input.getSummary,
        positionals: [
          {
            name: "key",
            description: "Recipe key",
          },
          {
            name: "version",
            description: "Optional recipe version",
          },
        ],
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "key",
            description: "Recipe key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "version",
            description: "Recipe version",
            kind: "string",
            valueLabel: "version",
          },
        ],
      },
      {
        name: "list",
        id: `${input.name}.list`,
        summary: input.listSummary,
        positionals: [
          {
            name: "key",
            description: "Optional recipe key filter",
          },
        ],
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "key",
            description: "Recipe key filter",
            kind: "string",
            valueLabel: "key",
          },
        ],
      },
      {
        name: "run",
        id: `${input.name}.run`,
        summary: input.runSummary,
        positionals: [
          {
            name: "key",
            description: "Recipe key",
          },
        ],
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "key",
            description: "Recipe key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "version",
            description: "Recipe version",
            kind: "string",
            valueLabel: "version",
          },
          {
            name: "variables-json",
            description: "JSON object of initial recipe variables",
            kind: "json-object",
            valueLabel: "json",
            internalName: "variablesJson",
          },
        ],
      },
    ],
  };
}

const ROOT_COMMANDS: readonly CliCommandDefinition[] = [
  {
    name: "open",
    id: "open",
    summary: "Open a browser session and optionally navigate to a URL.",
    positionals: [
      {
        name: "url",
        description: "URL to open immediately after session creation",
      },
    ],
    options: [
      ...SESSION_OPTIONS,
      {
        name: "engine",
        description: "Browser engine",
        kind: "enum",
        valueLabel: "name",
        values: ["playwright", "abp"],
      },
      {
        name: "local",
        description: "Force local execution mode",
        kind: "boolean",
      },
      {
        name: "cloud",
        description: "Use Opensteer Cloud",
        kind: "boolean",
      },
      {
        name: "browser",
        description: "Browser mode",
        kind: "enum",
        valueLabel: "kind",
        values: ["managed", "snapshot-session", "snapshot-authenticated", "attach-live"],
      },
      {
        name: "headed",
        description: "Force a visible browser window",
        kind: "boolean",
      },
      {
        name: "headless",
        description: "Run browser headlessly",
        kind: "boolean",
      },
      {
        name: "executable-path",
        description: "Custom browser executable path",
        kind: "string",
        valueLabel: "path",
      },
      {
        name: "browser-arg",
        description: "Extra browser launch argument (repeatable)",
        kind: "string",
        valueLabel: "arg",
        multiple: true,
      },
      {
        name: "timeout-ms",
        description: "Session timeout in milliseconds",
        kind: "number",
        valueLabel: "ms",
      },
      {
        name: "attach-endpoint",
        description: "Chrome DevTools endpoint for browser attach-live mode",
        kind: "string",
        valueLabel: "endpoint",
        internalName: "attachEndpoint",
      },
      {
        name: "attach-header",
        description:
          "Extra attach header in NAME=VALUE form for explicit attach-live endpoint mode (repeatable)",
        kind: "string",
        valueLabel: "name=value",
        multiple: true,
        internalName: "attachHeader",
      },
      {
        name: "source-user-data-dir",
        description: "Source Chromium user-data root for snapshot browser modes",
        kind: "string",
        valueLabel: "path",
        internalName: "sourceUserDataDir",
      },
      {
        name: "source-profile-directory",
        description: "Source profile directory inside the snapshot source user-data-dir",
        kind: "string",
        valueLabel: "name",
        internalName: "sourceProfileDirectory",
      },
      {
        name: "fresh-tab",
        description: "Open a fresh tab when attaching through browser attach-live",
        kind: "boolean",
      },
      {
        name: "browser-json",
        description: "Full browser configuration as JSON",
        kind: "json-object",
        valueLabel: "json",
      },
      {
        name: "context-json",
        description: "Full browser context configuration as JSON",
        kind: "json-object",
        valueLabel: "json",
      },
      {
        name: "viewport",
        description: 'Viewport size, for example 1280x720, "null", or "none"',
        kind: "string",
        valueLabel: "viewport",
      },
      {
        name: "locale",
        description: "Browser locale",
        kind: "string",
        valueLabel: "locale",
      },
      {
        name: "timezone-id",
        description: "Browser timezone identifier",
        kind: "string",
        valueLabel: "tz",
      },
      {
        name: "user-agent",
        description: "Custom user agent string",
        kind: "string",
        valueLabel: "ua",
      },
      {
        name: "ignore-https-errors",
        description: "Ignore HTTPS certificate errors",
        kind: "boolean",
      },
      {
        name: "javascript-enabled",
        description: "Enable or disable JavaScript in the context",
        kind: "boolean",
      },
      {
        name: "bypass-csp",
        description: "Bypass Content Security Policy",
        kind: "boolean",
      },
      {
        name: "reduced-motion",
        description: "Reduced motion setting",
        kind: "enum",
        valueLabel: "mode",
        values: ["reduce", "no-preference"],
      },
      {
        name: "color-scheme",
        description: "Color scheme setting",
        kind: "enum",
        valueLabel: "scheme",
        values: ["light", "dark", "no-preference"],
      },
      {
        name: "cloud-profile-id",
        description: "Cloud browser profile ID",
        kind: "string",
        valueLabel: "id",
      },
      {
        name: "cloud-profile-reuse-if-active",
        description: "Reuse an active cloud session for the selected profile",
        kind: "boolean",
      },
    ],
    examples: [
      "opensteer open https://example.com --headless true",
      "opensteer open https://example.com --browser attach-live --fresh-tab",
    ],
  },
  {
    name: "goto",
    id: "goto",
    summary: "Navigate the active page to a URL.",
    positionals: [
      {
        name: "url",
        description: "Destination URL",
        required: true,
      },
    ],
    options: [...SESSION_OPTIONS, NETWORK_TAG_OPTION],
  },
  {
    name: "snapshot",
    id: "snapshot",
    summary: "Capture a snapshot of the current page.",
    positionals: [
      {
        name: "mode",
        description: 'Snapshot mode, for example "action" or "extraction"',
      },
    ],
    options: SESSION_OPTIONS,
  },
  {
    name: "click",
    id: "click",
    summary: "Click an element.",
    positionals: [
      {
        name: "target",
        description: "Element counter target",
      },
    ],
    options: [...ACTION_TARGET_OPTIONS, NETWORK_TAG_OPTION],
  },
  {
    name: "hover",
    id: "hover",
    summary: "Hover over an element.",
    positionals: [
      {
        name: "target",
        description: "Element counter target",
      },
    ],
    options: [...ACTION_TARGET_OPTIONS, NETWORK_TAG_OPTION],
  },
  {
    name: "input",
    id: "input",
    summary: "Type text into an element.",
    positionals: [
      {
        name: "target",
        description: "Element counter target",
      },
      {
        name: "text",
        description: "Text to type",
      },
    ],
    options: [
      ...ACTION_TARGET_OPTIONS,
      {
        name: "text",
        description: "Text to type",
        kind: "string",
        valueLabel: "text",
      },
      {
        name: "press-enter",
        description: "Press Enter after typing",
        kind: "boolean",
      },
      NETWORK_TAG_OPTION,
    ],
    examples: [
      'opensteer input 12 "search query"',
      'opensteer input --selector "input[name=q]" --text "query" --press-enter',
    ],
  },
  {
    name: "scroll",
    id: "scroll",
    summary: "Scroll an element or the page.",
    positionals: [
      {
        name: "target",
        description: "Element counter target",
      },
      {
        name: "direction",
        description: "Scroll direction",
      },
      {
        name: "amount",
        description: "Scroll amount",
      },
    ],
    options: [
      ...ACTION_TARGET_OPTIONS,
      {
        name: "direction",
        description: "Scroll direction",
        kind: "enum",
        valueLabel: "dir",
        values: ["up", "down", "left", "right"],
      },
      {
        name: "amount",
        description: "Scroll amount",
        kind: "number",
        valueLabel: "n",
      },
      NETWORK_TAG_OPTION,
    ],
  },
  {
    name: "extract",
    id: "extract",
    summary: "Extract structured data from the current page.",
    positionals: [
      {
        name: "schema",
        description: "Extraction schema JSON",
      },
    ],
    options: [
      ...SESSION_OPTIONS,
      {
        name: "description",
        description: "Extraction descriptor key",
        kind: "string",
        valueLabel: "text",
      },
      {
        name: "schema",
        description: "Extraction schema JSON object",
        kind: "json-object",
        valueLabel: "json",
      },
    ],
  },
  {
    name: "network",
    summary: "Query and manage captured network traffic.",
    subcommands: [
      {
        name: "query",
        id: "network.query",
        summary: "Query captured network traffic.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "source",
            description: "Network source filter",
            kind: "string",
            valueLabel: "source",
          },
          {
            name: "include-bodies",
            description: "Include request and response bodies",
            kind: "boolean",
          },
          {
            name: "limit",
            description: "Maximum number of records",
            kind: "number",
            valueLabel: "n",
          },
          {
            name: "tag",
            description: "Filter by tag",
            kind: "string",
            valueLabel: "tag",
          },
          {
            name: "page-ref",
            description: "Filter by page reference",
            kind: "string",
            valueLabel: "ref",
          },
          {
            name: "record-id",
            description: "Filter by record ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "request-id",
            description: "Filter by request ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "action-id",
            description: "Filter by action ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "url",
            description: "Filter by URL",
            kind: "string",
            valueLabel: "url",
          },
          {
            name: "hostname",
            description: "Filter by hostname",
            kind: "string",
            valueLabel: "host",
          },
          {
            name: "path",
            description: "Filter by URL path",
            kind: "string",
            valueLabel: "path",
          },
          {
            name: "method",
            description: "Filter by HTTP method",
            kind: "string",
            valueLabel: "method",
          },
          {
            name: "status",
            description: "Filter by HTTP status",
            kind: "string",
            valueLabel: "status",
          },
          {
            name: "resource-type",
            description: "Filter by resource type",
            kind: "string",
            valueLabel: "type",
          },
        ],
      },
      {
        name: "save",
        id: "network.save",
        summary: "Save captured network records under a tag.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "tag",
            description: "Destination tag",
            kind: "string",
            valueLabel: "tag",
          },
          {
            name: "page-ref",
            description: "Filter by page reference",
            kind: "string",
            valueLabel: "ref",
          },
          {
            name: "record-id",
            description: "Filter by record ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "request-id",
            description: "Filter by request ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "action-id",
            description: "Filter by action ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "url",
            description: "Filter by URL",
            kind: "string",
            valueLabel: "url",
          },
          {
            name: "hostname",
            description: "Filter by hostname",
            kind: "string",
            valueLabel: "host",
          },
          {
            name: "path",
            description: "Filter by URL path",
            kind: "string",
            valueLabel: "path",
          },
          {
            name: "method",
            description: "Filter by HTTP method",
            kind: "string",
            valueLabel: "method",
          },
          {
            name: "status",
            description: "Filter by HTTP status",
            kind: "string",
            valueLabel: "status",
          },
          {
            name: "resource-type",
            description: "Filter by resource type",
            kind: "string",
            valueLabel: "type",
          },
        ],
      },
      {
        name: "clear",
        id: "network.clear",
        summary: "Clear captured network records.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "tag",
            description: "Clear only records with this tag",
            kind: "string",
            valueLabel: "tag",
          },
        ],
      },
      {
        name: "minimize",
        id: "network.minimize",
        summary: "Minimize a captured request to its smallest viable form.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "record-id",
            description: "Saved or live network record ID to minimize",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "transport",
            description: "Transport to use while testing minimized variants",
            kind: "enum",
            valueLabel: "kind",
            values: ["direct-http", "matched-tls", "context-http", "page-http", "session-http"],
          },
          {
            name: "max-trials",
            description: "Maximum number of trial requests",
            kind: "number",
            valueLabel: "count",
          },
          {
            name: "preserve",
            description: "Comma-separated header or cookie names to keep",
            kind: "string",
            valueLabel: "csv",
          },
          {
            name: "status-codes",
            description: "Comma-separated success status codes",
            kind: "string",
            valueLabel: "csv",
          },
          {
            name: "response-body-includes",
            description: "Comma-separated substrings required in the response body",
            kind: "string",
            valueLabel: "csv",
            internalName: "responseBodyIncludes",
          },
          {
            name: "response-structure-match",
            description: "Require JSON response structure to match the baseline request",
            kind: "boolean",
          },
        ],
      },
      {
        name: "diff",
        id: "network.diff",
        summary: "Compare two captured requests or responses field-by-field.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "left",
            description: "Left record ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "right",
            description: "Right record ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "scope",
            description: "Diff headers, body, or both",
            kind: "enum",
            valueLabel: "scope",
            values: ["headers", "body", "all"],
          },
          {
            name: "include-unchanged",
            description: "Include unchanged fields in the output",
            kind: "boolean",
          },
        ],
      },
      {
        name: "probe",
        id: "network.probe",
        summary:
          "Probe a captured request across transports and recommend the lightest working one.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "record-id",
            description: "Saved or live network record ID to probe",
            kind: "string",
            valueLabel: "id",
          },
        ],
      },
    ],
  },
  {
    name: "reverse",
    summary: "Discover reverse-engineering evidence, build replay packages, and rerun them.",
    defaultSubcommand: "discover",
    subcommands: [
      {
        name: "discover",
        id: "reverse.discover",
        summary:
          "Capture a bounded observation window, analyze all plausible records, and return an ordered discovery view.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "case-id",
            description: "Existing case ID to extend",
            kind: "string",
            valueLabel: "id",
            internalName: "caseId",
          },
          {
            name: "key",
            description: "Case key for a new discovery run",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "objective",
            description: "Reverse-engineering objective",
            kind: "string",
            valueLabel: "text",
          },
          { name: "notes", description: "Discovery notes", kind: "string", valueLabel: "text" },
          {
            name: "page-ref",
            description: "Page reference to discover from",
            kind: "string",
            valueLabel: "ref",
          },
          {
            name: "state-source",
            description: "State source classification for this discovery run",
            kind: "enum",
            valueLabel: "kind",
            values: ["managed", "attach-live", "snapshot-session", "snapshot-authenticated"],
            internalName: "stateSource",
          },
          {
            name: "include-scripts",
            description: "Capture linked scripts",
            kind: "boolean",
            internalName: "includeScripts",
          },
          {
            name: "include-storage",
            description: "Capture browser storage state",
            kind: "boolean",
            internalName: "includeStorage",
          },
          {
            name: "include-session-storage",
            description: "Include sessionStorage in captured state",
            kind: "boolean",
            internalName: "includeSessionStorage",
          },
          {
            name: "include-indexed-db",
            description: "Include IndexedDB metadata in captured state",
            kind: "boolean",
            internalName: "includeIndexedDb",
          },
          {
            name: "interaction-trace-id",
            description: "Link an interaction trace as guard evidence (repeatable)",
            kind: "string",
            valueLabel: "id",
            multiple: true,
            internalName: "interactionTraceId",
          },
          {
            name: "target-host",
            description: "Target host hint for candidate ranking (repeatable)",
            kind: "string",
            valueLabel: "host",
            multiple: true,
            internalName: "targetHost",
          },
          {
            name: "target-path",
            description: "Target path hint for candidate ranking (repeatable)",
            kind: "string",
            valueLabel: "path",
            multiple: true,
            internalName: "targetPath",
          },
          {
            name: "target-operation-name",
            description: "Target GraphQL or operation name hint (repeatable)",
            kind: "string",
            valueLabel: "name",
            multiple: true,
            internalName: "targetOperationName",
          },
          {
            name: "target-channel",
            description: "Target channel hint (repeatable)",
            kind: "enum",
            valueLabel: "channel",
            values: ["http", "event-stream", "websocket"],
            multiple: true,
            internalName: "targetChannel",
          },
          {
            name: "capture-window-ms",
            description: "Only analyze recent requests observed within this window",
            kind: "number",
            valueLabel: "ms",
            internalName: "captureWindowMs",
          },
          {
            name: "manual-calibration",
            description:
              "How strongly discovery should assume manual unlock calibration is acceptable",
            kind: "enum",
            valueLabel: "mode",
            values: ["allow", "avoid", "require"],
            internalName: "manualCalibration",
          },
        ],
      },
      {
        name: "query",
        id: "reverse.query",
        summary:
          "Query an existing reverse case with deterministic filters and explicit sort keys.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "case-id",
            description: "Reverse case ID",
            kind: "string",
            valueLabel: "id",
            internalName: "caseId",
          },
          {
            name: "view",
            description: "Query view to return",
            kind: "enum",
            valueLabel: "view",
            values: ["records", "clusters", "candidates"],
          },
          {
            name: "filters-json",
            description: "JSON object of reverse query filters",
            kind: "json",
            valueLabel: "json",
            internalName: "filtersJson",
          },
          {
            name: "sort-preset",
            description: "Query sort preset shortcut",
            kind: "enum",
            valueLabel: "preset",
            values: [
              "advisory-rank",
              "observed-at",
              "portability",
              "first-party",
              "hint-match",
              "response-richness",
            ],
            internalName: "sortPreset",
          },
          {
            name: "sort-json",
            description: "JSON object with explicit query sort keys",
            kind: "json-object",
            valueLabel: "json",
            internalName: "sortJson",
          },
          { name: "limit", description: "Result page size", kind: "number", valueLabel: "count" },
          {
            name: "cursor",
            description: "Result page cursor",
            kind: "string",
            valueLabel: "cursor",
          },
        ],
      },
      {
        name: "run",
        id: "reverse.package.run",
        summary: "Run a reverse package draft and return executed or failing step details.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "package-id",
            description: "Reverse package ID",
            kind: "string",
            valueLabel: "id",
            internalName: "packageId",
          },
          {
            name: "page-ref",
            description: "Optional page reference for browser replay",
            kind: "string",
            valueLabel: "ref",
            internalName: "pageRef",
          },
        ],
      },
      {
        name: "export",
        id: "reverse.export",
        summary:
          "Read or clone the generated reverse package, including a request plan when portable.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "package-id",
            description: "Reverse package ID",
            kind: "string",
            valueLabel: "id",
            internalName: "packageId",
          },
          { name: "key", description: "Export key", kind: "string", valueLabel: "key" },
          { name: "version", description: "Export version", kind: "string", valueLabel: "version" },
        ],
      },
      {
        name: "report",
        id: "reverse.report",
        summary: "Read a discovery or package reverse-engineering report.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "package-id",
            description: "Reverse package ID",
            kind: "string",
            valueLabel: "id",
            internalName: "packageId",
          },
          {
            name: "case-id",
            description: "Reverse case ID",
            kind: "string",
            valueLabel: "id",
            internalName: "caseId",
          },
          {
            name: "report-id",
            description: "Reverse report ID",
            kind: "string",
            valueLabel: "id",
            internalName: "reportId",
          },
          {
            name: "kind",
            description: "Report kind when reading by case ID",
            kind: "enum",
            valueLabel: "kind",
            values: ["discovery", "package"],
          },
        ],
      },
      {
        name: "package",
        summary: "Create, inspect, list, and patch reverse packages.",
        subcommands: [
          {
            name: "create",
            id: "reverse.package.create",
            summary: "Create an explicit replay package draft from a chosen record or candidate.",
            options: [
              ...SESSION_OPTIONS,
              OUTPUT_OPTION,
              {
                name: "case-id",
                description: "Reverse case ID",
                kind: "string",
                valueLabel: "id",
                internalName: "caseId",
              },
              {
                name: "candidate-id",
                description: "Candidate ID to build from",
                kind: "string",
                valueLabel: "id",
                internalName: "candidateId",
              },
              {
                name: "record-id",
                description: "Observed record ID to build from",
                kind: "string",
                valueLabel: "id",
                internalName: "recordId",
              },
              {
                name: "template-id",
                description: "Optional advisory template ID",
                kind: "string",
                valueLabel: "id",
                internalName: "templateId",
              },
              { name: "key", description: "Package key", kind: "string", valueLabel: "key" },
              {
                name: "version",
                description: "Package version",
                kind: "string",
                valueLabel: "version",
              },
              { name: "notes", description: "Package notes", kind: "string", valueLabel: "text" },
            ],
          },
          {
            name: "get",
            id: "reverse.package.get",
            summary: "Read one reverse package.",
            options: [
              ...SESSION_OPTIONS,
              OUTPUT_OPTION,
              {
                name: "package-id",
                description: "Reverse package ID",
                kind: "string",
                valueLabel: "id",
                internalName: "packageId",
              },
            ],
          },
          {
            name: "list",
            id: "reverse.package.list",
            summary: "List reverse packages.",
            options: [
              ...SESSION_OPTIONS,
              OUTPUT_OPTION,
              {
                name: "case-id",
                description: "Filter by reverse case ID",
                kind: "string",
                valueLabel: "id",
                internalName: "caseId",
              },
              {
                name: "key",
                description: "Filter by package key",
                kind: "string",
                valueLabel: "key",
              },
              {
                name: "kind",
                description: "Filter by package kind",
                kind: "enum",
                valueLabel: "kind",
                values: ["portable-http", "browser-workflow"],
              },
              {
                name: "readiness",
                description: "Filter by package readiness",
                kind: "enum",
                valueLabel: "state",
                values: ["runnable", "draft", "unsupported"],
              },
            ],
          },
          {
            name: "patch",
            id: "reverse.package.patch",
            summary: "Write a new reverse package revision with edited workflow or evidence.",
            options: [
              ...SESSION_OPTIONS,
              OUTPUT_OPTION,
              {
                name: "package-id",
                description: "Source reverse package ID",
                kind: "string",
                valueLabel: "id",
                internalName: "packageId",
              },
              {
                name: "key",
                description: "Patched package key",
                kind: "string",
                valueLabel: "key",
              },
              {
                name: "version",
                description: "Patched package version",
                kind: "string",
                valueLabel: "version",
              },
              { name: "notes", description: "Package notes", kind: "string", valueLabel: "text" },
              {
                name: "workflow-json",
                description: "JSON array of package workflow steps",
                kind: "json",
                valueLabel: "json",
                internalName: "workflowJson",
              },
              {
                name: "resolvers-json",
                description: "JSON array of executable resolvers",
                kind: "json",
                valueLabel: "json",
                internalName: "resolversJson",
              },
              {
                name: "validators-json",
                description: "JSON array of validation rules",
                kind: "json",
                valueLabel: "json",
                internalName: "validatorsJson",
              },
              {
                name: "trace-id",
                description: "Attach interaction trace IDs (repeatable)",
                kind: "string",
                valueLabel: "id",
                multiple: true,
                internalName: "traceId",
              },
              {
                name: "artifact-id",
                description: "Attach artifact IDs (repeatable)",
                kind: "string",
                valueLabel: "id",
                multiple: true,
                internalName: "artifactId",
              },
              {
                name: "record-id",
                description: "Attach network record IDs (repeatable)",
                kind: "string",
                valueLabel: "id",
                multiple: true,
                internalName: "recordId",
              },
              {
                name: "state-snapshot-id",
                description: "Attach state snapshot IDs (repeatable)",
                kind: "string",
                valueLabel: "id",
                multiple: true,
                internalName: "stateSnapshotId",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "interaction",
    summary: "Capture and compare guarded interaction traces.",
    subcommands: [
      {
        name: "capture",
        id: "interaction.capture",
        summary: "Capture an interaction window with event properties and state deltas.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          { name: "key", description: "Trace key", kind: "string", valueLabel: "key" },
          {
            name: "page-ref",
            description: "Page reference",
            kind: "string",
            valueLabel: "ref",
            internalName: "pageRef",
          },
          {
            name: "duration-ms",
            description: "Manual capture duration",
            kind: "number",
            valueLabel: "ms",
            internalName: "durationMs",
          },
          {
            name: "script",
            description: "Automated capture script",
            kind: "string",
            valueLabel: "js",
          },
          {
            name: "args-json",
            description: "JSON array of script args",
            kind: "json",
            valueLabel: "json",
            internalName: "argsJson",
          },
          {
            name: "steps-json",
            description: "JSON array of declarative capture steps",
            kind: "json",
            valueLabel: "json",
            internalName: "stepsJson",
          },
          {
            name: "include-storage",
            description: "Capture browser storage state",
            kind: "boolean",
            internalName: "includeStorage",
          },
          {
            name: "include-session-storage",
            description: "Include sessionStorage",
            kind: "boolean",
            internalName: "includeSessionStorage",
          },
          {
            name: "include-indexed-db",
            description: "Include IndexedDB metadata",
            kind: "boolean",
            internalName: "includeIndexedDb",
          },
          {
            name: "global-name",
            description: "Page global to snapshot (repeatable)",
            kind: "string",
            valueLabel: "name",
            multiple: true,
            internalName: "globalName",
          },
          {
            name: "case-id",
            description: "Attach trace to an existing case",
            kind: "string",
            valueLabel: "id",
            internalName: "caseId",
          },
          { name: "notes", description: "Trace notes", kind: "string", valueLabel: "text" },
        ],
      },
      {
        name: "get",
        id: "interaction.get",
        summary: "Read one interaction trace.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "trace-id",
            description: "Trace ID",
            kind: "string",
            valueLabel: "id",
            internalName: "traceId",
          },
        ],
      },
      {
        name: "diff",
        id: "interaction.diff",
        summary: "Diff two interaction traces.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "left-trace-id",
            description: "Left trace ID",
            kind: "string",
            valueLabel: "id",
            internalName: "leftTraceId",
          },
          {
            name: "right-trace-id",
            description: "Right trace ID",
            kind: "string",
            valueLabel: "id",
            internalName: "rightTraceId",
          },
        ],
      },
      {
        name: "replay",
        id: "interaction.replay",
        summary: "Replay one interaction trace against a live page.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "trace-id",
            description: "Trace ID",
            kind: "string",
            valueLabel: "id",
            internalName: "traceId",
          },
          {
            name: "page-ref",
            description: "Optional page reference override",
            kind: "string",
            valueLabel: "ref",
            internalName: "pageRef",
          },
        ],
      },
    ],
  },
  {
    name: "artifact",
    summary: "Read captured reverse-engineering artifacts.",
    subcommands: [
      {
        name: "read",
        id: "artifact.read",
        summary: "Read one stored artifact.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "artifact-id",
            description: "Artifact ID",
            kind: "string",
            valueLabel: "id",
            internalName: "artifactId",
          },
        ],
      },
    ],
  },
  {
    name: "scripts",
    summary: "Capture page script sources for reverse-engineering workflows.",
    defaultSubcommand: "capture",
    subcommands: [
      {
        name: "capture",
        id: "scripts.capture",
        summary: "Capture inline and external script sources from the current page and run.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "page-ref",
            description: "Capture against a specific page reference",
            kind: "string",
            valueLabel: "ref",
          },
          {
            name: "include-inline",
            description: "Include inline script tags",
            kind: "boolean",
          },
          {
            name: "include-external",
            description: "Include external script requests",
            kind: "boolean",
          },
          {
            name: "include-dynamic",
            description: "Include script requests observed outside the current DOM tree",
            kind: "boolean",
          },
          {
            name: "include-workers",
            description: "Include worker script URLs observed during the current run",
            kind: "boolean",
          },
          {
            name: "url-filter",
            description: "Only include script URLs containing this string",
            kind: "string",
            valueLabel: "text",
          },
          {
            name: "no-persist",
            description: "Return captured scripts without persisting script artifacts",
            kind: "boolean",
          },
        ],
      },
      {
        name: "beautify",
        id: "scripts.beautify",
        summary: "Beautify captured or inline script content with Prettier.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "artifact-id",
            description: "Script artifact ID to beautify",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "content",
            description: "Inline script content to beautify",
            kind: "string",
            valueLabel: "code",
          },
          {
            name: "no-persist",
            description: "Return beautified content without persisting a new artifact",
            kind: "boolean",
          },
        ],
      },
      {
        name: "deobfuscate",
        id: "scripts.deobfuscate",
        summary: "Deobfuscate captured or inline script content with webcrack.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "artifact-id",
            description: "Script artifact ID to deobfuscate",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "content",
            description: "Inline script content to deobfuscate",
            kind: "string",
            valueLabel: "code",
          },
          {
            name: "no-persist",
            description: "Return deobfuscated content without persisting a new artifact",
            kind: "boolean",
          },
        ],
      },
      {
        name: "sandbox",
        id: "scripts.sandbox",
        summary: "Run script content in a configurable VM sandbox.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "artifact-id",
            description: "Script artifact ID to execute",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "content",
            description: "Inline script content to execute",
            kind: "string",
            valueLabel: "code",
          },
          {
            name: "fidelity",
            description: "Sandbox fidelity level",
            kind: "enum",
            valueLabel: "level",
            values: ["minimal", "standard", "full"],
          },
          {
            name: "ajax-routes",
            description: "JSON array of AJAX route rules",
            kind: "json",
            valueLabel: "json",
          },
          {
            name: "cookies",
            description: "JSON object of cookie values",
            kind: "json-object",
            valueLabel: "json",
          },
          {
            name: "globals",
            description: "JSON object of extra globals to inject",
            kind: "json-object",
            valueLabel: "json",
          },
          {
            name: "timeout-ms",
            description: "Execution timeout in milliseconds",
            kind: "number",
            valueLabel: "ms",
          },
          {
            name: "clock-mode",
            description: "Clock behavior inside the sandbox",
            kind: "enum",
            valueLabel: "mode",
            values: ["real", "manual"],
          },
        ],
      },
    ],
  },
  {
    name: "captcha",
    summary: "Detect and solve page CAPTCHA challenges.",
    defaultSubcommand: "solve",
    subcommands: [
      {
        name: "solve",
        id: "captcha.solve",
        summary: "Solve a supported CAPTCHA and inject the token into the page.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "provider",
            description: "CAPTCHA solving provider",
            kind: "enum",
            valueLabel: "provider",
            values: ["2captcha", "capsolver"],
          },
          {
            name: "api-key",
            description: "Provider API key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "page-ref",
            description: "Target page reference",
            kind: "string",
            valueLabel: "ref",
          },
          {
            name: "type",
            description: "Explicit CAPTCHA type",
            kind: "enum",
            valueLabel: "type",
            values: ["recaptcha-v2", "hcaptcha", "turnstile"],
          },
          {
            name: "site-key",
            description: "Explicit CAPTCHA site key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "page-url",
            description: "Explicit page URL for the CAPTCHA challenge",
            kind: "string",
            valueLabel: "url",
          },
          {
            name: "timeout-ms",
            description: "Solve timeout in milliseconds",
            kind: "number",
            valueLabel: "ms",
          },
        ],
      },
    ],
  },
  {
    name: "plan",
    summary: "Manage request plans.",
    subcommands: [
      {
        name: "write",
        id: "plan.write",
        summary: "Write a request plan.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "id",
            description: "Explicit plan record ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "key",
            description: "Plan key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "version",
            description: "Plan version",
            kind: "string",
            valueLabel: "version",
          },
          {
            name: "payload",
            description: "Inline request plan payload JSON object",
            kind: "json-object",
            valueLabel: "json",
          },
          {
            name: "payload-file",
            description: "Request plan payload JSON file",
            kind: "string",
            valueLabel: "path",
          },
          {
            name: "lifecycle",
            description: "Plan lifecycle",
            kind: "string",
            valueLabel: "lifecycle",
          },
          {
            name: "tags",
            description: "Comma-separated plan tags",
            kind: "string",
            valueLabel: "csv",
          },
          {
            name: "provenance-source",
            description: "Plan provenance source",
            kind: "string",
            valueLabel: "source",
          },
          {
            name: "provenance-source-id",
            description: "Plan provenance source identifier",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "provenance-captured-at",
            description: "Plan provenance capture timestamp",
            kind: "number",
            valueLabel: "ms",
          },
          {
            name: "provenance-notes",
            description: "Plan provenance notes",
            kind: "string",
            valueLabel: "text",
          },
        ],
      },
      {
        name: "infer",
        id: "plan.infer",
        summary: "Infer a request plan from a captured network record.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "record-id",
            description: "Network record ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "key",
            description: "Plan key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "version",
            description: "Plan version",
            kind: "string",
            valueLabel: "version",
          },
          {
            name: "lifecycle",
            description: "Plan lifecycle",
            kind: "string",
            valueLabel: "lifecycle",
          },
        ],
      },
      {
        name: "get",
        id: "plan.get",
        summary: "Read a request plan.",
        positionals: [
          {
            name: "key",
            description: "Plan key",
          },
          {
            name: "version",
            description: "Plan version",
          },
        ],
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "key",
            description: "Plan key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "version",
            description: "Plan version",
            kind: "string",
            valueLabel: "version",
          },
        ],
      },
      {
        name: "list",
        id: "plan.list",
        summary: "List request plans.",
        positionals: [
          {
            name: "key",
            description: "Optional plan key filter",
          },
        ],
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "key",
            description: "Plan key filter",
            kind: "string",
            valueLabel: "key",
          },
        ],
      },
    ],
  },
  {
    name: "request",
    summary: "Execute request plans or raw requests.",
    defaultSubcommand: "execute",
    subcommands: [
      {
        name: "raw",
        id: "request.raw",
        summary: "Execute a raw HTTP request.",
        positionals: [
          {
            name: "url",
            description: "Request URL",
          },
        ],
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "url",
            description: "Request URL",
            kind: "string",
            valueLabel: "url",
          },
          {
            name: "transport",
            description: "Transport mode for raw requests",
            kind: "enum",
            valueLabel: "kind",
            values: ["direct-http", "matched-tls", "context-http", "page-http", "session-http"],
          },
          {
            name: "method",
            description: "HTTP method",
            kind: "string",
            valueLabel: "method",
          },
          {
            name: "header",
            description: "Header in NAME=VALUE form (repeatable)",
            kind: "string",
            valueLabel: "name=value",
            multiple: true,
          },
          {
            name: "body-json",
            description: "JSON request body",
            kind: "json",
            valueLabel: "json",
          },
          {
            name: "body-text",
            description: "Text request body",
            kind: "string",
            valueLabel: "text",
          },
          {
            name: "body-base64",
            description: "Base64 request body",
            kind: "string",
            valueLabel: "data",
          },
          {
            name: "body-file",
            description: "Request body file",
            kind: "string",
            valueLabel: "path",
          },
          {
            name: "content-type",
            description: "Content-Type header",
            kind: "string",
            valueLabel: "type",
          },
          {
            name: "no-follow-redirects",
            description: "Do not follow redirects",
            kind: "boolean",
          },
        ],
      },
      {
        name: "execute",
        id: "request.execute",
        summary: "Execute a stored request plan.",
        positionals: [
          {
            name: "key",
            description: "Plan key",
          },
        ],
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "key",
            description: "Plan key",
            kind: "string",
            valueLabel: "key",
          },
          {
            name: "version",
            description: "Plan version",
            kind: "string",
            valueLabel: "version",
          },
          {
            name: "param",
            description: "Path parameter in NAME=VALUE form (repeatable)",
            kind: "string",
            valueLabel: "name=value",
            multiple: true,
          },
          {
            name: "query",
            description: "Query parameter in NAME=VALUE form (repeatable)",
            kind: "string",
            valueLabel: "name=value",
            multiple: true,
          },
          {
            name: "header",
            description: "Request header in NAME=VALUE form (repeatable)",
            kind: "string",
            valueLabel: "name=value",
            multiple: true,
          },
          {
            name: "body-json",
            description: "JSON request body override",
            kind: "json",
            valueLabel: "json",
          },
          {
            name: "body-text",
            description: "Text request body override",
            kind: "string",
            valueLabel: "text",
          },
          {
            name: "body-base64",
            description: "Base64 request body override",
            kind: "string",
            valueLabel: "data",
          },
          {
            name: "body-file",
            description: "Request body file override",
            kind: "string",
            valueLabel: "path",
          },
          {
            name: "content-type",
            description: "Content-Type header override",
            kind: "string",
            valueLabel: "type",
          },
          {
            name: "no-validate",
            description: "Skip response validation",
            kind: "boolean",
          },
        ],
      },
    ],
  },
  {
    name: "inspect",
    summary: "Inspect browser session state.",
    defaultSubcommand: "cookies",
    subcommands: [
      {
        name: "cookies",
        id: "inspect.cookies",
        summary: "Read cookies from the current browser session.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "url",
            description: "Filter cookies by URL (repeatable)",
            kind: "string",
            valueLabel: "url",
            multiple: true,
          },
        ],
      },
      {
        name: "storage",
        id: "inspect.storage",
        summary: "Read browser storage from the current browser session.",
        options: [
          ...SESSION_OPTIONS,
          OUTPUT_OPTION,
          {
            name: "include-session-storage",
            description: "Include sessionStorage snapshots",
            kind: "boolean",
          },
          {
            name: "include-indexed-db",
            description: "Include IndexedDB snapshots",
            kind: "boolean",
          },
        ],
      },
    ],
  },
  createRecipeCommandDefinition({
    name: "recipe",
    groupSummary: "Manage reusable recipes.",
    writeSummary: "Write a reusable recipe.",
    getSummary: "Read a recipe.",
    listSummary: "List recipes.",
    runSummary: "Run a recipe.",
    payloadLabel: "recipe",
  }),
  createRecipeCommandDefinition({
    name: "auth-recipe",
    groupSummary: "Manage auth recovery recipes.",
    writeSummary: "Write an auth recovery recipe.",
    getSummary: "Read an auth recovery recipe.",
    listSummary: "List auth recovery recipes.",
    runSummary: "Run an auth recovery recipe.",
    payloadLabel: "auth recipe",
  }),
  {
    name: "computer",
    id: "computer",
    summary: "Execute a computer-use action.",
    positionals: [
      {
        name: "action",
        description: "Computer action JSON object",
      },
    ],
    options: [
      ...SESSION_OPTIONS,
      NETWORK_TAG_OPTION,
      {
        name: "action",
        description: "Computer action JSON object",
        kind: "json-object",
        valueLabel: "json",
      },
      {
        name: "screenshot-json",
        description: "Full screenshot configuration as JSON object",
        kind: "json-object",
        valueLabel: "json",
      },
      {
        name: "format",
        description: "Screenshot format",
        kind: "string",
        valueLabel: "format",
      },
      {
        name: "include-cursor",
        description: "Include cursor in screenshots",
        kind: "boolean",
      },
      {
        name: "disable-annotations",
        description: "Comma-separated screenshot annotations to disable",
        kind: "string",
        valueLabel: "csv",
      },
    ],
  },
  {
    name: "close",
    id: "close",
    summary: "Close the active browser session.",
    options: SESSION_OPTIONS,
  },
  {
    name: "service-host",
    id: "service-host",
    summary: "Start the local Opensteer service host.",
    options: [
      ...SESSION_OPTIONS,
      {
        name: "engine",
        description: "Browser engine",
        kind: "enum",
        valueLabel: "name",
        values: ["playwright", "abp"],
      },
    ],
  },
  {
    name: "mcp",
    id: "mcp",
    summary: "Run the Opensteer MCP server.",
    options: [
      ...SESSION_OPTIONS,
      {
        name: "engine",
        description: "Browser engine",
        kind: "enum",
        valueLabel: "name",
        values: ["playwright", "abp"],
      },
      {
        name: "local",
        description: "Force local execution mode",
        kind: "boolean",
      },
      {
        name: "cloud",
        description: "Use Opensteer Cloud",
        kind: "boolean",
      },
    ],
  },
  {
    name: "local-profile",
    summary: "Inspect local Chrome profiles for real-browser mode.",
    subcommands: [
      {
        name: "list",
        id: "local-profile.list",
        summary: "List discovered local Chrome/Chromium profiles.",
        options: [
          {
            name: "json",
            description: "Print JSON output",
            kind: "boolean",
          },
          {
            name: "user-data-dir",
            description: "Override Chrome user-data root",
            kind: "string",
            valueLabel: "path",
          },
        ],
      },
      {
        name: "inspect",
        id: "local-profile.inspect",
        summary: "Inspect a local Chrome user-data-dir for launch ownership state.",
        options: [
          {
            name: "user-data-dir",
            description: "Override Chrome user-data root",
            kind: "string",
            valueLabel: "path",
          },
        ],
      },
      {
        name: "unlock",
        id: "local-profile.unlock",
        summary: "Remove stale Chrome singleton artifacts from a user-data-dir.",
        options: [
          {
            name: "user-data-dir",
            description: "Chrome user-data root",
            kind: "string",
            valueLabel: "path",
          },
        ],
      },
    ],
  },
  {
    name: "browser",
    summary: "Inspect local CDP browser discovery and endpoints.",
    defaultSubcommand: "discover",
    subcommands: [
      {
        name: "discover",
        id: "browser.discover",
        summary: "Discover locally attachable Chrome/Chromium DevTools endpoints.",
        options: [
          {
            name: "json",
            description: "Print JSON output",
            kind: "boolean",
          },
          {
            name: "timeout-ms",
            description: "Probe timeout in milliseconds",
            kind: "number",
            valueLabel: "ms",
            internalName: "timeoutMs",
          },
        ],
      },
      {
        name: "inspect",
        id: "browser.inspect",
        summary: "Inspect a CDP endpoint and resolve its browser websocket URL.",
        options: [
          {
            name: "endpoint",
            description: "Chrome DevTools endpoint to inspect",
            kind: "string",
            valueLabel: "port|ws-url|http-url",
          },
          {
            name: "json",
            description: "Print JSON output",
            kind: "boolean",
          },
          {
            name: "timeout-ms",
            description: "Probe timeout in milliseconds",
            kind: "number",
            valueLabel: "ms",
            internalName: "timeoutMs",
          },
        ],
      },
    ],
  },
  {
    name: "profile",
    summary: "Manage cloud browser profile cookie sync.",
    subcommands: [
      {
        name: "sync",
        id: "profile.sync",
        summary:
          "Sync cookies from a live Chromium browser into an existing Opensteer cloud profile.",
        options: [
          {
            name: "profile-id",
            description: "Destination cloud browser profile ID",
            kind: "string",
            valueLabel: "id",
          },
          {
            name: "browser",
            description: "Source Chromium-family browser brand",
            kind: "enum",
            valueLabel: "brand",
            values: PROFILE_SYNC_BROWSER_VALUES,
            internalName: "brandId",
          },
          {
            name: "attach-endpoint",
            description: "DevTools endpoint for the source browser; auto-discovered when omitted",
            kind: "string",
            valueLabel: "endpoint",
            internalName: "attachEndpoint",
          },
          {
            name: "user-data-dir",
            description: "Explicit browser user-data-dir",
            kind: "string",
            valueLabel: "path",
            internalName: "userDataDir",
          },
          {
            name: "profile-directory",
            description:
              'Profile directory name inside the selected user-data-dir (for example "Default")',
            kind: "string",
            valueLabel: "name",
            internalName: "profileDirectory",
          },
          {
            name: "executable-path",
            description: "Explicit browser executable override",
            kind: "string",
            valueLabel: "path",
            internalName: "executablePath",
          },
          {
            name: "strategy",
            description: "Cookie capture strategy",
            kind: "enum",
            valueLabel: "mode",
            values: PROFILE_SYNC_STRATEGY_VALUES,
          },
          {
            name: "domain",
            description: "Restrict sync to a domain (repeatable)",
            kind: "string",
            valueLabel: "domain",
            multiple: true,
          },
          {
            name: "all-domains",
            description: "Sync cookies for all domains",
            kind: "boolean",
            internalName: "allDomains",
          },
          {
            name: "restore-browser",
            description: "Re-launch the browser after managed-relaunch capture (default: true)",
            kind: "boolean",
            internalName: "restoreBrowser",
          },
          {
            name: "no-restore-browser",
            description: "Do not re-launch the browser after managed-relaunch capture",
            kind: "boolean",
            internalName: "noRestoreBrowser",
          },
          {
            name: "yes",
            description: "Skip interactive confirmations",
            kind: "boolean",
          },
          {
            name: "timeout-ms",
            description: "Capture planning timeout in milliseconds",
            kind: "number",
            valueLabel: "ms",
            internalName: "timeoutMs",
          },
          {
            name: "dry-run",
            description: "Print the resolved capture plan without syncing",
            kind: "boolean",
            internalName: "dryRun",
          },
          {
            name: "json",
            description: "Print JSON output",
            kind: "boolean",
          },
        ],
      },
    ],
  },
] as const;

export const opensteerCliSchema: CliCommandDefinition = {
  name: "opensteer",
  summary: "Thin JSON-first CLI for Opensteer sessions and workflows.",
  subcommands: ROOT_COMMANDS,
};

export const browserCliSchema = requireSubcommand(opensteerCliSchema, "browser");
export const localProfileCliSchema = requireSubcommand(opensteerCliSchema, "local-profile");
export const profileCliSchema = requireSubcommand(opensteerCliSchema, "profile");

validateCliSchema(opensteerCliSchema);

export function parseCliArguments(input: {
  readonly schema: CliCommandDefinition;
  readonly programName: string;
  readonly argv: readonly string[];
}): CliParseResult {
  const { schema, programName, argv } = input;

  if (argv.length === 0) {
    return createHelpResult(schema, [], programName);
  }

  if (isHelpToken(argv[0]!)) {
    const resolved = resolveHelpTarget(schema, argv.slice(1));
    return createHelpResult(resolved.command, resolved.commandPath, programName);
  }

  const resolved = resolveCommand(schema, argv);
  if (
    resolved.command.subcommands !== undefined &&
    resolved.command.defaultSubcommand === undefined
  ) {
    if (resolved.remaining.length === 1 && isHelpToken(resolved.remaining[0]!)) {
      return createHelpResult(resolved.command, resolved.commandPath, programName);
    }
    throw new Error(
      `${formatCommandPath(programName, resolved.commandPath)} requires a subcommand: ${listSubcommandNames(resolved.command)}.`,
    );
  }

  const parsed = parseLeafArguments(resolved.command, resolved.remaining);
  if (parsed.help) {
    return createHelpResult(resolved.command, resolved.commandPath, programName);
  }

  validatePositionalCount(resolved.command, parsed.positionals, programName, resolved.commandPath);

  return {
    kind: "command",
    invocation: {
      commandId: resolved.command.id ?? resolved.commandPath.join("."),
      command: resolved.command,
      commandPath: resolved.commandPath,
      positionals: parsed.positionals,
      options: parsed.options,
    },
  };
}

export function renderHelp(input: {
  readonly schema: CliCommandDefinition;
  readonly programName: string;
  readonly commandPath?: readonly string[];
}): string {
  const commandPath = input.commandPath ?? [];
  const resolved =
    commandPath.length === 0
      ? { command: input.schema, commandPath }
      : resolveHelpTarget(input.schema, commandPath);
  return renderCommandHelp(resolved.command, resolved.commandPath, input.programName);
}

function createHelpResult(
  command: CliCommandDefinition,
  commandPath: readonly string[],
  programName: string,
): CliParseResult {
  return {
    kind: "help",
    command,
    commandPath,
    text: renderCommandHelp(command, commandPath, programName),
  };
}

function resolveHelpTarget(
  schema: CliCommandDefinition,
  tokens: readonly string[],
): {
  readonly command: CliCommandDefinition;
  readonly commandPath: readonly string[];
} {
  let command = schema;
  const commandPath: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("-")) {
      throw new Error(`Unsupported help target "${token}".`);
    }
    const next = command.subcommands?.find((entry) => entry.name === token);
    if (!next) {
      throw new Error(`unsupported command "${token}"`);
    }
    command = next;
    commandPath.push(token);
  }

  return {
    command,
    commandPath,
  };
}

function resolveCommand(
  schema: CliCommandDefinition,
  argv: readonly string[],
): {
  readonly command: CliCommandDefinition;
  readonly commandPath: readonly string[];
  readonly remaining: readonly string[];
} {
  let command = schema;
  const commandPath: string[] = [];
  let index = 0;

  while (command.subcommands !== undefined && index < argv.length) {
    const token = argv[index]!;
    if (token.startsWith("-")) {
      break;
    }
    const next = command.subcommands.find((entry) => entry.name === token);
    if (next) {
      command = next;
      commandPath.push(token);
      index += 1;
      continue;
    }
    if (command.defaultSubcommand !== undefined) {
      command = requireSubcommand(command, command.defaultSubcommand);
      commandPath.push(command.name);
      break;
    }
    break;
  }

  if (command === schema) {
    throw new Error(
      `unsupported command "${argv[0]}". Supported commands: ${listSubcommandNames(schema)}.`,
    );
  }

  if (command.subcommands !== undefined && command.defaultSubcommand !== undefined) {
    command = requireSubcommand(command, command.defaultSubcommand);
    commandPath.push(command.name);
  }

  return {
    command,
    commandPath,
    remaining: argv.slice(index),
  };
}

function parseLeafArguments(
  command: CliCommandDefinition,
  argv: readonly string[],
): {
  readonly help: boolean;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, ParsedOptionValue>>;
} {
  const definitions = [...(command.options ?? []), HELP_OPTION];
  const optionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const parsed: Record<string, ParsedOptionValue> = {};
  const positionals: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h" || token === "--help") {
      help = true;
      continue;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unsupported short option "${token}". Only -h is supported.`);
    }

    const trimmed = token.slice(2);
    const [name, inlineValue] = trimmed.split("=", 2);
    if (!name) {
      throw new Error("invalid option syntax");
    }
    const definition = optionsByName.get(name);
    if (!definition) {
      throw new Error(buildUnknownOptionMessage(name, optionsByName));
    }

    const internalName = definition.internalName ?? toCamelCase(definition.name);
    if (!definition.multiple && Object.prototype.hasOwnProperty.call(parsed, internalName)) {
      throw new Error(`Option "--${definition.name}" may only be specified once.`);
    }

    const consumed = parseOptionValue(definition, inlineValue, argv[index + 1]);
    if (consumed.consumeNext) {
      index += 1;
    }

    if (definition.multiple) {
      const existing = parsed[internalName];
      const nextValues =
        existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
      parsed[internalName] = [...nextValues, consumed.value];
    } else {
      parsed[internalName] = consumed.value;
    }
  }

  return {
    help,
    positionals,
    options: parsed,
  };
}

function parseOptionValue(
  definition: CliOptionDefinition,
  inlineValue: string | undefined,
  nextToken: string | undefined,
): {
  readonly value: ParsedOptionValue;
  readonly consumeNext: boolean;
} {
  if (definition.kind === "boolean") {
    if (inlineValue !== undefined) {
      return {
        value: parseBooleanValue(inlineValue, definition.name),
        consumeNext: false,
      };
    }
    if (nextToken !== undefined && isBooleanLiteral(nextToken)) {
      return {
        value: parseBooleanValue(nextToken, definition.name),
        consumeNext: true,
      };
    }
    return {
      value: true,
      consumeNext: false,
    };
  }

  const rawValue =
    inlineValue !== undefined ? inlineValue : nextToken !== undefined ? nextToken : undefined;
  if (rawValue === undefined) {
    throw new Error(`Option "--${definition.name}" requires a value.`);
  }
  if (inlineValue === undefined && nextToken === undefined) {
    throw new Error(`Option "--${definition.name}" requires a value.`);
  }
  if (inlineValue === undefined && nextToken !== undefined && nextToken.startsWith("--")) {
    throw new Error(`Option "--${definition.name}" requires a value.`);
  }

  switch (definition.kind) {
    case "string":
      return {
        value: rawValue,
        consumeNext: inlineValue === undefined,
      };
    case "number": {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Option "--${definition.name}" must be a number.`);
      }
      return {
        value: parsed,
        consumeNext: inlineValue === undefined,
      };
    }
    case "json":
      return {
        value: parseJson(rawValue, definition.name),
        consumeNext: inlineValue === undefined,
      };
    case "json-object":
      return {
        value: parseJsonObject(rawValue, definition.name),
        consumeNext: inlineValue === undefined,
      };
    case "enum":
      if (!definition.values?.includes(rawValue)) {
        throw new Error(
          `Option "--${definition.name}" must be one of: ${definition.values?.join(", ") ?? ""}.`,
        );
      }
      return {
        value: rawValue,
        consumeNext: inlineValue === undefined,
      };
  }
}

function parseBooleanValue(value: string, name: string): boolean {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new Error(`Option "--${name}" must be a boolean value.`);
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Option "--${name}" must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  const parsed = parseJson(value, name);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Option "--${name}" must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function buildUnknownOptionMessage(
  name: string,
  definitions: ReadonlyMap<string, CliOptionDefinition>,
): string {
  const suggestion = suggestOption(name, [...definitions.keys()]);
  return suggestion === undefined
    ? `unknown option "--${name}".`
    : `unknown option "--${name}". Did you mean "--${suggestion}"?`;
}

function suggestOption(name: string, candidates: readonly string[]): string | undefined {
  const normalized = normalizeOptionName(name);
  const normalizedMatches = candidates.filter(
    (candidate) => normalizeOptionName(candidate) === normalized,
  );
  if (normalizedMatches.length === 1) {
    return normalizedMatches[0];
  }

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= 2 ? best : undefined;
}

function normalizeOptionName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function levenshteinDistance(left: string, right: string): number {
  const matrix = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let row = 0; row <= left.length; row += 1) {
    matrix[row]![0] = row;
  }
  for (let column = 0; column <= right.length; column += 1) {
    matrix[0]![column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + cost,
      );
    }
  }
  return matrix[left.length]![right.length]!;
}

function validatePositionalCount(
  command: CliCommandDefinition,
  positionals: readonly string[],
  programName: string,
  commandPath: readonly string[],
): void {
  const definitions = command.positionals ?? [];
  if (definitions.length === 0) {
    if (positionals.length > 0) {
      throw new Error(
        `${formatCommandPath(programName, commandPath)} does not accept positional arguments.`,
      );
    }
    return;
  }

  const max = definitions.some((definition) => definition.variadic)
    ? Number.POSITIVE_INFINITY
    : definitions.length;
  if (positionals.length > max) {
    throw new Error(
      `${formatCommandPath(programName, commandPath)} accepts at most ${String(max)} positional argument${max === 1 ? "" : "s"}.`,
    );
  }

  const required = definitions.filter((definition) => definition.required).length;
  if (required > 0 && positionals.length < required) {
    throw new Error(
      `${formatCommandPath(programName, commandPath)} requires ${String(required)} positional argument${required === 1 ? "" : "s"}.`,
    );
  }
}

function renderCommandHelp(
  command: CliCommandDefinition,
  commandPath: readonly string[],
  programName: string,
): string {
  const lines: string[] = [];
  lines.push(`Usage: ${renderUsage(programName, command, commandPath)}`);
  lines.push("");
  lines.push(command.summary);

  if (command.description) {
    lines.push("");
    lines.push(command.description);
  }

  if (command.subcommands?.length) {
    lines.push("");
    lines.push("Commands:");
    for (const subcommand of command.subcommands) {
      lines.push(
        `  ${padRight(subcommand.name, longestCommandName(command.subcommands))}  ${subcommand.summary}`,
      );
    }
  }

  if (command.positionals?.length) {
    lines.push("");
    lines.push("Positionals:");
    for (const positional of command.positionals) {
      lines.push(
        `  ${padRight(renderPositional(positional), longestPositionalName(command.positionals))}  ${positional.description}`,
      );
    }
  }

  const options = [...(command.options ?? []), HELP_OPTION];
  if (options.length > 0) {
    lines.push("");
    lines.push("Options:");
    for (const option of options) {
      const label =
        option.name === "help" ? "-h, --help" : `--${option.name}${renderValueLabel(option)}`;
      lines.push(`  ${padRight(label, longestOptionLabel(options))}  ${option.description}`);
    }
  }

  if (command.examples?.length) {
    lines.push("");
    lines.push("Examples:");
    for (const example of command.examples) {
      lines.push(`  ${example}`);
    }
  }

  if (command.subcommands?.length) {
    lines.push("");
    const helpTarget =
      commandPath.length === 0 ? "<command>" : `${commandPath.join(" ")} <command>`;
    lines.push(`Use "${programName} help ${helpTarget}" for more information.`);
  }

  return `${lines.join("\n")}\n`;
}

function renderUsage(
  programName: string,
  command: CliCommandDefinition,
  commandPath: readonly string[],
): string {
  const base = formatCommandPath(programName, commandPath);
  if (command.subcommands?.length) {
    return `${base} <command>`;
  }

  const positionals = (command.positionals ?? []).map(renderPositional);
  const suffix = positionals.length === 0 ? "" : ` ${positionals.join(" ")}`;
  return `${base}${suffix}${(command.options ?? []).length > 0 ? " [options]" : ""}`;
}

function renderPositional(positional: CliPositionalDefinition): string {
  const wrapped = positional.required ? `<${positional.name}>` : `[${positional.name}]`;
  return positional.variadic ? `${wrapped}...` : wrapped;
}

function renderValueLabel(option: CliOptionDefinition): string {
  if (option.kind === "boolean") {
    return "";
  }
  return ` <${option.valueLabel ?? "value"}>`;
}

function formatCommandPath(programName: string, commandPath: readonly string[]): string {
  return commandPath.length === 0 ? programName : `${programName} ${commandPath.join(" ")}`;
}

function listSubcommandNames(command: CliCommandDefinition): string {
  return command.subcommands?.map((entry) => entry.name).join(", ") ?? "";
}

function longestCommandName(commands: readonly CliCommandDefinition[]): number {
  return Math.max(...commands.map((command) => command.name.length));
}

function longestOptionLabel(options: readonly CliOptionDefinition[]): number {
  return Math.max(
    ...options.map(
      (option) =>
        (option.name === "help" ? "-h, --help" : `--${option.name}${renderValueLabel(option)}`)
          .length,
    ),
  );
}

function longestPositionalName(positionals: readonly CliPositionalDefinition[]): number {
  return Math.max(...positionals.map((positional) => renderPositional(positional).length));
}

function padRight(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function validateCliSchema(schema: CliCommandDefinition): void {
  walkCommands(schema, (command, ancestors) => {
    const optionNames = new Set<string>();
    for (const option of command.options ?? []) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(option.name)) {
        throw new Error(`CLI option "${option.name}" must be kebab-case.`);
      }
      if (optionNames.has(option.name)) {
        throw new Error(
          `CLI option "${option.name}" is duplicated on ${[...ancestors, command.name].join(" ")}.`,
        );
      }
      optionNames.add(option.name);
    }
    if (command.defaultSubcommand !== undefined) {
      requireSubcommand(command, command.defaultSubcommand);
    }
  });
}

function walkCommands(
  command: CliCommandDefinition,
  visit: (command: CliCommandDefinition, ancestors: readonly string[]) => void,
  ancestors: readonly string[] = [],
): void {
  visit(command, ancestors);
  for (const subcommand of command.subcommands ?? []) {
    walkCommands(subcommand, visit, [...ancestors, command.name]);
  }
}

function requireSubcommand(command: CliCommandDefinition, name: string): CliCommandDefinition {
  const match = command.subcommands?.find((entry) => entry.name === name);
  if (!match) {
    throw new Error(`Unknown subcommand "${name}" on "${command.name}".`);
  }
  return match;
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, character: string) => character.toUpperCase());
}

function isHelpToken(value: string): boolean {
  return value === "help" || value === "--help" || value === "-h";
}

function isBooleanLiteral(value: string): boolean {
  return value === "true" || value === "false" || value === "1" || value === "0";
}
