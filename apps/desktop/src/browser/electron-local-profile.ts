import path from "node:path";
import { app, session, safeStorage, WebContentsView, type Session } from "electron";
import { LocalProfileBindingSchema, type LocalProfileBinding } from "@opensteer/protocol";
import { BrowserRuntimeError } from "@opensteer/browser-runtime-core";
import { VerifiedDesktopSecretCryptography } from "../secrets/verified-secret-cryptography.js";
import { BrowserSessionRequestGate } from "./browser-session-policy.js";
import { SessionCookieMirror } from "./session-cookie-mirror.js";

// Electron retains Sessions by path until exit, across logical runtime/host eviction.
const profiles = new Map<string, ElectronLocalProfile>();
const retainedDirectories = new Set<string>();
const cryptography = new VerifiedDesktopSecretCryptography(safeStorage);
let watchingNetworkService = false;

export function acquireElectronLocalProfile(input: {
  root: string | undefined;
  directory: string;
  binding: LocalProfileBinding;
  configure(session: Session, gate: BrowserSessionRequestGate): void;
  initialize?: (profile: ElectronLocalProfile) => Promise<void>;
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
    if (JSON.stringify(existing.binding) !== JSON.stringify(binding) || input.initialize)
      throw persistenceFailure();
    existing.assertUsable();
    return existing;
  }
  if (retainedDirectories.has(input.directory)) throw persistenceFailure();
  if (!watchingNetworkService) {
    watchingNetworkService = true;
    app.on("child-process-gone", (_event, details) => {
      if (!isNetworkService(details)) return;
      // Suspend ALL owners before any recovery can provoke a capture in another Session.
      for (const profile of profiles.values()) profile.suspend();
      for (const profile of profiles.values()) profile.recoverAfterNetworkLoss();
    });
  }
  const profile = new ElectronLocalProfile(input.directory, binding, input.configure);
  profiles.set(input.directory, profile);
  profile.start(input.initialize);
  return profile;
}

/**
 * Electron 44.9.2 EmitChildProcessGone emits ChildProcessData.metrics_name.
 * Chromium 151 service_process_host_impl.cc sets it to receiver.interface_name(),
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
  readonly gate = new BrowserSessionRequestGate();
  readonly binding: LocalProfileBinding;
  readonly mirror: SessionCookieMirror;
  readonly #contexts = new Set<() => Promise<void>>();
  #ready: Promise<unknown> = Promise.resolve();
  #failed = false;
  #retired = false;
  #admitted = false;
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
    this.session = session.fromPath(directory);
    retainedDirectories.add(directory);
    configure(this.session, this.gate);
    // This private target exists only for the cookie bridge, never as a user page.
    const command = async (method: string, parameters?: Record<string, unknown>) => {
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
        return await this.#cookieTarget.webContents.debugger.sendCommand(method, parameters);
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
      onFailure: () => this.#fail(),
      onIdle: () => this.#releaseIdleCookieTarget(),
    });
  }

  start(initialize?: (profile: ElectronLocalProfile) => Promise<void>): void {
    this.#ready = (initialize ? initialize(this) : this.mirror.recover())
      .then(() => {
        this.#suspended = false;
      })
      .catch(() => {
        this.#fail();
        throw persistenceFailure();
      });
    void this.#ready.catch(() => undefined);
  }

  async ready(): Promise<void> {
    // A loss notification can replace the barrier while an acquisition awaits it.
    let barrier: Promise<unknown>;
    do {
      barrier = this.#ready;
      await barrier;
    } while (barrier !== this.#ready);
    this.assertUsable();
  }

  async admit(): Promise<void> {
    await this.ready();
    this.#admitted = true;
    this.gate.open();
  }

  assertUsable(): void {
    if (this.#failed || this.#retired) throw persistenceFailure();
  }
  assertReady(): void {
    this.assertUsable();
    if (this.#suspended) throw persistenceFailure();
  }
  trackContext(close: () => Promise<void>): () => void {
    this.#contexts.add(close);
    this.#idle = false;
    return () => {
      this.#contexts.delete(close);
      this.#releaseIdleCookieTarget();
    };
  }
  suspend(): void {
    this.#suspended = true;
    this.mirror.suspend();
    this.gate.close();
  }
  recoverAfterNetworkLoss(): void {
    if (this.#failed || this.#retired) return;
    this.#ready = this.#ready
      .then(async () => {
        const restored = await this.mirror.recover();
        if (restored) {
          this.#suspended = false;
          if (this.#admitted) this.gate.open();
        }
      })
      .catch(() => {
        this.#fail();
        throw persistenceFailure();
      });
    void this.#ready.catch(() => undefined);
  }
  async eraseLiveData(): Promise<void> {
    this.#retired = true;
    this.gate.fail();
    await this.mirror.stop();
    await Promise.all([...this.#contexts].map((close) => close()));
    this.#releaseIdleCookieTarget();
    // This is explicit profile deletion, never eviction or failure cleanup.
    await this.session.clearStorageData();
    await this.session.clearCache();
  }
  #releaseIdleCookieTarget(): void {
    if (this.#contexts.size) return;
    this.#idle = true;
    if (this.#cookieCommands) return;
    const target = this.#cookieTarget;
    this.#cookieTarget = undefined;
    if (target && !target.webContents.isDestroyed())
      target.webContents.close({ waitForBeforeUnload: false });
  }
  #fail(): void {
    this.#failed = true;
    this.mirror.suspend();
    this.gate.fail();
    for (const close of this.#contexts) void close().catch(() => undefined);
  }
}

function persistenceFailure(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    "conflict",
    "Browser profile storage is unavailable. The profile was preserved.",
    { reason: "browser-profile-persistence-failed" },
  );
}
