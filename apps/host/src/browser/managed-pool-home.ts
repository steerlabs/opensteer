/**
 * A pooled Cloud Computer's Home chooses its browser's coordinator (phase B, piece 5: W6, S7).
 * Only a Home whose boot answer said browserPool reaches this; for it, the coordinator is built
 * for the target its account placed, and replaced, never patched, when the target changes. A
 * Home with no ready target has no coordinator at all.
 */
import type { KeyObject } from "node:crypto";
import type { Kysely } from "kysely";
import type { RunnerId } from "@opensteer/core";
import { retireBrowserPoolTarget, type DatabaseSchema } from "@opensteer/database";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { BrowserPoolCoordinator } from "./browser-pool-coordinator.js";
import type { BrowserService } from "./browser-service.js";
import { managedBrowserPool, type ManagedBrowserPoolHomeKeys } from "./managed-pool.js";
import { loadOrCreateManagedBrowserPoolKeys } from "./managed-pool-keys.js";
import {
  databaseManagedBrowserPoolTargetRecord,
  ManagedBrowserPoolAccountClient,
  ManagedBrowserPoolTargetService,
  type ManagedBrowserPoolAccount,
  type ManagedBrowserPoolTarget,
} from "./managed-pool-target.js";

/** The runtime id the Cloud Computer's Runner reports for its browser (deploy/home/compose.yaml). */
export const pooledBrowserRuntimeId = "browser-main";

export interface ManagedBrowserPoolHome {
  readonly runnerId: RunnerId;
  readonly targets: ManagedBrowserPoolTargetService;
  close(): Promise<void>;
}

/** Builds the coordinator for one target: a different target is a different coordinator. */
export function managedBrowserPoolCoordinator(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly runnerId: RunnerId;
  readonly target: ManagedBrowserPoolTarget;
  readonly keys: ManagedBrowserPoolHomeKeys;
  readonly onSuspect: (reason?: "over") => void;
  readonly onError?: (error: unknown) => void;
}): BrowserPoolCoordinator {
  const parts = managedBrowserPool(input.target, input.keys);
  return new BrowserPoolCoordinator({
    database: input.database,
    runnerId: input.runnerId,
    runtimeId: pooledBrowserRuntimeId,
    slotId: input.target.slotId,
    term: input.target.term,
    runtime: parts.runtime,
    controller: parts.controller,
    onSuspect: input.onSuspect,
    ...(input.onError ? { onError: input.onError } : {}),
  });
}

/**
 * Starts a pooled Cloud Computer's Home's browser: a target it already read is chosen at once (its
 * sessions were kept by the startup sweep), and the target service reads the account for any
 * other. Call after `BrowserService.initialize`.
 */
export async function startManagedBrowserPool(input: {
  readonly database: Kysely<DatabaseSchema>;
  readonly dataDirectory: string;
  readonly cloudComputerId: string;
  readonly runnerId: RunnerId;
  readonly hostKey: KeyObject;
  readonly browser: Pick<BrowserService, "adoptPool" | "retirePool">;
  readonly account:
    ManagedBrowserPoolAccount | { readonly controlApiOrigin: URL; readonly hostCredential: string };
  readonly onError?: (error: unknown) => void;
}): Promise<ManagedBrowserPoolHome> {
  const keys = await loadOrCreateManagedBrowserPoolKeys(input.dataDirectory);
  const record = databaseManagedBrowserPoolTargetRecord(input.database, input.cloudComputerId);
  let current: string | undefined;
  // One target change at a time: the old coordinator retires before the new one is adopted.
  let changing: Promise<void> = Promise.resolve();
  const choose = (target: ManagedBrowserPoolTarget) => {
    changing = changing.then(async () => {
      // Canonical: a target read back from the database has its keys in another order.
      const key = canonicalJson(target);
      if (key === current) return;
      if (current !== undefined) {
        await input.browser.retirePool(input.runnerId, "browser-replaced");
        // Nothing of the old target is ever sent to the new one.
        await retireBrowserPoolTarget(input.database, input.runnerId);
      }
      current = key;
      await input.browser.adoptPool(
        input.runnerId,
        managedBrowserPoolCoordinator({
          database: input.database,
          runnerId: input.runnerId,
          target,
          keys,
          onSuspect: (reason) => targets.suspect(reason === "over" ? { over: true } : {}),
          ...(input.onError ? { onError: input.onError } : {}),
        }),
      );
    });
    return changing;
  };
  const account =
    "register" in input.account
      ? input.account
      : new ManagedBrowserPoolAccountClient({
          controlApiOrigin: input.account.controlApiOrigin,
          hostCredential: input.account.hostCredential,
        });
  const targets = new ManagedBrowserPoolTargetService({
    cloudComputerId: input.cloudComputerId,
    keys,
    hostKey: input.hostKey,
    account,
    record,
    onTarget: choose,
    ...(input.onError ? { onError: input.onError } : {}),
  });
  const stored = await record.read();
  if (stored?.status === "ready" && stored.target)
    await choose(stored.target as unknown as ManagedBrowserPoolTarget);
  targets.start();
  return {
    runnerId: input.runnerId,
    targets,
    close: async () => {
      await targets.close();
      await changing.catch(() => undefined);
    },
  };
}
