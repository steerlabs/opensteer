import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, test } from "vitest";
import {
  commitPersonalMutation,
  installPersonalMutationHooks,
} from "@opensteer/database/personal-mutation";
import { createPersonalStateFixture } from "@opensteer/database/test-support/personal-state";
import {
  authorizedSyncState,
  personalScopeKey,
  readPersonalScopeCut,
  withPersonalSyncRead,
} from "@opensteer/database/personal-sync-store";
import { buildPersonalShellSnapshot } from "@opensteer/database/personal-snapshot-store";
import { PersonalSyncSocket } from "./personal-sync.js";

function deadline<T>(promise: Promise<T>, message: string) {
  return withTimeout(promise, 2000, { timeoutError: () => new Error(message) });
}

test("wakes independent device generations after a PostgreSQL resource-only commit", async () => {
  const fixture = await createPersonalStateFixture("two-personal-devices");
  const { database, run } = fixture;
  function device(generation: number) {
    const synchronized = Promise.withResolvers<void>();
    const resource = Promise.withResolvers<{ generation: number; revision: string }>();
    const socket = new PersonalSyncSocket({
      async read(scope, cursor) {
        const cut = await readPersonalScopeCut(database, {
          viewerId: run.userId,
          scope,
          ...(cursor ? { cursor } : {}),
          snapshot: (tx, state) => buildPersonalShellSnapshot(tx, state, run.userId, run.threadId),
        });
        const throughSequence = cut.state.sequence;
        const next = {
          deploymentId: cut.state.deploymentId,
          viewerId: run.userId,
          epoch: cut.state.epoch,
          afterSequence: throughSequence,
          scopeKey: personalScopeKey(scope),
        };
        if (cut.kind === "snapshot")
          return {
            throughSequence,
            cursor: next,
            frames: [{ type: "host.snapshot", scope, throughSequence, snapshot: cut.snapshot }],
          };
        if (cut.kind === "replay")
          return {
            throughSequence,
            cursor: next,
            frames: cut.commits.map((change) => ({
              ...change,
              type: "host.changes" as const,
              scope,
              changes: change.changes
                .map((row) =>
                  ScopedHostMessageSchema.parse({
                    type: "host.changes",
                    scope,
                    subscriptionId: "shell",
                    generation,
                    fromSequence: change.fromSequence,
                    throughSequence: change.throughSequence,
                    changes: [row],
                  }),
                )
                .flatMap((frame) => (frame.type === "host.changes" ? frame.changes : [])),
            })),
          };
        throw new Error("Fixture scope was unexpectedly stale");
      },
      readResources: (interests, installed) =>
        withPersonalSyncRead(database, async (tx) => {
          const state = await authorizedSyncState(tx, run.userId);
          return interests.flatMap((kind) =>
            state.resourceRevisions[kind] === installed[kind]
              ? []
              : [
                  {
                    kind,
                    revision: state.resourceRevisions[kind],
                    view: { entries: [], complete: true, hasMore: false },
                  },
                ],
          );
        }),
      async send(encoded, guard) {
        if (!guard()) return false;
        const frame = ScopedHostMessageSchema.parse(JSON.parse(encoded));
        if (frame.type === "host.synchronized") synchronized.resolve();
        if (frame.type === "host.resource")
          resource.resolve({ generation: frame.generation, revision: frame.revision });
        return true;
      },
      close() {},
    });
    return { socket, synchronized, resource };
  }

  const first = device(1);
  const second = device(3);
  const remove = installPersonalMutationHooks(database, {
    wake: ({ head }) => {
      first.socket.wake(head);
      second.socket.wake(head);
    },
    onFailure(error) {
      throw error;
    },
  });
  try {
    for (const [entry, generation] of [
      [first, 1],
      [second, 3],
    ] as const) {
      entry.socket.attach({
        type: "client.attach",
        apiVersion: 62,
        generation,
        interests: ["settings"],
        installed: { settings: "0" },
      });
    }
    await deadline(
      Promise.all([first.synchronized.promise, second.synchronized.promise]),
      "The initial cuts did not synchronize",
    );
    const revision = await commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.bumpResource("settings");
      return mutation.sequence;
    });
    expect(
      await deadline(first.resource.promise, "The first device did not receive the revision"),
    ).toEqual({ generation: 1, revision });
    expect(
      await deadline(second.resource.promise, "The second device did not receive the revision"),
    ).toEqual({ generation: 3, revision });
    expect(
      await database.selectFrom("clientChanges").select("sequence").limit(1).execute(),
    ).toEqual([]);
  } finally {
    remove();
    first.socket.close("test finished");
    second.socket.close("test finished");
    await fixture.close();
  }
});
