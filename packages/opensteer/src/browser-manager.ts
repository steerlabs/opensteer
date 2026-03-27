import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BrowserCoreEngine } from "@opensteer/browser-core";
import {
  connectPlaywrightChromiumBrowser,
  createPlaywrightBrowserCoreEngine,
  disconnectPlaywrightChromiumBrowser,
} from "@opensteer/engine-playwright";
import type {
  OpensteerAttachBrowserOptions,
  OpensteerBrowserContextOptions,
  OpensteerBrowserLaunchOptions,
  OpensteerBrowserOptions,
} from "@opensteer/protocol";

import { isProcessRunning } from "./local-browser/process-owner.js";
import { clearChromeSingletonEntries } from "./local-browser/chrome-singletons.js";
import {
  readDevToolsActivePort,
  resolveChromeExecutablePath,
} from "./local-browser/chrome-discovery.js";
import { inspectCdpEndpoint, selectAttachBrowserCandidate } from "./local-browser/cdp-discovery.js";
import { createBrowserProfileSnapshot } from "./local-browser/profile-clone.js";
import { injectBrowserStealthScripts } from "./local-browser/stealth.js";
import { generateStealthProfile, type StealthProfile } from "./local-browser/stealth-profiles.js";
import {
  createFilesystemOpensteerWorkspace,
  resolveFilesystemWorkspacePath,
  type FilesystemOpensteerWorkspace,
} from "./root.js";
import {
  ensureDirectory,
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "./internal/filesystem.js";
import {
  assertSupportedEngineOptions,
  DEFAULT_OPENSTEER_ENGINE,
  toAbpLaunchOptions,
  type OpensteerEngineName,
} from "./internal/engine-selection.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEVTOOLS_POLL_INTERVAL_MS = 50;
const TEMPORARY_WORKSPACE_PREFIX = "opensteer-temporary-workspace-";
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

type DisposableBrowserCoreEngine = BrowserCoreEngine & {
  dispose?: () => Promise<void>;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

export interface WorkspaceBrowserBootstrap {
  readonly kind: "empty" | "cloneLocalProfile";
  readonly sourceUserDataDir?: string;
  readonly sourceProfileDirectory?: string;
}

export interface WorkspaceBrowserManifest {
  readonly mode: "persistent";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly userDataDir: "browser/user-data";
  readonly bootstrap: WorkspaceBrowserBootstrap;
}

export interface WorkspaceLiveBrowserRecord {
  readonly mode: "persistent";
  readonly engine: OpensteerEngineName;
  readonly endpoint?: string;
  readonly baseUrl?: string;
  readonly remoteDebuggingUrl?: string;
  readonly sessionDir?: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly executablePath?: string;
  readonly userDataDir: string;
}

export interface OpensteerBrowserStatus {
  readonly mode: "temporary" | "persistent" | "attach";
  readonly engine: OpensteerEngineName;
  readonly workspace?: string;
  readonly rootPath: string;
  readonly live: boolean;
  readonly browserPath?: string;
  readonly userDataDir?: string;
  readonly endpoint?: string;
  readonly baseUrl?: string;
  readonly manifest?: WorkspaceBrowserManifest;
}

export interface OpensteerBrowserManagerOptions {
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly workspace?: string;
  readonly engineName?: OpensteerEngineName;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
}

export class OpensteerBrowserManager {
  readonly mode: "temporary" | "persistent" | "attach";
  readonly engineName: OpensteerEngineName;
  readonly rootPath: string;
  readonly workspace: string | undefined;
  readonly cleanupRootOnDisconnect: boolean;

  private readonly browserOptions: OpensteerAttachBrowserOptions | undefined;
  private readonly launchOptions: OpensteerBrowserLaunchOptions | undefined;
  private readonly contextOptions: OpensteerBrowserContextOptions | undefined;
  private workspaceStore: FilesystemOpensteerWorkspace | undefined;

  constructor(options: OpensteerBrowserManagerOptions = {}) {
    this.workspace = normalizeWorkspace(options.workspace);
    this.mode = resolveBrowserMode(this.workspace, options.browser);
    this.browserOptions = isAttachBrowserOptions(options.browser) ? options.browser : undefined;
    this.launchOptions = options.launch;
    this.contextOptions = normalizeBrowserContextOptions(options.context);
    this.engineName = options.engineName ?? DEFAULT_OPENSTEER_ENGINE;
    assertSupportedEngineOptions({
      engineName: this.engineName,
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(this.contextOptions === undefined ? {} : { context: this.contextOptions }),
    });
    this.rootPath =
      options.rootPath ??
      (this.workspace === undefined
        ? path.join(tmpdir(), `${TEMPORARY_WORKSPACE_PREFIX}${randomUUID()}`)
        : resolveFilesystemWorkspacePath({
            rootDir: path.resolve(options.rootDir ?? process.cwd()),
            workspace: this.workspace,
          }));
    this.cleanupRootOnDisconnect = this.workspace === undefined;
  }

  async createEngine(): Promise<DisposableBrowserCoreEngine> {
    if (this.mode === "persistent") {
      const effectiveEngine = (await this.resolveLivePersistentEngineName()) ?? this.engineName;
      if (effectiveEngine === "abp") {
        return this.createAbpEngine();
      }
      return this.createPersistentEngine();
    }

    if (this.engineName === "abp") {
      return this.createAbpEngine();
    }
    if (this.mode === "temporary") {
      return this.createTemporaryEngine();
    }
    if (this.mode === "attach") {
      return this.createAttachEngine();
    }
    return this.createPersistentEngine();
  }

  async status(): Promise<OpensteerBrowserStatus> {
    if (this.mode === "temporary") {
      return {
        mode: "temporary",
        engine: this.engineName,
        rootPath: this.rootPath,
        live: false,
      };
    }

    const workspace = await this.ensureWorkspaceStore();
    const manifest = await this.readBrowserManifest(workspace);
    const liveRecord = await this.readLivePersistentBrowser(workspace);
    return {
      mode: this.mode,
      engine: liveRecord?.engine ?? this.engineName,
      ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      rootPath: workspace.rootPath,
      live: liveRecord !== undefined,
      browserPath: workspace.browserPath,
      userDataDir: workspace.browserUserDataDir,
      ...(liveRecord?.endpoint === undefined ? {} : { endpoint: liveRecord.endpoint }),
      ...(liveRecord?.baseUrl === undefined ? {} : { baseUrl: liveRecord.baseUrl }),
      ...(manifest === undefined ? {} : { manifest }),
    };
  }

  async clonePersistentBrowser(input: {
    readonly sourceUserDataDir: string;
    readonly sourceProfileDirectory?: string;
  }): Promise<WorkspaceBrowserManifest> {
    this.requirePersistentMode("clone");
    const workspace = await this.ensureWorkspaceStore();
    return workspace.lock(async () => {
      await this.assertPersistentBrowserClosed(workspace);
      await rm(workspace.browserPath, { recursive: true, force: true });
      await ensureDirectory(workspace.browserUserDataDir);
      await clearChromeSingletonEntries(workspace.browserUserDataDir);
      await createBrowserProfileSnapshot({
        sourceUserDataDir: input.sourceUserDataDir,
        targetUserDataDir: workspace.browserUserDataDir,
        ...(input.sourceProfileDirectory === undefined
          ? {}
          : { profileDirectory: input.sourceProfileDirectory }),
        copyMode: "full",
      });
      const manifest: WorkspaceBrowserManifest = {
        mode: "persistent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        userDataDir: "browser/user-data",
        bootstrap: {
          kind: "cloneLocalProfile",
          sourceUserDataDir: path.resolve(input.sourceUserDataDir),
          ...(input.sourceProfileDirectory === undefined
            ? {}
            : { sourceProfileDirectory: input.sourceProfileDirectory }),
        },
      };
      await writeJsonFileAtomic(workspace.browserManifestPath, manifest);
      return manifest;
    });
  }

  async reset(): Promise<void> {
    this.requirePersistentMode("reset");
    const workspace = await this.ensureWorkspaceStore();
    await workspace.lock(async () => {
      await this.closePersistentBrowser(workspace);
      await rm(resolveAbpSessionDir(workspace), { recursive: true, force: true });
      await rm(workspace.browserPath, { recursive: true, force: true });
      await rm(workspace.liveBrowserPath, { force: true });
      await ensureDirectory(workspace.browserUserDataDir);
    });
  }

  async delete(): Promise<void> {
    this.requirePersistentMode("delete");
    const workspace = await this.ensureWorkspaceStore();
    await workspace.lock(async () => {
      await this.closePersistentBrowser(workspace);
      await rm(resolveAbpSessionDir(workspace), { recursive: true, force: true });
      await rm(workspace.browserPath, { recursive: true, force: true });
      await rm(workspace.liveBrowserPath, { force: true });
    });
  }

  async close(): Promise<void> {
    if (this.mode !== "persistent") {
      return;
    }

    const workspace = await this.ensureWorkspaceStore();
    await workspace.lock(async () => {
      await this.closePersistentBrowser(workspace);
    });
  }

  private async createAbpEngine(): Promise<DisposableBrowserCoreEngine> {
    if (this.mode === "attach") {
      throw new Error(
        'ABP engine does not support browser.mode="attach". Use the Playwright engine for attach flows.',
      );
    }
    if (this.mode === "temporary") {
      return this.createTemporaryAbpEngine();
    }
    return this.createPersistentAbpEngine();
  }

  private async createTemporaryAbpEngine(): Promise<DisposableBrowserCoreEngine> {
    const workspace = await this.ensureWorkspaceStore();
    await clearChromeSingletonEntries(workspace.browserUserDataDir);
    const { createAbpBrowserCoreEngine } = await loadAbpModule();
    const launch = toAbpLaunchOptions({
      ...(this.launchOptions === undefined ? {} : { launch: this.launchOptions }),
      ...(this.contextOptions === undefined ? {} : { context: this.contextOptions }),
      userDataDir: workspace.browserUserDataDir,
      sessionDir: resolveAbpSessionDir(workspace),
    });
    return (await createAbpBrowserCoreEngine(
      launch === undefined ? {} : { launch },
    )) as DisposableBrowserCoreEngine;
  }

  private async createPersistentAbpEngine(): Promise<DisposableBrowserCoreEngine> {
    const workspace = await this.ensureWorkspaceStore();
    return workspace.lock(async () => {
      const live = await this.readLivePersistentBrowser(workspace);
      if (live !== undefined) {
        if (live.engine !== "abp") {
          throw new Error(
            `workspace "${this.workspace}" already has a live ${live.engine} browser. Close it before reopening with engine "abp".`,
          );
        }
        return this.createAdoptedAbpEngine(live);
      }

      await this.ensurePersistentBrowserManifest(workspace);
      await clearChromeSingletonEntries(workspace.browserUserDataDir);
      const { launchAbpProcess } = await loadAbpModule();
      const launch = toAbpLaunchOptions({
        ...(this.launchOptions === undefined ? {} : { launch: this.launchOptions }),
        ...(this.contextOptions === undefined ? {} : { context: this.contextOptions }),
        userDataDir: workspace.browserUserDataDir,
        sessionDir: resolveAbpSessionDir(workspace),
      });
      const launched = await launchAbpProcess({
        port: await allocateEphemeralPort(),
        userDataDir: workspace.browserUserDataDir,
        sessionDir: resolveAbpSessionDir(workspace),
        headless: launch?.headless ?? true,
        args: launch?.args ?? [],
        verbose: false,
        ...(launch?.browserExecutablePath === undefined
          ? {}
          : { browserExecutablePath: launch.browserExecutablePath }),
      });
      const liveRecord: WorkspaceLiveBrowserRecord = {
        mode: "persistent",
        engine: "abp",
        baseUrl: launched.baseUrl,
        remoteDebuggingUrl: launched.remoteDebuggingUrl,
        pid: launched.process.pid ?? 0,
        startedAt: Date.now(),
        userDataDir: workspace.browserUserDataDir,
        sessionDir: resolveAbpSessionDir(workspace),
        ...(launch?.browserExecutablePath === undefined
          ? {}
          : { executablePath: launch.browserExecutablePath }),
      };
      await writeJsonFileAtomic(workspace.liveBrowserPath, liveRecord);

      try {
        return await this.createAdoptedAbpEngine(liveRecord);
      } catch (error) {
        await terminateProcess(launched.process.pid ?? 0).catch(() => undefined);
        await rm(workspace.liveBrowserPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  private async createAdoptedAbpEngine(
    live: WorkspaceLiveBrowserRecord,
  ): Promise<DisposableBrowserCoreEngine> {
    if (live.baseUrl === undefined || live.remoteDebuggingUrl === undefined) {
      throw new Error("workspace live browser record is missing ABP connection metadata.");
    }

    const { createAbpBrowserCoreEngine } = await loadAbpModule();
    return (await createAbpBrowserCoreEngine({
      browser: {
        baseUrl: live.baseUrl,
        remoteDebuggingUrl: live.remoteDebuggingUrl,
      },
    })) as DisposableBrowserCoreEngine;
  }

  private async createTemporaryEngine(): Promise<DisposableBrowserCoreEngine> {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-temporary-browser-"));
    await clearChromeSingletonEntries(userDataDir);
    const launched = await launchOwnedBrowser({
      userDataDir,
      cleanupUserDataDir: userDataDir,
      ...(this.launchOptions === undefined ? {} : { launch: this.launchOptions }),
    });
    try {
      return await this.createAttachedEngine({
        endpoint: launched.endpoint,
        freshTab: false,
        onDispose: async () => {
          await terminateProcess(launched.pid).catch(() => undefined);
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        },
      });
    } catch (error) {
      await terminateProcess(launched.pid).catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async createAttachEngine(): Promise<DisposableBrowserCoreEngine> {
    const endpoint = await resolveAttachEndpoint(this.browserOptions);
    return this.createAttachedEngine({
      endpoint,
      ...(this.browserOptions?.headers === undefined
        ? {}
        : { headers: this.browserOptions.headers }),
      freshTab: this.browserOptions?.freshTab ?? true,
      onDispose: async () => undefined,
    });
  }

  private async createPersistentEngine(): Promise<DisposableBrowserCoreEngine> {
    const workspace = await this.ensureWorkspaceStore();
    return workspace.lock(async () => {
      const live = await this.readLivePersistentBrowser(workspace);
      if (live) {
        if (live.engine !== "playwright") {
          throw new Error(
            `workspace "${this.workspace}" already has a live ${live.engine} browser. Close it before reopening with engine "playwright".`,
          );
        }
        if (live.endpoint === undefined) {
          throw new Error("workspace live browser record is missing a DevTools endpoint.");
        }
        return this.createAttachedEngine({
          endpoint: live.endpoint,
          freshTab: false,
          onDispose: async () => undefined,
        });
      }

      await this.ensurePersistentBrowserManifest(workspace);
      const launched = await launchOwnedBrowser({
        userDataDir: workspace.browserUserDataDir,
        ...(this.launchOptions === undefined ? {} : { launch: this.launchOptions }),
      });
      const liveRecord: WorkspaceLiveBrowserRecord = {
        mode: "persistent",
        engine: "playwright",
        endpoint: launched.endpoint,
        pid: launched.pid,
        startedAt: Date.now(),
        executablePath: launched.executablePath,
        userDataDir: workspace.browserUserDataDir,
      };
      await writeJsonFileAtomic(workspace.liveBrowserPath, liveRecord);

      try {
        return await this.createAttachedEngine({
          endpoint: launched.endpoint,
          freshTab: false,
          onDispose: async () => undefined,
        });
      } catch (error) {
        await terminateProcess(launched.pid).catch(() => undefined);
        await rm(workspace.liveBrowserPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  private async createAttachedEngine(input: {
    readonly endpoint: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly freshTab: boolean;
    readonly onDispose: () => Promise<void>;
  }): Promise<DisposableBrowserCoreEngine> {
    const browser = await connectPlaywrightChromiumBrowser({
      url: input.endpoint,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    });
    try {
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error("Connected browser did not expose a Chromium browser context.");
      }

      const stealthProfile = resolveStealthProfile(this.contextOptions?.stealthProfile);
      await injectBrowserStealthScripts(
        context as Parameters<typeof injectBrowserStealthScripts>[0],
        stealthProfile === undefined ? {} : { profile: stealthProfile },
      );

      const page =
        input.freshTab || context.pages()[0] === undefined
          ? await context.newPage()
          : context.pages()[0]!;
      await page.bringToFront?.();

      const engine = (await createPlaywrightBrowserCoreEngine({
        browser: browser as never,
        attachedContext: context,
        attachedPage: page,
        closeAttachedContextOnSessionClose: false,
        closeBrowserOnDispose: false,
        ...(this.contextOptions === undefined
          ? {}
          : { context: toEngineBrowserContextOptions(this.contextOptions) }),
      })) as DisposableBrowserCoreEngine;

      const originalDispose = engine.dispose?.bind(engine);
      const originalAsyncDispose = engine[Symbol.asyncDispose]?.bind(engine);
      let disposed = false;
      const disposeConnection = async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        try {
          await originalDispose?.();
        } finally {
          await disconnectPlaywrightChromiumBrowser(browser).catch(() => undefined);
          await input.onDispose().catch(() => undefined);
        }
      };

      engine.dispose = disposeConnection;
      engine[Symbol.asyncDispose] = async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        try {
          await originalAsyncDispose?.();
        } finally {
          await disconnectPlaywrightChromiumBrowser(browser).catch(() => undefined);
          await input.onDispose().catch(() => undefined);
        }
      };
      return engine;
    } catch (error) {
      await disconnectPlaywrightChromiumBrowser(browser).catch(() => undefined);
      throw error;
    }
  }

  private async ensureWorkspaceStore(): Promise<FilesystemOpensteerWorkspace> {
    this.workspaceStore ??= await createFilesystemOpensteerWorkspace({
      rootPath: this.rootPath,
      ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
      scope: this.workspace === undefined ? "temporary" : "workspace",
    });
    return this.workspaceStore;
  }

  private async ensurePersistentBrowserManifest(
    workspace: FilesystemOpensteerWorkspace,
  ): Promise<WorkspaceBrowserManifest> {
    const existing = await this.readBrowserManifest(workspace);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const manifest: WorkspaceBrowserManifest = {
      mode: "persistent",
      createdAt: now,
      updatedAt: now,
      userDataDir: "browser/user-data",
      bootstrap: {
        kind: "empty",
      },
    };
    await ensureDirectory(workspace.browserUserDataDir);
    await writeJsonFileAtomic(workspace.browserManifestPath, manifest);
    return manifest;
  }

  private async readBrowserManifest(
    workspace: FilesystemOpensteerWorkspace,
  ): Promise<WorkspaceBrowserManifest | undefined> {
    if (!(await pathExists(workspace.browserManifestPath))) {
      return undefined;
    }
    return readJsonFile<WorkspaceBrowserManifest>(workspace.browserManifestPath);
  }

  private async readLivePersistentBrowser(
    workspace: FilesystemOpensteerWorkspace,
  ): Promise<WorkspaceLiveBrowserRecord | undefined> {
    const live = await this.readStoredLiveBrowser(workspace);
    if (live === undefined) {
      return undefined;
    }
    if (!isProcessRunning(live.pid)) {
      await rm(workspace.liveBrowserPath, { force: true }).catch(() => undefined);
      return undefined;
    }
    if (live.engine === "playwright") {
      if (live.endpoint === undefined || !(await isEndpointReachable(live.endpoint))) {
        throw new Error(
          `workspace "${this.workspace}" browser process ${String(live.pid)} is still running, but its DevTools endpoint is unavailable`,
        );
      }
      return live;
    }

    if (live.baseUrl === undefined || !(await isAbpBaseUrlReachable(live.baseUrl))) {
      throw new Error(
        `workspace "${this.workspace}" browser process ${String(live.pid)} is still running, but its ABP endpoint is unavailable`,
      );
    }
    return live;
  }

  private async readStoredLiveBrowser(
    workspace: FilesystemOpensteerWorkspace,
  ): Promise<WorkspaceLiveBrowserRecord | undefined> {
    if (!(await pathExists(workspace.liveBrowserPath))) {
      return undefined;
    }
    const live = await readJsonFile<WorkspaceLiveBrowserRecord & { readonly engine?: string }>(
      workspace.liveBrowserPath,
    );
    if (live.engine === "abp") {
      return live;
    }
    return {
      ...live,
      engine: "playwright",
    };
  }

  private async resolveLivePersistentEngineName(): Promise<OpensteerEngineName | undefined> {
    if (this.mode !== "persistent") {
      return undefined;
    }

    const workspace = await this.ensureWorkspaceStore();
    const live = await this.readStoredLiveBrowser(workspace);
    return live?.engine;
  }

  private async assertPersistentBrowserClosed(
    workspace: FilesystemOpensteerWorkspace,
  ): Promise<void> {
    if ((await this.readLivePersistentBrowser(workspace)) !== undefined) {
      throw new Error(
        `workspace "${this.workspace}" already has a live browser. Close it before changing the saved profile.`,
      );
    }
  }

  private async closePersistentBrowser(workspace: FilesystemOpensteerWorkspace): Promise<void> {
    const live = await this.readStoredLiveBrowser(workspace);
    if (!live) {
      await rm(workspace.liveBrowserPath, { force: true }).catch(() => undefined);
      return;
    }

    if (live.engine === "playwright") {
      if (live.endpoint !== undefined) {
        await requestBrowserClose(live.endpoint).catch(() => undefined);
      }
      if (await waitForProcessExit(live.pid, BROWSER_CLOSE_TIMEOUT_MS)) {
        await rm(workspace.liveBrowserPath, { force: true }).catch(() => undefined);
        return;
      }
      await terminateProcess(live.pid).catch(() => undefined);
      await rm(workspace.liveBrowserPath, { force: true }).catch(() => undefined);
      return;
    }

    await terminateProcess(live.pid).catch(() => undefined);
    await rm(workspace.liveBrowserPath, { force: true }).catch(() => undefined);
  }

  private requirePersistentMode(method: "clone" | "reset" | "delete"): void {
    if (this.mode !== "persistent" || this.workspace === undefined) {
      throw new Error(`browser.${method}() requires a persistent workspace browser.`);
    }
  }
}

function normalizeWorkspace(workspace: string | undefined): string | undefined {
  const normalized = workspace?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function resolveBrowserMode(
  workspace: string | undefined,
  browser: OpensteerBrowserOptions | undefined,
): "temporary" | "persistent" | "attach" {
  if (browser === undefined) {
    return workspace === undefined ? "temporary" : "persistent";
  }
  if (browser === "temporary" || browser === "persistent") {
    return browser;
  }
  return "attach";
}

function isAttachBrowserOptions(
  browser: OpensteerBrowserOptions | undefined,
): browser is OpensteerAttachBrowserOptions {
  return typeof browser === "object" && browser !== null && browser.mode === "attach";
}

async function resolveAttachEndpoint(
  browser: OpensteerAttachBrowserOptions | undefined,
): Promise<string> {
  const endpoint = browser?.endpoint?.trim();
  if (endpoint && endpoint.length > 0) {
    return endpoint;
  }
  const selection = await selectAttachBrowserCandidate({
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return selection.endpoint;
}

async function launchOwnedBrowser(input: {
  readonly userDataDir: string;
  readonly cleanupUserDataDir?: string;
  readonly launch?: OpensteerBrowserLaunchOptions;
}): Promise<{
  readonly endpoint: string;
  readonly pid: number;
  readonly executablePath: string;
}> {
  await ensureDirectory(input.userDataDir);
  await clearChromeSingletonEntries(input.userDataDir);

  const executablePath = resolveChromeExecutablePath(input.launch?.executablePath);
  const args = buildChromeArgs(input.userDataDir, input.launch);
  const child = spawn(executablePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });

  child.unref();
  const stderrLines: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderrLines.push(String(chunk));
  });
  (
    child.stderr as
      | (NodeJS.ReadableStream & {
          unref?: () => void;
        })
      | undefined
  )?.unref?.();

  const endpoint = await waitForDevToolsEndpoint({
    userDataDir: input.userDataDir,
    timeoutMs: input.launch?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    childExited: async () => child.exitCode,
    stderrLines,
  }).catch(async (error) => {
    child.kill("SIGKILL");
    throw error;
  });

  return {
    endpoint,
    pid: child.pid ?? 0,
    executablePath,
  };
}

function buildChromeArgs(
  userDataDir: string,
  launch: OpensteerBrowserLaunchOptions | undefined,
): readonly string[] {
  const args = [
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-background-networking",
    "--disable-backgrounding-occluded-windows",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-features=Translate",
    "--enable-features=NetworkService,NetworkServiceInProcess",
    "--password-store=basic",
    "--use-mock-keychain",
    `--user-data-dir=${userDataDir}`,
  ];

  if (launch?.headless ?? true) {
    args.push("--headless=new");
    if (!(launch?.args ?? []).some((entry) => entry.startsWith("--window-size"))) {
      args.push("--window-size=1280,800");
    }
  }

  args.push(...(launch?.args ?? []));
  return args;
}

async function waitForDevToolsEndpoint(input: {
  readonly userDataDir: string;
  readonly timeoutMs: number;
  readonly childExited: () => Promise<number | null>;
  readonly stderrLines: readonly string[];
}): Promise<string> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const activePort = readDevToolsActivePort(input.userDataDir);
    if (activePort) {
      try {
        const inspected = await inspectCdpEndpoint({
          endpoint: `http://127.0.0.1:${String(activePort.port)}`,
          timeoutMs: Math.min(2_000, input.timeoutMs),
        });
        return inspected.endpoint;
      } catch {
        return `ws://127.0.0.1:${String(activePort.port)}${activePort.webSocketPath}`;
      }
    }

    const exitCode = await input.childExited();
    if (exitCode !== null) {
      throw new Error(formatChromeLaunchError(input.stderrLines));
    }

    await sleep(DEVTOOLS_POLL_INTERVAL_MS);
  }

  throw new Error(formatChromeLaunchError(input.stderrLines));
}

function formatChromeLaunchError(stderrLines: readonly string[]): string {
  const collapsed = stderrLines
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (collapsed.length === 0) {
    return "Chrome failed to launch before exposing a DevTools endpoint.";
  }
  return `Chrome failed to launch before exposing a DevTools endpoint.\n${collapsed.slice(-5).join("\n")}`;
}

async function isEndpointReachable(endpoint: string): Promise<boolean> {
  try {
    await inspectCdpEndpoint({
      endpoint,
      timeoutMs: 1_500,
    });
    return true;
  } catch {
    return false;
  }
}

async function isAbpBaseUrlReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/browser/status`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function terminateProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  if (await waitForProcessExit(pid, BROWSER_CLOSE_TIMEOUT_MS)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
}

async function requestBrowserClose(endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for Browser.close."));
    }, BROWSER_CLOSE_TIMEOUT_MS);
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          readonly id?: number;
          readonly error?: { readonly message?: string };
        };
        if (message.id !== 1) {
          return;
        }
        finish(message.error?.message === undefined ? undefined : new Error(message.error.message));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.addEventListener("close", () => {
      finish();
    });

    socket.addEventListener("error", () => {
      finish(new Error("Failed to send Browser.close."));
    });
  });
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(50);
  }

  return !isProcessRunning(pid);
}

function resolveAbpSessionDir(workspace: FilesystemOpensteerWorkspace): string {
  return path.join(workspace.livePath, "abp-session");
}

async function allocateEphemeralPort(): Promise<number> {
  const { allocatePort } = await loadAbpModule();
  return allocatePort();
}

async function loadAbpModule() {
  try {
    return await import("@opensteer/engine-abp");
  } catch (error) {
    if (isMissingPackageError(error, "@opensteer/engine-abp")) {
      throw new Error(
        'ABP engine selected but "@opensteer/engine-abp" is not installed. Install it to use --engine abp or OPENSTEER_ENGINE=abp.',
      );
    }
    throw error;
  }
}

function isMissingPackageError(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes(`Cannot find package '${packageName}'`) ||
    error.message.includes(`Cannot find module '${packageName}'`) ||
    error.message.includes(`Cannot find module "${packageName}"`)
  );
}

function normalizeBrowserContextOptions(
  context: OpensteerBrowserContextOptions | undefined,
): OpensteerBrowserContextOptions | undefined {
  const stealthProfile = resolveStealthProfile(context?.stealthProfile);
  const locale = context?.locale ?? stealthProfile?.locale;
  const timezoneId = context?.timezoneId ?? stealthProfile?.timezoneId;
  const userAgent = context?.userAgent ?? stealthProfile?.userAgent;
  return {
    ...(context ?? {}),
    ...(stealthProfile === undefined ? {} : { stealthProfile }),
    ...(locale === undefined ? {} : { locale }),
    ...(timezoneId === undefined ? {} : { timezoneId }),
    ...(userAgent === undefined ? {} : { userAgent }),
    viewport: context?.viewport ??
      stealthProfile?.viewport ?? {
        width: 1440,
        height: 900,
      },
  };
}

function toEngineBrowserContextOptions(
  context: OpensteerBrowserContextOptions,
): Omit<OpensteerBrowserContextOptions, "stealthProfile"> {
  const { stealthProfile: _stealthProfile, ...engineContext } = context;
  return engineContext;
}

function resolveStealthProfile(
  input: OpensteerBrowserContextOptions["stealthProfile"] | undefined,
): StealthProfile | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (isStealthProfile(input)) {
    return input;
  }
  return generateStealthProfile(input);
}

function isStealthProfile(
  input: NonNullable<OpensteerBrowserContextOptions["stealthProfile"]>,
): input is StealthProfile {
  return (
    input.id !== undefined &&
    input.platform !== undefined &&
    input.browserBrand !== undefined &&
    input.browserVersion !== undefined &&
    input.userAgent !== undefined &&
    input.viewport !== undefined &&
    input.screenResolution !== undefined &&
    input.devicePixelRatio !== undefined &&
    input.maxTouchPoints !== undefined &&
    input.webglVendor !== undefined &&
    input.webglRenderer !== undefined &&
    input.fonts !== undefined &&
    input.canvasNoiseSeed !== undefined &&
    input.audioNoiseSeed !== undefined &&
    input.locale !== undefined &&
    input.timezoneId !== undefined
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
