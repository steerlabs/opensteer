#!/usr/bin/env node
import type { ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadOrCreateHostKeys } from "../apps/host/src/identity/host-keys.js";
import {
  assertDevelopmentListenersAvailable,
  assertDevelopmentEnvironment,
  DevelopmentStackAlreadyRunningError,
  DevelopmentStackLock,
  developmentListeners,
  developmentKind,
  signalProcessTree,
  spawnInProcessGroup,
} from "./dev-supervisor.js";
import {
  openBrowser,
  parseOpenBrowser,
  waitForLocalBootstrap,
  waitForOrigin,
  type LocalBootstrap,
} from "./local-bootstrap.js";

const supportedServices = ["host", "runner", "browser-runtime", "channel-runtime", "web"] as const;
type ServiceName = (typeof supportedServices)[number];

const developmentEnvironmentId = "env_00000000-0000-5000-8000-000000000001";

const defaultServices: readonly ServiceName[] = [
  "host",
  "runner",
  "browser-runtime",
  "channel-runtime",
  "web",
];

export function parseServices(value: string | undefined): readonly ServiceName[] {
  if (!value?.trim()) return defaultServices;
  const requested = value
    .split(",")
    .map((service) => service.trim())
    .filter(Boolean);
  if (requested.length === 0) throw new Error("OPENSTEER_DEV_SERVICES cannot be empty");
  const unknown = requested.filter(
    (service): service is string => !supportedServices.includes(service as ServiceName),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown development service${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
  return [...new Set(requested)] as ServiceName[];
}

export function parseShutdownGraceMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 10_000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("OPENSTEER_DEV_SHUTDOWN_GRACE_MS must be from 1000 through 60000");
  }
  return parsed;
}

export function developmentPreflightCommands(
  services: readonly ServiceName[],
  kind: ReturnType<typeof developmentKind> = "personal",
): readonly (readonly string[])[] {
  return services.includes("runner") || (kind === "personal" && services.includes("host"))
    ? [["--filter", "@opensteer/runner", "build:native-fs"]]
    : [];
}

export async function runDevelopmentStack(
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<void> {
  await loadLocalEnvironment();
  if (signal?.aborted) return;
  const deploymentShape = developmentKind(environment);
  assertDevelopmentEnvironment(environment);
  configureDevelopmentEnvironment(deploymentShape, environment);
  const requestedServices = parseServices(environment.OPENSTEER_DEV_SERVICES);
  const services =
    deploymentShape === "team"
      ? requestedServices.filter((service) => service === "host" || service === "web")
      : requestedServices;
  if (
    deploymentShape === "team" &&
    environment.OPENSTEER_DEV_SERVICES &&
    requestedServices.some((service) => service !== "host" && service !== "web")
  )
    throw new Error("Team development runs only host and web");
  await configureDevelopmentBrowserRuntimeEnvironment(services, environment);
  const shutdownGraceMs = parseShutdownGraceMs(environment.OPENSTEER_DEV_SHUTDOWN_GRACE_MS);
  const children = new Map<ServiceName, ChildProcess>();
  const shutdown = new AbortController();
  const stackLock = await DevelopmentStackLock.acquire(
    resolve(import.meta.dirname, "..", ".opensteer", "dev.lock"),
    publicUrl(environment).toString(),
  );
  const abort = () => shutdown.abort(signal?.reason ?? new Error("Development stack stopping"));
  signal?.addEventListener("abort", abort, { once: true });

  try {
    await assertDevelopmentListenersAvailable(developmentListeners(services, environment));
    for (const command of developmentPreflightCommands(services, deploymentShape)) {
      await runPnpm(command, environment, signal);
    }
    if (signal?.aborted) return;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let stopping = false;
      let remaining = services.length;
      let terminalFailure: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      const settled = new Set<ServiceName>();
      const unspawned = new Set<ServiceName>(services);

      const stop = (failure?: Error): void => {
        terminalFailure ??= failure;
        if (!stopping) {
          stopping = true;
          // Services are started in stages, so anything not yet spawned will
          // never emit an exit. Settle those here or the shutdown never
          // completes.
          for (const service of unspawned) settleService(service);
          unspawned.clear();
          for (const child of children.values()) {
            signalProcessTree(child, "SIGTERM");
          }
          forceTimer = setTimeout(() => {
            for (const child of children.values()) {
              signalProcessTree(child, "SIGKILL");
            }
          }, shutdownGraceMs);
          forceTimer.unref();
        }
        if (remaining !== 0) return;
        if (forceTimer) clearTimeout(forceTimer);
        if (terminalFailure) rejectPromise(terminalFailure);
        else resolvePromise();
      };

      const settleService = (service: ServiceName, failure?: Error): void => {
        if (settled.has(service)) return;
        settled.add(service);
        remaining -= 1;
        stop(failure);
      };

      shutdown.signal.addEventListener("abort", () => stop(), { once: true });

      const startService = (
        service: ServiceName,
        extraEnvironment: NodeJS.ProcessEnv = {},
      ): void => {
        if (stopping || !unspawned.delete(service)) return;
        const serviceEnvironment = { ...environment, ...extraEnvironment };
        let command = pnpmExecutable();
        let arguments_: string[] = ["--filter", `@opensteer/${service}`, "dev"];
        const child = spawnInProcessGroup(command, arguments_, {
          cwd: resolve(import.meta.dirname, ".."),
          env: serviceEnvironment,
          stdio: "inherit",
        });
        children.set(service, child);
        child.once("error", (error) => {
          settleService(service, new Error(`Could not start ${service}`, { cause: error }));
        });
        child.once("exit", (code, childSignal) => {
          if (stopping) {
            settleService(service);
            return;
          }
          settleService(
            service,
            new Error(
              `${service} stopped unexpectedly (${childSignal ? `signal ${childSignal}` : `exit ${code ?? "unknown"}`})`,
            ),
          );
        });
      };

      void startDevelopmentServices(services, startService, environment, shutdown.signal).catch(
        (error: unknown) => {
          stop(error instanceof Error ? error : new Error("Development startup failed"));
        },
      );
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    for (const child of children.values()) {
      signalProcessTree(child, "SIGKILL");
    }
    await stackLock.release();
  }
}

export async function configureDevelopmentBrowserRuntimeEnvironment(
  services: readonly ServiceName[],
  environment: NodeJS.ProcessEnv,
  repositoryRoot = resolve(import.meta.dirname, ".."),
): Promise<void> {
  if (!services.includes("browser-runtime")) return;

  environment.OPENSTEER_BROWSER_RUNTIME_ID =
    environment.OPENSTEER_BROWSER_RUNTIME_ID?.trim() || "browser-main";
  environment.OPENSTEER_BROWSER_BRIDGE_TOKEN =
    environment.OPENSTEER_BROWSER_BRIDGE_TOKEN?.trim() || randomBytes(32).toString("base64url");
  if (services.includes("runner")) {
    environment.OPENSTEER_BROWSER_BRIDGE_URL = developmentBrowserRuntimeUrl(environment).toString();
  }

  environment.OPENSTEER_BROWSER_PROFILE_ROOT = resolve(
    repositoryRoot,
    environment.OPENSTEER_BROWSER_PROFILE_ROOT?.trim() || ".opensteer/browser-runtime/profiles",
  );
  if (!environment.OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL?.trim()) {
    environment.OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL = hostUrl(environment).origin;
  }

  if (!environment.OPENSTEER_CHROMIUM_EXECUTABLE?.trim()) {
    const executable = await firstExecutable(chromiumCandidates());
    if (!executable) {
      throw new Error(
        "The development Browser Runtime requires OPENSTEER_CHROMIUM_EXECUTABLE or an installed Chrome/Chromium browser.",
      );
    }
    environment.OPENSTEER_CHROMIUM_EXECUTABLE = executable;
  }

  if (!environment.OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS?.trim()) {
    // pnpm runs the Host package script with apps/host as its working directory,
    // so relative Host key paths must be resolved from that same boundary.
    const hostWorkingDirectory = resolve(repositoryRoot, "apps", "host");
    const dataDirectory = resolve(
      hostWorkingDirectory,
      environment.OPENSTEER_HOST_DATA_DIR?.trim() || ".opensteer/host",
    );
    const privateKeyPath = environment.OPENSTEER_HOST_PRIVATE_KEY_PATH?.trim();
    const publicKeyPath = environment.OPENSTEER_HOST_PUBLIC_KEY_PATH?.trim();
    const keys = await loadOrCreateHostKeys({
      dataDirectory,
      ...(privateKeyPath ? { privateKeyPath: resolve(hostWorkingDirectory, privateKeyPath) } : {}),
      ...(publicKeyPath ? { publicKeyPath: resolve(hostWorkingDirectory, publicKeyPath) } : {}),
    });
    const keyId = environment.OPENSTEER_BROWSER_ATTACH_KEY_ID?.trim() || "host-v1";
    environment.OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS = JSON.stringify({
      [keyId]: keys.publicKeyPem,
    });
  }
}

/**
 * The messaging computer is one the development stack supervises for itself,
 * so the stack holds its one-use enrollment token before the Host starts and
 * configures the Host with it — the same contract a managed or self-hosted
 * Deployment follows. The Host records an enrollment only for a computer whose
 * supervisor holds the token.
 *
 * The Host binds the enrollment's idempotency key to the exact token, so the
 * value has to survive restarts. It is derived from the one secret this stack
 * already keeps in `.env`, which `pnpm setup:local` preserves, so there is no
 * second file to lose: the token changes exactly when the deployment's own
 * secret does, and then every session and credential is gone with it anyway.
 */
export function developmentMessagingEnrollmentToken(
  services: readonly ServiceName[],
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (!services.includes("channel-runtime")) return undefined;
  const configured = environment.OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN?.trim();
  if (configured) return configured;
  const authSecret = environment.OPENSTEER_AUTH_SECRET?.trim();
  if (!authSecret) return undefined;
  return createHmac("sha256", authSecret)
    .update("opensteer-development-messaging-enrollment")
    .digest("base64url");
}

export function developmentBrowserRuntimeUrl(environment: NodeJS.ProcessEnv): URL {
  const host = environment.OPENSTEER_BROWSER_HOST?.trim() || "127.0.0.1";
  const portText = environment.OPENSTEER_BROWSER_PORT?.trim() || "4312";
  if (!/^[0-9]+$/u.test(portText)) {
    throw new Error("OPENSTEER_BROWSER_PORT must be a TCP port");
  }
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OPENSTEER_BROWSER_PORT must be a TCP port");
  }
  const url = new URL("http://127.0.0.1");
  url.hostname = host;
  url.port = String(port);
  return url;
}

function chromiumCandidates(): readonly string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    const candidates = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value));
    return candidates.flatMap((directory) => [
      resolve(directory, "Google", "Chrome", "Application", "chrome.exe"),
      resolve(directory, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for a supported local development browser.
    }
  }
  return undefined;
}

export function configureDevelopmentEnvironment(
  kind: ReturnType<typeof developmentKind>,
  environment: NodeJS.ProcessEnv,
): void {
  environment.OPENSTEER_DEPLOYMENT_KIND = kind;
  environment.OPENSTEER_DEPLOYMENT_NAME ||=
    kind === "personal" ? "Development" : "Development team";
  const repositoryRoot = resolve(import.meta.dirname, "..");
  if (kind === "team") {
    environment.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN ||= createHmac(
      "sha256",
      environment.OPENSTEER_AUTH_SECRET || "",
    )
      .update("development-team-setup")
      .digest("base64url");
    environment.OPENSTEER_HOST_DATA_DIR = resolve(repositoryRoot, ".opensteer/team-host");
    return;
  }
  const runnerEnvironment = environment.OPENSTEER_ENVIRONMENT_ID?.trim();
  const hostingEnvironment = environment.OPENSTEER_HOSTING_ENVIRONMENT_ID?.trim();
  if (runnerEnvironment && hostingEnvironment && runnerEnvironment !== hostingEnvironment)
    throw new Error("The development Runner and hosting environment must match");
  const environmentId = runnerEnvironment || hostingEnvironment || developmentEnvironmentId;
  environment.OPENSTEER_ENVIRONMENT_ID = environmentId;
  environment.OPENSTEER_HOSTING_ENVIRONMENT_ID = environmentId;
  environment.OPENSTEER_AGENT_HOME = resolve(
    repositoryRoot,
    environment.OPENSTEER_AGENT_HOME?.trim() || ".opensteer/agent-home",
  );
  environment.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN ||= createHmac(
    "sha256",
    environment.OPENSTEER_AUTH_SECRET || "",
  )
    .update("development-local-owner")
    .digest("base64url");
  const nativeFsHelper =
    environment.OPENSTEER_NATIVE_FS_HELPER?.trim() ||
    resolve(
      repositoryRoot,
      "apps/runner/native-fs-helper",
      `opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    );
  if (!isAbsolute(nativeFsHelper))
    throw new Error("The development native filesystem helper path must be absolute");
  environment.OPENSTEER_NATIVE_FS_HELPER = nativeFsHelper;
}

/**
 * Starts the selected services in the order their dependencies require.
 *
 * The browser bridge comes up before the Main Runner, then the Host mints the
 * Runner's first-use enrollment. The Runner is the machine identity for both
 * modules, matching the packaged Personal stack rather than introducing a
 * second browser-only machine in development. The messaging computer's token
 * was minted by this stack before the Host started, so it is handed over
 * rather than fetched.
 */
async function startDevelopmentServices(
  services: readonly ServiceName[],
  startService: (service: ServiceName, extraEnvironment?: NodeJS.ProcessEnv) => void,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  const remaining = new Set(services);
  const messagingToken = developmentMessagingEnrollmentToken(services, environment);
  let bootstrap: LocalBootstrap | null = null;
  if (signal.aborted) return;

  if (remaining.delete("browser-runtime")) {
    startService("browser-runtime");
    const browserRuntimeUrl = developmentBrowserRuntimeUrl(environment);
    if (!(await waitForOrigin(new URL("/health", browserRuntimeUrl), signal))) {
      throw new Error(`The Browser Runtime did not become ready at ${browserRuntimeUrl.origin}`);
    }
  }
  if (signal.aborted) return;

  if (remaining.delete("host")) {
    startService(
      "host",
      messagingToken ? { OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: messagingToken } : {},
    );
    if (environment.OPENSTEER_DEPLOYMENT_KIND === "personal")
      bootstrap = await waitForLocalBootstrap(
        hostUrl(environment),
        signal,
        undefined,
        environment.OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN,
      );
    else if (!(await waitForOrigin(new URL("/healthz", hostUrl(environment)), signal)))
      throw new Error("The team Host did not become ready");
  }
  if (signal.aborted) return;

  if (remaining.delete("runner")) {
    // pnpm does not forward inherited file descriptors past fd 2, so the
    // development Runner receives its one-use token through its own process
    // environment rather than the fd 3 channel the packaged desktop shell uses.
    // The value never reaches `.env`, and it is spent on first connect.
    startService(
      "runner",
      bootstrap?.runnerEnrollmentToken
        ? { OPENSTEER_RUNNER_ENROLLMENT_TOKEN: bootstrap.runnerEnrollmentToken }
        : {},
    );
  }
  if (remaining.delete("channel-runtime")) {
    startService("channel-runtime", {
      OPENSTEER_MESSAGING_HOST_URL: hostUrl(environment).origin,
      ...(messagingToken ? { OPENSTEER_RUNNER_ENROLLMENT_TOKEN: messagingToken } : {}),
    });
  }
  for (const service of remaining) startService(service);

  if (signal.aborted) return;
  const webReady =
    services.includes("web") && (await waitForOrigin(publicUrl(environment), signal));
  if (signal.aborted) return;
  // The summary and its link always print. `OPENSTEER_OPEN_BROWSER=false`
  // declines the browser, not the information — suppressing both would leave a
  // headless or CI run with no way to reach setup at all.
  const url =
    environment.OPENSTEER_DEPLOYMENT_KIND === "team"
      ? new URL(
          `/setup#${environment.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN}`,
          publicUrl(environment),
        ).toString()
      : (bootstrap?.setupUrl ?? publicUrl(environment).toString());
  const openingBrowser =
    webReady &&
    Boolean(bootstrap?.setupUrl) &&
    parseOpenBrowser(environment.OPENSTEER_OPEN_BROWSER);
  process.stdout.write(readySummary(services, { bootstrap, openingBrowser, url, webReady }));
  if (openingBrowser) openBrowser(url);
}

const serviceSummaryLabels: Record<ServiceName, string> = {
  "browser-runtime": "Browser Runtime",
  "channel-runtime": "Messaging service",
  host: "Host",
  runner: "Main Runner",
  web: "Web",
};

/**
 * The boot summary is part of the product: it names what started, says only
 * what is actually known — health-checked services are "ready", the rest
 * merely "started" — and ends with the one address that matters. Service logs
 * keep streaming above it untouched; hiding them would trade debuggability for
 * tidiness.
 */
export function readySummary(
  services: readonly ServiceName[],
  status: {
    readonly bootstrap: LocalBootstrap | null;
    readonly openingBrowser: boolean;
    readonly url: string;
    readonly webReady: boolean;
  },
): string {
  const readiness = (service: ServiceName): string => {
    if (service === "host") return status.bootstrap ? "ready" : "started";
    if (service === "browser-runtime") return "ready";
    if (service === "web") return status.webReady ? "ready" : "starting";
    return "started";
  };
  const lines = services
    .map(
      (service) =>
        `  ✓ ${(serviceSummaryLabels[service] ?? service).padEnd(18)}${readiness(service)}`,
    )
    .join("\n");
  const finish = status.bootstrap?.setupUrl
    ? "Your development Opensteer is ready — finish setup at"
    : "Your development Opensteer is ready";
  return `\n${lines}\n\n  ${finish}\n  → ${status.url}\n${status.openingBrowser ? "\n  Opening your browser…\n" : ""}\n`;
}

function hostUrl(environment: NodeJS.ProcessEnv): URL {
  return new URL(environment.OPENSTEER_HOST_URL?.trim() || "http://127.0.0.1:4310");
}

function publicUrl(environment: NodeJS.ProcessEnv): URL {
  return new URL(environment.OPENSTEER_CANONICAL_ORIGIN?.trim() || "http://localhost:43100");
}

async function loadLocalEnvironment(): Promise<void> {
  const path = resolve(import.meta.dirname, "..", ".env");
  try {
    await access(path);
  } catch {
    return;
  }
  process.loadEnvFile(path);
}

function pnpmExecutable(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function runPnpm(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawnInProcessGroup(pnpmExecutable(), arguments_, {
      cwd: resolve(import.meta.dirname, ".."),
      env: environment,
      stdio: "inherit",
    });
    let forceTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      signalProcessTree(child, "SIGTERM");
      forceTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 5_000);
      forceTimer.unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      rejectPromise(
        new Error(`Development preflight could not start: ${arguments_.join(" ")}`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, childSignal) => {
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            `Development preflight failed (${childSignal ? `signal ${childSignal}` : `exit ${code ?? "unknown"}`}): ${arguments_.join(" ")}`,
          ),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  let secondSignal = false;
  const stop = () => {
    if (secondSignal) {
      process.exitCode = 1;
      return;
    }
    secondSignal = true;
    controller.abort();
  };
  // Keep both handlers installed until cleanup completes. pnpm and tsx can
  // forward more than one terminal signal; a one-shot handler would restore
  // Node's default immediate-exit behavior before the lock is released.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await runDevelopmentStack(process.env, controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    if (error instanceof DevelopmentStackAlreadyRunningError) {
      process.stdout.write(`${error.message}\n`);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
