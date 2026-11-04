import { DeploymentIdSchema, IsoDateTimeSchema, UserIdSchema } from "@opensteer/core";
import {
  IntegrationAuthorizationAttemptIdSchema,
  type IntegrationAuthorizationStatus,
} from "@opensteer/integration-core";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { z } from "zod";
import { integrationAuthorizationTerminalStatuses } from "./authorization-outcome.js";

const EntrySchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  attemptId: IntegrationAuthorizationAttemptIdSchema,
  userId: UserIdSchema.optional(),
  expiresAt: IsoDateTimeSchema,
});
export type IntegrationAuthorizationAttempt = z.infer<typeof EntrySchema>;
type Attempt = Pick<IntegrationAuthorizationAttempt, "deploymentId" | "attemptId"> & {
  readonly userId?: string | undefined;
};
export interface IntegrationAuthorizationAttemptStore {
  read(): Promise<unknown>;
  write(entries: readonly IntegrationAuthorizationAttempt[]): Promise<void>;
}
const maximumAttempts = 32;
const keyOf = (attempt: Attempt) => `${attempt.deploymentId}:${attempt.attemptId}`;

/** Local authority to finish only consents this app began with an authenticated Host. */
export class IntegrationAuthorizationAttempts {
  readonly #entries = new Map<string, IntegrationAuthorizationAttempt>();
  readonly #deliveries = new Map<
    string,
    {
      expiresAt: number;
      userId: string | undefined;
      result: Promise<IntegrationAuthorizationStatus | null>;
    }
  >();
  readonly #writes = new MutationQueue();
  readonly #store: IntegrationAuthorizationAttemptStore | undefined;
  readonly #now: () => number;
  #loading: Promise<void> | undefined;
  #generation = 0;
  constructor(
    options: {
      readonly store?: IntegrationAuthorizationAttemptStore;
      readonly now?: () => number;
    } = {},
  ) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }
  load(): Promise<void> {
    return (this.#loading ??= (async () => {
      if (!this.#store) return;
      const parsed = z
        .array(EntrySchema)
        .max(maximumAttempts)
        .safeParse(await this.#store.read());
      if (parsed.success) for (const entry of parsed.data) this.#entries.set(keyOf(entry), entry);
      this.#prune();
      await this.#persist();
    })().catch((error: unknown) => {
      this.#loading = undefined;
      throw error;
    }));
  }
  find(attempt: Attempt): IntegrationAuthorizationAttempt | null {
    this.#prune();
    const entry = this.#entries.get(keyOf(attempt));
    return entry &&
      (attempt.userId === undefined ||
        entry.userId === undefined ||
        attempt.userId === entry.userId)
      ? entry
      : null;
  }
  async register(entry: IntegrationAuthorizationAttempt): Promise<void> {
    const generation = this.#generation;
    await this.load();
    if (generation !== this.#generation) throw new Error("Integration authorization was stopped.");
    this.#prune();
    const parsed = EntrySchema.parse(entry);
    if (Date.parse(parsed.expiresAt) <= this.#now())
      throw new Error("Integration authorization has expired.");
    if (this.#entries.size >= maximumAttempts && !this.#entries.has(keyOf(parsed)))
      throw new Error("Too many integration sign-ins are pending.");
    this.#entries.set(keyOf(parsed), parsed);
    try {
      await this.#persist();
    } catch (error) {
      this.#entries.delete(keyOf(parsed));
      throw error;
    }
  }
  async forget(attempt: Attempt): Promise<void> {
    await this.load();
    this.#entries.delete(keyOf(attempt));
    this.#deliveries.delete(keyOf(attempt));
    await this.#persist();
  }
  async clear(deploymentId?: string): Promise<void> {
    this.#generation += 1;
    await this.load();
    for (const [key, entry] of this.#entries)
      if (deploymentId === undefined || entry.deploymentId === deploymentId)
        this.#entries.delete(key);
    for (const key of this.#deliveries.keys())
      if (deploymentId === undefined || key.startsWith(`${deploymentId}:`))
        this.#deliveries.delete(key);
    await this.#persist();
  }
  async deliver(
    attempt: Attempt,
    finish: (entry: IntegrationAuthorizationAttempt) => Promise<IntegrationAuthorizationStatus>,
  ): Promise<IntegrationAuthorizationStatus | null> {
    await this.load();
    this.#prune();
    const previous = this.#deliveries.get(keyOf(attempt));
    if (previous)
      return attempt.userId === undefined ||
        previous.userId === undefined ||
        attempt.userId === previous.userId
        ? previous.result
        : null;
    const entry = this.find(attempt);
    if (!entry) return null;
    const result = Promise.resolve()
      .then(() => finish(entry))
      .then(async (status) => {
        if (integrationAuthorizationTerminalStatuses.has(status.status)) {
          this.#entries.delete(keyOf(attempt));
          await this.#persist();
        } else this.#deliveries.delete(keyOf(attempt));
        return status;
      })
      .catch((error: unknown) => {
        this.#deliveries.delete(keyOf(attempt));
        throw error;
      });
    this.#deliveries.set(keyOf(attempt), {
      expiresAt: Date.parse(entry.expiresAt),
      userId: entry.userId,
      result,
    });
    return result;
  }
  #prune(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries)
      if (Date.parse(entry.expiresAt) <= now) this.#entries.delete(key);
    for (const [key, delivery] of this.#deliveries)
      if (delivery.expiresAt <= now) this.#deliveries.delete(key);
  }
  #persist(): Promise<void> {
    const entries = [...this.#entries.values()];
    return this.#writes.run(async () => {
      await this.#store?.write(entries);
    });
  }
}
