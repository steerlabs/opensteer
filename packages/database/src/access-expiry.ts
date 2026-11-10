import type { Kysely } from "kysely";
import {
  expireAccessMemberships,
  nextAccessDeadline,
  type MembershipTransition,
} from "./access-store.js";
import type { DatabaseSchema } from "./schema.js";

export function createAccessExpiryScheduler(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly committed: (transitions: readonly MembershipTransition[]) => void;
  readonly failed: (error: unknown) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let started = false;
  let revision = 0;
  const schedule = async () => {
    const observed = ++revision;
    const deadline = await nextAccessDeadline(input.database);
    if (!started || observed !== revision) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (deadline)
      timer = setTimeout(
        () => {
          void drain().catch((error: unknown) => {
            started = false;
            input.failed(error);
          });
        },
        Math.min(2_147_483_647, Math.max(0, deadline.getTime() - Date.now())),
      );
  };
  const drain = (): Promise<void> => {
    active ??= (async () => {
      input.committed(await expireAccessMemberships(input.database));
      await schedule();
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
  return {
    async start(): Promise<void> {
      if (started) return active;
      started = true;
      try {
        await drain();
      } catch (error) {
        started = false;
        throw error;
      }
    },
    async changed(): Promise<void> {
      if (started) await schedule();
    },
    async close(): Promise<void> {
      started = false;
      ++revision;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await active;
    },
  };
}
