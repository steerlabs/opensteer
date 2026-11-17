import { OpensteerError, type EnvironmentId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import type { RunnerIdentity } from "@opensteer/orchestration";
import type { Kysely } from "kysely";

export class PersonalRunnerObservations {
  readonly #byEnvironment = new Map<
    EnvironmentId,
    { readonly revision: string; readonly identity: RunnerIdentity | undefined }
  >();

  readonly #database: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }

  publish(identity: RunnerIdentity, online: boolean) {
    return commitPersonalMutation(this.#database, async (tx, mutation) => {
      const runner = await tx
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", identity.runnerId)
        .where("connectionGeneration", "=", String(identity.connectionGeneration))
        .executeTakeFirst();
      if (!runner || (online && runner.revokedAt)) return;
      for (const kind of [
        "machine",
        "environment",
        "harness-auth",
        "harness-catalog",
        "agent-home-settings",
        "browser-availability",
        "browser-placement",
        "tab",
      ] as const)
        mutation.bumpResource(kind);

      mutation.observation(() => {
        for (const id of identity.environmentIds) {
          const previous = this.#byEnvironment.get(id);
          if (!previous || BigInt(previous.revision) < BigInt(mutation.sequence))
            this.#byEnvironment.set(id, {
              revision: mutation.sequence,
              identity: online ? identity : undefined,
            });
        }
      });
    });
  }

  read(environmentId: EnvironmentId, revision: string) {
    const current = this.#byEnvironment.get(environmentId);
    if (current && BigInt(current.revision) > BigInt(revision))
      throw new OpensteerError({
        code: "conflict",
        message: "Runner state advanced during this read.",
        retryable: true,
      });
    return current?.identity;
  }
}
