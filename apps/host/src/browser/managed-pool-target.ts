/**
 * A pooled Cloud Computer's Home and its target (phase B, piece 4: W4, S5, W5, S7). The Home
 * registers the public halves of its own keys with its Opensteer account, signed by its pinned
 * host key as well as carried by its host credential, and reads the target the account placed
 * for it: public material only. Nothing here runs for any other Home.
 *
 * - The attempt is written before a registration leaves the Home; an answer that did not come is
 *   read back with the target, and the Home registers again only once it has read what the
 *   account holds (a registration of keys the account already has is a no-op there).
 * - The term is the account's: the Home never raises it, and reads it with the target.
 * - The target is read at start, while none is ready, while the one it had is over, and when the
 *   browser's calls have gone unanswered for long (`suspect`): paced, from 5 s doubling to five
 *   minutes; nothing while a ready target answers.
 */
import { sign, type KeyObject } from "node:crypto";
import {
  managedBrowserPoolRegistrationPath,
  ManagedBrowserPoolRegistrationRequestSchema,
  managedBrowserPoolRegistrationSigningBytes,
  managedBrowserPoolTargetPath,
  ManagedBrowserPoolTargetResponseSchema,
  type ManagedBrowserPoolRegistrationRequest,
  type ManagedBrowserPoolTarget,
  type ManagedBrowserPoolTargetResponse,
} from "@opensteer/control-plane-protocol";
import { setTimeout as delay } from "node:timers/promises";
import {
  readBrowserPoolTarget,
  recordBrowserPoolRegistrationAttempt,
  recordBrowserPoolTargetAnswer,
} from "@opensteer/database";
import { managedBrowserPoolRegistration, type ManagedBrowserPoolHomeKeys } from "./managed-pool.js";

export type { ManagedBrowserPoolTarget, ManagedBrowserPoolTargetResponse };

/** The account's two routes for a pooled Home, under its host credential. */
export interface ManagedBrowserPoolAccount {
  register(
    request: ManagedBrowserPoolRegistrationRequest,
  ): Promise<ManagedBrowserPoolTargetResponse>;
  target(): Promise<ManagedBrowserPoolTargetResponse>;
}

/** The Home's link to its account for its pooled browser, over HTTPS with its host credential. */
export class ManagedBrowserPoolAccountClient implements ManagedBrowserPoolAccount {
  readonly #origin: URL;
  readonly #credential: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly controlApiOrigin: URL;
    readonly hostCredential: string;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  }) {
    this.#origin = options.controlApiOrigin;
    this.#credential = options.hostCredential;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  register(request: ManagedBrowserPoolRegistrationRequest) {
    return this.#send("PUT", managedBrowserPoolRegistrationPath, request);
  }

  target() {
    return this.#send("GET", managedBrowserPoolTargetPath);
  }

  async #send(method: "GET" | "PUT", path: string, body?: unknown) {
    const response = await this.#fetch(new URL(path, this.#origin), {
      method,
      headers: {
        authorization: `Bearer ${this.#credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok)
      throw new ManagedBrowserPoolAccountRefused(
        `The account refused the browser's ${method === "PUT" ? "registration" : "target"} (${response.status}).`,
        response.status,
      );
    return ManagedBrowserPoolTargetResponseSchema.parse(await response.json());
  }
}

/** The account answered, and refused: a definite answer, unlike no answer at all. */
export class ManagedBrowserPoolAccountRefused extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The registration signed by the Home's pinned host key: its bearer credential alone is not enough. */
export function signedManagedBrowserPoolRegistration(input: {
  readonly cloudComputerId: string;
  readonly keys: ManagedBrowserPoolHomeKeys;
  readonly hostKey: KeyObject;
  readonly issuedAt: Date;
}): ManagedBrowserPoolRegistrationRequest {
  const document = {
    purpose: "opensteer-managed-browser-pool-registration" as const,
    documentVersion: 1 as const,
    cloudComputerId: input.cloudComputerId,
    issuedAt: input.issuedAt.toISOString(),
    keys: managedBrowserPoolRegistration(input.keys),
  };
  return ManagedBrowserPoolRegistrationRequestSchema.parse({
    document,
    signature: sign(
      null,
      managedBrowserPoolRegistrationSigningBytes(
        document as Parameters<typeof managedBrowserPoolRegistrationSigningBytes>[0],
      ),
      input.hostKey,
    ).toString("base64url"),
  });
}

/** Where the Home keeps its registration's attempt and the target it read. */
export interface ManagedBrowserPoolTargetRecord {
  read(): Promise<
    | {
        readonly attemptKeys: Readonly<Record<string, unknown>> | null;
        readonly registeredKeys: Readonly<Record<string, unknown>> | null;
        readonly status: ManagedBrowserPoolTargetResponse["status"];
        readonly target: Readonly<Record<string, unknown>> | null;
      }
    | undefined
  >;
  attempt(keys: Readonly<Record<string, unknown>>, issuedAt: Date): Promise<void>;
  answer(input: {
    readonly response: ManagedBrowserPoolTargetResponse;
    readonly registered?: Readonly<Record<string, unknown>>;
    readonly attemptUnreceived?: boolean;
  }): Promise<void>;
}

export interface ManagedBrowserPoolTargetServiceOptions {
  readonly cloudComputerId: string;
  readonly keys: ManagedBrowserPoolHomeKeys;
  readonly hostKey: KeyObject;
  readonly account: ManagedBrowserPoolAccount;
  readonly record: ManagedBrowserPoolTargetRecord;
  /** A ready target, read now; a different one than before means a different guest. */
  readonly onTarget: (target: ManagedBrowserPoolTarget) => void | Promise<void>;
  /** What the person is shown while there is no ready target. */
  readonly onNotReady?: (status: ManagedBrowserPoolTargetResponse["status"]) => void;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => Date;
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;
}

export class ManagedBrowserPoolTargetService {
  readonly #options: ManagedBrowserPoolTargetServiceOptions;
  #closed = false;
  #wake = new AbortController();
  #running: Promise<void> | undefined;
  #delivered: string | undefined;
  /** The target in hand is ready and answering: nothing is read until it is suspected. */
  #settled = false;

  constructor(options: ManagedBrowserPoolTargetServiceOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#running || this.#closed) return;
    this.#running = this.#run().finally(() => {
      this.#running = undefined;
    });
  }

  /**
   * The target in hand may be over: it answered that it is, or its calls have gone unanswered or
   * been refused unsigned for long. The account is asked again.
   */
  suspect(): void {
    this.#settled = false;
    this.#kick();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#kick();
    await this.#running;
  }

  #kick(): void {
    const previous = this.#wake;
    this.#wake = new AbortController();
    previous.abort();
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#closed) {
      const woken = this.#wake.signal;
      try {
        const response = await this.#turn();
        if (response.status === "ready" && response.target) {
          failures = 0;
          const key = JSON.stringify(response.target);
          if (key !== this.#delivered) {
            this.#delivered = key;
            await this.#options.onTarget(response.target);
          }
          this.#settled = true;
        } else {
          this.#options.onNotReady?.(response.status);
          failures++;
        }
      } catch (error) {
        this.#options.onError?.(error);
        failures++;
      }
      if (this.#closed) return;
      if (this.#settled) {
        // Ready and answering: nothing more is read until the target is suspected.
        await untilAborted(woken);
        continue;
      }
      const first = this.#options.firstDelayMs ?? 5_000;
      const wait = Math.min(
        first * 2 ** Math.min(failures - 1, 16),
        this.#options.maxDelayMs ?? 300_000,
      );
      await delay(wait, undefined, { signal: woken }).catch(() => undefined);
    }
  }

  async #turn(): Promise<ManagedBrowserPoolTargetResponse> {
    const { record, account, keys } = this.#options;
    const mine = managedBrowserPoolRegistration(keys) as unknown as Record<string, unknown>;
    // A registration whose answer did not come: what the account holds is read first, and only
    // then is it registered again (keys the account already has are a no-op there).
    if ((await record.read())?.attemptKeys) {
      const read = await account.target();
      await record.answer({ response: read, attemptUnreceived: read.status === "unregistered" });
    }
    const row = await record.read();
    if (!sameKeys(row?.registeredKeys, mine)) return this.#register(mine);
    const read = await account.target();
    await record.answer({ response: read });
    return read;
  }

  async #register(
    mine: Readonly<Record<string, unknown>>,
  ): Promise<ManagedBrowserPoolTargetResponse> {
    const { record, account } = this.#options;
    const issuedAt = this.#options.now?.() ?? new Date();
    // The attempt is durable before anything leaves the Home.
    await record.attempt(mine, issuedAt);
    const response = await account.register(
      signedManagedBrowserPoolRegistration({
        cloudComputerId: this.#options.cloudComputerId,
        keys: this.#options.keys,
        hostKey: this.#options.hostKey,
        issuedAt,
      }),
    );
    await record.answer({ response, registered: mine });
    return response;
  }
}

function sameKeys(
  a: Readonly<Record<string, unknown>> | null | undefined,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return a !== null && a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** The record kept in the Home's own database (`browser_pool_targets`). */
export function databaseManagedBrowserPoolTargetRecord(
  database: Parameters<typeof readBrowserPoolTarget>[0],
  cloudComputerId: string,
): ManagedBrowserPoolTargetRecord {
  return {
    read: () => readBrowserPoolTarget(database, cloudComputerId),
    attempt: (keys, issuedAt) =>
      recordBrowserPoolRegistrationAttempt(database, { cloudComputerId, keys, issuedAt }),
    answer: ({ response, registered, attemptUnreceived }) =>
      recordBrowserPoolTargetAnswer(database, {
        cloudComputerId,
        status: response.status,
        target: (response.target as Readonly<Record<string, unknown>> | undefined) ?? null,
        ...(registered ? { registered } : {}),
        ...(attemptUnreceived ? { attemptUnreceived } : {}),
      }),
  };
}
