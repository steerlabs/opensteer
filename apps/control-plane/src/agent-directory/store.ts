import {
  AgentDirectoryDocumentSchema,
  AgentDirectoryEntryIdSchema,
  AgentDirectoryEntrySchema,
  agentDirectoryJwtTyp,
  agentDirectoryTokenUse,
  maximumAgentDirectoryEnvelopeBytes,
  type AgentDirectoryDocument,
  type AgentDirectoryEntry,
  type AgentDirectoryEntryId,
} from "@opensteer/control-plane-protocol";
import type { Kysely, Transaction } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { ControlPlaneError } from "../server/errors.js";

type Database = Kysely<ControlPlaneDatabaseSchema>;
type TransactionDb = Transaction<ControlPlaneDatabaseSchema>;

export interface AgentDirectorySnapshot {
  readonly revision: number;
  readonly entries: readonly AgentDirectoryEntry[];
}

export interface AgentDirectoryReader {
  document(): Promise<AgentDirectoryDocument>;
}

/**
 * Pure transition for directory mutations: validates entry schema, uniqueness and a monotonic
 * revision bump before anything touches storage.
 */
export function applyAgentDirectoryChange(
  current: AgentDirectorySnapshot,
  change:
    | { readonly kind: "add"; readonly input: unknown }
    | { readonly kind: "update"; readonly id: string; readonly input: unknown }
    | { readonly kind: "remove"; readonly id: string },
  now: Date,
): {
  readonly revision: number;
  readonly entries: readonly AgentDirectoryEntry[];
  readonly entry?: AgentDirectoryEntry;
} {
  const nextRevision = current.revision + 1;
  const byId = new Map(current.entries.map((entry) => [entry.id, entry] as const));

  let changedEntry: AgentDirectoryEntry | undefined;
  if (change.kind === "add") {
    const parsed = AgentDirectoryEntrySchema.safeParse(change.input);
    if (!parsed.success) {
      throw new ControlPlaneError(
        "bad_request",
        parsed.error.issues[0]?.message ?? "Invalid agent directory entry",
      );
    }
    if (byId.has(parsed.data.id)) {
      throw new ControlPlaneError(
        "conflict",
        `Agent directory entry ${parsed.data.id} already exists`,
      );
    }
    byId.set(parsed.data.id, parsed.data);
    changedEntry = parsed.data;
  } else if (change.kind === "update") {
    const idParsed = AgentDirectoryEntryIdSchema.safeParse(change.id);
    if (!idParsed.success) {
      throw new ControlPlaneError("bad_request", "Invalid agent directory entry ID");
    }
    const id = idParsed.data;
    if (!byId.has(id)) {
      throw new ControlPlaneError("not_found", `Agent directory entry ${id} was not found`);
    }
    const raw =
      typeof change.input === "object" && change.input !== null && !Array.isArray(change.input)
        ? { ...(change.input as Record<string, unknown>), id }
        : change.input;
    if (
      typeof change.input === "object" &&
      change.input !== null &&
      "id" in change.input &&
      (change.input as { id?: unknown }).id !== id
    ) {
      throw new ControlPlaneError("bad_request", "Entry ID in JSON does not match target ID");
    }
    const parsed = AgentDirectoryEntrySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ControlPlaneError(
        "bad_request",
        parsed.error.issues[0]?.message ?? "Invalid agent directory entry",
      );
    }
    byId.set(id, parsed.data);
    changedEntry = parsed.data;
  } else {
    const idParsed = AgentDirectoryEntryIdSchema.safeParse(change.id);
    if (!idParsed.success) {
      throw new ControlPlaneError("bad_request", "Invalid agent directory entry ID");
    }
    const id = idParsed.data;
    if (!byId.has(id)) {
      throw new ControlPlaneError("not_found", `Agent directory entry ${id} was not found`);
    }
    byId.delete(id);
  }

  const nextEntries = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  const validated = AgentDirectoryDocumentSchema.safeParse({
    revision: nextRevision,
    issuedAt: now.toISOString(),
    entries: nextEntries,
  });
  if (!validated.success) {
    const message = validated.error.issues[0]?.message ?? "Invalid agent directory state";
    throw new ControlPlaneError(
      message.startsWith("Duplicate ") ? "conflict" : "bad_request",
      message,
    );
  }
  if (maximumEnvelopeSize(validated.data) > maximumAgentDirectoryEnvelopeBytes) {
    throw new ControlPlaneError(
      "bad_request",
      "Signed agent directory would exceed its byte limit",
    );
  }
  return {
    revision: validated.data.revision,
    entries: validated.data.entries,
    ...(changedEntry ? { entry: changedEntry } : {}),
  };
}

function maximumEnvelopeSize(document: AgentDirectoryDocument): number {
  const claims = {
    ...document,
    tokenUse: agentDirectoryTokenUse,
    iss: "x".repeat(256),
    iat: Number.MAX_SAFE_INTEGER,
  };
  // Allow for a 256-character key ID with every character needing JSON escaping.
  const headerBytes =
    JSON.stringify({ alg: "EdDSA", kid: "", typ: agentDirectoryJwtTyp }).length + 6 * 256;
  const encodedLength = (bytes: number) => Math.ceil((bytes * 4) / 3);
  return (
    encodedLength(headerBytes) +
    encodedLength(Buffer.byteLength(JSON.stringify(claims))) +
    encodedLength(64) +
    2 +
    JSON.stringify({ assertion: "" }).length
  );
}

export class AgentDirectoryStore implements AgentDirectoryReader {
  readonly #db: Database;
  readonly #now: () => Date;

  constructor(database: Database, options: { readonly now?: () => Date } = {}) {
    this.#db = database;
    this.#now = options.now ?? (() => new Date());
  }

  async document(): Promise<AgentDirectoryDocument> {
    return this.#db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        const snapshot = await this.#readSnapshot(tx, false);
        return AgentDirectoryDocumentSchema.parse({
          revision: snapshot.revision,
          issuedAt: this.#now().toISOString(),
          entries: snapshot.entries,
        });
      });
  }

  async list(): Promise<AgentDirectorySnapshot> {
    return this.#db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => this.#readSnapshot(tx, false));
  }

  async add(
    input: unknown,
  ): Promise<{ readonly revision: number; readonly entry: AgentDirectoryEntry }> {
    return this.#db.transaction().execute(async (tx) => {
      const now = this.#now();
      const current = await this.#readSnapshot(tx, true);
      const next = applyAgentDirectoryChange(current, { kind: "add", input }, now);
      const entry = next.entry!;
      await tx
        .insertInto("agentDirectoryEntries")
        .values({
          id: entry.id,
          displayName: entry.displayName,
          origins: JSON.stringify(entry.origins),
          createdAt: now,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await this.#bumpRevision(tx, next.revision, now);
      return { revision: next.revision, entry };
    });
  }

  async update(
    id: string,
    input: unknown,
  ): Promise<{ readonly revision: number; readonly entry: AgentDirectoryEntry }> {
    return this.#db.transaction().execute(async (tx) => {
      const now = this.#now();
      const current = await this.#readSnapshot(tx, true);
      const next = applyAgentDirectoryChange(current, { kind: "update", id, input }, now);
      const entry = next.entry!;
      await tx
        .updateTable("agentDirectoryEntries")
        .set({
          displayName: entry.displayName,
          origins: JSON.stringify(entry.origins),
          updatedAt: now,
        })
        .where("id", "=", entry.id)
        .executeTakeFirstOrThrow();
      await this.#bumpRevision(tx, next.revision, now);
      return { revision: next.revision, entry };
    });
  }

  async remove(id: string): Promise<{ readonly revision: number; readonly removed: true }> {
    return this.#db.transaction().execute(async (tx) => {
      const now = this.#now();
      const current = await this.#readSnapshot(tx, true);
      const next = applyAgentDirectoryChange(current, { kind: "remove", id }, now);
      await tx
        .deleteFrom("agentDirectoryEntries")
        .where("id", "=", id as AgentDirectoryEntryId)
        .executeTakeFirstOrThrow();
      await this.#bumpRevision(tx, next.revision, now);
      return { revision: next.revision, removed: true };
    });
  }

  async #readSnapshot(tx: TransactionDb, lock: boolean): Promise<AgentDirectorySnapshot> {
    let stateQuery = tx.selectFrom("agentDirectoryState").select(["revision"]).where("id", "=", 1);
    if (lock) stateQuery = stateQuery.forNoKeyUpdate();
    const state = await stateQuery.executeTakeFirst();
    if (!state) {
      throw new ControlPlaneError("internal", "Agent directory state row is missing");
    }
    const rows = await tx
      .selectFrom("agentDirectoryEntries")
      .select(["id", "displayName", "origins"])
      .orderBy("id")
      .execute();
    const entries = rows.map((row) =>
      AgentDirectoryEntrySchema.parse({
        id: row.id,
        displayName: row.displayName,
        origins: row.origins,
      }),
    );
    return { revision: state.revision, entries };
  }

  async #bumpRevision(tx: TransactionDb, revision: number, now: Date): Promise<void> {
    await tx
      .updateTable("agentDirectoryState")
      .set({ revision, updatedAt: now })
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
  }
}
