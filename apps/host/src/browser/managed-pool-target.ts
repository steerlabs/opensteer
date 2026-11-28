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
 * - A ready target's call that went unanswered or could not connect asks once, at once (`check`):
 *   one read at a time, its start at least 10 s after the last early read's. It changes nothing, in
 *   memory or on disk, unless the account names a different ready target that is not older.
 * - For the same slot an older term is never saved or delivered, on any read: the account's answer
 *   that lags behind a replacement never retires the target that replaced it.
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
import { canonicalJson } from "@opensteer/shared/canonicalJson";
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
  readonly #credential: () => Promise<string | null>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly controlApiOrigin: URL;
    /** The account link's credential; none before the Home was claimed. */
    readonly hostCredential: string | (() => Promise<string | null>);
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  }) {
    this.#origin = options.controlApiOrigin;
    const credential = options.hostCredential;
    this.#credential = typeof credential === "string" ? async () => credential : credential;
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
    const credential = await this.#credential();
    if (!credential)
      throw new ManagedBrowserPoolUnclaimed("This Home is not linked to its account yet.");
    const response = await this.#fetch(new URL(path, this.#origin), {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
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

/** The Home has not been claimed by its Opensteer account yet, so it has no host credential. */
export class ManagedBrowserPoolUnclaimed extends Error {}

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

/** How often unanswered calls to a ready target may ask the account (10 s). */
const checkEveryMs = 10_000;

export class ManagedBrowserPoolTargetService {
  readonly #options: ManagedBrowserPoolTargetServiceOptions;
  #closed = false;
  #wake = new AbortController();
  #running: Promise<void> | undefined;
  #delivered: string | undefined;
  /** The target in hand is ready and answering: nothing is read until it is suspected. */
  #settled = false;
  /** The target that is over: the account is asked, paced, until it places a different one. */
  #over: string | undefined;
  /** The newest ready target known (saved, or delivered): a lower term of its slot is stale. */
  #newest: ManagedBrowserPoolTarget | undefined;
  /** A turn is reading the account now: an unanswered call's check asks nothing more. */
  #reading = false;
  /**
   * When the last early read began. Early reads are paced against each other only: the loop's own
   * reads (the one that settled the target included) never delay the first one.
   */
  #earlyReadStartedAt: number | undefined;

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
  suspect(options: { readonly over?: boolean } = {}): void {
    // Over: the target in hand is known gone, so the same one read again is no answer (V6).
    if (options.over) this.#over = this.#delivered;
    this.#settled = false;
    this.#kick();
  }

  /**
   * A call to the ready target in hand went unanswered or could not connect: its pool host may
   * have been replaced. The account is asked once, now: one read at a time, and no early read that
   * starts within 10 s of the last early read's start (the loop's own reads, the one that settled
   * the target included, never delay it). Only a different ready target that is not older is
   * taken (saved, then delivered as any read's is); anything else (preparing, no answer, an
   * error, the same target) changes nothing, in memory or on disk. While the target is not
   * settled the loop is reading already, and this asks nothing more.
   */
  check(): void {
    if (this.#closed || !this.#settled || this.#reading) return;
    if (
      this.#earlyReadStartedAt !== undefined &&
      this.#now() - this.#earlyReadStartedAt < checkEveryMs
    )
      return;
    // Single flight from here: the loop's turn holds it until its read has ended.
    this.#reading = true;
    this.#kick();
  }

  #now(): number {
    return (this.#options.now?.() ?? new Date()).getTime();
  }

  /** A ready target known to the Home: the newest of its slot is kept. */
  #know(target: ManagedBrowserPoolTarget | undefined): void {
    if (!target) return;
    if (!this.#older(target)) this.#newest = target;
  }

  /** For the slot of the newest target known, a lower term: an answer that lags, never taken. */
  #older(target: ManagedBrowserPoolTarget): boolean {
    const newest = this.#newest;
    return newest !== undefined && newest.slotId === target.slotId && target.term < newest.term;
  }

  /** The answer names an older term of the newest target's slot. */
  #stale(response: ManagedBrowserPoolTargetResponse): boolean {
    return (
      response.status === "ready" && response.target !== undefined && this.#older(response.target)
    );
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
      // Settled and woken: an unanswered call's check. It counts toward no backoff, and leaves
      // the target in hand settled whatever it reads.
      const checking = this.#settled;
      this.#reading = true;
      try {
        const response = await this.#turn(checking);
        // Compared canonically: the database gives back an object with its keys reordered.
        const key =
          response?.status === "ready" && response.target
            ? canonicalJson(response.target)
            : undefined;
        if (!response) {
          // Nothing taken and nothing written: an early read that learned nothing new, or an
          // answer that lags behind the target in hand (asked again later, paced).
          if (!checking) failures++;
        } else if (response.target && key !== undefined && key === this.#over) {
          // The account still names the target that is over: asked again later, paced.
          failures++;
        } else if (response.status === "ready" && response.target && key !== undefined) {
          failures = 0;
          this.#over = undefined;
          if (key !== this.#delivered) {
            // Delivered once it has been taken: one that failed is delivered again.
            await this.#options.onTarget(response.target);
            this.#delivered = key;
            this.#know(response.target);
          }
          this.#settled = true;
        } else {
          this.#options.onNotReady?.(response.status);
          if (!checking) failures++;
        }
      } catch (error) {
        this.#options.onError?.(error);
        if (!checking) failures++;
      } finally {
        this.#reading = false;
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

  /**
   * One read of the account. Undefined: nothing to take, and no target written (an early read
   * that learned nothing new, or an answer naming an older term of the target's slot).
   */
  async #turn(checking: boolean): Promise<ManagedBrowserPoolTargetResponse | undefined> {
    const { record, account, keys } = this.#options;
    const mine = managedBrowserPoolRegistration(keys) as unknown as Record<string, unknown>;
    const first = await record.read();
    this.#knowSaved(first);
    if (checking) {
      // An early read changes nothing unless it names a different ready target that is not
      // older: the target saved stays exactly as it was for anything else.
      if (first?.attemptKeys || !sameKeys(first?.registeredKeys, mine)) return undefined;
      this.#earlyReadStartedAt = this.#now();
      const read = await account.target();
      if (
        read.status !== "ready" ||
        !read.target ||
        this.#stale(read) ||
        canonicalJson(read.target) === this.#delivered
      )
        return undefined;
      await record.answer({ response: read });
      return read;
    }
    // A registration whose answer did not come: what the account holds is read first, and only
    // then is it registered again (keys the account already has are a no-op there).
    if (first?.attemptKeys) {
      const read = await account.target();
      await record.answer({
        response: this.#stale(read) ? keptAnswer(first) : read,
        attemptUnreceived: read.status === "unregistered",
      });
    }
    const row = await record.read();
    this.#knowSaved(row);
    if (!sameKeys(row?.registeredKeys, mine)) return this.#register(mine, row);
    const read = await account.target();
    if (this.#stale(read)) return undefined;
    await record.answer({ response: read });
    return read;
  }

  /** The target saved, when it is a ready one: known like a delivered one. */
  #knowSaved(row: Awaited<ReturnType<ManagedBrowserPoolTargetRecord["read"]>>): void {
    if (row?.status === "ready" && row.target)
      this.#know(row.target as unknown as ManagedBrowserPoolTarget);
  }

  async #register(
    mine: Readonly<Record<string, unknown>>,
    row: Awaited<ReturnType<ManagedBrowserPoolTargetRecord["read"]>>,
  ): Promise<ManagedBrowserPoolTargetResponse | undefined> {
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
    // The keys are registered either way; a lagging target is not saved with them.
    const stale = this.#stale(response);
    await record.answer({ response: stale ? keptAnswer(row) : response, registered: mine });
    return stale ? undefined : response;
  }
}

/** What the Home had saved, written back unchanged beside a lagging answer's bookkeeping. */
function keptAnswer(
  row: Awaited<ReturnType<ManagedBrowserPoolTargetRecord["read"]>>,
): ManagedBrowserPoolTargetResponse {
  return {
    status: row?.status ?? "unregistered",
    ...(row?.target ? { target: row.target as unknown as ManagedBrowserPoolTarget } : {}),
  } as ManagedBrowserPoolTargetResponse;
}

function sameKeys(
  a: Readonly<Record<string, unknown>> | null | undefined,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return a !== null && a !== undefined && canonicalJson(a) === canonicalJson(b);
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
