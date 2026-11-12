import type { KnowledgeTopicId, TeamActor, UserId } from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { teamReadSchemas, type TeamCommandSchema, type TeamSqlInput } from "@opensteer/protocol";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { testTeamAccess, testTeamAudit } from "./team-access.test-support.js";
import { startTeamKnowledge, type TeamKnowledgeReadName } from "./team-knowledge.js";

const none = { users: [], channels: [], topics: [], links: [], requests: [] };

/**
 * Mira, a plain member, reaches pricing through nested groups and manages #support; Sam posts in
 * #support and reads roadmap; Lee manages roadmap; Ada is an admin on no list. Both
 * shared topics are attached to #support; payroll is Mira's but attached nowhere.
 */
async function team() {
  const f = await createTeamKnowledgeFixture();
  const { access, pauses, changes } = testTeamAccess(f.database);
  const knowledge = await ownTestDatabaseProducer(f.databaseUrl, () =>
    startTeamKnowledge({
      database: f.database,
      databaseUrl: f.databaseUrl,
      credentials: f.credentials,
      access,
      audit: testTeamAudit,
    }),
  );
  const owner = f.owner;
  const mira = await f.member("Mira");
  const sam = await f.member("Sam");
  const lee = await f.member("Lee");
  const ada = await f.member("Ada", "admin");
  const sales = await f.group("sales", [mira]);
  const revenue = await f.group("revenue", [], [sales]);
  const support = await f.channel({
    name: "support",
    access: [
      { userId: mira, level: "post", manage: true },
      { userId: sam, level: "post" },
    ],
  });
  const leadership = await f.channel({
    name: "leadership",
    kind: "private",
    access: [{ userId: mira, level: "post", manage: true }],
  });
  const quiet = await f.channel({
    name: "quiet",
    kind: "private",
    peopleOnly: true,
    access: [
      { userId: mira, level: "post", manage: true },
      { userId: sam, level: "post" },
    ],
  });
  const pricing = await f.sharedTopic("pricing", [
    { subject: { kind: "group", groupId: revenue }, level: "manage" },
  ]);
  const roadmap = await f.sharedTopic("roadmap", [
    { subject: { kind: "person", userId: sam }, level: "read" },
    { subject: { kind: "person", userId: lee }, level: "manage" },
  ]);
  const payroll = await f.sharedTopic("payroll", [
    { subject: { kind: "person", userId: mira }, level: "manage" },
  ]);
  await f.attach(support.channelId, pricing);
  await f.attach(support.channelId, roadmap);
  const seed = async (topic: KnowledgeTopicId, value: string) => {
    const operation = randomUUID();
    await sql`insert into knowledge.operations (id, writer_kind, writer_id, input_hash, row_count, receipt)
      values (${operation}, 'human', ${owner}, repeat('0', 64), 1, '{}')`.execute(f.database);
    await sql`insert into knowledge.fact_log
        (topic, thing, property, value, writer_kind, writer_id, operation_id, operation_row)
      values (${topic}, 'marker', 'v', ${JSON.stringify(value)}::jsonb, 'human', ${owner}, ${operation}, 1)`.execute(
      f.database,
    );
  };
  await seed(support.topicId, "SUPPORT_FACT");
  await seed(leadership.topicId, "SECRET_LEADERSHIP");
  await seed(quiet.topicId, "QUIET_FACT");
  await seed(pricing, "PRICING_FACT");
  await seed(roadmap, "ROADMAP_FACT");
  await seed(payroll, "SECRET_PAYROLL");
  const asks = {
    mira: await f.request(mira, support.channelId),
    sam: await f.request(sam, support.channelId),
    quiet: await f.request(mira, quiet.channelId),
  };
  type Ask = (typeof asks)[keyof typeof asks];
  const ask = (who: Ask, input: Partial<TeamSqlInput> = {}) =>
    knowledge
      .sql({
        linkId: who.linkId,
        requestId: who.requestId,
        input: { mode: "read", parameters: [], ...input },
      })
      .then((answer) => answer.result);
  const write = (who: Ask, topic: KnowledgeTopicId, thing: string, operationId = randomUUID()) =>
    ask(who, {
      sql: "INSERT INTO facts (topic, thing, property, value) VALUES ($1, $2, 'v', '1')",
      parameters: [topic, thing],
      mode: "write",
      operationId,
    });
  const person = (userId: UserId): TeamActor => ({ kind: "human", userId });
  /** A person's read, checked against the wire contract. */
  const read = async <Name extends TeamKnowledgeReadName>(
    userId: UserId,
    name: Name,
    input: z.input<(typeof teamReadSchemas)[Name]["input"]>,
  ) =>
    teamReadSchemas[name].output.parse(
      await knowledge.read(person(userId), name, input),
    ) as z.infer<(typeof teamReadSchemas)[Name]["output"]>;
  const command = (userId: UserId, input: z.infer<typeof TeamCommandSchema>) =>
    knowledge.command(person(userId), input);
  const scope = async (who: Ask) => ((await ask(who)).topics ?? []).map((topic) => topic.id);
  const count = async () =>
    Number(
      (
        await sql<{
          count: string;
        }>`select count(*)::text as count from knowledge.fact_log`.execute(f.database)
      ).rows[0]!.count,
    );
  return {
    ...f,
    knowledge,
    lock: access,
    pauses,
    changes,
    read,
    command,
    people: { mira, sam, lee, ada },
    groups: { sales, revenue },
    channels: { support, leadership, quiet },
    topics: { pricing, roadmap, payroll },
    asks,
    ask,
    write,
    scope,
    count,
  };
}
type Team = Awaited<ReturnType<typeof team>>;

/** Resolves when the call reaches the pause; `release` lets it go on. */
function hold() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    pause: async () => {
      reached.resolve();
      await released.promise;
    },
  };
}

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "allowed",
    (error: unknown) => (error as { reason?: string }).reason ?? String(error),
  );

const losses: Record<string, (t: Team) => Promise<void>> = {
  member: (t) =>
    t.lock.mutate(async (transaction) => {
      await transaction
        .updateTable("teamMembers")
        .set({ state: "removed" })
        .where("userId", "=", t.people.mira)
        .execute();
      return { value: undefined, effects: { ...none, users: [t.people.mira] } };
    }),
  link: (t) =>
    t.lock.mutate(async (transaction) => {
      await transaction
        .updateTable("teamLinks")
        .set({ state: "revoked", revokedAt: new Date() })
        .where("id", "=", t.asks.mira.linkId)
        .execute();
      return { value: undefined, effects: { ...none, links: [t.asks.mira.linkId] } };
    }),
  topic: async (t) => {
    await t.command(t.people.mira, {
      type: "team.knowledge.topic.access.set",
      topicId: t.topics.pricing,
      expectedRevision: "0" as never,
      access: [{ subject: { kind: "person", userId: t.people.sam }, level: "read" }],
    });
  },
  group: (t) =>
    t.lock.mutate(async (transaction) => {
      await transaction
        .deleteFrom("teamGroupPeople")
        .where("groupId", "=", t.groups.sales)
        .where("userId", "=", t.people.mira)
        .execute();
      return { value: undefined, effects: { ...none, users: [t.people.mira] } };
    }),
};

async function waitingOnLock(t: Team) {
  await vi.waitFor(
    async () => {
      const { rows } = await sql<{ waiting: string }>`
        select count(*)::text as waiting from pg_catalog.pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `.execute(t.database);
      if (rows[0]?.waiting === "0") throw new Error("The access change never waited for the write");
    },
    { timeout: 10_000, interval: 20 },
  );
}

// Skip outside the integration launcher, which supplies an isolated PostgreSQL clone.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("team knowledge", () => {
  it.each(["rename", "archive", "restore"] as const)(
    "fences a topic %s already admitted by a manager until commit before removing their grant",
    async (action) => {
      const t = await team();
      const barrier = hold();
      let paused = false;
      const topic = t.lock.topic.bind(t.lock);
      vi.spyOn(t.lock, "topic").mockImplementation(async (tx, actor, topicId) => {
        const rights = await topic(tx, actor, topicId);
        if (!paused && actor.userId === t.people.mira && topicId === t.topics.payroll) {
          paused = true;
          await withTimeout(barrier.pause(), 5000, {
            timeoutError: () => new Error("Metadata barrier never released"),
          });
        }
        return rights;
      });
      const command = t.command(
        t.people.mira,
        action === "rename"
          ? { type: "team.knowledge.topic.rename", topicId: t.topics.payroll, name: "Updated" }
          : {
              type:
                action === "archive"
                  ? "team.knowledge.topic.archive"
                  : "team.knowledge.topic.restore",
              topicId: t.topics.payroll,
            },
      );
      const outcome = reason(command);
      await withTimeout(barrier.reached, 5000, {
        timeoutError: () => new Error("Metadata never checked manager authority"),
      });
      let removed = false;
      const removal = t
        .command(t.people.ada, {
          type: "team.knowledge.topic.access.set",
          topicId: t.topics.payroll,
          expectedRevision: "0" as never,
          access: [{ subject: { kind: "person", userId: t.people.ada }, level: "manage" }],
        })
        .then(() => {
          removed = true;
        });
      try {
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{
              waiting: boolean;
            }>`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as waiting`.execute(
              t.database,
            );
            expect(removed || rows[0]?.waiting).toBe(true);
          },
          { timeout: 3000 },
        );
        expect(removed).toBe(false);
      } finally {
        barrier.release();
        await removal;
        await outcome;
      }
      expect(await outcome).toBe("allowed");
      await expect(
        t.command(t.people.mira, {
          type: "team.knowledge.topic.rename",
          topicId: t.topics.payroll,
          name: "After removal",
        }),
      ).rejects.toThrow();
    },
  );

  it("notifies the previous topic manager when an admin replaces every grant with themselves", async () => {
    const t = await team();
    await t.command(t.people.ada, {
      type: "team.knowledge.topic.access.set",
      topicId: t.topics.payroll,
      expectedRevision: "0" as never,
      access: [{ subject: { kind: "person", userId: t.people.ada }, level: "manage" }],
    });
    expect(
      await t.database
        .selectFrom("teamNotices")
        .select("recipientUserId")
        .where("recipientUserId", "=", t.people.mira)
        .execute(),
    ).toHaveLength(1);
  });
  it("scopes each owner's agent to its ticket channel's topic and the attached topics it may use", async () => {
    const t = await team();
    const { support } = t.channels;
    const { pricing, roadmap, payroll } = t.topics;
    expect((await t.ask(t.asks.mira)).topics).toEqual([
      { id: support.topicId, name: "support" },
      { id: pricing, name: "pricing" },
    ]);
    expect(await t.scope(t.asks.sam)).toEqual([support.topicId, roadmap]);
    const texts = async (who: (typeof t.asks)["mira"]) =>
      (await t.ask(who, { sql: "SELECT text FROM facts ORDER BY text" })).rows;
    expect(await texts(t.asks.mira)).toEqual([["PRICING_FACT"], ["SUPPORT_FACT"]]);
    expect(await texts(t.asks.sam)).toEqual([["ROADMAP_FACT"], ["SUPPORT_FACT"]]);

    // Naming a topic is never a grant: an agent writes only where its owner may, from this channel.
    const outcomes = await Promise.all(
      (
        [
          ["mira", pricing],
          ["mira", support.topicId],
          ["mira", roadmap],
          ["mira", payroll],
          ["mira", t.channels.leadership.topicId],
          ["sam", support.topicId],
          ["sam", roadmap],
          ["sam", pricing],
        ] as const
      ).map(async ([who, topic]) => [who, topic, await reason(t.write(t.asks[who], topic, who))]),
    );
    expect(outcomes).toEqual([
      ["mira", pricing, "allowed"],
      ["mira", support.topicId, "allowed"],
      ["mira", roadmap, "knowledge-topic-not-writable"],
      ["mira", payroll, "knowledge-topic-not-writable"],
      ["mira", t.channels.leadership.topicId, "knowledge-topic-not-writable"],
      ["sam", support.topicId, "allowed"],
      ["sam", roadmap, "knowledge-topic-not-writable"],
      ["sam", pricing, "knowledge-topic-not-writable"],
    ]);
    const { rows: stamped } = await sql<Record<string, string | null>>`
      select f.topic, f.writer_kind, f.writer_id, o.request_id from knowledge.fact_log f
      join knowledge.operations o on o.id = f.operation_id where f.thing in ('mira', 'sam')
      order by f.writer_id = ${t.people.mira} desc, f.topic
    `.execute(t.database);
    expect(stamped).toEqual(
      expect.arrayContaining([
        {
          topic: pricing,
          writerKind: "agent",
          writerId: t.people.mira,
          requestId: t.asks.mira.requestId,
        },
        {
          topic: support.topicId,
          writerKind: "agent",
          writerId: t.people.sam,
          requestId: t.asks.sam.requestId,
        },
      ]),
    );
    expect(stamped).toHaveLength(3);
    const audit = await t.database
      .selectFrom("teamAudit")
      .select(["actorUserId", "actorKind", "agentRequestId", "outcome"])
      .where("action", "=", "knowledge.sql")
      .execute();
    expect(audit.length).toBeGreaterThanOrEqual(7);
    expect(new Set(audit.map((row) => row.actorKind))).toEqual(new Set(["agent"]));
  });

  it("grants nothing by attaching a topic, and shrinks the scope when it is detached", async () => {
    const t = await team();
    const { mira, sam } = t.people;
    const { support } = t.channels;
    const { pricing, roadmap, payroll } = t.topics;
    const supportTopics = async (userId: UserId) =>
      (
        await t.read(userId, "team.knowledge.topics.list", { channelId: support.channelId })
      ).topics.map((topic) => topic.id);
    expect(await supportTopics(mira)).toEqual([support.topicId, pricing]);
    await expect(
      t.read(mira, "team.knowledge.topic.get", { topicId: roadmap }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    // Attaching needs channel manage and topic read; Payroll joins Mira's scope only.
    await expect(
      t.command(sam, {
        type: "team.channel.topic.attach",
        channelId: support.channelId,
        topicId: payroll,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      t.command(mira, {
        type: "team.channel.topic.attach",
        channelId: t.channels.leadership.channelId,
        topicId: roadmap,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await t.command(mira, {
      type: "team.channel.topic.attach",
      channelId: support.channelId,
      topicId: payroll,
    });
    expect(await t.scope(t.asks.mira)).toEqual([support.topicId, payroll, pricing]);
    expect(await t.scope(t.asks.sam)).toEqual([support.topicId, roadmap]);
    // A channel manager detaches a topic she cannot read herself.
    await t.command(mira, {
      type: "team.channel.topic.detach",
      channelId: support.channelId,
      topicId: roadmap,
    });
    expect(await t.scope(t.asks.sam)).toEqual([support.topicId]);
    expect((await t.ask(t.asks.sam, { sql: "SELECT text FROM facts ORDER BY text" })).rows).toEqual(
      [["SUPPORT_FACT"]],
    );
  });

  it("keeps agents out of people-only channels and topics, which their owners still read", async () => {
    const t = await team();
    const { mira } = t.people;
    const { support, quiet } = t.channels;
    const { pricing } = t.topics;
    expect(await reason(t.ask(t.asks.quiet))).toBe("knowledge-request-unavailable");
    expect(await reason(t.ask(t.asks.quiet, { sql: "SELECT 1" }))).toBe(
      "knowledge-request-unavailable",
    );
    expect(
      await t.database
        .selectFrom("teamAudit")
        .select(["actorUserId", "actorKind", "agentRequestId", "linkId"])
        .where("outcome", "=", "denied")
        .execute(),
    ).toEqual(
      Array(2).fill({
        actorUserId: mira,
        actorKind: "agent",
        agentRequestId: t.asks.quiet.requestId,
        linkId: t.asks.quiet.linkId,
      }),
    );
    expect(
      (await t.read(mira, "team.knowledge.facts.page", { topicId: quiet.topicId })).facts.map(
        (fact) => fact.value,
      ),
    ).toEqual(["QUIET_FACT"]);

    const peopleOnly = (topicId: KnowledgeTopicId, value: boolean) =>
      t.command(mira, {
        type: "team.knowledge.topic.peopleOnly.set",
        topicId,
        peopleOnly: value,
      });
    await peopleOnly(support.topicId, true);
    expect(await t.scope(t.asks.mira)).toEqual([pricing]);
    expect(await reason(t.write(t.asks.mira, support.topicId, "x"))).toBe(
      "knowledge-topic-not-writable",
    );
    await peopleOnly(support.topicId, false);
    await peopleOnly(pricing, true);
    expect(await t.scope(t.asks.mira)).toEqual([support.topicId]);
    expect(
      (
        await t.ask(t.asks.mira, {
          sql: "SELECT count(*) FROM facts WHERE text = 'PRICING_FACT'",
        })
      ).rows,
    ).toEqual([["0"]]);
    const shown = await t.read(mira, "team.knowledge.topic.get", { topicId: pricing });
    expect(shown).toMatchObject({
      peopleOnly: true,
      can: { read: true, write: true, manage: true },
    });
    expect(
      (await t.read(mira, "team.knowledge.facts.page", { topicId: pricing })).facts.map(
        (fact) => fact.value,
      ),
    ).toEqual(["PRICING_FACT"]);
  });

  it("refuses forged scope settings, roles and catalog reads without revealing anything", async () => {
    const t = await team();
    const hidden = t.topics.roadmap;
    const before = await t.count();
    const attempts: Partial<TeamSqlInput>[] = [
      { sql: `SELECT set_config('knowledge.read_topics', '{${hidden}}', true)` },
      {
        sql: "SELECT text FROM facts WHERE set_config('knowledge.read_topics', $1, true) IS NOT NULL",
        parameters: [`{${hidden}}`],
      },
      { sql: `SET LOCAL knowledge.read_topics = '{${hidden}}'` },
      { sql: "RESET knowledge.write_topics" },
      { sql: "SELECT current_setting('knowledge.read_topics')" },
      { sql: "SELECT current_setting('knowledge.writer_id')" },
      { sql: "SET ROLE opensteer_knowledge_owner" },
      { sql: "SET SESSION AUTHORIZATION DEFAULT" },
      { sql: "SELECT current_user, session_user" },
      { sql: "SELECT * FROM knowledge.fact_log" },
      { sql: "SELECT * FROM knowledge.topics" },
      { sql: "SELECT * FROM knowledge.operations" },
      { sql: "SELECT * FROM team_topic_grants" },
      { sql: "SELECT * FROM public.team_members" },
      { sql: "SELECT query FROM pg_catalog.pg_stat_activity" },
      { sql: "SELECT name, setting FROM pg_settings" },
      { sql: "SELECT * FROM information_schema.role_table_grants" },
      { sql: "SELECT pg_read_file('/etc/passwd')" },
      {
        sql: "INSERT INTO facts (topic, thing, property, value, writer_id) VALUES ($1, 'x', 'p', '1', $2)",
        parameters: [t.channels.support.topicId, t.people.sam],
        mode: "write",
      },
      {
        sql: "INSERT INTO knowledge.fact_log (topic, thing, property, value, writer_kind, writer_id, operation_id, operation_row) VALUES ($1, 'x', 'p', '1', 'human', 'u', 'o', 1)",
        parameters: [hidden],
        mode: "write",
      },
      {
        sql: "INSERT INTO facts (topic, thing, property, value) SELECT topic, 'x', 'p', value FROM facts",
        mode: "write",
      },
    ];
    for (const attempt of attempts) {
      const outcome = await t.ask(t.asks.mira, attempt).then(
        (result) => ({ allowed: JSON.stringify(result) }),
        (error: { code?: string; message?: string; next?: string }) => error,
      );
      expect(outcome, attempt.sql).not.toHaveProperty("allowed");
      expect(["bad_request", "forbidden"], attempt.sql).toContain(
        (outcome as { code?: string }).code,
      );
      const text = JSON.stringify(outcome);
      expect(text, attempt.sql).not.toContain(hidden);
      expect(text, attempt.sql).not.toMatch(/ROADMAP_FACT|SECRET_|opensteer_knowledge|passwd/u);
    }
    expect(await t.count()).toBe(before);
  });

  it("replays a write's receipt only while its topics are still writable", async () => {
    const t = await team();
    const key = randomUUID();
    const first = await t.write(t.asks.mira, t.topics.pricing, "replayed", key);
    expect(first.receipt).toMatchObject({ committed: true, replayed: false });
    const replay = await t.write(t.asks.mira, t.topics.pricing, "replayed", key);
    expect(replay).toEqual({ ...first, receipt: { ...first.receipt!, replayed: true } });
    const saved = await t.count();
    await losses.topic!(t);
    const stale = await t.write(t.asks.mira, t.topics.pricing, "replayed", key).then(
      () => "allowed",
      (error: { reason?: string; message?: string }) => `${error.reason}: ${error.message ?? ""}`,
    );
    expect(stale).toMatch(/^knowledge-topic-not-writable: /u);
    expect(stale).not.toContain(first.receipt!.facts[0]!.id);
    expect(await t.count()).toBe(saved);
  });

  describe.each(Object.keys(losses))("losing access by %s", (loss) => {
    it("refuses a write authorized before the change returned that had not reached the lock", async () => {
      const t = await team();
      const paused = hold();
      t.pauses.beforeWriteLock = paused.pause;
      const writing = reason(t.write(t.asks.mira, t.topics.pricing, "late"));
      await paused.reached;
      const before = await t.count();
      await losses[loss]!(t);
      const afterReturn = await t.count();
      paused.release();
      expect(await writing).toMatch(/^knowledge-(request-unavailable|topic-not-writable)$/u);
      expect(afterReturn).toBe(before);
      expect(await t.count()).toBe(before);
    });

    it("does not return the change until a write already holding the lock has committed", async () => {
      const t = await team();
      const paused = hold();
      t.pauses.insideWriteLock = paused.pause;
      const writing = reason(t.write(t.asks.mira, t.topics.pricing, "early"));
      await paused.reached;
      const before = await t.count();
      let returned = false;
      const changing = losses[loss]!(t).then(() => {
        returned = true;
      });
      await waitingOnLock(t);
      expect(returned).toBe(false);
      paused.release();
      await changing;
      const afterReturn = await t.count();
      delete t.pauses.insideWriteLock;
      expect(await writing).toBe("allowed");
      expect(afterReturn).toBe(before + 1);
      expect(await reason(t.write(t.asks.mira, t.topics.pricing, "after"))).toMatch(
        /^knowledge-(request-unavailable|topic-not-writable)$/u,
      );
      expect(await t.count()).toBe(afterReturn);
    });
  });

  it("discards a whole aggregate when the access it was computed under shrinks before handoff", async () => {
    const t = await team();
    const count: TeamSqlInput = { sql: "SELECT count(*) FROM facts", mode: "read", parameters: [] };
    const delivered = await t.knowledge.sql({ ...t.asks.mira, input: count });
    expect(delivered.result.rows).toEqual([["2"]]);
    expect(await delivered.reauthorize()).toBe(true);
    const paused = hold();
    t.pauses.beforeHandoff = paused.pause;
    const counting = t.ask(t.asks.mira, { sql: "SELECT count(*) FROM facts" });
    await paused.reached;
    await losses.topic!(t);
    paused.release();
    await expect(counting).rejects.toMatchObject({
      code: "forbidden",
      reason: "knowledge-access-changed",
      message: "Access to this knowledge changed while answering, so nothing was returned.",
    });
    // The link's own final handoff re-checks the same whole scope.
    expect(await delivered.reauthorize()).toBe(false);

    // A change elsewhere only makes the answer re-check, and it is still delivered.
    const again = hold();
    t.pauses.beforeHandoff = again.pause;
    const recount = t.ask(t.asks.mira, { sql: "SELECT count(*) FROM facts" });
    await again.reached;
    await t.command(t.people.lee, {
      type: "team.knowledge.topic.access.set",
      topicId: t.topics.roadmap,
      expectedRevision: "0" as never,
      access: [
        { subject: { kind: "person", userId: t.people.lee }, level: "manage" },
        { subject: { kind: "person", userId: t.people.sam }, level: "write" },
      ],
    });
    again.release();
    expect((await recount).rows).toEqual([["1"]]);
  });

  it("lets people browse, edit and manage topics by their own access, admins by a change made as themselves", async () => {
    const t = await team();
    const { mira, sam, lee, ada } = t.people;
    const { support, leadership, quiet } = t.channels;
    const { pricing, roadmap, payroll } = t.topics;
    const listed = async (userId: UserId) =>
      (await t.read(userId, "team.knowledge.topics.list", {})).topics.map((topic) => [
        topic.name,
        topic.can.read,
      ]);
    expect(await listed(mira)).toEqual([
      ["leadership", true],
      ["payroll", true],
      ["pricing", true],
      ["quiet", true],
      ["support", true],
    ]);
    expect(await listed(sam)).toEqual([
      ["quiet", true],
      ["roadmap", true],
      ["support", true],
    ]);
    // An admin manages every public or private channel and shared topic, without reading them.
    expect(await listed(ada)).toEqual([
      ["leadership", false],
      ["payroll", false],
      ["pricing", false],
      ["quiet", false],
      ["roadmap", false],
      ["support", false],
    ]);
    await expect(
      t.read(ada, "team.knowledge.facts.page", { topicId: roadmap }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      t.read(mira, "team.knowledge.topic.access.get", { topicId: support.topicId }),
    ).rejects.toMatchObject({ reason: "team-topic-follows-channel" });

    // People append versions; a stale version is refused; agents' writes name their source.
    await t.command(mira, {
      type: "team.knowledge.fact.append",
      operationId: randomUUID(),
      facts: [
        {
          topicId: support.topicId,
          thing: "refunds",
          property: "window",
          value: "30 days",
          replacesId: null,
        },
      ],
    });
    const [current] = (
      await t.read(mira, "team.knowledge.facts.page", { topicId: support.topicId })
    ).facts;
    expect(current).toMatchObject({
      thing: "refunds",
      writerKind: "human",
      writerUserId: mira,
      source: null,
    });
    await expect(
      t.command(sam, {
        type: "team.knowledge.fact.append",
        operationId: randomUUID(),
        facts: [
          {
            topicId: support.topicId,
            thing: "refunds",
            property: "window",
            value: "14 days",
            replacesId: null,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "conflict", reason: "knowledge-fact-changed" });
    await t.command(sam, {
      type: "team.knowledge.fact.append",
      operationId: randomUUID(),
      facts: [
        {
          topicId: support.topicId,
          thing: "refunds",
          property: "window",
          value: "14 days",
          replacesId: current!.id,
        },
      ],
    });
    await t.write(t.asks.mira, support.topicId, "agent-wrote");
    const facts = (await t.read(mira, "team.knowledge.facts.page", { topicId: support.topicId }))
      .facts;
    expect(facts.map((fact) => [fact.thing, fact.value, fact.writerKind])).toEqual([
      ["agent-wrote", 1, "agent"],
      ["refunds", "14 days", "human"],
      ["marker", "SUPPORT_FACT", "human"],
    ]);
    expect(facts[0]!.source).toEqual({
      channelId: support.channelId,
      messageId: t.asks.mira.messageId,
    });
    expect(
      (await t.read(mira, "team.knowledge.history.page", { topicId: support.topicId })).facts.map(
        (fact) => fact.value,
      ),
    ).toEqual([1, "14 days", "30 days", "SUPPORT_FACT"]);
    await expect(
      t.command(sam, {
        type: "team.knowledge.fact.append",
        operationId: randomUUID(),
        facts: [
          { topicId: leadership.topicId, thing: "x", property: "y", value: 1, replacesId: null },
        ],
      }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "knowledge-topic-not-writable" });

    // Lists change at their revision, by managers or admins; an admin adding herself is logged and told.
    const access = await t.read(lee, "team.knowledge.topic.access.get", { topicId: roadmap });
    expect(access).toMatchObject({ revision: "0", can: { manage: true } });
    await expect(
      t.command(sam, {
        type: "team.knowledge.topic.access.set",
        topicId: roadmap,
        expectedRevision: access.revision,
        access: [],
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await t.command(ada, {
      type: "team.knowledge.topic.access.set",
      topicId: roadmap,
      expectedRevision: access.revision,
      access: [...access.entries, { subject: { kind: "person", userId: ada }, level: "read" }],
    });
    await expect(
      t.command(lee, {
        type: "team.knowledge.topic.access.set",
        topicId: roadmap,
        expectedRevision: access.revision,
        access: access.entries,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await t.read(ada, "team.knowledge.facts.page", { topicId: roadmap })).facts.map(
        (fact) => fact.value,
      ),
    ).toEqual(["ROADMAP_FACT"]);
    // The access service records and announces an admin's self-add from the change's actor.
    expect(t.changes).toContainEqual({
      actor: { kind: "human", userId: ada },
      action: "team.knowledge.topic.access.set",
    });
    expect(
      await t
        .read(sam, "team.knowledge.topic.get", { topicId: payroll })
        .catch((error) => error.code),
    ).toBe("not_found");
    expect(
      (await t.read(sam, "team.knowledge.topics.list", { channelId: quiet.channelId })).topics,
    ).toHaveLength(1);
    expect(await t.read(mira, "team.knowledge.topic.get", { topicId: pricing })).toMatchObject({
      name: "pricing",
    });
  });
});
