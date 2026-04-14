import type {
  CookieRecord,
  OpensteerActionResult,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerOpenInput,
  OpensteerOpenOutput,
  OpensteerPageActivateInput,
  OpensteerPageActivateOutput,
  OpensteerPageCloseInput,
  OpensteerPageCloseOutput,
  OpensteerPageEvaluateInput,
  OpensteerPageListInput,
  OpensteerPageListOutput,
  OpensteerPageNewInput,
  OpensteerPageNewOutput,
} from "@opensteer/protocol";

export const opensteerConformanceFamilies = [
  "session-page-lifecycle",
  "evaluate-init-script",
  "dom-actions-extract",
  "cookies-storage",
  "network-capture",
  "route-intercept",
  "computer-execute",
] as const;

export type OpensteerConformanceFamily = (typeof opensteerConformanceFamilies)[number];

export type OpensteerConformanceStatus = "pass" | "fail" | "unsupported-by-capability";

export interface OpensteerConformanceUrls {
  readonly baseUrl: string;
  readonly main: string;
  readonly secondary: string;
  readonly scripted: string;
}

export interface OpensteerRouteRegistration {
  readonly routeId: string;
}

export interface OpensteerConformanceTarget {
  open(input?: string | OpensteerOpenInput): Promise<OpensteerOpenOutput>;
  listPages(input?: OpensteerPageListInput): Promise<OpensteerPageListOutput>;
  newPage(input?: OpensteerPageNewInput): Promise<OpensteerPageNewOutput>;
  activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput>;
  closePage(input?: OpensteerPageCloseInput): Promise<OpensteerPageCloseOutput>;
  goto(url: string, options?: { readonly captureNetwork?: string }): Promise<unknown>;
  evaluate(input: string | OpensteerPageEvaluateInput): Promise<unknown>;
  addInitScript(input: string | OpensteerAddInitScriptInput): Promise<OpensteerAddInitScriptOutput>;
  click(input: {
    readonly selector?: string;
    readonly element?: number;
    readonly persist?: string;
    readonly captureNetwork?: string;
  }): Promise<OpensteerActionResult>;
  hover?(input: {
    readonly selector?: string;
    readonly element?: number;
    readonly persist?: string;
    readonly captureNetwork?: string;
  }): Promise<OpensteerActionResult>;
  input(input: {
    readonly selector?: string;
    readonly element?: number;
    readonly persist?: string;
    readonly captureNetwork?: string;
    readonly text: string;
    readonly pressEnter?: boolean;
  }): Promise<OpensteerActionResult>;
  scroll(input: {
    readonly selector?: string;
    readonly element?: number;
    readonly persist?: string;
    readonly captureNetwork?: string;
    readonly direction: "up" | "down" | "left" | "right";
    readonly amount: number;
  }): Promise<OpensteerActionResult>;
  extract(input: { readonly persist: string }): Promise<unknown>;
  cookies(domain?: string): Promise<{
    has(name: string): boolean;
    get(name: string): string | undefined;
    getAll(): readonly CookieRecord[];
    serialize(): string;
  }>;
  storage(domain?: string, type?: "local" | "session"): Promise<Readonly<Record<string, string>>>;
  readonly network: {
    query(input?: OpensteerNetworkQueryInput): Promise<OpensteerNetworkQueryOutput>;
    detail(recordId: string): Promise<{
      readonly recordId: string;
      readonly requestHeaders: readonly { readonly name: string; readonly value: string }[];
      readonly responseHeaders: readonly { readonly name: string; readonly value: string }[];
      readonly responseBody?: {
        readonly data?: unknown;
      };
    }>;
  };
  route?(input: {
    readonly pageRef?: string;
    readonly urlPattern: string;
    readonly resourceTypes?: readonly string[];
    readonly times?: number;
    readonly handler: (input: {
      readonly request: {
        readonly url: string;
        readonly method: string;
      };
      fetchOriginal(): Promise<{
        readonly status: number;
        readonly headers: readonly { readonly name: string; readonly value: string }[];
        readonly body?: { readonly bytes: Uint8Array };
      }>;
    }) =>
      | Promise<{
          readonly kind: "continue" | "abort" | "fulfill";
          readonly status?: number;
          readonly headers?: readonly { readonly name: string; readonly value: string }[];
          readonly body?: string | Uint8Array;
          readonly contentType?: string;
        }>
      | {
          readonly kind: "continue" | "abort" | "fulfill";
          readonly status?: number;
          readonly headers?: readonly { readonly name: string; readonly value: string }[];
          readonly body?: string | Uint8Array;
          readonly contentType?: string;
        };
  }): Promise<OpensteerRouteRegistration>;
  interceptScript?(input: {
    readonly pageRef?: string;
    readonly urlPattern: string;
    readonly times?: number;
    readonly handler: (input: {
      readonly url: string;
      readonly content: string;
      readonly headers: readonly { readonly name: string; readonly value: string }[];
      readonly status: number;
    }) => Promise<string> | string;
  }): Promise<OpensteerRouteRegistration>;
  computerExecute?(input: OpensteerComputerExecuteInput): Promise<OpensteerComputerExecuteOutput>;
  close(): Promise<unknown>;
}

export interface OpensteerConformanceHarness {
  readonly target: OpensteerConformanceTarget;
  readonly urls: OpensteerConformanceUrls;
  supports?(family: OpensteerConformanceFamily): boolean;
}

export interface OpensteerConformanceCase {
  readonly id: string;
  readonly family: OpensteerConformanceFamily;
  readonly description: string;
  run(harness: OpensteerConformanceHarness): Promise<void>;
}

export interface OpensteerConformanceResult {
  readonly id: string;
  readonly family: OpensteerConformanceFamily;
  readonly description: string;
  readonly status: OpensteerConformanceStatus;
  readonly error?: Error;
}

export async function runOpensteerConformanceCase(
  testCase: OpensteerConformanceCase,
  harness: OpensteerConformanceHarness,
): Promise<OpensteerConformanceResult> {
  if (harness.supports && !harness.supports(testCase.family)) {
    return {
      id: testCase.id,
      family: testCase.family,
      description: testCase.description,
      status: "unsupported-by-capability",
    };
  }

  try {
    await testCase.run(harness);
    return {
      id: testCase.id,
      family: testCase.family,
      description: testCase.description,
      status: "pass",
    };
  } catch (error) {
    return {
      id: testCase.id,
      family: testCase.family,
      description: testCase.description,
      status: "fail",
      error: asError(error),
    };
  }
}

export async function runOpensteerConformanceCases(
  cases: readonly OpensteerConformanceCase[],
  createHarness: () => Promise<OpensteerConformanceHarness>,
): Promise<readonly OpensteerConformanceResult[]> {
  const results: OpensteerConformanceResult[] = [];
  for (const testCase of cases) {
    const harness = await createHarness();
    try {
      results.push(await runOpensteerConformanceCase(testCase, harness));
    } finally {
      await harness.target.close().catch(() => undefined);
    }
  }
  return results;
}

export const opensteerCoreConformanceCases: readonly OpensteerConformanceCase[] = [
  {
    id: "session-page-lifecycle",
    family: "session-page-lifecycle",
    description: "opens, enumerates, activates, and closes pages coherently",
    async run({ target, urls }) {
      const opened = await target.open(urls.main);
      const initial = await target.listPages();
      assert(
        initial.pages.some((page) => page.pageRef === opened.pageRef),
        "expected the opened page to appear in page.list output",
      );

      const created = await target.newPage({
        url: urls.secondary,
        openerPageRef: opened.pageRef,
      });
      const withPopup = await target.listPages();
      assert(
        withPopup.pages.some((page) => page.pageRef === created.pageRef),
        "expected page.new to create a second page",
      );

      const activated = await target.activatePage({ pageRef: created.pageRef });
      assertEqual(
        activated.pageRef,
        created.pageRef,
        "expected page.activate to switch the active page",
      );

      const closed = await target.closePage({ pageRef: created.pageRef });
      assertEqual(
        closed.closedPageRef,
        created.pageRef,
        "expected page.close to report the closed page",
      );
      const afterClose = await target.listPages();
      assert(
        !afterClose.pages.some((page) => page.pageRef === created.pageRef),
        "expected the closed page to disappear from page.list output",
      );
    },
  },
  {
    id: "evaluate-init-script",
    family: "evaluate-init-script",
    description: "propagates init scripts and evaluates page state on demand",
    async run({ target, urls }) {
      await target.open(urls.main);
      await target.addInitScript("window.__opensteerConformanceInit = 'ready';");
      const page = await target.newPage({ url: urls.secondary });
      const initValue = await target.evaluate({
        pageRef: page.pageRef,
        script: "() => window.__opensteerConformanceInit",
      });
      assertEqual(
        initValue,
        "ready",
        "expected addInitScript to affect subsequently created pages",
      );

      const evaluation = await target.evaluate({
        pageRef: page.pageRef,
        script: "() => ({ title: document.title, pathname: location.pathname })",
      });
      const record = asRecord(evaluation, "expected page.evaluate to return an object");
      assertEqual(record.title, "Opensteer Conformance Secondary");
      assertEqual(record.pathname, "/conformance/secondary");
    },
  },
  {
    id: "dom-actions-extract",
    family: "dom-actions-extract",
    description: "executes DOM actions and extracts stable page state",
    async run({ target, urls }) {
      await target.open(urls.main);
      await target.click({ selector: "#action-button" });
      await target.input({ selector: "#text-input", text: "typed-value" });
      await target.scroll({ selector: "body", direction: "down", amount: 120 });

      const extracted = asRecord(
        await target.extract({
          persist: "conformance fixture state",
        }),
        "expected extract() to produce an object",
      );
      assertEqual(extracted.status, "clicked");
      assertEqual(extracted.mirror, "typed-value");
    },
  },
  {
    id: "cookies-storage",
    family: "cookies-storage",
    description: "captures cookies plus local/session storage through the session boundary",
    async run({ target, urls }) {
      await target.open(urls.main);
      await target.evaluate(`
        (() => {
          document.cookie = "conformance-cookie=available; path=/";
          localStorage.setItem("conformance-key", "stored");
          sessionStorage.setItem("conformance-session-key", "sessioned");
          return "ok";
        })()
      `);

      const cookies = await target.cookies(new URL(urls.main).hostname);
      assert(
        cookies.has("conformance-cookie") && cookies.get("conformance-cookie") === "available",
        "expected session.cookies to include the cookie written in-page",
      );

      const localStorage = await target.storage(new URL(urls.main).hostname, "local");
      assertEqual(
        localStorage["conformance-key"],
        "stored",
        "expected session.storage(local) to include localStorage entries",
      );

      const sessionStorage = await target.storage(new URL(urls.main).hostname, "session");
      assertEqual(
        sessionStorage["conformance-session-key"],
        "sessioned",
        "expected session.storage(session) to include sessionStorage entries",
      );
    },
  },
  {
    id: "network-capture",
    family: "network-capture",
    description: "queries captured traffic and inspects request details",
    async run({ target, urls }) {
      await target.open(urls.main);
      const networkUrl = new URL("/api/network?kind=live", urls.baseUrl).href;
      await target.evaluate({
        script: "(url) => fetch(url).then((response) => response.text())",
        args: [networkUrl],
      });

      await poll(
        async () => {
          const live = await target.network.query({
            url: networkUrl,
            limit: 10,
          });
          return live.records.length > 0;
        },
        5_000,
        "expected network.query to observe the live request",
      );

      const records = await target.network.query({
        url: networkUrl,
        limit: 10,
      });
      const record = records.records[0];
      assert(record, "expected network.query to return at least one captured record");

      const detail = await target.network.detail(record.recordId);
      assert(
        detail.requestHeaders.length > 0 || detail.responseHeaders.length > 0,
        "expected network.detail to expose request or response headers",
      );
    },
  },
  {
    id: "route-intercept",
    family: "route-intercept",
    description: "fulfills network routes and rewrites scripts before page execution",
    async run({ target, urls }) {
      if (!target.route || !target.interceptScript) {
        throw new UnsupportedCapabilityError(
          "expected route() and interceptScript() to be available",
        );
      }

      await target.open(urls.main);
      await target.route({
        urlPattern: "**/api/routed",
        times: 1,
        handler: async () => ({
          kind: "fulfill",
          status: 200,
          body: "intercepted",
          contentType: "text/plain; charset=utf-8",
        }),
      });

      const routedResponse = await target.evaluate({
        script: "(url) => fetch(url).then((response) => response.text())",
        args: [new URL("/api/routed", urls.baseUrl).href],
      });
      assertEqual(routedResponse, "intercepted");

      await target.interceptScript({
        urlPattern: "**/assets/intercept.js",
        times: 1,
        handler: ({ content }) => content.replace("__INTERCEPT_VALUE__", "patched-by-intercept"),
      });

      const scripted = await target.newPage({ url: urls.scripted });
      const interceptedValue = await target.evaluate({
        pageRef: scripted.pageRef,
        script: "() => window.__opensteerInterceptValue",
      });
      assertEqual(interceptedValue, "patched-by-intercept");
    },
  },
  {
    id: "computer-execute",
    family: "computer-execute",
    description: "drives the viewport through coordinate-based computer actions",
    async run({ target, urls }) {
      if (!target.computerExecute) {
        throw new UnsupportedCapabilityError("expected computerExecute() to be available");
      }

      await target.open(urls.main);
      await target.computerExecute({
        action: {
          type: "click",
          x: 90,
          y: 40,
        },
      });
      const status = asRecord(
        await target.extract({
          persist: "conformance computer status",
        }),
        "expected extract() to return the computer action status",
      );
      assertEqual(status.status, "clicked");
    },
  },
] as const;

export class UnsupportedCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCapabilityError";
  }
}

export function isUnsupportedCapabilityError(error: unknown): error is UnsupportedCapabilityError {
  return error instanceof UnsupportedCapabilityError;
}

async function poll(
  check: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message = `expected ${String(expected)}, received ${String(actual)}`,
): void {
  if (actual !== expected) {
    throw new Error(message);
  }
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
