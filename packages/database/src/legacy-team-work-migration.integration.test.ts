import {
  createId,
  ReplyTargetSchema,
  ThreadInputStateSchema,
  threadInputDelivery,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { recoverThreadWorkQueues } from "./execution-recovery.js";
import { replayMigrations } from "./migration-replay.test-support.js";
import { migrateToLatest, migrationProvider } from "./migrations.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { emptyPersonalResourceRevisions } from "./personal-state-schema.js";
import { readTranscriptItem } from "./personal-sync-store.js";
import { createRunFinishDrain } from "./run-finalization.js";
import type { DatabaseSchema } from "./schema.js";
import { cloneTestDatabase, type TestDatabase } from "./test-database.test-support.js";

/**
 * A personal Home at main's schema that did Team work: Runs and inputs that answered a teammate's
 * request carry `reply_target.kind = 'team-thread'`, and a teammate's ask can still wait for its
 * owner in `awaiting-approval`. The update must carry all of it forward to values this release
 * reads, settle what never started, keep what ran, and start.
 */

let clone: TestDatabase;
let database: Kysely<DatabaseSchema>;
const model = '{"providerId":"openai","modelId":"fixture","options":{}}';
const links = { threadUrl: (id: ThreadId) => `/tasks/${id}` };
const ended = threadInputDelivery({
  cancelReason: "team-work-ended",
  policy: "queue",
  state: "cancelled",
});

beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  database = createDatabase({ connectionString: clone.url });
  await sql`drop schema public cascade; create schema public`.execute(database);
});

afterEach(async () => {
  try {
    await database?.destroy();
  } finally {
    await clone?.drop();
  }
});

/** Main's last migration, by the real migrator; nothing of this release's own has run. */
async function migrateToMain() {
  const all = await migrationProvider().getMigrations();
  const main = Object.fromEntries(
    Object.entries(all).filter(([name]) => name <= "0046_run_provider_retry"),
  );
  await migrateToLatest(database, { getMigrations: async () => main });
}

/** Main before its current-state conversion (0038): the update crosses it. */
async function migrateToBeforeConversion() {
  await migrateToLatest(database, migrationProvider({ personalCurrentState: false }));
}

type Home = Awaited<ReturnType<typeof seedHome>>;

async function seedHome() {
  const owner = await seedPersonalFixture(database, "/tmp/legacy-team-work-fixture");
  const harness = createId("harnessInstance");
  const {
    rows: [principal],
  } = await sql<{ id: string }>`
    select id from principals where user_id = ${owner.userId}
  `.execute(database);
  await sql`insert into harness_instances
    (id, environment_id, driver_kind, name, config, runtime_revision, state_kind, enabled, is_default, source_id)
    values (${harness}, ${owner.environmentId}, 'codex', 'Codex', '{}', 1, 'ready', true, true, 'native')
  `.execute(database);
  return { ...owner, harness, principal: principal!.id, team: createId("deployment") };
}

async function task(home: Home, title: string): Promise<ThreadId> {
  const thread = createId("thread");
  await sql`insert into threads
    (id, lineage_root_thread_id, purpose, listed, title, icon_source, color, environment_id,
     harness_instance_id, model_selection, created_by, created_by_principal_id)
    values (${thread}, ${thread}, 'task', true, ${title}, 'default', 'blue', ${home.environmentId},
            ${home.harness}, ${model}::jsonb, ${home.userId}, ${home.principal})
  `.execute(database);
  return thread;
}

interface Input {
  readonly thread: ThreadId;
  readonly sequence: number;
  readonly text: string;
  readonly state: string;
  /** A teammate's request, as main wrote it: its id, its source, its reply target. */
  readonly team: boolean;
  readonly runId?: RunId;
  readonly cancelReason?: string;
}

async function input(home: Home, spec: Input) {
  const message = createId("message");
  const chain = createId("causalChain");
  const request = createId("teamAgentRequest");
  const channelId = createId("teamChannel");
  const target = spec.team
    ? JSON.stringify({
        kind: "team-thread",
        teamId: home.team,
        channelId,
        threadRootId: "1",
        requestId: request,
      })
    : null;
  const source = spec.team
    ? JSON.stringify({
        teamId: home.team,
        channelId,
        threadRootId: "1",
        messageId: "2",
        audience: {
          teamName: "Design",
          channelName: "launch",
          channelKind: "public",
          memberCount: 3,
          peopleOnly: false,
        },
      })
    : null;
  const authority = spec.team
    ? JSON.stringify({ kind: "team-request", teamId: home.team, requestId: request })
    : JSON.stringify({ kind: "user-session", userId: home.userId });
  const author = spec.team
    ? JSON.stringify({
        kind: "team-member",
        actor: "human",
        teamId: home.team,
        teamUserId: createId("user"),
        displayName: "Sam",
      })
    : JSON.stringify({
        kind: "human",
        userId: home.userId,
        principalId: home.principal,
        displayName: "Alex",
      });
  await sql`insert into causal_chains (id, max_delegations, max_autonomous_runs, used_delegations, used_autonomous_runs)
    values (${chain}, 100, 100, 0, 0)`.execute(database);
  await sql`insert into messages (id, thread_id, sequence, kind, actor_principal_id, author, content)
    values (${message}, ${spec.thread}, ${spec.sequence}, 'input', ${home.principal}, ${author}::jsonb,
      ${JSON.stringify([{ type: "text", text: spec.text }])}::jsonb)`.execute(database);
  await sql`insert into thread_inputs
    (message_id, thread_id, actor_principal_id, authority_source, causal_chain_id, idempotency_key,
      policy, queue_rank, request_fingerprint, requested_by, state, delivered_at, cancel_reason,
      team_request_id, team_source, reply_target)
    values (${message}, ${spec.thread}, ${home.principal}, ${authority}::jsonb, ${chain},
      ${`fixture:${message}`}, 'queue', ${spec.sequence}, 'fixture', ${home.userId}, ${spec.state},
      ${spec.state === "delivered" ? sql`now()` : null}, ${spec.cancelReason ?? null},
      ${spec.team ? request : null}, ${source}::jsonb, ${target}::jsonb)`.execute(database);
  return { message, chain, target };
}

async function run(
  home: Home,
  spec: {
    readonly thread: ThreadId;
    readonly seed: {
      readonly message: MessageId;
      readonly chain: string;
      readonly target: string | null;
    };
    readonly status: string;
    readonly ordinal?: number;
    readonly finishIntent?: Record<string, unknown>;
  },
): Promise<RunId> {
  const id = createId("run");
  const intent = spec.finishIntent ? JSON.stringify(spec.finishIntent) : null;
  await sql`insert into runs
    (id, thread_id, environment_id, harness_instance_id, model_selection, access_mode, requested_by,
     actor_principal_id, authority_source, run_ordinal, status, reply_target,
     activation_input_id, seed_input_id, causal_chain_id)
    values (${id}, ${spec.thread}, ${home.environmentId}, ${home.harness}, ${model}::jsonb,
      'approval-required', ${home.userId}, ${home.principal}, '{}', ${spec.ordinal ?? 0}, ${spec.status},
      ${spec.seed.target}::jsonb, ${spec.seed.message}, ${spec.seed.message}, ${spec.seed.chain})`.execute(
    database,
  );
  await sql`update threads set next_run_ordinal = greatest(next_run_ordinal, ${(spec.ordinal ?? 0) + 1})
    where id = ${spec.thread}`.execute(database);
  if (intent)
    await sql`update runs set finish_intent = ${intent}::jsonb where id = ${id}`.execute(database);
  return id;
}

/** A transcript card as the current-state projection kept it. */
async function card(thread: ThreadId, message: MessageId, position: number | null) {
  await sql`insert into transcript_items
    (id, thread_id, kind, position, revision, visible, is_turn_start, created_at, message_id, view)
    values (${message}, ${thread}, 'message', ${position}, 0, ${position !== null},
      ${position !== null}, now(), ${message},
      '{"author":"team-member","messageKind":"input","edited":false,"published":false,"preview":"fixture"}')`.execute(
    database,
  );
  if (position !== null)
    await sql`update threads set next_transcript_position = greatest(next_transcript_position, ${position})
      where id = ${thread}`.execute(database);
}

async function inputRow(message: MessageId) {
  return database
    .selectFrom("threadInputs")
    .select(["state", "cancelReason", "replyTarget", "runId"])
    .where("messageId", "=", message)
    .executeTakeFirstOrThrow();
}

async function runRow(id: RunId) {
  return database
    .selectFrom("runs")
    .select(["status", "replyTarget", "finishIntent"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

/** Nothing stored after the update carries a value this release cannot read. */
async function expectEverythingReadable() {
  const targets = await sql<{ target: unknown }>`
    select reply_target as target from runs where reply_target is not null
    union all select reply_target from thread_inputs where reply_target is not null
    union all select reply_target from delegations where reply_target is not null`.execute(
    database,
  );
  for (const { target } of targets.rows) ReplyTargetSchema.parse(target);
  const states = await sql<{ state: string }>`select distinct state from thread_inputs`.execute(
    database,
  );
  for (const { state } of states.rows) ThreadInputStateSchema.parse(state);
}

/** The person's own read of a card: what their task shows for that message. */
async function expectCardSaysWhy(home: Home, thread: ThreadId, message: MessageId) {
  const read = await readTranscriptItem(database, {
    viewerId: home.userId,
    scope: { kind: "thread", threadId: thread },
    itemId: message,
  });
  expect(read).toMatchObject({ kind: "item", item: { messageId: message, delivery: ended } });
}

/** What start-up does with this work: the queues' recovery, then one pass of the finish drain. */
async function startUp() {
  const errors: unknown[] = [];
  await recoverThreadWorkQueues(database);
  const drain = createRunFinishDrain(database, links, {
    now: () => Date.now(),
    onError: (error) => errors.push(error),
  });
  const retryAt = await drain();
  return { errors, retryAt };
}

describe("a ready Home at main's last migration that did Team work", () => {
  it("settles its Team work on the update and starts without a retry", async () => {
    await migrateToMain();
    const home = await seedHome();

    // A Team Run that was finishing at shutdown: its finish intent is committed.
    const finishingTask = await task(home, "Team status update");
    const finishingSeed = await input(home, {
      thread: finishingTask,
      sequence: 0,
      text: "Write a brief status update for the team",
      state: "delivered",
      team: true,
    });
    const finishing = await run(home, {
      thread: finishingTask,
      seed: finishingSeed,
      status: "running",
      finishIntent: {
        attemptId: null,
        bindingGeneration: null,
        mode: "host",
        outcome: "interrupted",
        completedAt: new Date().toISOString(),
        replyMessageId: null,
        queuedInputCancellation: "seed-input",
      },
    });
    await sql`update thread_inputs set run_id = ${finishing} where message_id = ${finishingSeed.message}`.execute(
      database,
    );

    // A Team Run still running: the person's computer keeps doing it.
    const runningTask = await task(home, "Team research");
    const runningSeed = await input(home, {
      thread: runningTask,
      sequence: 0,
      text: "Collect the release notes",
      state: "delivered",
      team: true,
    });
    const running = await run(home, { thread: runningTask, seed: runningSeed, status: "running" });
    await sql`update thread_inputs set run_id = ${running} where message_id = ${runningSeed.message}`.execute(
      database,
    );

    // A Team seed admitted to a queued Run that never started.
    const queuedTask = await task(home, "Team follow-up");
    const queuedSeed = await input(home, {
      thread: queuedTask,
      sequence: 0,
      text: "Draft the follow-up email",
      state: "pending",
      team: true,
    });
    const queued = await run(home, { thread: queuedTask, seed: queuedSeed, status: "queued" });
    await card(queuedTask, queuedSeed.message, 1);

    // A teammate's ask still waiting for its owner, counted in the task's pending count.
    const askTask = await task(home, "Team ask");
    const ask = await input(home, {
      thread: askTask,
      sequence: 0,
      text: "Can your agent review my pull request?",
      state: "awaiting-approval",
      team: true,
    });
    await card(askTask, ask.message, null);
    await sql`update threads set pending_request_count = 1 where id = ${askTask}`.execute(database);

    // A Team input cancelled before the update.
    const cancelledTask = await task(home, "Team cancelled");
    const cancelled = await input(home, {
      thread: cancelledTask,
      sequence: 0,
      text: "Never mind",
      state: "cancelled",
      cancelReason: "team-request-cancelled",
      team: true,
    });

    // The person's own work beside it, which the update leaves exactly as it was.
    const ownTask = await task(home, "My own work");
    const ownSeed = await input(home, {
      thread: ownTask,
      sequence: 0,
      text: "Tidy my downloads folder",
      state: "delivered",
      team: false,
    });
    const own = await run(home, { thread: ownTask, seed: ownSeed, status: "running" });
    await sql`update thread_inputs set run_id = ${own} where message_id = ${ownSeed.message}`.execute(
      database,
    );
    const ownWaiting = await input(home, {
      thread: ownTask,
      sequence: 1,
      text: "Then empty the trash",
      state: "pending",
      team: false,
    });

    await migrateToLatest(database);
    const started = await startUp();
    expect(started.errors).toEqual([]);
    expect(started.retryAt).toBeNull();
    await expectEverythingReadable();

    // Finishing: its outcome stands; only its delivery to the team ended.
    expect(await runRow(finishing)).toEqual({
      status: "interrupted",
      replyTarget: null,
      finishIntent: null,
    });
    expect(await inputRow(finishingSeed.message)).toMatchObject({
      state: "delivered",
      replyTarget: null,
    });

    // Running: untouched, but answers only the person now.
    expect(await runRow(running)).toEqual({
      status: "running",
      replyTarget: null,
      finishIntent: null,
    });
    expect(await inputRow(runningSeed.message)).toMatchObject({
      state: "delivered",
      replyTarget: null,
    });

    // Queued, never started: cancelled with its reason, never queued again as the person's.
    expect((await runRow(queued)).status).toBe("interrupted");
    expect(await inputRow(queuedSeed.message)).toEqual({
      state: "cancelled",
      cancelReason: "team-work-ended",
      replyTarget: null,
      runId: null,
    });
    expect(
      await database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", queuedTask)
        .where("status", "in", ["queued", "starting", "running", "waiting"])
        .execute(),
    ).toEqual([]);

    // The ask: cancelled the same way, and no longer counted.
    expect(await inputRow(ask.message)).toEqual({
      state: "cancelled",
      cancelReason: "team-work-ended",
      replyTarget: null,
      runId: null,
    });
    expect(
      (
        await database
          .selectFrom("threads")
          .select("pendingRequestCount")
          .where("id", "=", askTask)
          .executeTakeFirstOrThrow()
      ).pendingRequestCount,
    ).toBe(0);

    // Both keep their message in the task, with the plain reason on it.
    for (const [thread, message] of [
      [queuedTask, queuedSeed.message],
      [askTask, ask.message],
    ] as const) {
      const item = await database
        .selectFrom("transcriptItems")
        .select(["visible", "position", "view"])
        .where("id", "=", message)
        .executeTakeFirstOrThrow();
      expect(item.visible).toBe(true);
      expect(item.position).not.toBeNull();
      expect(item.view).toMatchObject({ delivery: ended, published: false });
      await expectCardSaysWhy(home, thread, message);
      expect(
        await database
          .selectFrom("messages")
          .select("id")
          .where("id", "=", message)
          .where("threadId", "=", thread)
          .execute(),
      ).toHaveLength(1);
    }

    // Cancelled earlier: as it was, without its team target.
    expect(await inputRow(cancelled.message)).toEqual({
      state: "cancelled",
      cancelReason: "team-request-cancelled",
      replyTarget: null,
      runId: null,
    });

    // The person's own: exactly as before.
    expect(await runRow(own)).toEqual({ status: "running", replyTarget: null, finishIntent: null });
    expect(await inputRow(ownSeed.message)).toMatchObject({ state: "delivered", runId: own });
    expect(await inputRow(ownWaiting.message)).toMatchObject({ state: "pending", runId: null });
  });
});

describe("a Home crossing main's current-state conversion with Team work", () => {
  it("settles a Team Run awaiting offline settlement without requeueing its seed, and starts", async () => {
    await migrateToBeforeConversion();
    const home = await seedHome();

    // A Team Run whose seed was claimed and never sent: main cancelled it rather than requeue it.
    const teamTask = await task(home, "Team handoff");
    const teamSeed = await input(home, {
      thread: teamTask,
      sequence: 0,
      text: "Summarise the handoff for the team",
      state: "claimed",
      team: true,
    });
    const teamRun = await run(home, { thread: teamTask, seed: teamSeed, status: "running" });
    await sql`update thread_inputs set run_id = ${teamRun} where message_id = ${teamSeed.message}`.execute(
      database,
    );

    // The person's own Run in the same state: its seed goes back in line, as main did.
    const ownTask = await task(home, "My own handoff");
    const ownSeed = await input(home, {
      thread: ownTask,
      sequence: 0,
      text: "Summarise my notes",
      state: "claimed",
      team: false,
    });
    const ownRun = await run(home, { thread: ownTask, seed: ownSeed, status: "running" });
    await sql`update thread_inputs set run_id = ${ownRun} where message_id = ${ownSeed.message}`.execute(
      database,
    );

    // A teammate's ask still waiting for its owner.
    const askTask = await task(home, "Team ask");
    const ask = await input(home, {
      thread: askTask,
      sequence: 0,
      text: "Can your agent review my pull request?",
      state: "awaiting-approval",
      team: true,
    });

    await migrateToLatest(database);
    expect(
      (await sql<{ ready: boolean }>`select ready from client_sync_state`.execute(database)).rows,
    ).toEqual([{ ready: true }]);
    await expectEverythingReadable();

    expect(await runRow(teamRun)).toMatchObject({ status: "interrupted", replyTarget: null });
    expect(await inputRow(teamSeed.message)).toEqual({
      state: "cancelled",
      cancelReason: "team-work-ended",
      replyTarget: null,
      runId: teamRun,
    });
    expect(await runRow(ownRun)).toMatchObject({ status: "interrupted" });
    expect(await inputRow(ownSeed.message)).toMatchObject({ state: "pending", runId: null });
    expect(await inputRow(ask.message)).toEqual({
      state: "cancelled",
      cancelReason: "team-work-ended",
      replyTarget: null,
      runId: null,
    });
    for (const [thread, message] of [
      [teamTask, teamSeed.message],
      [askTask, ask.message],
    ] as const) {
      const item = await database
        .selectFrom("transcriptItems")
        .select(["visible", "view"])
        .where("id", "=", message)
        .executeTakeFirstOrThrow();
      expect(item.visible).toBe(true);
      expect(item.view).toMatchObject({ delivery: ended });
      await expectCardSaysWhy(home, thread, message);
    }

    const started = await startUp();
    expect(started.errors).toEqual([]);
    expect(started.retryAt).toBeNull();
    // The Team seed never runs again; the person's own goes on.
    expect(
      await database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", teamTask)
        .where("status", "in", ["queued", "starting", "running", "waiting"])
        .execute(),
    ).toEqual([]);
  });
});

/**
 * Main's 0038, verbatim: its durable resource kinds (origin/main
 * packages/protocol/src/resources.ts, `durablePersonalResourceKinds`) and the default and CHECK
 * it built from them (origin/main packages/database/src/personal-state-schema.ts, the
 * `resource_revisions` column of `retainedStateDdl`).
 */
const mainKinds = [
  "settings",
  "identity",
  "owner-profile",
  "environment",
  "machine",
  "harness",
  "harness-catalog",
  "tab",
  "tab-layout",
  "browser-profile",
  "browser-placement",
  "browser-home",
  "browser-availability",
  "plugin",
  "team-replies",
];
const mainKeys = `array[${mainKinds.map((kind) => `'${kind}'`).join(",")}]`;
const mainEach = mainKinds
  .map(
    (kind) => `jsonb_typeof(resource_revisions->'${kind}') = 'string' and
    (resource_revisions->>'${kind}') ~ '^(0|[1-9][0-9]{0,18})$' and
    (resource_revisions->>'${kind}')::numeric <= sequence`,
  )
  .join(" and ");
const main0038 = `create table main_0038 (
    sequence bigint not null default 0,
    resource_revisions jsonb not null default '${JSON.stringify(Object.fromEntries(mainKinds.map((kind) => [kind, "0"])))}',
    check (jsonb_typeof(resource_revisions) = 'object'
      and resource_revisions ?& ${mainKeys}
      and resource_revisions - ${mainKeys} = '{}'::jsonb and ${mainEach}))`;

/** The revisions column's default and every CHECK on its table, as PostgreSQL holds them. */
async function revisionCatalog(target: Kysely<DatabaseSchema>, table = "client_sync_state") {
  const column = await sql<{ default: string }>`
    select pg_get_expr(d.adbin, d.adrelid) as default from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = ${table}::regclass and a.attname = 'resource_revisions'`.execute(target);
  const checks = await sql<{ name: string; definition: string }>`
    select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid = ${table}::regclass and contype = 'c' order by conname`.execute(target);
  return { default: column.rows[0]?.default, checks: checks.rows };
}

describe("the resource revisions 0038 created", () => {
  it("are main's on a Home at main's last migration, hold through this release's writes, and end as a fresh install's", async () => {
    await migrateToMain();
    // The fixture's 0038 objects are main's: deparsed, they equal those of main's text.
    await sql.raw(main0038).execute(database);
    const main = await revisionCatalog(database, "main_0038");
    const at0046 = await revisionCatalog(database);
    expect(at0046.default).toBe(main.default);
    expect(at0046.checks.map(({ definition }) => definition)).toContain(main.checks[0]!.definition);
    await sql`drop table main_0038`.execute(database);

    // A ready Home main has written to: its settings revision moved.
    const home = await seedHome();
    await sql`update client_sync_state set sequence = 7,
      resource_revisions = jsonb_set(resource_revisions, '{settings}', '"7"')`.execute(database);
    await migrateToLatest(database);
    // This release's own commit, bumping two kinds, after the update.
    await commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.bumpResource("plugin");
      mutation.bumpResource("tab");
    });
    const state = await database
      .selectFrom("clientSyncState")
      .select(["resourceRevisions", "sequence"])
      .where("deploymentId", "=", home.deploymentId)
      .executeTakeFirstOrThrow();
    expect(state.resourceRevisions).toEqual({
      ...emptyPersonalResourceRevisions,
      settings: "7",
      plugin: state.sequence,
      tab: state.sequence,
    });
    const upgraded = await revisionCatalog(database);

    const fresh = await cloneTestDatabase("host");
    const freshDatabase = createDatabase({ connectionString: fresh.url });
    try {
      await sql`drop schema public cascade; create schema public`.execute(freshDatabase);
      await migrateToLatest(freshDatabase);
      expect(upgraded).toEqual(await revisionCatalog(freshDatabase));
    } finally {
      await freshDatabase.destroy();
      await fresh.drop();
    }
    // And the default is what this release writes for a new Home.
    expect(
      (
        await sql<{ value: unknown }>`select ${sql.raw(upgraded.default!)} as value`.execute(
          database,
        )
      ).rows[0]!.value,
    ).toEqual(emptyPersonalResourceRevisions);
  });
});

describe("Needs you after the update", () => {
  it("counts Requests alone on a ready Home whose projection drifted below its pending count", async () => {
    await migrateToMain();
    await seedHome();
    // Main counted a teammate's ask in Needs you; the Request projection holds no row.
    await sql`update client_sync_state set pending_request_count = 1, needs_you_count = 3`.execute(
      database,
    );
    await migrateToLatest(database);
    expect(
      (
        await sql<{ pending: number; needsYou: number }>`
          select pending_request_count as pending, needs_you_count as needs_you from client_sync_state`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ pending: 0, needsYou: 0 }]);
  });

  it("counts Requests alone when main's conversion had passed its count stage", async () => {
    await migrateToBeforeConversion();
    await seedHome();
    // The Home stops right after its conversion counted Needs you, as main's could.
    const stopped = new Error("The Home stopped during its conversion");
    await expect(
      migrateToLatest(database, migrationProvider(), {
        afterBatch: (stage) => {
          if (stage === "attention-links") throw stopped;
        },
      }),
    ).rejects.toBe(stopped);
    expect(
      (
        await sql<{ ready: boolean; stage: string }>`
          select ready, upgrade_cursor->>'stage' as stage from client_sync_state`.execute(database)
      ).rows,
    ).toEqual([{ ready: false, stage: "verify" }]);
    // Main's count stage counted two of a teammate's asks in Needs you.
    await sql`update client_sync_state set needs_you_count = needs_you_count + 2`.execute(database);

    // 0107 meets that count before the conversion goes on from where it stopped.
    await replayMigrations(database, "0107_needs_you_counts_requests");
    expect(
      (
        await sql<{ ready: boolean; pending: number; needsYou: number }>`
          select ready, pending_request_count as pending, needs_you_count as needs_you
          from client_sync_state`.execute(database)
      ).rows,
    ).toEqual([{ ready: true, pending: 0, needsYou: 0 }]);
  });
});
