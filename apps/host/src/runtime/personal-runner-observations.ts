import type { RunnerId } from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import { commitPersonalMutation } from "@opensteer/database/personal-mutation";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  RunnerModuleNameSchema,
  type RunnerModuleName,
  type RunnerModuleReadiness,
} from "@opensteer/protocol";
import type { Kysely } from "kysely";
import type { PersonalResourceObservations } from "./personal-resource-observations.js";

const runnerKinds = [
  "machine",
  "environment",
  "harness-auth",
  "harness-catalog",
  "agent-home-settings",
  "browser-availability",
  "browser-placement",
  "tab",
] as const;

type Readiness = (id: RunnerId, module: RunnerModuleName) => RunnerModuleReadiness | undefined;

type Observation = {
  readonly revision: bigint;
  readonly identityRevision: bigint;
  readonly connectionGeneration: number;
  readonly identity: RunnerIdentity | undefined;
  readonly readiness: ReadonlyMap<RunnerModuleName, RunnerModuleReadiness>;
};

export class PersonalRunnerObservations {
  readonly #byRunner = new Map<RunnerId, Observation>();
  readonly #database: Kysely<DatabaseSchema>;
  readonly #resources: PersonalResourceObservations;
  readonly #current: (id: RunnerId) => RunnerIdentity | undefined;
  readonly #moduleReadiness: Readiness;

  constructor(
    database: Kysely<DatabaseSchema>,
    resources: PersonalResourceObservations,
    current: (id: RunnerId) => RunnerIdentity | undefined,
    moduleReadiness: Readiness,
  ) {
    this.#database = database;
    this.#resources = resources;
    this.#current = current;
    this.#moduleReadiness = moduleReadiness;
  }

  publish(identity: RunnerIdentity, online: boolean, readinessOnly = false) {
    const id = identity.runnerId;
    const valid = () => {
      const current = this.#current(id);
      return online ? current?.connectionId === identity.connectionId : !current;
    };
    if (!valid()) return Promise.resolve();
    const kinds = readinessOnly ? (["machine", "environment", "tab"] as const) : runnerKinds;
    const finish = this.#resources.begin(kinds);
    return commitPersonalMutation(this.#database, async (tx, mutation) => {
      mutation.observation(finish);
      const runner = await tx
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", id)
        .where("connectionGeneration", "=", String(identity.connectionGeneration))
        .executeTakeFirst();
      if (!runner || (online && runner.revokedAt) || !valid()) return;
      const previous = this.#byRunner.get(id);
      if (readinessOnly && previous?.identity?.connectionId !== identity.connectionId) return;
      const readiness = new Map<RunnerModuleName, RunnerModuleReadiness>();
      if (online)
        for (const module of RunnerModuleNameSchema.options) {
          const status = this.#moduleReadiness(id, module);
          if (status !== undefined) readiness.set(module, status);
        }
      if (
        readinessOnly &&
        previous?.readiness.size === readiness.size &&
        [...readiness].every(([module, status]) => previous.readiness.get(module) === status)
      )
        return;

      for (const kind of kinds) mutation.bumpResource(kind);
      mutation.observation(() => {
        if (!valid()) return;
        const held = this.#byRunner.get(id);
        const revision = BigInt(mutation.sequence);
        if (
          held &&
          (held.connectionGeneration > identity.connectionGeneration || held.revision >= revision)
        )
          return;
        this.#byRunner.set(id, {
          revision,
          identityRevision: readinessOnly && held ? held.identityRevision : revision,
          connectionGeneration: identity.connectionGeneration,
          identity: online ? identity : undefined,
          readiness,
        });
      });
    }).finally(finish);
  }

  readRunner(
    id: RunnerId,
    revision: string,
    connectionGeneration: string,
    includeReadiness = false,
  ) {
    const observed = this.#byRunner.get(id);
    return observed?.identity &&
      (includeReadiness ? observed.revision : observed.identityRevision) <= BigInt(revision) &&
      String(observed.connectionGeneration) === connectionGeneration &&
      this.#current(id)?.connectionId === observed.identity.connectionId
      ? observed
      : undefined;
  }
}
