import { release } from "node:os";
import type { DesktopPasswordsStatus } from "@opensteer/protocol/desktop";
import {
  passwordsBrokerLatestProtocolVersion,
  type PasswordsBrokerProtocolVersion,
} from "@opensteer/protocol/passwords-broker";
import type {
  PasswordsBrokerSignInRequestParams,
  PasswordsBrokerSignInRequestV6Params,
  PasswordsBrokerSignInProbeParams,
  PasswordsBrokerSignInProbeResult,
  PasswordsBrokerStatus,
} from "@opensteer/protocol/passwords-broker";
import type { SignedHelperProcess } from "../signed-helpers/signed-helper.js";
import {
  PasswordsBrokerClient,
  type PasswordsBrokerCallMethod,
  type PasswordsBrokerClientOptions,
  type PasswordsBrokerParams,
  type PasswordsBrokerResult,
} from "./broker-client.js";
import {
  PasswordsBrokerFailure,
  type PasswordsBrokerSession,
  type PasswordsBrokerCardSession,
  type PasswordsBrokerPersonFillSession,
  type PasswordsBrokerPersonSaveSession,
  type PasswordsBrokerSignInGrant,
} from "./broker-session.js";
import { ensurePasswordsBrokerInstalled } from "./install.js";
import {
  passwordsBrokerLockPath,
  passwordsBrokerNotBuiltMessage,
  passwordsBrokerSocketPath,
} from "./paths.js";

/** Darwin 23 is macOS 14, the first release the broker's CryptoKit HPKE runs on. */
const minimumDarwinMajor = 23;
/** How long installing may wait for another Opensteer that holds the lifecycle lock. */
const installLockWaitMs = 15_000;
const statusMessageLimit = 500;

const notRunningSentence =
  "Opensteer Passwords is not running on this Mac. It starts again when it is needed.";

export interface PasswordsServiceOptions {
  readonly appVersion: string;
  readonly protocolVersion?: PasswordsBrokerProtocolVersion;
  /** The broker this build ships, already resolved for packaged/development. */
  readonly bundledBrokerPath: () => string;
  /** Test seams for the broker connection; production uses the defaults. */
  readonly client?: Pick<
    PasswordsBrokerClientOptions,
    | "connectTimeoutMs"
    | "launchTimeoutMs"
    | "peerVerificationTimeoutMs"
    | "requestTimeoutMs"
    | "verifyPeer"
  >;
  /** A development desktop uses the development broker, and only it. */
  readonly development: boolean;
  readonly homeDirectory?: string;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  /** The kernel release, e.g. `25.0.0`; macOS's Darwin version. */
  readonly osRelease?: () => string;
  readonly platform?: NodeJS.Platform;
  readonly run?: SignedHelperProcess;
}

interface Transaction {
  readonly credential: "login" | "card" | "person" | "save";
  /** The client and connection the broker bound this transaction to. */
  readonly client: PasswordsBrokerClient;
  readonly generation: number;
  /** Aborted once that connection is gone, which is when the broker ended it. */
  readonly lifetime: AbortController;
  aborted: boolean;
}

/**
 * Opensteer Passwords for this desktop process: installing, launching and
 * talking to the broker, the status the app shows, and the narrow session
 * the login authority uses.
 *
 * Nothing is installed or launched off macOS, or on a macOS the broker does
 * not run on. Elsewhere the broker is installed and started by the first call
 * that needs it, and stays connected so its status changes reach the app.
 */
export class PasswordsService {
  readonly #options: PasswordsServiceOptions;
  readonly #now: () => number;
  readonly #listeners = new Set<(status: DesktopPasswordsStatus) => void>();
  readonly #transactions = new Map<string, Transaction>();
  readonly #compatibilityServices = new Map<PasswordsBrokerProtocolVersion, PasswordsService>();
  #client: PasswordsBrokerClient | null = null;
  #clientPromise: Promise<PasswordsBrokerClient> | null = null;
  #last: string | null = null;
  #stopped = false;

  constructor(options: PasswordsServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * What this Mac reports, read without unlocking anything. It never throws:
   * a broker that cannot be reached is `unavailable` with a sentence.
   */
  async status(): Promise<DesktopPasswordsStatus> {
    const unsupported = this.#unsupported();
    if (unsupported) return unsupported;
    try {
      const status = await this.#call("status", {});
      return this.#publish(this.#describe(status));
    } catch (error) {
      return this.#publish(this.#unavailable(error));
    }
  }

  /** Every change of what `status` would answer, as it happens. */
  onStatusChanged(listener: (status: DesktopPasswordsStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Brings up the broker's window, which decides between setup and the list.
   */
  async open(): Promise<void> {
    this.#assertSupported();
    await this.#call("window.open", {});
  }

  /** The narrow surface the login authority uses. */
  broker(
    protocolVersion: PasswordsBrokerProtocolVersion = this.#options.protocolVersion ??
      passwordsBrokerLatestProtocolVersion,
  ): PasswordsBrokerSession &
    PasswordsBrokerCardSession &
    Partial<PasswordsBrokerPersonFillSession & PasswordsBrokerPersonSaveSession> {
    // Browser-only consent from a previous-release Host must stay on protocol4.
    if (
      protocolVersion !== (this.#options.protocolVersion ?? passwordsBrokerLatestProtocolVersion)
    ) {
      let compatibility = this.#compatibilityServices.get(protocolVersion);
      if (!compatibility) {
        compatibility = new PasswordsService({ ...this.#options, protocolVersion });
        this.#compatibilityServices.set(protocolVersion, compatibility);
        if (this.#stopped) void compatibility.stop();
      }
      return compatibility.broker();
    }
    const session: PasswordsBrokerSession &
      PasswordsBrokerCardSession &
      Partial<PasswordsBrokerPersonFillSession & PasswordsBrokerPersonSaveSession> = {
      cardProbe: async () => {
        try {
          return await this.#call("card.probe", {});
        } catch {
          return { cards: "unavailable" };
        }
      },
      cardRequest: async (params, signal) =>
        await this.#startTransaction("card.request", params, signal),
      cardApprove: async (params, signal) =>
        await this.#bound(params.transactionId, "card.approve", (client, connection) =>
          client.call("card.approve", params, { connection, signal }),
        ),
      cardRelease: async (params, signal) =>
        await this.#bound(params.transactionId, "card.release", (client, connection) =>
          client.call("card.release", params, { connection, ...(signal ? { signal } : {}) }),
        ),
      commit: async (transactionId, signal) =>
        await this.#bound(transactionId, "signin.commit", (client, connection) =>
          client.call("signin.commit", { transactionId }, { connection, signal }),
        ),
      cancel: async (transactionId) => await this.#cancel(transactionId),
      probe: async (params) => await this.#probe(params),
      approve: async (params, signal) =>
        await this.#bound(params.transactionId, "signin.approve", (client, connection) =>
          client.call("signin.approve", params, { connection, signal }),
        ),
      request: async (params, signal) => await this.#request(params, signal),
      release: async (params, signal) => {
        if (
          this.#transactions.get(params.transactionId)?.credential === "person" &&
          (!("kind" in params) || params.kind !== "browser")
        ) {
          throw new PasswordsBrokerFailure(
            "invalid",
            "Person fills require a browser destination.",
          );
        }
        return await this.#bound(params.transactionId, "signin.release", (client, connection) =>
          client.call("signin.release", params, { connection, ...(signal ? { signal } : {}) }),
        );
      },
    };
    Object.defineProperty(session, "protocolVersion", {
      enumerable: true,
      get: () => this.#client?.connection?.protocolVersion ?? protocolVersion,
    });
    if (protocolVersion >= 8) {
      const fillAccounts: PasswordsBrokerPersonFillSession["fillAccounts"] = async (
        params,
        signal,
      ) => {
        const client = await this.#ready();
        return await this.#guard(client.call("fill.accounts", params, signal ? { signal } : {}));
      };
      const fillBegin: PasswordsBrokerPersonFillSession["fillBegin"] = async (params, signal) =>
        await this.#startTransaction("fill.begin", params, signal);
      Object.defineProperties(session, {
        fillAccounts: {
          get: () =>
            (this.#client?.connection?.protocolVersion ?? protocolVersion) >= 8
              ? fillAccounts
              : undefined,
        },
        fillBegin: {
          get: () =>
            (this.#client?.connection?.protocolVersion ?? protocolVersion) >= 8
              ? fillBegin
              : undefined,
        },
      });
    }
    if (protocolVersion >= 9) {
      const saveBegin: PasswordsBrokerPersonSaveSession["saveBegin"] = async (params, signal) =>
        await this.#startTransaction("save.begin", params, signal);
      const saveCommit: PasswordsBrokerPersonSaveSession["saveCommit"] = async (transactionId) => {
        try {
          return await this.#bound(transactionId, "save.commit", (client, connection) =>
            client.call("save.commit", { transactionId }, { connection }),
          );
        } finally {
          this.#transactions.delete(transactionId);
        }
      };
      const saving = () => (this.#client?.connection?.protocolVersion ?? protocolVersion) >= 9;
      Object.defineProperties(session, {
        saveBegin: { get: () => (saving() ? saveBegin : undefined) },
        saveCommit: { get: () => (saving() ? saveCommit : undefined) },
      });
    }
    return session;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#listeners.clear();
    const client = this.#client;
    this.#client = null;
    this.#clientPromise = null;
    if (client) this.#connectionLost(client);
    await Promise.all([
      client?.close(),
      ...Array.from(this.#compatibilityServices.values(), (service) => service.stop()),
    ]);
  }

  async #probe(
    params: PasswordsBrokerSignInProbeParams,
  ): Promise<PasswordsBrokerSignInProbeResult> {
    if (this.#unsupported()) return { passwords: "unavailable" };
    try {
      return await this.#call("signin.probe", params);
    } catch (error) {
      this.#publish(this.#unavailable(error));
      return { passwords: "unavailable" };
    }
  }

  async #request(
    params: PasswordsBrokerSignInRequestParams | PasswordsBrokerSignInRequestV6Params,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInGrant> {
    return await this.#startTransaction("signin.request", params, signal);
  }

  async #startTransaction<
    Method extends "signin.request" | "card.request" | "fill.begin" | "save.begin",
  >(
    method: Method,
    params: PasswordsBrokerParams<Method>,
    signal: AbortSignal,
  ): Promise<{ decision: PasswordsBrokerResult<Method>; lifetime: AbortSignal }> {
    this.#assertSupported();
    const client = await this.#ready();
    const connection = await this.#guard(client.connect(signal));
    if (this.#transactions.has(params.transactionId)) {
      throw new PasswordsBrokerFailure("invalid", "That sign-in was already requested.");
    }
    const transaction: Transaction = {
      credential:
        method === "card.request"
          ? "card"
          : method === "fill.begin"
            ? "person"
            : method === "save.begin"
              ? "save"
              : "login",
      aborted: false,
      client,
      generation: connection.generation,
      lifetime: new AbortController(),
    };
    this.#transactions.set(params.transactionId, transaction);
    try {
      const decision = await this.#guard(
        client.call(method, params, {
          connection: connection.generation,
          signal: AbortSignal.any([signal, transaction.lifetime.signal]),
        }),
      );
      if (
        decision.decision === "unavailable" ||
        decision.decision === "cancelled" ||
        decision.decision === "changed" ||
        decision.decision === "skip"
      ) {
        transaction.lifetime.abort();
        this.#transactions.delete(params.transactionId);
      }
      return { decision, lifetime: transaction.lifetime.signal };
    } catch (error) {
      if (error instanceof PasswordsBrokerFailure && error.code === "aborted") {
        transaction.aborted = true;
      }
      throw error;
    }
  }

  async #cancel(transactionId: string): Promise<void> {
    const transaction = this.#transactions.get(transactionId);
    this.#transactions.delete(transactionId);
    if (!transaction || transaction.aborted) return;
    const client = this.#client;
    // Turning Passwords off aborts a transaction's lifetime but leaves its
    // connection open, so the broker still holds it until it is cancelled.
    if (!this.#connected(transaction) || !client) return;
    await this.#guard(
      client.call(
        transaction.credential === "save" ? "save.cancel" : "signin.cancel",
        { transactionId },
        { connection: transaction.generation },
      ),
    ).catch((error: unknown) => {
      // The broker no longer knows it: it already ended, by expiry.
      if (error instanceof PasswordsBrokerFailure && error.code === "invalid") return;
      throw error;
    });
  }

  /**
   * A call that belongs to one transaction, on the connection that
   * transaction was started on and no other.
   */
  async #bound<T>(
    transactionId: string,
    method: string,
    send: (client: PasswordsBrokerClient, connection: number) => Promise<T>,
  ): Promise<T> {
    const transaction = this.#transactions.get(transactionId);
    if (!transaction) {
      throw new PasswordsBrokerFailure("invalid", `There is no open sign-in for ${method}.`);
    }
    if (
      (method.startsWith("card.") && transaction.credential !== "card") ||
      (method === "signin.approve" && transaction.credential !== "login") ||
      (method === "signin.commit" && transaction.credential === "person") ||
      (method === "signin.release" && transaction.credential === "card") ||
      (transaction.credential === "save") !== (method === "save.commit")
    ) {
      throw new PasswordsBrokerFailure("invalid", "This credential cannot be used on that path.");
    }
    if (transaction.aborted) {
      throw new PasswordsBrokerFailure("aborted", "That sign-in was already cancelled.");
    }
    const client = this.#client;
    if (!this.#live(transaction) || !client) {
      throw new PasswordsBrokerFailure(
        "connection-lost",
        "That sign-in ended when Opensteer lost its connection to Opensteer Passwords.",
      );
    }
    try {
      return await this.#guard(send(client, transaction.generation));
    } catch (error) {
      if (error instanceof PasswordsBrokerFailure && error.code === "aborted")
        transaction.aborted = true;
      throw error;
    }
  }

  /** Whether a transaction still holds and its connection is still the open one. */
  #live(transaction: Transaction): boolean {
    return !transaction.lifetime.signal.aborted && this.#connected(transaction);
  }

  /** Whether the connection a transaction was bound to is still the open one. */
  #connected(transaction: Transaction): boolean {
    return (
      this.#client === transaction.client &&
      transaction.client.connection?.generation === transaction.generation
    );
  }

  /**
   * The broker ends every transaction a lost connection carried; their
   * approvals stop holding at once, with or without a further call.
   */
  #connectionLost(client: PasswordsBrokerClient, generation?: number): void {
    for (const transaction of this.#transactions.values()) {
      if (transaction.client !== client) continue;
      if (generation !== undefined && transaction.generation !== generation) continue;
      transaction.lifetime.abort();
    }
  }

  async #call<Method extends PasswordsBrokerCallMethod>(
    method: Method,
    params: PasswordsBrokerParams<Method>,
  ): Promise<PasswordsBrokerResult<Method>> {
    const client = await this.#ready();
    return await this.#guard(client.call(method, params));
  }

  /**
   * A broker of another protocol version, or of the other build, is usually
   * one an older or different Opensteer installed. Forgetting the client is
   * what installs again on the next call, which replaces it when it may.
   */
  async #guard<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      if (
        error instanceof PasswordsBrokerFailure &&
        (error.code === "incompatible" || error.code === "wrong-build")
      ) {
        this.#forgetClient();
      }
      throw error;
    }
  }

  async #ready(): Promise<PasswordsBrokerClient> {
    if (this.#stopped) {
      throw new PasswordsBrokerFailure(
        "stopped",
        "Opensteer Passwords is shutting down on this Mac.",
      );
    }
    const existing = this.#clientPromise;
    if (existing) return await existing;
    const creating = this.#install();
    this.#clientPromise = creating;
    void creating.catch(() => {
      if (this.#clientPromise === creating) this.#clientPromise = null;
    });
    return await creating;
  }

  async #install(): Promise<PasswordsBrokerClient> {
    const { development, homeDirectory } = this.#options;
    const bundledAppPath = this.#options.bundledBrokerPath();
    const installed = await ensurePasswordsBrokerInstalled({
      bundledAppPath,
      deadline: { at: this.#now() + installLockWaitMs },
      development,
      ...(homeDirectory === undefined ? {} : { homeDirectory }),
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
      now: this.#now,
      ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
    }).catch((error: unknown) => {
      if (error instanceof PasswordsBrokerFailure) throw error;
      const message = error instanceof Error ? error.message : "install failed";
      this.#options.log?.("desktop.passwords.broker-install-failed", { message });
      throw new PasswordsBrokerFailure(
        "not-running",
        message === passwordsBrokerNotBuiltMessage
          ? passwordsBrokerNotBuiltMessage
          : "Opensteer Passwords could not be installed on this Mac.",
        { cause: error },
      );
    });
    if (this.#stopped) {
      throw new PasswordsBrokerFailure(
        "stopped",
        "Opensteer Passwords is shutting down on this Mac.",
      );
    }
    const client = new PasswordsBrokerClient({
      ...this.#options.client,
      appVersion: this.#options.appVersion,
      protocolVersion: this.#options.protocolVersion ?? passwordsBrokerLatestProtocolVersion,
      brokerAppPath: installed.path,
      development,
      launchFreshInstance: installed.launchFreshInstance,
      lockPath: passwordsBrokerLockPath(development, homeDirectory),
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
      now: this.#now,
      ...(this.#options.run === undefined ? {} : { run: this.#options.run }),
      socketPath: passwordsBrokerSocketPath(development, homeDirectory),
      verifierAppPath: bundledAppPath,
    });
    client.onStatusChanged((status) => this.#publish(this.#describe(status)));
    client.onDisconnect((generation) => {
      this.#connectionLost(client, generation);
      if (this.#client === client) {
        // The next call installs again before it reconnects, so the copy it
        // launches is checked for its signature and its version, not only
        // the signature a reconnect alone would check.
        this.#forgetClient();
        this.#publish({ availability: "unavailable", message: notRunningSentence });
      }
    });
    this.#client = client;
    return client;
  }

  #forgetClient(): void {
    const client = this.#client;
    this.#client = null;
    this.#clientPromise = null;
    if (client) this.#connectionLost(client);
    void client?.close();
  }

  #describe(status: PasswordsBrokerStatus): DesktopPasswordsStatus {
    // The broker reports a Mac without a Secure Enclave, or a macOS it was not
    // qualified on, as a vault it cannot hold.
    if (status.vault === "unsupported") return { availability: "unsupported", reason: "hardware" };
    return { availability: "available", broker: status, development: this.#options.development };
  }

  #unavailable(error: unknown): DesktopPasswordsStatus {
    const message =
      error instanceof PasswordsBrokerFailure && error.message.trim().length > 0
        ? error.message.trim()
        : "Opensteer Passwords could not be reached on this Mac.";
    return { availability: "unavailable", message: message.slice(0, statusMessageLimit) };
  }

  #publish(status: DesktopPasswordsStatus): DesktopPasswordsStatus {
    for (const transaction of this.#transactions.values()) {
      if (status.availability === "unsupported") transaction.lifetime.abort("denied");
      if (status.availability !== "available") continue;
      const enabled =
        transaction.credential === "person"
          ? status.broker.personFill === "on"
          : transaction.credential === "save"
            ? status.broker.personSave === "on"
            : status.broker.agentSignIns === "on";
      if (!enabled || status.broker.vault !== "ready") transaction.lifetime.abort("denied");
    }
    const key = JSON.stringify(status);
    if (key === this.#last) return status;
    this.#last = key;
    for (const listener of Array.from(this.#listeners)) listener(status);
    return status;
  }

  #unsupported(): DesktopPasswordsStatus | null {
    if ((this.#options.platform ?? process.platform) !== "darwin") {
      return { availability: "unsupported", reason: "platform" };
    }
    const major = Number.parseInt((this.#options.osRelease ?? release)().split(".")[0] ?? "", 10);
    if (!Number.isSafeInteger(major) || major < minimumDarwinMajor) {
      return { availability: "unsupported", reason: "os" };
    }
    return null;
  }

  #assertSupported(): void {
    const unsupported = this.#unsupported();
    if (!unsupported) return;
    throw new PasswordsBrokerFailure(
      "unavailable",
      unsupported.availability === "unsupported" && unsupported.reason === "platform"
        ? "Opensteer Passwords runs only on macOS."
        : "Opensteer Passwords needs macOS 14 or later.",
    );
  }
}
