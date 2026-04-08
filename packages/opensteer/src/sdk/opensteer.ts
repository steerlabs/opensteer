import type {
  CookieRecord,
  OpensteerCookieQueryOutput,
  OpensteerActionResult,
  OpensteerAddInitScriptInput,
  OpensteerAddInitScriptOutput,
  OpensteerComputerExecuteInput,
  OpensteerComputerExecuteOutput,
  OpensteerComputerKeyModifier,
  OpensteerComputerMouseButton,
  OpensteerNetworkDetailOutput,
  OpensteerNetworkQueryInput,
  OpensteerNetworkQueryOutput,
  OpensteerNetworkReplayInput,
  OpensteerNetworkReplayOutput,
  OpensteerOpenInput,
  OpensteerOpenOutput,
  OpensteerPageActivateInput,
  OpensteerPageActivateOutput,
  OpensteerPageCloseInput,
  OpensteerPageCloseOutput,
  OpensteerPageEvaluateInput,
  OpensteerPageEvaluateOutput,
  OpensteerPageGotoInput,
  OpensteerPageGotoOutput,
  OpensteerPageListInput,
  OpensteerPageListOutput,
  OpensteerPageNewInput,
  OpensteerPageNewOutput,
  OpensteerRequestResponseResult,
  OpensteerSessionCloseOutput,
  OpensteerSessionFetchInput,
  OpensteerSessionInfo,
  OpensteerSnapshotMode,
  OpensteerStateQueryOutput,
  OpensteerStorageArea,
  OpensteerStorageDomainSnapshot,
  OpensteerTargetInput,
} from "@opensteer/protocol";

import {
  OpensteerBrowserManager,
  type OpensteerBrowserStatus,
  type WorkspaceBrowserManifest,
} from "../browser-manager.js";
import { resolveOpensteerEnvironment } from "../env.js";
import type { OpensteerProviderOptions } from "../provider/config.js";
import type {
  OpensteerInterceptScriptOptions,
  OpensteerInstrumentableRuntime,
  OpensteerRouteOptions,
  OpensteerRouteRegistration,
} from "./instrumentation.js";
import type { OpensteerRuntimeOptions } from "./runtime.js";
import {
  createOpensteerSemanticRuntime,
  resolveOpensteerRuntimeConfig,
} from "./runtime-resolution.js";
import type { OpensteerDisconnectableRuntime } from "./semantic-runtime.js";

export interface OpensteerTargetOptions {
  readonly element?: number;
  readonly selector?: string;
  readonly persist?: string;
  readonly captureNetwork?: string;
}

export interface OpensteerClickOptions extends OpensteerTargetOptions {
  readonly button?: OpensteerComputerMouseButton;
  readonly clickCount?: number;
  readonly modifiers?: readonly OpensteerComputerKeyModifier[];
}

export interface OpensteerInputOptions extends OpensteerTargetOptions {
  readonly text: string;
  readonly pressEnter?: boolean;
}

export interface OpensteerScrollOptions extends OpensteerTargetOptions {
  readonly direction: "up" | "down" | "left" | "right";
  readonly amount: number;
}

export interface OpensteerExtractOptions {
  readonly persist: string;
  readonly schema?: Record<string, unknown>;
}

export interface OpensteerWaitForNetworkOptions extends OpensteerNetworkQueryInput {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface OpensteerWaitForPageOptions {
  readonly openerPageRef?: string;
  readonly urlIncludes?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export type OpensteerAddInitScriptOptions = OpensteerAddInitScriptInput;
export type OpensteerGotoOptions = Omit<OpensteerPageGotoInput, "url">;
export type OpensteerNetworkQueryOptions = OpensteerNetworkQueryInput;
export type OpensteerNetworkQueryResult = OpensteerNetworkQueryOutput;
export type OpensteerNetworkDetailResult = OpensteerNetworkDetailOutput;
export type OpensteerNetworkReplayOptions = Omit<OpensteerNetworkReplayInput, "recordId">;
export type OpensteerNetworkReplayResult = OpensteerNetworkReplayOutput;
export type OpensteerFetchOptions = Omit<OpensteerSessionFetchInput, "url">;
export type OpensteerComputerExecuteOptions = OpensteerComputerExecuteInput;
export type OpensteerStorageMap = Readonly<Record<string, string>>;
export type OpensteerBrowserState = OpensteerStateQueryOutput;

export interface OpensteerCookieJar {
  readonly domain?: string;
  has(name: string): boolean;
  get(name: string): string | undefined;
  getAll(): readonly CookieRecord[];
  serialize(): string;
}

export interface OpensteerDomController {
  click(input: OpensteerClickOptions): Promise<OpensteerActionResult>;
  hover(input: OpensteerTargetOptions): Promise<OpensteerActionResult>;
  input(input: OpensteerInputOptions): Promise<OpensteerActionResult>;
  scroll(input: OpensteerScrollOptions): Promise<OpensteerActionResult>;
}

export interface OpensteerNetworkController {
  query(input?: OpensteerNetworkQueryOptions): Promise<OpensteerNetworkQueryResult>;
  detail(recordId: string): Promise<OpensteerNetworkDetailResult>;
  replay(
    recordId: string,
    overrides?: OpensteerNetworkReplayOptions,
  ): Promise<OpensteerNetworkReplayResult>;
}

export interface OpensteerOptions extends OpensteerRuntimeOptions {
  readonly provider?: OpensteerProviderOptions;
}

export interface OpensteerBrowserCloneOptions {
  readonly sourceUserDataDir: string;
  readonly sourceProfileDirectory?: string;
}

export interface OpensteerBrowserController {
  status(): Promise<OpensteerBrowserStatus>;
  clone(input: OpensteerBrowserCloneOptions): Promise<WorkspaceBrowserManifest>;
  reset(): Promise<void>;
  delete(): Promise<void>;
}

class SessionCookieJar implements OpensteerCookieJar {
  readonly domain?: string;
  private readonly cookies: readonly CookieRecord[];

  constructor(output: OpensteerCookieQueryOutput) {
    if (output.domain !== undefined) {
      this.domain = output.domain;
    }
    this.cookies = output.cookies;
  }

  has(name: string): boolean {
    return this.cookies.some((cookie) => cookie.name === name);
  }

  get(name: string): string | undefined {
    return this.cookies.find((cookie) => cookie.name === name)?.value;
  }

  getAll(): readonly CookieRecord[] {
    return this.cookies;
  }

  serialize(): string {
    return this.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }
}

export class Opensteer {
  private readonly runtime: OpensteerDisconnectableRuntime;
  private readonly browserManager: OpensteerBrowserManager | undefined;
  readonly browser: OpensteerBrowserController;
  readonly dom: OpensteerDomController;
  readonly network: OpensteerNetworkController;

  constructor(options: OpensteerOptions = {}) {
    const environment = resolveOpensteerEnvironment(options.rootDir);
    const { provider, engineName, ...runtimeOptions } = options;
    const runtimeConfig = resolveOpensteerRuntimeConfig({
      ...(provider === undefined ? {} : { provider }),
      environment,
    });

    if (runtimeConfig.provider.mode === "cloud") {
      this.browserManager = undefined;
      this.runtime = createOpensteerSemanticRuntime({
        ...(provider === undefined ? {} : { provider }),
        ...(engineName === undefined ? {} : { engine: engineName }),
        environment,
        runtimeOptions,
      });
      this.browser = createUnsupportedBrowserController();
    } else {
      this.browserManager = new OpensteerBrowserManager({
        ...(runtimeOptions.rootDir === undefined ? {} : { rootDir: runtimeOptions.rootDir }),
        ...(runtimeOptions.rootPath === undefined ? {} : { rootPath: runtimeOptions.rootPath }),
        ...(runtimeOptions.workspace === undefined ? {} : { workspace: runtimeOptions.workspace }),
        ...(engineName === undefined ? {} : { engineName }),
        ...(runtimeOptions.browser === undefined ? {} : { browser: runtimeOptions.browser }),
        ...(runtimeOptions.launch === undefined ? {} : { launch: runtimeOptions.launch }),
        ...(runtimeOptions.context === undefined ? {} : { context: runtimeOptions.context }),
      });
      this.runtime = createOpensteerSemanticRuntime({
        ...(provider === undefined ? {} : { provider }),
        ...(engineName === undefined ? {} : { engine: engineName }),
        environment,
        runtimeOptions: {
          ...runtimeOptions,
          rootPath: this.browserManager.rootPath,
          cleanupRootOnClose: this.browserManager.cleanupRootOnDisconnect,
        },
      });
      this.browser = {
        status: () => this.browserManager!.status(),
        clone: (input) => this.browserManager!.clonePersistentBrowser(input),
        reset: () => this.browserManager!.reset(),
        delete: () => this.browserManager!.delete(),
      };
    }

    this.dom = {
      click: (input) => this.click(input),
      hover: (input) => this.hover(input),
      input: (input) => this.input(input),
      scroll: (input) => this.scroll(input),
    };

    this.network = {
      query: (input = {}) => this.queryNetwork(input),
      detail: (recordId) => this.runtime.getNetworkDetail({ recordId }),
      replay: (recordId, overrides = {}) =>
        this.runtime.replayNetwork({
          recordId,
          ...overrides,
        }),
    };
  }

  async open(input: string | OpensteerOpenInput = {}): Promise<OpensteerOpenOutput> {
    return this.runtime.open(typeof input === "string" ? { url: input } : input);
  }

  async info(): Promise<OpensteerSessionInfo> {
    return this.runtime.info();
  }

  async listPages(input: OpensteerPageListInput = {}): Promise<OpensteerPageListOutput> {
    return this.runtime.listPages(input);
  }

  async newPage(input: OpensteerPageNewInput = {}): Promise<OpensteerPageNewOutput> {
    return this.runtime.newPage(input);
  }

  async activatePage(input: OpensteerPageActivateInput): Promise<OpensteerPageActivateOutput> {
    return this.runtime.activatePage(input);
  }

  async closePage(input: OpensteerPageCloseInput = {}): Promise<OpensteerPageCloseOutput> {
    return this.runtime.closePage(input);
  }

  async goto(url: string, options: OpensteerGotoOptions = {}): Promise<OpensteerPageGotoOutput> {
    return this.runtime.goto({
      url,
      ...options,
    });
  }

  async evaluate(
    input: string | OpensteerPageEvaluateInput,
  ): Promise<OpensteerPageEvaluateOutput["value"]> {
    const normalized =
      typeof input === "string"
        ? {
            script: input,
          }
        : input;
    return (await this.runtime.evaluate(normalized)).value;
  }

  async evaluateJson(
    input: string | OpensteerPageEvaluateInput,
  ): Promise<OpensteerPageEvaluateOutput["value"]> {
    return this.evaluate(input);
  }

  async addInitScript(
    input: string | OpensteerAddInitScriptInput,
  ): Promise<OpensteerAddInitScriptOutput> {
    return this.runtime.addInitScript(
      typeof input === "string"
        ? {
            script: input,
          }
        : input,
    );
  }

  async click(input: OpensteerClickOptions): Promise<OpensteerActionResult> {
    const { button, clickCount, modifiers, ...target } = input;
    return this.runtime.click({
      ...normalizeTargetOptions(target),
      ...(button === undefined ? {} : { button }),
      ...(clickCount === undefined ? {} : { clickCount }),
      ...(modifiers === undefined ? {} : { modifiers }),
    });
  }

  async hover(input: OpensteerTargetOptions): Promise<OpensteerActionResult> {
    return this.runtime.hover(normalizeTargetOptions(input));
  }

  async input(input: OpensteerInputOptions): Promise<OpensteerActionResult> {
    return this.runtime.input({
      ...normalizeTargetOptions(input),
      text: input.text,
      ...(input.pressEnter === undefined ? {} : { pressEnter: input.pressEnter }),
    });
  }

  async scroll(input: OpensteerScrollOptions): Promise<OpensteerActionResult> {
    return this.runtime.scroll({
      ...normalizeTargetOptions(input),
      direction: input.direction,
      amount: input.amount,
    });
  }

  async extract(input: OpensteerExtractOptions): Promise<unknown> {
    return (await this.runtime.extract(input)).data;
  }

  async queryNetwork(
    input: OpensteerNetworkQueryOptions = {},
  ): Promise<OpensteerNetworkQueryResult> {
    return this.runtime.queryNetwork(input);
  }

  async waitForNetwork(
    input: OpensteerWaitForNetworkOptions,
  ): Promise<OpensteerNetworkQueryResult["records"][number]> {
    const { timeoutMs, pollIntervalMs, ...query } = input;
    const timeoutAt = Date.now() + (timeoutMs ?? 30_000);
    const pollInterval = pollIntervalMs ?? 100;
    const baseline = new Set(
      (await this.runtime.queryNetwork({ ...query, limit: 200 })).records.map(
        (record) => record.recordId,
      ),
    );

    while (true) {
      const next = (await this.runtime.queryNetwork({ ...query, limit: 200 })).records.find(
        (record) => !baseline.has(record.recordId),
      );
      if (next !== undefined) {
        return next;
      }
      if (Date.now() >= timeoutAt) {
        throw new Error("waitForNetwork timed out");
      }
      await delay(pollInterval);
    }
  }

  async waitForResponse(
    input: OpensteerWaitForNetworkOptions,
  ): Promise<OpensteerNetworkQueryResult["records"][number]> {
    return this.waitForNetwork(input);
  }

  async waitForPage(
    input: OpensteerWaitForPageOptions = {},
  ): Promise<OpensteerPageListOutput["pages"][number]> {
    const baseline = new Set((await this.runtime.listPages()).pages.map((page) => page.pageRef));
    const timeoutAt = Date.now() + (input.timeoutMs ?? 30_000);
    const pollIntervalMs = input.pollIntervalMs ?? 100;

    while (true) {
      const match = (await this.runtime.listPages()).pages.find((page) => {
        if (baseline.has(page.pageRef)) {
          return false;
        }
        if (input.openerPageRef !== undefined && page.openerPageRef !== input.openerPageRef) {
          return false;
        }
        if (input.urlIncludes !== undefined && !page.url.includes(input.urlIncludes)) {
          return false;
        }
        return true;
      });
      if (match !== undefined) {
        return match;
      }
      if (Date.now() >= timeoutAt) {
        throw new Error("waitForPage timed out");
      }
      await delay(pollIntervalMs);
    }
  }

  async snapshot(mode: OpensteerSnapshotMode = "action"): Promise<string> {
    return (await this.runtime.snapshot({ mode })).html;
  }

  async cookies(domain?: string): Promise<OpensteerCookieJar> {
    return new SessionCookieJar(
      await this.runtime.getCookies(domain === undefined ? {} : { domain }),
    );
  }

  async storage(
    domain?: string,
    type: OpensteerStorageArea = "local",
  ): Promise<OpensteerStorageMap> {
    const snapshot = await this.runtime.getStorageSnapshot(domain === undefined ? {} : { domain });
    const domainSnapshot = pickStorageDomainSnapshot(snapshot, domain);
    if (domainSnapshot === undefined) {
      return {};
    }
    const entries = type === "local" ? domainSnapshot.localStorage : domainSnapshot.sessionStorage;
    return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
  }

  async state(domain?: string): Promise<OpensteerBrowserState> {
    return this.runtime.getBrowserState(domain === undefined ? {} : { domain });
  }

  async fetch(url: string, options: OpensteerFetchOptions = {}): Promise<Response> {
    const result = await this.runtime.fetch({
      url,
      ...options,
    });
    if (result.response === undefined) {
      throw new Error(result.note ?? `session.fetch did not produce a response for ${url}`);
    }
    return toResponse(result.response);
  }

  async computerExecute(
    input: OpensteerComputerExecuteOptions,
  ): Promise<OpensteerComputerExecuteOutput> {
    return this.runtime.computerExecute(input);
  }

  async route(input: OpensteerRouteOptions): Promise<OpensteerRouteRegistration> {
    return this.requireOwnedInstrumentationRuntime("route").route(input);
  }

  async interceptScript(
    input: OpensteerInterceptScriptOptions,
  ): Promise<OpensteerRouteRegistration> {
    return this.requireOwnedInstrumentationRuntime("interceptScript").interceptScript(input);
  }

  async close(): Promise<OpensteerSessionCloseOutput> {
    if (this.browserManager === undefined || this.browserManager.mode === "temporary") {
      return this.runtime.close();
    }

    const output = await this.runtime.close();
    await this.browserManager.close();
    return output;
  }

  async disconnect(): Promise<void> {
    await this.runtime.disconnect();
  }

  private requireOwnedInstrumentationRuntime(
    method: "route" | "interceptScript",
  ): OpensteerInstrumentableRuntime {
    if (
      typeof (this.runtime as Partial<OpensteerInstrumentableRuntime>).route === "function" &&
      typeof (this.runtime as Partial<OpensteerInstrumentableRuntime>).interceptScript ===
        "function"
    ) {
      return this.runtime as OpensteerDisconnectableRuntime & OpensteerInstrumentableRuntime;
    }
    throw new Error(`${method}() is not available for this session runtime.`);
  }
}

function createUnsupportedBrowserController(): OpensteerBrowserController {
  const fail = async (): Promise<never> => {
    throw new Error("browser.* helpers are only available in local mode.");
  };

  return {
    status: fail,
    clone: fail,
    reset: fail,
    delete: fail,
  };
}

function normalizeTargetOptions(input: OpensteerTargetOptions): {
  readonly target: OpensteerTargetInput;
  readonly persist?: string;
  readonly captureNetwork?: string;
} {
  const hasElement = input.element !== undefined;
  const hasSelector = input.selector !== undefined;
  if (hasElement && hasSelector) {
    throw new Error("Specify exactly one of element, selector, or persist.");
  }

  if (hasElement) {
    return {
      target: {
        kind: "element",
        element: input.element,
      },
      ...(input.persist === undefined ? {} : { persist: input.persist }),
      ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
    };
  }

  if (hasSelector) {
    return {
      target: {
        kind: "selector",
        selector: input.selector,
      },
      ...(input.persist === undefined ? {} : { persist: input.persist }),
      ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
    };
  }

  if (input.persist === undefined) {
    throw new Error("Specify exactly one of element, selector, or persist.");
  }

  return {
    target: {
      kind: "persist",
      name: input.persist,
    },
    ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
  };
}

function pickStorageDomainSnapshot(
  snapshot: {
    readonly domains: readonly OpensteerStorageDomainSnapshot[];
  },
  domain: string | undefined,
): OpensteerStorageDomainSnapshot | undefined {
  if (snapshot.domains.length === 0) {
    return undefined;
  }
  if (domain === undefined) {
    return snapshot.domains[0];
  }
  return snapshot.domains.find((entry) => entry.domain === domain);
}

function toResponse(response: OpensteerRequestResponseResult): Response {
  return new Response(decodeBody(response), {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.map((header) => [header.name, header.value])),
  });
}

function decodeBody(response: OpensteerRequestResponseResult): Uint8Array | undefined {
  if (response.body === undefined) {
    return undefined;
  }
  return Uint8Array.from(Buffer.from(response.body.data, "base64"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
