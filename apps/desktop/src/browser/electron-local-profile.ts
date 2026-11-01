import { BrowserRuntimeError } from "@opensteer/browser-runtime-core";
import { LocalProfileBindingSchema, type LocalProfileBinding } from "@opensteer/protocol";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { app, safeStorage, session, WebContentsView, type Session } from "electron";
import path from "node:path";
import { ProtectedStorageUnavailableError } from "../secrets/protected-json-file.js";
import { VerifiedDesktopSecretCryptography } from "../secrets/verified-secret-cryptography.js";
import { BrowserSessionRequestGate } from "./browser-session-policy.js";
import { SessionCookieMirror } from "./session-cookie-mirror.js";

// Electron retains Sessions by path until exit, across logical runtime/host eviction.
const profiles = new Map<string, ElectronLocalProfile>();
const retainedDirectories = new Set<string>();
const sessionMutations = new WeakMap<Session, Promise<unknown>>();
/** A rejected CDP waiter is not proof that Chromium cancelled an issued mutation. */
export function electronSessionCookieCommand(
  session: Session,
  method: string,
  send: () => Promise<unknown>,
): Promise<unknown> {
  if (method !== "Network.setCookies") return send();
  if (sessionMutations.has(session)) return Promise.reject(persistenceFailure());
  const pending = send();
  sessionMutations.set(session, pending);
  void pending.then(
    () => {
      if (sessionMutations.get(session) === pending) sessionMutations.delete(session);
    },
    () => undefined,
  );
  return pending;
}

const cryptography = new VerifiedDesktopSecretCryptography(safeStorage);
let watchingNetworkService = false;

/** Provider consent is resolved at engine startup; actual profile keys stay lazy. */
export async function prepareElectronLocalProfiles(): Promise<boolean> {
  return (
    (await cryptography.isAsyncEncryptionAvailable()) &&
    !(
      process.platform === "linux" &&
      ["basic_text", "unknown"].includes(cryptography.getSelectedStorageBackend())
    )
  );
}

export async function createEmptySessionCookieMirror(
  directory: string,
  binding: LocalProfileBinding,
  signal: AbortSignal,
): Promise<void> {
  const mirror = new SessionCookieMirror({
    directory,
    binding,
    cryptography,
    capture: async () => [],
    restore: async () => {},
    subscribe: () => () => {},
    onFailure: () => {},
    publish: async (file, content, assertCurrent) => {
      signal.throwIfAborted();
      await replacePrivateFileAtomically(file, content, () => {
        signal.throwIfAborted();
        assertCurrent();
      });
    },
  });
  const abort = () => {
    void mirror.stop().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await withTimeout(mirror.initialize(), 5000, {
      signal,
      timeoutError: () => persistenceFailure(),
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await withTimeout(mirror.stop(), 2000, { timeoutError: () => persistenceFailure() });
  }
}
export async function requireElectronLocalProfiles(): Promise<void> {
  if (!(await prepareElectronLocalProfiles()))
    throw persistenceFailure(
      new ProtectedStorageUnavailableError("Protected storage unavailable."),
    );
}

export function acquireElectronLocalProfile(input: {
  root: string | undefined;
  directory: string;
  binding: LocalProfileBinding;
  configure(session: Session, gate: BrowserSessionRequestGate): void;
}): ElectronLocalProfile {
  const binding = LocalProfileBindingSchema.parse(input.binding);
  if (
    !input.root ||
    !path.isAbsolute(input.root) ||
    path.resolve(input.root) !== input.root ||
    binding.engine !== "electron" ||
    input.directory !== path.join(input.root, "profiles", binding.profileId, "native")
  ) {
    throw persistenceFailure();
  }
  const existing = profiles.get(input.directory);
  if (existing) {
    if (JSON.stringify(existing.binding) !== JSON.stringify(binding)) throw persistenceFailure();
    existing.assertUsable();
    return existing;
  }

  if (!watchingNetworkService) {
    watchingNetworkService = true;
    app.on("child-process-gone", (_event, details) => {
      if (!isNetworkService(details)) return;
      // Suspend ALL owners before any recovery can provoke a capture in another Session.
      for (const profile of profiles.values()) profile.suspend();
      for (const profile of profiles.values()) void profile.retire().catch(() => undefined);
    });
  }
  const profile = new ElectronLocalProfile(input.directory, binding, input.configure);
  profiles.set(input.directory, profile);
  profile.start();
  return profile;
}

/**
 * Electron 44.9.2 EmitChildProcessGone emits ChildProcessData.metrics_name.
 * Chromium 152.0.7977.167 service_process_host_impl.cc sets it to receiver.interface_name(),
 * so this matches the Mojo interface, not the localized display name.
 */
export function isNetworkService(details: { type: string; serviceName?: string }): boolean {
  return details.type === "Utility" && details.serviceName === "network.mojom.NetworkService";
}

export async function releaseElectronLocalProfile(
  directory: string,
): Promise<"released" | "retained-until-exit"> {
  const profile = profiles.get(directory);
  if (!profile) return retainedDirectories.has(directory) ? "retained-until-exit" : "released";
  await profile.eraseLiveData();
  return "retained-until-exit";
}

export class ElectronLocalProfile {
  readonly session: Session;
  readonly #directory: string;
  readonly #cancellation = new AbortController();
  readonly gate = new BrowserSessionRequestGate();
  readonly binding: LocalProfileBinding;
  readonly mirror: SessionCookieMirror;
  readonly #contexts = new Set<() => Promise<void>>();
  #ready: Promise<unknown> = Promise.resolve();
  #failure: BrowserRuntimeError | undefined;
  #retired = false;
  #admitted = false;
  #retirement: Promise<void> | undefined;
  #cookieTarget: WebContentsView | undefined;
  #cookieCommands = 0;
  #idle = false;
  #suspended = true;

  constructor(
    directory: string,
    binding: LocalProfileBinding,
    configure: (session: Session, gate: BrowserSessionRequestGate) => void,
  ) {
    this.binding = binding;
    this.#directory = directory;
    this.gate.dormant();
    this.session = session.fromPath(directory);
    retainedDirectories.add(directory);
    configure(this.session, this.gate);
    // This private target exists only for the cookie bridge, never as a user page.
    const command = async (method: string, parameters?: Record<string, unknown>) => {
      this.assertUsable();
      this.#cookieCommands++;
      try {
        if (!this.#cookieTarget) {
          const view = new WebContentsView({
            webPreferences: {
              session: this.session,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              devTools: false,
              backgroundThrottling: true,
            },
          });
          this.#cookieTarget = view;
          // Cookie CDP commands need the Session, not a loaded renderer document.
          view.webContents.debugger.attach("1.3");
        }
        const pending = electronSessionCookieCommand(this.session, method, () =>
          this.#cookieTarget!.webContents.debugger.sendCommand(method, parameters),
        );
        const result = await withTimeout(pending, 5_000, {
          signal: this.#cancellation.signal,
          timeoutError: persistenceFailure,
        });
        this.assertUsable();
        return result;
      } finally {
        this.#cookieCommands--;
        if (this.#idle) this.#releaseIdleCookieTarget();
      }
    };
    this.mirror = new SessionCookieMirror({
      directory: path.dirname(directory),
      binding,
      cryptography,
      capture: async () => {
        const result: unknown = await command("Network.getAllCookies");
        if (
          !result ||
          typeof result !== "object" ||
          !("cookies" in result) ||
          !Array.isArray(result.cookies)
        )
          throw persistenceFailure();
        return result.cookies;
      },
      restore: async (cookies) => {
        await command("Network.setCookies", { cookies });
        await this.session.cookies.flushStore();
      },
      subscribe: (invalidate) => {
        this.session.cookies.on("changed", invalidate);
        return () => {
          this.session.cookies.off("changed", invalidate);
        };
      },
      onFailure: (error) => this.#fail(error),
      onIdle: () => this.#releaseIdleCookieTarget(),
    });
  }

  start(): void {
    this.#ready = withTimeout(
      Promise.resolve().then(async () => {
        if (sessionMutations.has(this.session)) throw persistenceFailure();
        await this.mirror.recover();
      }),
      5_000,
      { signal: this.#cancellation.signal, timeoutError: persistenceFailure },
    )
      .then(() => {
        this.assertUsable();
        this.#suspended = false;
      })
      .catch((error: unknown) => {
        this.#fail(error);
        throw this.#failure;
      });
    void this.#ready.catch(() => undefined);
  }

  get hasContexts(): boolean {
    return this.#contexts.size > 0;
  }

  async ready(): Promise<void> {
    await this.#ready;
    this.assertUsable();
  }

  async admit(signal?: AbortSignal): Promise<void> {
    await this.ready();
    signal?.throwIfAborted();
    this.assertReady();
    if (!this.#admitted) {
      this.#admitted = true;
      this.gate.open();
    }
  }

  assertUsable(): void {
    if (this.#failure) throw this.#failure;
    if (this.#retired) throw persistenceFailure();
  }
  assertReady(): void {
    this.assertUsable();
    if (this.#suspended) throw persistenceFailure();
  }
  assertAdmitted(): void {
    this.assertReady();
    if (!this.#admitted) throw new Error("Electron browser profile is not admitted.");
  }
  trackContext(close: () => Promise<void>): () => void {
    this.#contexts.add(close);
    this.#idle = false;
    return () => {
      this.#contexts.delete(close);
      if (!this.#contexts.size) {
        this.#admitted = false;
        this.gate.dormant();
      }
      this.#releaseIdleCookieTarget();
    };
  }
  suspend(): void {
    this.#suspended = true;
    this.mirror.suspend();
    if (this.#admitted) this.gate.close();
    else this.gate.dormant();
  }

  retire(): Promise<void> {
    if (this.#retirement) return this.#retirement;
    this.#retired = true;
    this.#cancellation.abort(persistenceFailure());
    if (profiles.get(this.#directory) === this) profiles.delete(this.#directory);
    this.gate.fail();
    const stopped = this.mirror.stop();
    this.#releaseIdleCookieTarget();
    const contexts = [...this.#contexts].map((close) => close());
    this.#retirement = (async () => {
      await withTimeout(Promise.all([stopped, ...contexts]), 2_000, {
        timeoutError: persistenceFailure,
      });
      this.#releaseIdleCookieTarget();
    })();
    return this.#retirement;
  }
  async eraseLiveData(): Promise<void> {
    await this.retire();
    // This is explicit profile deletion, never eviction or failure cleanup.
    await this.session.clearStorageData();
    await this.session.clearCache();
  }
  #releaseIdleCookieTarget(): void {
    if (!this.#retired && this.#contexts.size) return;
    this.#idle = true;
    if (!this.#retired && this.#cookieCommands) return;
    const target = this.#cookieTarget;
    this.#cookieTarget = undefined;
    if (target && !target.webContents.isDestroyed())
      target.webContents.close({ waitForBeforeUnload: false });
  }
  #fail(error: unknown): void {
    this.#failure ??= persistenceFailure(error);
    this.mirror.suspend();
    this.gate.fail();
    void this.retire().catch(() => undefined);
  }
}

function persistenceFailure(cause?: unknown): BrowserRuntimeError {
  if (cause instanceof BrowserRuntimeError) return cause;
  return new BrowserRuntimeError(
    "conflict",
    cause instanceof ProtectedStorageUnavailableError
      ? "Browser profile encryption is unavailable. Unlock the login keychain in Keychain Access, then Retry opening this profile. The profile was preserved."
      : "Browser profile storage is unavailable. The profile was preserved.",
    { cause, reason: "browser-profile-persistence-failed" },
  );
}
