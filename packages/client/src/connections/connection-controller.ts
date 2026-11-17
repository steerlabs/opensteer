import type { ClientIssue } from "../feedback/client-issue.js";
import { clientIssue } from "../feedback/client-issue.js";
import {
  connectionInterruptionHoldMs,
  realtimeIdleProbeMs,
  socketProbeDeadlineMs,
  socketTrustWindowMs,
  type ClientLifecycle,
  type ClientNetworkState,
  type ClientVisibility,
} from "../host/lifecycle.js";
import { classifyClientFailure, unrefTimer, type ClientFailure } from "./operation-error.js";
import { HostTransportError } from "./host-transport-error.js";

export interface ClientScope {
  readonly authorityKey: string;
  readonly deploymentId: string;
  readonly viewerId: string;
  readonly loginId: string;
  readonly accountLoginId?: string;
}
export function clientScopeKey(scope: ClientScope | null): string | null {
  return (
    scope &&
    JSON.stringify([
      scope.authorityKey,
      scope.deploymentId,
      scope.viewerId,
      scope.loginId,
      scope.accountLoginId ?? null,
    ])
  );
}
export type ConnectionPhase = "idle" | "connecting" | "ready" | "recovering" | "blocked";
export interface ConnectionPresentation {
  readonly name: string | null;
  readonly target: "computer" | "team";
  readonly route: "same-computer" | "private-network" | "connect" | null;
}
export interface ClientConnectionState extends ConnectionPresentation {
  readonly phase: ConnectionPhase;
  readonly network: ClientNetworkState;
  readonly visibility: ClientVisibility;
  readonly scope: ClientScope | null;
  readonly epoch: number;
  readonly readyRevision: number;
  readonly showInterruption: boolean;
  readonly issue: ClientIssue | null;
  readonly trying: boolean;
  readonly pathRevision: number;
  readonly lastConnectedAt: number | null;
}
export interface ClientConnection {
  getSnapshot(): ClientConnectionState;
  subscribe(listener: () => void): () => void;
  retry(): void;
}
export interface ClientSession {
  readonly connection: ClientConnection;
}
export interface ConnectionAttempt {
  readonly signal: AbortSignal;
  readonly epoch: number;
  admit?(lease: ConnectionLease): void;
  acceptScope(scope: ClientScope): void;
}
export interface ConnectionLease {
  readonly closed: Promise<ClientFailure>;
  probe(signal: AbortSignal): Promise<void>;
  close(): void;
}
export interface ConnectionDriver {
  connect(attempt: ConnectionAttempt): Promise<ConnectionLease>;
}
export interface ConnectionController extends ClientConnection {
  start(): void;
  wake(): void;
  stop(): void;
  invalidateScope(): void;
  setPresentation(presentation: ConnectionPresentation): void;
  dispose(): void;
}
export interface ConnectionControllerOptions {
  readonly driver: ConnectionDriver;
  readonly lifecycle?: ClientLifecycle;
  readonly random?: () => number;
  readonly presentation?: ConnectionPresentation;
  readonly keepAliveInBackground?: boolean | (() => boolean);
  readonly liveness?: { readonly idleMs: number; readonly deadlineMs: number };
  readonly backoff?: { readonly baseMs: number; readonly maximumMs: number };
}

export function createConnectionController(
  options: ConnectionControllerOptions,
): ConnectionController {
  return new SessionConnectionController(options);
}

class SessionConnectionController implements ConnectionController {
  readonly #options: ConnectionControllerOptions;
  readonly #listeners = new Set<() => void>();
  readonly #disposers: (() => void)[] = [];
  #state: ClientConnectionState;
  #desired = false;
  #disposed = false;
  #attempt = 0;
  #controller: AbortController | null = null;
  #lease: ConnectionLease | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #hold: ReturnType<typeof setTimeout> | null = null;
  #idle: ReturnType<typeof setInterval> | null = null;
  #probe: Promise<void> | null = null;
  #probeFollowsNetwork = false;
  #backgroundAt: number | null = null;
  #explicit = false;
  #retryNotBefore = 0;
  #unreadable = 0;

  constructor(options: ConnectionControllerOptions) {
    this.#options = options;
    const lifecycle = options.lifecycle?.getSnapshot();
    this.#state = {
      phase: "idle",
      network: lifecycle?.network ?? "unknown",
      visibility: lifecycle?.visibility ?? "foreground",
      scope: null,
      epoch: 0,
      readyRevision: 0,
      showInterruption: false,
      issue: null,
      trying: false,
      pathRevision: 0,
      lastConnectedAt: null,
      name: options.presentation?.name ?? null,
      target: options.presentation?.target ?? "computer",
      route: options.presentation?.route ?? null,
    };
    if (options.lifecycle)
      this.#disposers.push(
        options.lifecycle.onBackground(() => this.#background()),
        options.lifecycle.onForeground(() => this.#foreground()),
        options.lifecycle.onNetworkChange((network, path) => {
          const previous = this.#state.network;
          this.#publish({
            network,
            pathRevision: this.#state.pathRevision + (path === "changed" ? 1 : 0),
          });
          if (!this.#desired || this.#state.phase === "blocked") return;
          if (network === "offline") {
            this.#cancel();
            this.#waiting();
            return;
          }
          if (path === "same" && previous === network) {
            if (this.#lease) this.#checkLease(true);
          } else this.#restart(false);
        }),
      );
  }
  getSnapshot = (): ClientConnectionState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  setPresentation = (presentation: ConnectionPresentation): void => {
    this.#publish(presentation);
  };
  start = (): void => {
    if (this.#disposed || this.#desired) return;
    this.#desired = true;
    this.#restart(false);
  };
  wake = (): void => {
    if (this.#desired && !this.#controller && this.#state.phase !== "blocked") this.#restart(false);
  };
  retry = (): void => {
    if (this.#disposed) return;
    this.#desired = true;
    this.#attempt = 0;
    this.#restart(true);
  };
  stop = (): void => {
    this.#desired = false;
    this.#cancel();
    this.#clearHold();
    this.#publish({ phase: "idle", trying: false, showInterruption: false, issue: null });
  };
  invalidateScope = (): void => {
    this.#cancel();
    this.#publish({
      scope: null,
      phase: "blocked",
      issue: { code: "sign-in" },
      showInterruption: true,
    });
  };
  dispose = (): void => {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    this.#disposers.splice(0).forEach((dispose) => dispose());
    this.#listeners.clear();
  };
  #publish(patch: Partial<ClientConnectionState>): void {
    if (
      Object.entries(patch).every(
        ([key, value]) => this.#state[key as keyof ClientConnectionState] === value,
      )
    )
      return;
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((listener) => listener());
  }
  #keepsAlive(): boolean {
    return typeof this.#options.keepAliveInBackground === "function"
      ? this.#options.keepAliveInBackground()
      : this.#options.keepAliveInBackground === true;
  }
  #suspended(): boolean {
    return (
      this.#state.network === "offline" ||
      (this.#state.visibility === "background" && !this.#keepsAlive())
    );
  }
  #cancel(): void {
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#idle) clearInterval(this.#idle);
    this.#retry = null;
    this.#idle = null;
    const controller = this.#controller,
      lease = this.#lease;
    this.#controller = null;
    this.#lease = null;
    this.#probe = null;
    this.#probeFollowsNetwork = false;
    this.#publish({ epoch: this.#state.epoch + 1, trying: false });
    controller?.abort(new HostTransportError("cancelled"));
    lease?.close();
  }
  #restart(explicit: boolean): void {
    if (!explicit && this.#unreadable > 0 && Date.now() < this.#retryNotBefore) {
      if (!this.#retry && !this.#suspended())
        this.#retry = setTimeout(() => {
          this.#retry = null;
          this.#restart(false);
        }, this.#retryNotBefore - Date.now());
      return;
    }
    if (explicit) this.#retryNotBefore = 0;
    this.#cancel();
    this.#explicit = explicit;
    this.#waiting();
    if (!this.#desired || this.#suspended()) {
      if (explicit && this.#state.visibility === "foreground")
        this.#publish({ showInterruption: true });
      return;
    }
    const controller = new AbortController();
    this.#controller = controller;
    const current = () =>
      this.#controller === controller &&
      !controller.signal.aborted &&
      this.#desired &&
      !this.#disposed;
    this.#publish({ trying: true });
    const admit = (lease: ConnectionLease): void => {
      if (!current()) {
        lease.close();
        return;
      }
      if (this.#lease === lease) return;
      this.#lease = lease;
      this.#attempt = 0;
      this.#unreadable = 0;
      this.#retryNotBefore = 0;
      this.#explicit = false;
      this.#clearHold();
      this.#publish({
        phase: "ready",
        trying: false,
        issue: null,
        showInterruption: false,
        readyRevision: this.#state.readyRevision + 1,
        lastConnectedAt: Date.now(),
      });
      this.#idle = setInterval(() => this.#checkLease(), (this.#options.liveness?.idleMs ?? realtimeIdleProbeMs));
      unrefTimer(this.#idle);
      void lease.closed.then(
        (failure) => {
          if (current()) this.#failed(failure);
        },
        (error) => {
          if (current()) this.#failed(classifyClientFailure(error));
        },
      );
    };
    let operation: Promise<ConnectionLease>;
    try {
      operation = this.#options.driver.connect({
        signal: controller.signal,
        epoch: this.#state.epoch,
        admit,
        acceptScope: (scope) => {
          if (current() && clientScopeKey(scope) !== clientScopeKey(this.#state.scope))
            this.#publish({ scope });
        },
      });
    } catch (error) { this.#failed(classifyClientFailure(error)); return; }
    void operation.then(admit, (error) => {
        if (current()) this.#failed(classifyClientFailure(error));
      });
  }
  #waiting(): void {
    if (!this.#desired) return;
    this.#publish({
      phase: this.#state.readyRevision === 0 ? "connecting" : "recovering",
      issue: this.#connectionIssue(),
      trying: false,
    });
    if (this.#state.visibility === "foreground" && !this.#hold && !this.#state.showInterruption) {
      this.#hold = setTimeout(() => {
        this.#hold = null;
        if (
          this.#desired &&
          this.#state.phase !== "ready" &&
          this.#state.visibility === "foreground"
        )
          this.#publish({ showInterruption: true });
      }, connectionInterruptionHoldMs);
      unrefTimer(this.#hold);
    }
  }
  #connectionIssue(unreachable = false): ClientIssue {
    return {
      code: "connection",
      reason:
        this.#state.network === "offline"
          ? "offline"
          : unreachable
            ? "unreachable"
            : "reconnecting",
      ...(this.#state.name ? { name: this.#state.name } : {}),
      target: this.#state.target,
    };
  }
  #failed(failure: ClientFailure): void {
    const explicit = this.#explicit;
    this.#cancel();
    if (!this.#desired) return;
    if (!failure.retryable && failure.kind !== "cancelled") {
      this.#clearHold();
      const issue = clientIssue(failure, { operation: "action", label: "connect" });
      this.#publish({
        phase: "blocked",
        showInterruption: true,
        trying: false,
        issue: issue?.code === "unconfirmed" ? { code: "access-lost" } : issue,
        ...(failure.code === "unauthorized" ? { scope: null } : {}),
      });
      return;
    }
    this.#waiting();
    this.#publish({
      phase: "recovering",
      issue: this.#connectionIssue(true),
      ...(explicit ? { showInterruption: true } : {}),
    });
    this.#explicit = false;
    if (this.#suspended()) return;
    const base = this.#options.backoff?.baseMs ?? 300;
    if (failure.reason === "unreadable-frame") this.#unreadable++;
    const maximum = this.#unreadable ? 300_000 : (this.#options.backoff?.maximumMs ?? 12_000);
    const delay =
      Math.min(maximum, base * 2 ** Math.min(Math.max(this.#attempt++, this.#unreadable - 1), 16)) *
      (0.5 + (this.#options.random ?? Math.random)() * 0.5);
    this.#retryNotBefore = Date.now() + delay;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#restart(false);
    }, delay);
    unrefTimer(this.#retry);
  }
  #background(): void {
    if (this.#disposed) return;
    this.#backgroundAt = Date.now();
    this.#clearHold();
    this.#publish({ visibility: "background", showInterruption: false });
    if (!this.#keepsAlive()) {
      if (this.#retry) clearTimeout(this.#retry);
      this.#retry = null;
      if (!this.#lease) this.#cancel();
      if (this.#idle) clearInterval(this.#idle);
      this.#idle = null;
    }
  }
  #foreground(): void {
    if (this.#disposed) return;
    const duration = Date.now() - (this.#backgroundAt ?? Date.now());
    this.#backgroundAt = null;
    this.#publish({ visibility: "foreground" });
    if (!this.#desired || this.#state.phase === "blocked") return;
    if (
      this.#lease &&
      duration < (this.#options.lifecycle?.socketTrustWindowMs ?? socketTrustWindowMs) &&
      this.#state.network !== "offline"
    ) {
      this.#checkLease();
      this.#idle ??= setInterval(() => this.#checkLease(), (this.#options.liveness?.idleMs ?? realtimeIdleProbeMs));
      unrefTimer(this.#idle);
    } else this.#restart(false);
  }
  #checkLease(followsNetwork = false): void {
    this.#probeFollowsNetwork ||= followsNetwork;
    const lease = this.#lease,
      controller = this.#controller;
    if (!lease || !controller || this.#probe || this.#suspended()) return;
    const probe = new AbortController();
    const aborted = () => probe.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(
      () => probe.abort(new HostTransportError("timed-out")),
      this.#options.liveness?.deadlineMs ?? socketProbeDeadlineMs,
    );
    unrefTimer(timer);
    const failed = new Promise<never>((_, reject) =>
      probe.signal.addEventListener("abort", () => reject(probe.signal.reason), { once: true }),
    );
    const pending = Promise.race([lease.probe(probe.signal), failed])
      .catch((error) => {
        if (this.#controller === controller) {
          if (this.#probeFollowsNetwork)
            this.#publish({ pathRevision: this.#state.pathRevision + 1 });
          this.#failed(classifyClientFailure(error));
        }
      })
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", aborted);
        if (this.#probe === pending) {
          this.#probe = null;
          this.#probeFollowsNetwork = false;
        }
      });
    this.#probe = pending;
  }
  #clearHold(): void {
    if (this.#hold) clearTimeout(this.#hold);
    this.#hold = null;
  }
}
