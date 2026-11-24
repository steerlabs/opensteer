import { createId, type ThreadId, type UserId } from "@opensteer/core";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { createDatabase } from "./connection.js";
import {
  connectionAttempts,
  markConnectionAttemptsContactLost,
  openCleanups,
  outstandingAttempts,
} from "./connection-disconnect.js";
import { migrateToLatest } from "./migrations.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { startPersonalQueuedRunFixture } from "./personal-run-fixture.test-support.js";
import { runContextLineage, threadContextLineage } from "./run-personal-context.js";
import { testReadyHarnessCatalog } from "./store.integration.test-support.js";
import { OpensteerStore } from "./store.js";
import { loadReleasedHome } from "./released-home.test-support.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";

/**
 * A Home at main's last migration (0046) that connected agents already worked in, brought to the
 * latest schema. Main recorded who wrote an input only in the input's own JSON (its author and
 * authority source); after the update the lineage walk reads `thread_inputs.connection_id`, so
 * every input a connected agent wrote must carry it there, whatever became of the input or of the
 * connection, and never as the person's own.
 */
let atMain: TestDatabase;
let clone: TestDatabase;
let database: ReturnType<typeof createDatabase>;
const model = '{"providerId":"openai","modelId":"fixture","options":{}}';

// One database at main's last migration, as main's own code made it; each case starts from its
// own copy of it.
beforeAll(async () => {
  atMain = await cloneTestDatabase("host");
  await loadReleasedHome(atMain.url);
});

afterAll(async () => {
  await atMain?.drop();
});

beforeEach(async () => {
  clone = await cloneTestDatabase("host", { fromSnapshotOf: atMain });
  database = createDatabase({ connectionString: clone.url });
});

afterEach(async () => {
  try {
    await database?.destroy();
  } finally {
    await clone?.drop();
  }
});

type Home = Awaited<ReturnType<typeof mainHome>>;
type InputState =
  | "pending"
  | "awaiting-approval"
  | "claimed"
  | "unknown"
  | "delivered"
  | "cancelled-after-run"
  | "cancelled-before-run";
type ConnectionFate = "live" | "revoked" | "gone";

/** The person's Home as main wrote it: one owner, a hosting computer and one engine. */
async function mainHome() {
  const owner = await seedPersonalFixture(database, "/tmp/connected-agent-lineage-fixture");
  const {
    rows: [principal],
  } = await sql<{ id: string }>`select id from principals where user_id = ${owner.userId}`.execute(
    database,
  );
  const harness = createId("harnessInstance");
  await sql`insert into harness_instances
    (id, environment_id, driver_kind, name, config, runtime_revision, state_kind, enabled, is_default, source_id)
    values (${harness}, ${owner.environmentId}, 'native', 'Fixture engine', '{}', 1, 'isolated', true, false, 'native')
  `.execute(database);
  return { ...owner, harness, principal: principal!.id };
}

async function mainTask(home: Home, title: string): Promise<ThreadId> {
  const thread = createId("thread");
  await sql`insert into threads
    (id, lineage_root_thread_id, purpose, listed, title, icon_source, color, environment_id,
     harness_instance_id, model_selection, created_by, created_by_principal_id)
    values (${thread}, ${thread}, 'task', true, ${title}, 'default', 'blue', ${home.environmentId},
            ${home.harness}, ${model}::jsonb, ${home.userId}, ${home.principal})
  `.execute(database);
  return thread;
}

/** A connection as main stored it; a gone one is named by inputs but has no row any more. */
async function mainConnection(userId: string, fate: ConnectionFate): Promise<string> {
  const id = `mcn_${crypto.randomUUID()}`;
  if (fate === "gone") return id;
  await sql`insert into agent_connections
    (id, user_id, label, client_name, access_mode, resource, token_hash, expires_at, revoked_at)
    values (${id}, ${userId}, 'Research agent', 'Research agent', 'auto', 'https://home.invalid/mcp',
      ${fate === "live" ? `synthetic-hash-${id}` : null}, now() + interval '1 day',
      ${fate === "revoked" ? new Date() : null})`.execute(database);
  return id;
}

const sequences = new Map<string, number>();

/** An input as main's writer stored it: the author and the authority source name the connection. */
async function mainInput(
  home: Home,
  thread: ThreadId,
  input: {
    readonly state: InputState;
    readonly connectionId?: string;
    readonly authorityUserId?: string;
    readonly runId?: string;
  },
) {
  const message = createId("message");
  const chain = createId("causalChain");
  const sequence = sequences.get(thread) ?? 0;
  sequences.set(thread, sequence + 1);
  const author = input.connectionId
    ? { kind: "connection", connectionId: input.connectionId, displayName: "Research agent" }
    : { kind: "human", displayName: "Alex", principalId: home.principal, userId: home.userId };
  const authority = input.connectionId
    ? {
        kind: "connection",
        connectionId: input.connectionId,
        userId: input.authorityUserId ?? home.userId,
      }
    : { kind: "user-session", userId: home.userId };
  const state = input.state.startsWith("cancelled") ? "cancelled" : input.state;
  const reachedRun = input.state !== "pending" && input.state !== "awaiting-approval";
  await sql`insert into causal_chains (id, max_delegations, max_autonomous_runs, used_delegations, used_autonomous_runs)
    values (${chain}, 100, 100, 0, 0)`.execute(database);
  await sql`insert into messages (id, thread_id, sequence, kind, actor_principal_id, author, content)
    values (${message}, ${thread}, ${sequence}, 'input', ${home.principal}, ${JSON.stringify(author)}::jsonb,
      '[{"type":"text","text":"Compare the two budgets"}]')`.execute(database);
  await sql`insert into thread_inputs
    (message_id, thread_id, actor_principal_id, authority_source, causal_chain_id, idempotency_key,
      policy, queue_rank, request_fingerprint, requested_by, state, delivered_at, cancel_reason)
    values (${message}, ${thread}, ${home.principal}, ${JSON.stringify(authority)}::jsonb, ${chain},
      ${`input-${message}`}, 'queue', ${sequence}, 'fixture', ${home.userId}, ${state},
      ${input.state === "delivered" ? new Date() : null},
      ${state === "cancelled" ? "fixture" : null})`.execute(database);
  // As main's writer does, the task's next message number moves past this one.
  await sql`update threads set next_message_sequence = ${sequence + 1} where id = ${thread}`.execute(
    database,
  );
  let runId = input.runId ?? null;
  if (reachedRun && input.state !== "cancelled-before-run" && !runId) {
    runId = await mainRun(home, thread, message, chain, authority, "completed");
  }
  if (runId)
    await sql`update thread_inputs set run_id = ${runId} where message_id = ${message}`.execute(
      database,
    );
  return { message, chain, authority, runId };
}

let ordinal = 0;
async function mainRun(
  home: Home,
  thread: ThreadId,
  seed: string,
  chain: string,
  authority: object,
  status: "queued" | "running" | "completed",
) {
  const run = createId("run");
  await sql`insert into runs
    (id, thread_id, environment_id, harness_instance_id, model_selection, access_mode, requested_by,
     actor_principal_id, authority_source, run_ordinal, status, activation_input_id, seed_input_id,
     causal_chain_id, binding_generation, started_at, completed_at)
    values (${run}, ${thread}, ${home.environmentId}, ${home.harness}, ${model}::jsonb, 'auto',
      ${home.userId}, ${home.principal}, ${JSON.stringify(authority)}::jsonb, ${ordinal++}, ${status},
      ${seed}, ${seed}, ${chain}, ${status === "queued" ? null : 1},
      ${status === "queued" ? null : new Date()}, ${status === "completed" ? new Date() : null})
  `.execute(database);
  await sql`update threads set next_run_ordinal = ${ordinal} where id = ${thread}`.execute(
    database,
  );
  return run;
}

const lineageOf = async (home: Home, thread: ThreadId) =>
  (await threadContextLineage(database, thread, home.userId as UserId)).personLineage;

const inputConnection = async (message: string) =>
  (
    await database
      .selectFrom("threadInputs")
      .select("connectionId")
      .where("messageId", "=", message as never)
      .executeTakeFirstOrThrow()
  ).connectionId;

const states: readonly InputState[] = [
  "pending",
  "awaiting-approval",
  "claimed",
  "unknown",
  "delivered",
  "cancelled-after-run",
];
const fates: readonly ConnectionFate[] = ["live", "revoked", "gone"];

describe("a connected agent's work from before the update", () => {
  it("keeps the delivered author of a pre-release connected-agent input in task lineage", async () => {
    const home = await mainHome();
    const thread = await mainTask(home, "Budget planning");
    const connection = await mainConnection(home.userId, "live");
    const written = await mainInput(home, thread, { state: "delivered", connectionId: connection });
    await migrateToLatest(database);
    expect(
      await lineageOf(home, thread),
      "delivered connected-agent input should narrow task lineage",
    ).toBe(false);
    expect(await inputConnection(written.message)).toBe(connection);
  });

  it("narrows every task a connected agent wrote into, whatever became of the input or the connection", async () => {
    const home = await mainHome();
    const cases: {
      state: InputState;
      fate: ConnectionFate;
      connection: string;
      thread: ThreadId;
      message: string;
    }[] = [];
    for (const fate of fates)
      for (const state of states) {
        const connection = await mainConnection(home.userId, fate);
        const thread = await mainTask(home, `${state} / ${fate}`);
        const written = await mainInput(home, thread, { state, connectionId: connection });
        cases.push({ state, fate, connection, thread, message: written.message });
      }
    // Never reached a Run: the walk ignores it, so the task stays the person's own.
    const unreached = await mainConnection(home.userId, "live");
    const unreachedThread = await mainTask(home, "cancelled before a Run");
    const unreachedInput = await mainInput(home, unreachedThread, {
      state: "cancelled-before-run",
      connectionId: unreached,
    });
    // Only the person ever wrote into it: no false narrowing.
    const ownThread = await mainTask(home, "the person's own");
    const own = await mainInput(home, ownThread, { state: "delivered" });
    const before = await database.selectFrom("agentConnections").select("id").execute();

    await migrateToLatest(database);

    const after = await database
      .selectFrom("agentConnections")
      .select(["id", "userId", "revokedAt", "removedAt", "tokenHash", "grant", "accessMode"])
      .select(["cleanupReason", "cleanupRequestedAt", "cleanupCompletedAt", "bridgeSenders"])
      .execute();
    const carriers = after.filter(({ id }) => !before.some((row) => row.id === id));
    // Connections that are gone are carried by one ended, hidden connection of the owner's.
    expect(carriers).toHaveLength(1);
    const [carrier] = carriers;
    expect(carrier).toMatchObject({
      userId: home.userId,
      tokenHash: null,
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
      cleanupReason: "revoked",
      cleanupCompletedAt: null,
      bridgeSenders: null,
    });
    expect(carrier!.revokedAt).not.toBeNull();
    expect(carrier!.removedAt).not.toBeNull();
    expect(carrier!.cleanupRequestedAt).not.toBeNull();
    expect(await openCleanups(database)).toContain(carrier!.id);

    for (const entry of cases) {
      const label = `${entry.state} input of a ${entry.fate} connection`;
      expect(await lineageOf(home, entry.thread), `${label} should narrow task lineage`).toBe(
        false,
      );
      expect(await inputConnection(entry.message), `${label} keeps its writer`).toBe(
        entry.fate === "gone" ? carrier!.id : entry.connection,
      );
    }
    expect(await lineageOf(home, unreachedThread)).toBe(true);
    expect(await inputConnection(unreachedInput.message)).toBeNull();
    expect(await lineageOf(home, ownThread)).toBe(true);
    expect(await inputConnection(own.message)).toBeNull();
    // Nothing old became anyone's: no task or automation gained an origin, no connection a grant.
    expect(
      await database
        .selectFrom("threads")
        .select("id")
        .where("originConnectionId", "is not", null)
        .execute(),
    ).toEqual([]);
    expect(
      after
        .filter(({ id }) => id !== carrier!.id)
        .every(({ grant, accessMode }) => grant.scope === "everything" && accessMode === "auto"),
    ).toBe(true);
  });

  it("keeps a task narrowed after the owner wrote into it again, and its next Run neither reuses an own session nor gets the owner's configuration", async () => {
    const home = await mainHome();
    const thread = await mainTask(home, "Trip planning");
    const connection = await mainConnection(home.userId, "live");
    const written = await mainInput(home, thread, { state: "delivered", connectionId: connection });
    const ownLater = await mainInput(home, thread, { state: "delivered" });
    // The engine conversation both Runs used before the update.
    const session = createId("providerSession");
    await sql`insert into provider_sessions
      (id, thread_id, harness_instance_id, active, state_layout, provider_session_reference,
       binding_generation, status)
      values (${session}, ${thread}, ${home.harness}, true, 'session', 'native:old-conversation', 1, 'ready')
    `.execute(database);
    await sql`update runs set provider_session_id = ${session}
      where id in (${written.runId}, ${ownLater.runId})`.execute(database);

    await migrateToLatest(database);

    // 0115 marks every existing session as possibly having loaded the person's configuration.
    expect(
      await database
        .selectFrom("providerSessions")
        .select("personLineage")
        .where("id", "=", session as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personLineage: true });
    expect(await lineageOf(home, thread)).toBe(false);

    const store = new OpensteerStore(database);
    await store.recordHarnessCatalogs({
      environmentId: home.environmentId,
      catalogs: [testReadyHarnessCatalog(home.harness as never)],
      expectedRevisions: new Map([[home.harness as never, 1]]),
    });
    // The owner types the next message.
    const next = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Now book the cheaper one" }],
      idempotencyKey: "owner-next",
      policy: "queue",
      requestedBy: home.userId as UserId,
      source: { kind: "human" },
      threadId: thread,
    });
    if (!next.run) throw new Error("Expected the owner's next Run");
    const run = await database
      .selectFrom("runs")
      .select(["connectionId", "providerSessionId"])
      .where("id", "=", next.run.id)
      .executeTakeFirstOrThrow();
    // The owner's own message runs as the owner: no connection, grant or mode is given to it.
    expect(run.connectionId).toBeNull();
    // It does not resume the conversation made under the person's own configuration ...
    expect(run.providerSessionId).not.toBe(session);
    expect(
      await database
        .selectFrom("providerSessions")
        .select(["id", "active", "personLineage"])
        .where("threadId", "=", thread)
        .orderBy("active")
        .execute(),
    ).toEqual([
      { id: session, active: false, personLineage: true },
      { id: run.providerSessionId, active: true, personLineage: false },
    ]);
    // ... and the Runner is told it is not the person's own, so the engine starts without it.
    expect((await runContextLineage(database, next.run.id)).personLineage).toBe(false);
    if (!next.command) throw new Error("Expected the owner's next Run to be dispatched");
    await startPersonalQueuedRunFixture(store, next.run.id);
    const dispatched = await store.loadRunDispatchContext(next.command.id);
    expect(dispatched.lineage.personLineage).toBe(false);
    expect(dispatched.personalContext).toBe(true);
  });

  it("binds an unfinished Run and its attempt to the connection so Disconnect finds them", async () => {
    const home = await mainHome();
    const bound: { fate: ConnectionFate; connection: string; run: string; attempt: string }[] = [];
    for (const fate of fates) {
      const connection = await mainConnection(home.userId, fate);
      const thread = await mainTask(home, `running for a ${fate} connection`);
      const seed = await mainInput(home, thread, {
        state: "claimed",
        connectionId: connection,
      });
      const run = seed.runId!;
      await sql`update runs set status = 'running', completed_at = null where id = ${run}`.execute(
        database,
      );
      const attempt = createId("runAttempt");
      await sql`insert into run_attempts
        (id, run_id, ordinal, reason, status, binding_generation, runner_id, runner_boot_id,
         dispatched_at, first_event_at)
        values (${attempt}, ${run}, 0, 'initial', 'current', 1, ${home.runnerId}, 'boot-before-update',
          now(), now())`.execute(database);
      bound.push({ fate, connection, run, attempt });
    }
    // The person's own Run on its own task is never bound.
    const ownThread = await mainTask(home, "own and running");
    const ownSeed = await mainInput(home, ownThread, { state: "claimed" });
    await sql`update runs set status = 'running', completed_at = null where id = ${ownSeed.runId}`.execute(
      database,
    );

    await migrateToLatest(database);

    const carrier = (await openCleanups(database))[0]!;
    for (const entry of bound) {
      const writer = entry.fate === "gone" ? carrier : entry.connection;
      expect(
        await database
          .selectFrom("runs")
          .select("connectionId")
          .where("id", "=", entry.run as never)
          .executeTakeFirstOrThrow(),
        `${entry.fate} connection's Run`,
      ).toEqual({ connectionId: writer });
      expect(
        await database
          .selectFrom("runAttempts")
          .select("connectionId")
          .where("id", "=", entry.attempt as never)
          .executeTakeFirstOrThrow(),
        `${entry.fate} connection's attempt`,
      ).toEqual({ connectionId: writer });
    }
    expect(
      await database
        .selectFrom("runs")
        .select("connectionId")
        .where("id", "=", ownSeed.runId! as never)
        .executeTakeFirstOrThrow(),
    ).toEqual({ connectionId: null });

    // Disconnect of the live connection waits on its old Run's attempt.
    const live = bound.find(({ fate }) => fate === "live")!;
    await new AgentConnectionStore(database).revoke(home.userId as UserId, live.connection);
    const held = async (connectionId: string) =>
      outstandingAttempts(await connectionAttempts(database, connectionId))
        .filter(({ kind }) => kind === "run-attempt")
        .map(({ id }) => id);
    expect(await held(live.connection)).toEqual([live.attempt]);
    // The carrier's cleanup, already open, waits on the gone connection's attempt.
    const gone = bound.find(({ fate }) => fate === "gone")!;
    expect(await held(carrier)).toEqual([gone.attempt]);
    // An attempt that names its connection is recorded as contact lost with its Runner's old
    // boot, which counts as its end for the connection.
    await markConnectionAttemptsContactLost(database, {
      runnerId: home.runnerId as never,
      runnerBootId: "boot-before-update",
    });
    const lost = async (connectionId: string) =>
      (await connectionAttempts(database, connectionId))
        .filter(({ kind }) => kind === "run-attempt")
        .map(({ id, contactLostAt }) => ({ id, lost: contactLostAt !== null }));
    expect(await lost(live.connection)).toEqual([{ id: live.attempt, lost: true }]);
    expect(await lost(carrier)).toEqual([{ id: gone.attempt, lost: true }]);
  });

  it("does not trust a stored connection that belongs to someone else", async () => {
    const home = await mainHome();
    const stranger = createId("user");
    await sql`insert into users (id, display_name, email, email_verified)
      values (${stranger}, 'Sam', 'sam@example.invalid', true)`.execute(database);
    const theirs = await mainConnection(stranger, "live");
    const thread = await mainTask(home, "Written by another's connection");
    const written = await mainInput(home, thread, { state: "delivered", connectionId: theirs });
    // Main's writer names the owner in the authority source; one naming another is not trusted.
    const mine = await mainConnection(home.userId, "live");
    const misnamed = await mainTask(home, "Authority names another person");
    const misnamedInput = await mainInput(home, misnamed, {
      state: "delivered",
      connectionId: mine,
      authorityUserId: stranger,
    });

    await migrateToLatest(database);

    const carrier = (
      await database
        .selectFrom("agentConnections")
        .select("id")
        .where("userId", "=", home.userId as UserId)
        .where("removedAt", "is not", null)
        .executeTakeFirstOrThrow()
    ).id;
    expect(await inputConnection(written.message)).toBe(carrier);
    expect(await inputConnection(misnamedInput.message)).toBe(carrier);
    expect(await lineageOf(home, thread)).toBe(false);
    expect(await lineageOf(home, misnamed)).toBe(false);
    // The stranger's connection holds nothing of the owner's.
    expect(
      await database
        .selectFrom("threadInputs")
        .select("messageId")
        .where("connectionId", "=", theirs)
        .execute(),
    ).toEqual([]);
  });
});
