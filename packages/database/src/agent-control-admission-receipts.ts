import { OpensteerError } from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

export class AgentOperationReceipts {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  static async completeInTransaction(
    tx: Transaction<DatabaseSchema>,
    input: {
      readonly callerKey: string;
      readonly operationKey: string;
      readonly tool: string;
      readonly fingerprint: string;
      readonly result: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx
      .updateTable("agentToolOperations")
      .set({ result: jsonValue(input.result) })
      .where("key", "=", `${input.callerKey}:${input.operationKey}:${input.tool}`)
      .where("inputFingerprint", "=", input.fingerprint)
      .returning("key")
      .executeTakeFirstOrThrow();
  }
  async execute(input: {
    readonly callerKey: string;
    readonly operationKey: string;
    readonly tool: string;
    readonly fingerprint: string;
    readonly check: () => Promise<void>;
    readonly invoke: () => Promise<Record<string, unknown>>;
    readonly recover?: () => Promise<Record<string, unknown>>;
  }): Promise<Record<string, unknown>> {
    await input.check();
    const key = `${input.callerKey}:${input.operationKey}:${input.tool}`;
    const complete = async (result: Record<string, unknown>) => {
      await this.database
        .updateTable("agentToolOperations")
        .set({ result: jsonValue(result) })
        .where("key", "=", key)
        .executeTakeFirstOrThrow();
      return result;
    };
    const claimed = await this.database
      .insertInto("agentToolOperations")
      .values({ key, inputFingerprint: input.fingerprint, result: null })
      .onConflict((oc) => oc.column("key").doNothing())
      .returning("key")
      .executeTakeFirst();
    if (!claimed) {
      const receipt = await this.database
        .selectFrom("agentToolOperations")
        .selectAll()
        .where("key", "=", key)
        .executeTakeFirstOrThrow();
      if (receipt.inputFingerprint !== input.fingerprint)
        throw new OpensteerError({
          code: "conflict",
          message: "Operation key was already used with different input",
        });
      await input.check();
      if (receipt.result !== null) return receipt.result;
      // Only a domain with its own atomic idempotency receipt can recover an
      // unfinished outer receipt. Provider effects without one stay uncertain.
      if (input.recover) return complete(await input.recover());
      throw new OpensteerError({
        code: "conflict",
        message:
          "This operation is still in progress or its result is unconfirmed; it will not be executed twice",
        retryable: true,
      });
    }
    // Reservation commits before an effect. A crash or an uncertain provider
    // failure cannot turn a retry into a second external write.
    return complete(await input.invoke());
  }
}
