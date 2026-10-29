import type { HarnessInstanceId, ThreadId, WorkspaceId } from "@opensteer/core";
import type { HarnessSession } from "@opensteer/harness";
import type { BrowserCdpRelay } from "../browser/browser-cdp-relay.js";
import type { CredentialProxy } from "../credentials/credential-proxy.js";
import type { RunCredentials } from "../credentials/run-credentials.js";
import type { MachineAccessSetup } from "../shell/machine-access-setup.js";
import type { MaterializedIntegrationSkills } from "../skills/integration-skills.js";

/**
 * An engine kept running between the Runs of one Thread, with everything it
 * was started with: its credential proxy and browser relay, whose URLs and
 * secret it holds, its machine-access launch directory, its containment
 * scope, and the skills directory it reads.
 */
export interface WarmEngine {
  /** The Run whose authority the proxy and relay carry; none while idle. */
  readonly authority: { credentials: RunCredentials | undefined };
  readonly browserCdpRelay: BrowserCdpRelay;
  readonly browserCdpUrl: string;
  readonly credentialProxy: CredentialProxy;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly integrationSkills: MaterializedIntegrationSkills;
  /** What the engine was started with; a Run with any other key starts its own. */
  readonly key: string;
  /** The session's own lifetime, which outlasts each Run's. */
  readonly lifetime: AbortController;
  /**
   * The launch directory the engine reaches other computers through, fixed
   * when it started; its relay is suspended while the engine is idle.
   */
  readonly machineAccess: MachineAccessSetup | undefined;
  readonly proxied: {
    readonly secret: string;
    readonly urls: Readonly<Record<"agent-tools" | "integration-tools", string>>;
  };
  /** The containment scope of every process the engine started. */
  readonly scope: string;
  readonly session: HarnessSession;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

interface Idle {
  readonly engine: WarmEngine;
  readonly timer: NodeJS.Timeout;
  readonly since: number;
}

/**
 * The idle warm engines of one Runner, at most one per Thread. The Thread's
 * next Run takes its engine and keeps it when its key matches; its idle time
 * running out, room for a newer one, or whatever it depends on going away
 * retires it. The Host never knows: a Thread always comes back to the Runner
 * of its environment.
 */
export class WarmEnginePool {
  readonly #idle = new Map<ThreadId, Idle>();
  readonly #idleMs: number;
  readonly #maxIdle: number;
  readonly #retire: (engine: WarmEngine) => Promise<void>;
  readonly #retiring = new Map<ThreadId, Promise<void>>();
  #closed = false;

  constructor(options: {
    readonly idleMs?: number;
    readonly maxIdle?: number;
    readonly retire: (engine: WarmEngine) => Promise<void>;
  }) {
    this.#idleMs = options.idleMs ?? 15 * 60 * 1_000;
    this.#maxIdle = options.maxIdle ?? 8;
    this.#retire = options.retire;
  }

  /**
   * Hands the Thread's idle engine to its next Run, which serves itself with
   * it when the keys match and retires it otherwise. Nothing else retires it
   * once taken, and a retirement already under way finishes first: it removes
   * what the Thread's next Run is about to write again.
   */
  async take(threadId: ThreadId): Promise<WarmEngine | undefined> {
    await this.#retiring.get(threadId);
    const idle = this.#idle.get(threadId);
    if (!idle) return undefined;
    this.#idle.delete(threadId);
    clearTimeout(idle.timer);
    return idle.engine;
  }

  /** Keeps an engine the Run released, until its Thread's next Run or its idle time ends. */
  async put(engine: WarmEngine): Promise<void> {
    if (this.#closed) {
      await this.#retireTracked(engine);
      return;
    }
    const previous = this.#idle.get(engine.threadId);
    if (previous) {
      this.#idle.delete(engine.threadId);
      clearTimeout(previous.timer);
      await this.#retireTracked(previous.engine);
    }
    const timer = setTimeout(() => {
      if (this.#idle.get(engine.threadId)?.engine !== engine) return;
      this.#idle.delete(engine.threadId);
      void this.#retireTracked(engine);
    }, this.#idleMs);
    timer.unref();
    this.#idle.set(engine.threadId, { engine, since: Date.now(), timer });
    while (this.#idle.size > this.#maxIdle) {
      const [threadId, oldest] = [...this.#idle].reduce((left, right) =>
        right[1].since < left[1].since ? right : left,
      );
      this.#idle.delete(threadId);
      clearTimeout(oldest.timer);
      await this.#retireTracked(oldest.engine);
    }
  }

  /** Retires every idle engine the predicate names: an account, a Workspace, a Thread. */
  async evict(predicate: (engine: WarmEngine) => boolean): Promise<void> {
    const matching = [...this.#idle].filter(([, idle]) => predicate(idle.engine));
    for (const [threadId, idle] of matching) {
      this.#idle.delete(threadId);
      clearTimeout(idle.timer);
    }
    await Promise.allSettled(matching.map(([, idle]) => this.#retireTracked(idle.engine)));
  }

  /** Retires everything; nothing is kept after. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.evict(() => true);
  }

  get size(): number {
    return this.#idle.size;
  }

  async #retireTracked(engine: WarmEngine): Promise<void> {
    const retiring = this.#retire(engine)
      .catch(() => undefined)
      .finally(() => {
        if (this.#retiring.get(engine.threadId) === retiring) {
          this.#retiring.delete(engine.threadId);
        }
      });
    this.#retiring.set(engine.threadId, retiring);
    await retiring;
  }
}
