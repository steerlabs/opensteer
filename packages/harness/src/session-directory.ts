import { randomUUID } from "node:crypto";
import { OpensteerError, type HarnessInstanceId, type ThreadId } from "@opensteer/core";
import type { HarnessSession } from "./types.js";

export interface LiveSessionBinding {
  readonly bootId: string;
  readonly generation: number;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly leaseToken: string;
  readonly session: HarnessSession;
  readonly threadId: ThreadId;
}

export class LiveSessionDirectory {
  readonly #bootId: string;
  readonly #bindings = new Map<ThreadId, LiveSessionBinding>();
  readonly #generations = new Map<ThreadId, number>();

  constructor(bootId: string) {
    if (!bootId) throw new TypeError("bootId is required");
    this.#bootId = bootId;
  }

  acquire(input: {
    readonly harnessInstanceId: HarnessInstanceId;
    readonly session: HarnessSession;
    readonly threadId: ThreadId;
  }): LiveSessionBinding {
    const existing = this.#bindings.get(input.threadId);
    if (existing) {
      throw new OpensteerError({
        code: "conflict",
        message: `Thread ${input.threadId} already has a live harness session`,
      });
    }
    const generation = (this.#generations.get(input.threadId) ?? 0) + 1;
    this.#generations.set(input.threadId, generation);
    const binding: LiveSessionBinding = {
      bootId: this.#bootId,
      generation,
      harnessInstanceId: input.harnessInstanceId,
      leaseToken: randomUUID(),
      session: input.session,
      threadId: input.threadId,
    };
    this.#bindings.set(input.threadId, binding);
    return binding;
  }

  get(threadId: ThreadId): LiveSessionBinding | undefined {
    return this.#bindings.get(threadId);
  }

  release(input: {
    readonly threadId: ThreadId;
    readonly generation: number;
    readonly leaseToken: string;
  }): boolean {
    const current = this.#bindings.get(input.threadId);
    if (
      !current ||
      current.generation !== input.generation ||
      current.leaseToken !== input.leaseToken
    ) {
      return false;
    }
    this.#bindings.delete(input.threadId);
    return true;
  }

  async stopAll(): Promise<void> {
    const bindings = [...this.#bindings.values()];
    this.#bindings.clear();
    await Promise.allSettled(bindings.map((binding) => binding.session.stop()));
  }
}
