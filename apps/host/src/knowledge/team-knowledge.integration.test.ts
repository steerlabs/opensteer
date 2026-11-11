import type { KnowledgeTopicId, UserId } from "@opensteer/core";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import type { TeamSqlInput } from "@opensteer/protocol";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testTeamAccess } from "./team-access.test-support.js";
import { startTeamKnowledge } from "./team-knowledge.js";

const none = { users: [], channels: [], topics: [], links: [], requests: [] };

/**
 * Mira, a plain member, reaches pricing through nested groups and manages #support; Sam posts in
 * #support and reads roadmap; Lee manages roadmap; Ada is an admin on no list. Both
 * shared topics are attached to #support; payroll is Mira's but attached nowhere.
 */
async function team() {
  const f = await createTeamKnowledgeFixture();
  const { resolver, lock, pauses } = testTeamAccess(f.database);
  const knowledge = await ownTestDatabaseProducer(f.databaseUrl, () =>
    startTeamKnowledge({
      database: f.database,
      databaseUrl: f.databaseUrl,
      access: resolver,
      lock,
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
        input: { mode: "read", operationKey: randomUUID(), ...input },
      })
      .then((answer) => answer.result);
  const write = (who: Ask, topic: KnowledgeTopicId, thing: string, operationKey?: string) =>
    ask(who, {
      query: "INSERT INTO facts (topic, thing, property, value) VALUES ($1, $2, 'v', '1')",
      parameters: [topic, thing],
      mode: "write",
      ...(operationKey ? { operationKey } : {}),
    });
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
    lock,
    pauses,
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
  topic: (t) =>
    t.knowledge.command(t.people.mira, {
      type: "team.knowledge.topic.access.set",
      topicId: t.topics.pricing,
      expectedRevision: "0" as never,
      access: [{ subject: { kind: "person", userId: t.people.sam }, level: "read" }],
    }),
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
      (await t.ask(who, { query: "SELECT text FROM facts ORDER BY text" })).rows;
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
      (await t.knowledge.topics(userId, { channelId: support.channelId })).topics.map(
        (topic) => topic.id,
      );
    expect(await supportTopics(mira)).toEqual([support.topicId, pricing]);
    await expect(t.knowledge.topic(mira, { topicId: roadmap })).rejects.toMatchObject({
      code: "not_found",
    });
    // Attaching needs channel manage and topic read; Payroll joins Mira's scope only.
    await expect(
      t.knowledge.command(sam, {
        type: "team.channel.topic.attach",
        channelId: support.channelId,
        topicId: payroll,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      t.knowledge.command(mira, {
        type: "team.channel.topic.attach",
        channelId: t.channels.leadership.channelId,
        topicId: roadmap,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await t.knowledge.command(mira, {
      type: "team.channel.topic.attach",
      channelId: support.channelId,
      topicId: payroll,
    });
    expect(await t.scope(t.asks.mira)).toEqual([support.topicId, payroll, pricing]);
    expect(await t.scope(t.asks.sam)).toEqual([support.topicId, roadmap]);
    // A channel manager detaches a topic she cannot read herself.
    await t.knowledge.command(mira, {
      type: "team.channel.topic.detach",
      channelId: support.channelId,
      topicId: roadmap,
    });
    expect(await t.scope(t.asks.sam)).toEqual([support.topicId]);
    expect(
      (await t.ask(t.asks.sam, { query: "SELECT text FROM facts ORDER BY text" })).rows,
    ).toEqual([["SUPPORT_FACT"]]);
  });

  it("keeps agents out of people-only channels and topics, which their owners still read", async () => {
    const t = await team();
    const { mira } = t.people;
    const { support, quiet } = t.channels;
    const { pricing } = t.topics;
    expect(await reason(t.ask(t.asks.quiet))).toBe("knowledge-request-unavailable");
    expect(await reason(t.ask(t.asks.quiet, { query: "SELECT 1" }))).toBe(
      "knowledge-request-unavailable",
    );
    expect(
      (await t.knowledge.facts(mira, { topicId: quiet.topicId })).facts.map((fact) => fact.value),
    ).toEqual(["QUIET_FACT"]);

    const peopleOnly = (topicId: KnowledgeTopicId, value: boolean) =>
      t.knowledge.command(mira, {
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
          query: "SELECT count(*) FROM facts WHERE text = 'PRICING_FACT'",
        })
      ).rows,
    ).toEqual([["0"]]);
    const shown = await t.knowledge.topic(mira, { topicId: pricing });
    expect(shown).toMatchObject({
      peopleOnly: true,
      can: { read: true, write: true, manage: true },
    });
    expect(
      (await t.knowledge.facts(mira, { topicId: pricing })).facts.map((fact) => fact.value),
    ).toEqual(["PRICING_FACT"]);
  });

  it("refuses forged scope settings, roles and catalog reads without revealing anything", async () => {
    const t = await team();
    const hidden = t.topics.roadmap;
    const before = await t.count();
    const attempts: Partial<TeamSqlInput>[] = [
      { query: `SELECT set_config('knowledge.read_topics', '{${hidden}}', true)` },
      {
        query:
          "SELECT text FROM facts WHERE set_config('knowledge.read_topics', $1, true) IS NOT NULL",
        parameters: [`{${hidden}}`],
      },
      { query: `SET LOCAL knowledge.read_topics = '{${hidden}}'` },
      { query: "RESET knowledge.write_topics" },
      { query: "SELECT current_setting('knowledge.read_topics')" },
      { query: "SELECT current_setting('knowledge.writer_id')" },
      { query: "SET ROLE opensteer_knowledge_owner" },
      { query: "SET SESSION AUTHORIZATION DEFAULT" },
      { query: "SELECT current_user, session_user" },
      { query: "SELECT * FROM knowledge.fact_log" },
      { query: "SELECT * FROM knowledge.topics" },
      { query: "SELECT * FROM knowledge.operations" },
      { query: "SELECT * FROM team_topic_grants" },
      { query: "SELECT * FROM public.team_members" },
      { query: "SELECT query FROM pg_catalog.pg_stat_activity" },
      { query: "SELECT name, setting FROM pg_settings" },
      { query: "SELECT * FROM information_schema.role_table_grants" },
      { query: "SELECT pg_read_file('/etc/passwd')" },
      {
        query:
          "INSERT INTO facts (topic, thing, property, value, writer_id) VALUES ($1, 'x', 'p', '1', $2)",
        parameters: [t.channels.support.topicId, t.people.sam],
        mode: "write",
      },
      {
        query:
          "INSERT INTO knowledge.fact_log (topic, thing, property, value, writer_kind, writer_id, operation_id, operation_row) VALUES ($1, 'x', 'p', '1', 'human', 'u', 'o', 1)",
        parameters: [hidden],
        mode: "write",
      },
      {
        query:
          "INSERT INTO facts (topic, thing, property, value) SELECT topic, 'x', 'p', value FROM facts",
        mode: "write",
      },
    ];
    for (const attempt of attempts) {
      const outcome = await t.ask(t.asks.mira, attempt).then(
        (result) => ({ allowed: JSON.stringify(result) }),
        (error: { code?: string; message?: string; next?: string }) => error,
      );
      expect(outcome, attempt.query).not.toHaveProperty("allowed");
      expect(["bad_request", "forbidden"], attempt.query).toContain(
        (outcome as { code?: string }).code,
      );
      const text = JSON.stringify(outcome);
      expect(text, attempt.query).not.toContain(hidden);
      expect(text, attempt.query).not.toMatch(/ROADMAP_FACT|SECRET_|opensteer_knowledge|passwd/u);
    }
    expect(await t.count()).toBe(before);
  });

  it("replays a write's receipt only while its topics are still writable", async () => {
    const t = await team();
    const first = await t.write(t.asks.mira, t.topics.pricing, "replayed", "k1");
    expect(first.receipt).toMatchObject({ committed: true, replayed: false });
    const replay = await t.write(t.asks.mira, t.topics.pricing, "replayed", "k1");
    expect(replay).toEqual({ ...first, receipt: { ...first.receipt!, replayed: true } });
    const saved = await t.count();
    await losses.topic!(t);
    const stale = await t.write(t.asks.mira, t.topics.pricing, "replayed", "k1").then(
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
    const count = {
      query: "SELECT count(*) FROM facts",
      mode: "read",
      operationKey: "count",
    } as const;
    const delivered = await t.knowledge.sql({ ...t.asks.mira, input: count });
    expect(delivered.result.rows).toEqual([["2"]]);
    expect(await delivered.reauthorize()).toBe(true);
    const paused = hold();
    t.pauses.beforeHandoff = paused.pause;
    const counting = t.ask(t.asks.mira, { query: "SELECT count(*) FROM facts" });
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
    const recount = t.ask(t.asks.mira, { query: "SELECT count(*) FROM facts" });
    await again.reached;
    await t.knowledge.command(t.people.lee, {
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

  it("lets people browse, edit and manage topics by their own access, admins only by a logged self-add", async () => {
    const t = await team();
    const { mira, sam, lee, ada } = t.people;
    const { support, leadership, quiet } = t.channels;
    const { pricing, roadmap, payroll } = t.topics;
    const listed = async (userId: UserId) =>
      (await t.knowledge.topics(userId, {})).topics.map((topic) => [topic.name, topic.can.read]);
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
    expect(await listed(ada)).toEqual([
      ["payroll", false],
      ["pricing", false],
      ["roadmap", false],
    ]);
    await expect(t.knowledge.facts(ada, { topicId: roadmap })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(t.knowledge.topicAccess(mira, { topicId: support.topicId })).rejects.toMatchObject(
      { reason: "team-topic-follows-channel" },
    );

    // People append versions; a stale version is refused; agents' writes name their source.
    await t.knowledge.command(mira, {
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
    const [current] = (await t.knowledge.facts(mira, { topicId: support.topicId })).facts;
    expect(current).toMatchObject({
      thing: "refunds",
      writerKind: "human",
      writerUserId: mira,
      source: null,
    });
    await expect(
      t.knowledge.command(sam, {
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
    await t.knowledge.command(sam, {
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
    const facts = (await t.knowledge.facts(mira, { topicId: support.topicId })).facts;
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
      (await t.knowledge.history(mira, { topicId: support.topicId })).facts.map(
        (fact) => fact.value,
      ),
    ).toEqual([1, "14 days", "30 days", "SUPPORT_FACT"]);
    await expect(
      t.knowledge.command(sam, {
        type: "team.knowledge.fact.append",
        operationId: randomUUID(),
        facts: [
          { topicId: leadership.topicId, thing: "x", property: "y", value: 1, replacesId: null },
        ],
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Lists change at their revision, by managers or admins; an admin adding herself is logged and told.
    const access = await t.knowledge.topicAccess(lee, { topicId: roadmap });
    expect(access).toMatchObject({ revision: "0", can: { manage: true } });
    await expect(
      t.knowledge.command(sam, {
        type: "team.knowledge.topic.access.set",
        topicId: roadmap,
        expectedRevision: access.revision,
        access: [],
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await t.knowledge.command(ada, {
      type: "team.knowledge.topic.access.set",
      topicId: roadmap,
      expectedRevision: access.revision,
      access: [...access.entries, { subject: { kind: "person", userId: ada }, level: "read" }],
    });
    await expect(
      t.knowledge.command(lee, {
        type: "team.knowledge.topic.access.set",
        topicId: roadmap,
        expectedRevision: access.revision,
        access: access.entries,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await t.knowledge.facts(ada, { topicId: roadmap })).facts.map((fact) => fact.value),
    ).toEqual(["ROADMAP_FACT"]);
    const notices = await t.database
      .selectFrom("teamNotices")
      .innerJoin("teamAudit", "teamAudit.id", "teamNotices.auditId")
      .select(["teamNotices.recipientUserId", "teamNotices.resourceId", "teamAudit.actorUserId"])
      .execute();
    expect(notices).toEqual([{ recipientUserId: lee, resourceId: roadmap, actorUserId: ada }]);
    expect(await t.knowledge.topic(sam, { topicId: payroll }).catch((error) => error.code)).toBe(
      "not_found",
    );
    expect((await t.knowledge.topics(sam, { channelId: quiet.channelId })).topics).toHaveLength(1);
    expect(await t.knowledge.topic(mira, { topicId: pricing })).toMatchObject({ name: "pricing" });
  });
});
