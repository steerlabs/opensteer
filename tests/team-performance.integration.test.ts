import { createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createId, type UserId } from "../packages/core/src/index.js";
import { TeamServerFrameSchema } from "../packages/protocol/src/index.js";
import { teamApiVersion } from "../packages/deployment-authority/src/index.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { TeamAccessStore } from "../packages/database/src/team-access-store.js";
import { TeamChatStore } from "../packages/database/src/team-chat-store.js";
import { createTeamKnowledgeFixture } from "../packages/database/src/team-knowledge.test-support.js";
import { appendTeamAudit } from "../packages/database/src/team-audit-store.js";
import { startTeamKnowledge } from "../apps/host/src/knowledge/team-knowledge.js";
import { startTeamSystem, openMachineSocket } from "./team-system.test-support.js";
import { TeamLinkConnection } from "../apps/host/src/team-links/connection.js";
import {
  recordScenario,
  measured,
  distribution,
  atRate,
  perfMembers,
  perfChannels,
  perfHistory,
  perfRequest,
  databaseMetrics,
  type PerfTeam,
} from "./team-performance.test-support.js";

const enabled = process.env.OPENSTEER_TEAM_PERF === "1";
// Resource benchmarks run only with OPENSTEER_TEAM_PERF=1; ordinary integration runs keep the focused correctness cases.
const scenario = enabled ? it : it.skip;
const deadline = <T>(promise: Promise<T>, label: string, ms = 15000) =>
  withTimeout(promise, ms, { timeoutError: () => new Error(label) });
async function usingTeam(work: (team: PerfTeam, owner: UserId) => Promise<void>) {
  const team = await startTeamSystem();
  try {
    await work(team, await team.setup());
  } finally {
    await team.close();
  }
}
function human(userId: UserId) {
  return { kind: "human" as const, userId };
}
async function socketViewer(
  team: PerfTeam,
  userId: UserId,
  channelId: ReturnType<typeof createId<"teamChannel">>,
  rootId?: string,
  sinceSeq: string | null = null,
  existingHeaders?: Readonly<Record<string, string>>,
) {
  const headers = existingHeaders ?? (await team.session(userId, "Performance device")).headers;
  const socket = new WebSocket(
    new URL(`/v1/realtime?opensteer_api_version=${teamApiVersion}`, team.origin)
      .toString()
      .replace(/^http/u, "ws"),
    { headers },
  );
  const frames: {
    at: number;
    frame: ReturnType<typeof TeamServerFrameSchema.parse>;
    bytes: number;
  }[] = [];
  const listeners = new Set<() => void>();
  socket.on("message", (raw) => {
    frames.push({
      at: performance.now(),
      frame: TeamServerFrameSchema.parse(JSON.parse(raw.toString())),
      bytes: Buffer.byteLength(raw.toString()),
    });
    for (const listener of listeners) listener();
  });
  const wait = <T>(read: () => T | undefined, label: string) => {
    const ready = Promise.withResolvers<T>();
    const check = () => {
      const value = read();
      if (value !== undefined) ready.resolve(value);
    };
    listeners.add(check);
    check();
    return deadline(ready.promise, label).finally(() => listeners.delete(check));
  };
  try {
    await deadline(once(socket, "open"), "Viewer socket did not open");
    socket.send(
      JSON.stringify({
        type: "team.subscribe",
        teamApiVersion,
        sidebar: false,
        subscriptionId: "channel",
        generation: 1,
        scope: { kind: "channel", channelId },
        sinceSeq,
      }),
    );
    if (rootId)
      socket.send(
        JSON.stringify({
          type: "team.subscribe",
          teamApiVersion,
          sidebar: true,
          subscriptionId: "thread",
          generation: 1,
          scope: { kind: "thread", channelId, rootId },
          sinceSeq,
        }),
      );
    await wait(
      () =>
        frames.filter((row) => row.frame.type === "team.cut").length >= (rootId ? 2 : 1)
          ? true
          : undefined,
      "Viewer did not synchronize",
    );
    return { socket, frames, wait, close: () => socket.terminate() };
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

scenario(
  "team-fanout-500",
  async () =>
    recordScenario("team-fanout-500", async (metrics) =>
      usingTeam(async (team, owner) => {
        const members = await perfMembers(team, 499),
          all = [owner, ...members];
        const [channelId] = await perfChannels(team, owner, 1, members);
        const viewers: Awaited<ReturnType<typeof socketViewer>>[] = [];
        try {
          for (let offset = 0; offset < all.length; offset += 25)
            viewers.push(
              ...(await Promise.all(
                all.slice(offset, offset + 25).map((id) => socketViewer(team, id, channelId!)),
              )),
            );
          const ask = await perfRequest(team, owner, channelId!);
          const ack: number[] = [],
            fanout: number[] = [],
            commit = new Map<string, number>();
          const unsubscribe = team.host.team.chat.onChange(() => {
            commit.set("latest", performance.now());
          });
          try {
            for (let index = 0; index < 10; index++) {
              const sent = await measured(ack, () =>
                team.host.team.chat.send(human(owner), {
                  channelId: channelId!,
                  threadRootId: null,
                  clientMessageId: crypto.randomUUID(),
                  bodyMarkdown: `Fanout ${index}`,
                  mentions: [],
                  attachmentIds: [],
                }),
              );
              const committed = commit.get("latest")!;
              const delivered = await Promise.all(
                viewers.map((viewer) =>
                  viewer.wait(() => {
                    const frame = viewer.frames.find(
                      (row) =>
                        row.frame.type === "team.cut" &&
                        (row.frame.cut.type === "snapshot"
                          ? row.frame.cut.messages
                          : row.frame.cut.changedRows
                        ).some((message) => message.id === sent.message.id),
                    );
                    return frame?.at;
                  }, "Fanout did not reach every viewer"),
                ),
              );
              fanout.push(Math.max(...delivered) - committed);
              if (index === 4) {
                for (const id of members.slice(0, 10))
                  await team.host.team.members.change(human(owner), id, "remove");
                for (const viewer of viewers.splice(1, 10)) {
                  if (viewer.socket.readyState === WebSocket.OPEN)
                    await deadline(
                      once(viewer.socket, "close"),
                      "Removed viewer remained connected",
                    );
                  viewer.close();
                }
              }
              if (index === 2 || index === 7)
                await team.host.team.requests.status(ask.linkId, ask.requestId, {
                  state: "working",
                  steps: [{ kind: "ran_commands", count: index + 1 }],
                });
            }
            await team.host.team.requests.reply(ask.linkId, ask.requestId, {
              bodyMarkdown: "Fanout final reply",
              attachmentIds: [],
            });
          } finally {
            unsubscribe();
          }
          metrics.viewers = 500;
          metrics.payload = {
            messages: 10,
            bytesPerMessage: "<64",
            note: "Saturation burst; no artificial inter-message sleep. Status/reply share channel sequence.",
          };
          metrics.commitToLastViewerMs = distribution(fanout);
          metrics.storeAckMs = distribution(ack);
          metrics.targets = {
            fanoutP95Below250: distribution(fanout).p95 < 250,
            ackP95Below100: distribution(ack).p95 < 100,
          };
          metrics.database = await databaseMetrics(team.database);
        } finally {
          for (const viewer of viewers) viewer.close();
        }
      }),
    ),
  300000,
);

scenario(
  "team-reconnect-storm",
  async () =>
    recordScenario("team-reconnect-storm", async (metrics) =>
      usingTeam(async (team, owner) => {
        const [channelId] = await perfChannels(team, owner, 1);
        await perfHistory(team, owner, [channelId!], 1000);
        const root = (
          await team.database
            .selectFrom("teamMessages")
            .select("id")
            .orderBy("id")
            .executeTakeFirstOrThrow()
        ).id;
        const viewers: Awaited<ReturnType<typeof socketViewer>>[] = [],
          latency: number[] = [];
        try {
          const credentials = await Promise.all(
            Array.from({ length: 1000 }, () => team.session(owner, "Stored device session")),
          );
          // Deterministic arrival jitter is the benchmark workload, independent of socket readiness.
          const connected = await Promise.allSettled(
            Array.from({ length: 1000 }, async (_, index) => {
              // oxlint-disable-next-line opensteer/no-real-time-wait-in-tests -- Models the specified reconnect arrival distribution, not a wait for readiness.
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.floor(index / 20) * 20),
              );
              const started = performance.now();
              const viewer = await socketViewer(
                team,
                owner,
                channelId!,
                root,
                "0",
                credentials[index]!.headers,
              );
              viewers.push(viewer);
              latency.push(performance.now() - started);
            }),
          );
          const failure = connected.find((row) => row.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          metrics.devices = 1000;
          metrics.resumeHandshakeMs = distribution(latency);
          metrics.targetP95Below2000 = distribution(latency).p95 < 2000;
          metrics.frames = {
            count: viewers.reduce((n, v) => n + v.frames.length, 0),
            bytes: viewers.reduce((n, v) => n + v.frames.reduce((a, f) => a + f.bytes, 0), 0),
            largest: Math.max(...viewers.flatMap((v) => v.frames.map((f) => f.bytes))),
          };
          expect(
            viewers.every((viewer) =>
              viewer.frames.some(
                (row) => row.frame.type === "team.cut" && row.frame.cut.type === "snapshot",
              ),
            ),
          ).toBe(true);
          metrics.database = await databaseMetrics(team.database);
        } finally {
          for (const viewer of viewers) viewer.close();
        }
      }),
    ),
  300000,
);

scenario(
  "team-history-keyset",
  async () =>
    recordScenario("team-history-keyset", async (metrics) =>
      usingTeam(async (team, owner) => {
        const [channelId] = await perfChannels(team, owner, 1);
        await perfHistory(team, owner, [channelId!], 100000);
        const root = (
          await team.database
            .selectFrom("teamMessages")
            .select("id")
            .orderBy("id")
            .executeTakeFirstOrThrow()
        ).id;
        await sql`insert into team_messages(channel_id,thread_root_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq) select ${channelId},${root},${owner},'human',gen_random_uuid(),'Reply '||n,'Reply '||n,100000+n from generate_series(1,20000) n`.execute(
          team.database,
        );
        await sql`update team_channels set change_seq=120000 where id=${channelId}`.execute(
          team.database,
        );
        await sql`analyze team_messages`.execute(team.database);
        const ids = await team.database
          .selectFrom("teamMessages")
          .select("id")
          .where("channelId", "=", channelId!)
          .orderBy("id")
          .execute();
        const cases = [
          { name: "newest", page: { direction: "newest" as const } },
          { name: "start", page: { direction: "after" as const, messageId: ids[0]!.id } },
          {
            name: "middle-before",
            page: { direction: "before" as const, messageId: ids[50000]!.id },
          },
          {
            name: "middle-after",
            page: { direction: "after" as const, messageId: ids[50000]!.id },
          },
          {
            name: "deep-before",
            page: { direction: "before" as const, messageId: ids[99000]!.id },
          },
          { name: "thread-20000", page: { direction: "newest" as const }, root },
        ];
        const results = [];
        for (const entry of cases) {
          const times: number[] = [];
          for (let index = 0; index < 12; index++) {
            const page = await measured(times, () =>
              team.host.team.chat.page(human(owner), channelId!, entry.page, entry.root),
            );
            expect(page.messages.length).toBeLessThanOrEqual(50);
          }
          results.push({
            case: entry.name,
            ms: distribution(times.slice(2)),
            targetP95Below50: distribution(times.slice(2)).p95 < 50,
          });
        }
        const queryStarts = new Map<
          object,
          { start: number; sql: string; parameters: readonly unknown[] }
        >();
        const queryCosts: {
          milliseconds: number;
          fingerprint: string;
          summary: boolean;
          query: { sql: string; parameters: readonly unknown[] };
        }[] = [];
        const instrumented = team.database.withPlugin({
          transformQuery({ node, queryId }) {
            const compiled = team.database.getExecutor().compileQuery(node, queryId);
            queryStarts.set(queryId, {
              start: performance.now(),
              sql: compiled.sql,
              parameters: compiled.parameters,
            });
            return node;
          },
          async transformResult({ result, queryId }) {
            const begun = queryStarts.get(queryId);
            if (begun)
              queryCosts.push({
                milliseconds: performance.now() - begun.start,
                fingerprint: createHash("sha256").update(begun.sql).digest("hex"),
                summary: begun.sql.includes("as root_id"),
                query: begun,
              });
            return result;
          },
        });
        const access = new TeamAccessStore(instrumented);
        await access.initialize();
        const profiled = new TeamChatStore(access, {
          teamId: team.host.deployment.id,
          teamName: "Acme",
        });
        await profiled.page(human(owner), channelId!, { direction: "newest" });
        metrics.queryCosts = queryCosts.map(({ query: _query, ...cost }) => cost);
        const summaryQuery = queryCosts.find((cost) => cost.summary)?.query;
        if (summaryQuery)
          metrics.summaryExplain = (
            await team.database.executeQuery(
              (await import("kysely")).CompiledQuery.raw(
                `explain(analyze,buffers,format json) ${summaryQuery.sql}`,
                [...summaryQuery.parameters],
              ),
            )
          ).rows;
        metrics.dataset = { channelRoots: 100000, threadReplies: 20000, payloadBytes: 270 };
        metrics.pages = results;
        metrics.explain = (
          await sql`explain(analyze,buffers,format json) select * from team_messages where channel_id=${channelId} and thread_root_id is null and id<${ids[99000]!.id} order by id desc limit 51`.execute(
            team.database,
          )
        ).rows;
        metrics.replyExplain = (
          await sql`explain(analyze,buffers,format json) select id from team_messages where thread_root_id=${root} order by id desc limit 51`.execute(
            team.database,
          )
        ).rows;
        metrics.database = await databaseMetrics(team.database);
      }),
    ),
  300000,
);

scenario(
  "team-search-acl",
  async () =>
    recordScenario("team-search-acl", async (metrics) =>
      usingTeam(async (team, owner) => {
        const readers = await perfMembers(team, 3),
          channels = await perfChannels(team, owner, 1000);
        for (const [index, count] of [5, 200, 1000].entries())
          await team.database
            .insertInto("teamChannelMembers")
            .values(
              channels.slice(0, count).map((channelId) => ({
                channelId,
                subjectKind: "person" as const,
                subjectId: readers[index]!,
                level: "post" as const,
                manage: false,
                addedBy: owner,
              })),
            )
            .execute();
        await perfHistory(team, owner, channels, 1000000);
        const results = [];
        for (const [index, count] of [5, 200, 1000].entries())
          for (const query of ["selectiveneedle", "common"]) {
            const times: number[] = [];
            for (let n = 0; n < 10; n++) {
              const found = await measured(times, () =>
                team.host.team.chat.search(human(readers[index]!), { query }),
              );
              expect(
                found.results.every((result) =>
                  channels.slice(0, count).includes(result.message.channelId),
                ),
              ).toBe(true);
            }
            results.push({
              channels: count,
              query,
              ms: distribution(times.slice(2)),
              targetP95Below300: distribution(times.slice(2)).p95 < 300,
            });
          }
        const writes: number[] = [];
        await atRate(25, 5, async (n) => {
          const text = `freshindex${n}`;
          const sent = await measured(writes, () =>
            team.host.team.chat.send(human(owner), {
              channelId: channels[0]!,
              threadRootId: null,
              clientMessageId: crypto.randomUUID(),
              bodyMarkdown: text,
              mentions: [],
              attachmentIds: [],
            }),
          );
          const found = await team.host.team.chat.search(human(owner), { query: text });
          expect(found.results[0]?.message.id).toBe(sent.message.id);
        });
        await team.host.team.chat.update(human(owner), channels[0]!, { peopleOnly: true });
        const agent = await team.host.team.chat.search(
          { kind: "agent", userId: owner },
          { query: "freshindex" },
        );
        expect(agent.results.some((row) => row.message.channelId === channels[0])).toBe(false);
        await team.host.team.members.change(human(owner), readers[0]!, "remove");
        await expect(
          team.host.team.chat.search(human(readers[0]!), { query: "common" }),
        ).rejects.toThrow();
        metrics.dataset = { messages: 1000000, channels: 1000, plainTextBytes: 270 };
        metrics.searches = results;
        metrics.transactionalGinWriteMs = distribution(writes);
        metrics.targetWritesPerSecond = 5;
        metrics.indexLagMs = 0;
        metrics.indexLagReason =
          "Generated stored tsvector and GIN; every commit searched immediately; no indexing outbox after Fable's cut.";
        metrics.explain = (
          await sql`explain(analyze,buffers,format json) select id from team_messages where search_document @@ websearch_to_tsquery('simple','selectiveneedle') order by id desc limit 51`.execute(
            team.database,
          )
        ).rows;
        metrics.database = await databaseMetrics(team.database);
      }),
    ),
  600000,
);

scenario(
  "team-unread-1000",
  async () =>
    recordScenario("team-unread-1000", async (metrics) =>
      usingTeam(async (team, owner) => {
        const members = await perfMembers(team, 999),
          channels = await perfChannels(team, owner, 50, members);
        let writes = 0;
        const counts: number[] = [];
        const instrumented = team.database.withPlugin({
          transformQuery({ node }) {
            if (["InsertQueryNode", "UpdateQueryNode", "DeleteQueryNode"].includes(node.kind))
              writes++;
            return node;
          },
          async transformResult({ result }) {
            return result;
          },
        });
        const access = new TeamAccessStore(instrumented);
        await access.initialize();
        const chat = new TeamChatStore(access, {
          teamId: team.host.deployment.id,
          teamName: "Acme",
        });
        const durations: number[] = [];
        for (let n = 0; n < 5000; n++) {
          const prior = writes;
          await measured(durations, () =>
            chat.send(human(owner), {
              channelId: channels[0]!,
              threadRootId: null,
              clientMessageId: crypto.randomUUID(),
              bodyMarkdown: `Burst ${n}`,
              mentions: [],
              attachmentIds: [],
            }),
          );
          counts.push(writes - prior);
        }
        expect(new Set(counts).size).toBe(1);
        const markerRows = await team.database
          .selectFrom("teamChannelMemberState")
          .select("userId")
          .execute();
        expect(markerRows).toHaveLength(0);
        const last = (
          await team.database
            .selectFrom("teamChannels")
            .select("latestMessageId")
            .where("id", "=", channels[0]!)
            .executeTakeFirstOrThrow()
        ).latestMessageId!;
        await Promise.all(
          [last, last, last].map((id) => chat.readMarker(human(members[0]!), channels[0]!, id)),
        );
        expect(
          await team.database.selectFrom("teamChannelMemberState").select("userId").execute(),
        ).toHaveLength(1);
        const sidebar: number[] = [];
        for (let n = 0; n < 12; n++)
          await measured(sidebar, () => chat.directory(human(members[0]!), undefined, true));
        metrics.dataset = { members: 1000, channels: 50, burst: 5000 };
        metrics.senderMs = distribution(durations);
        metrics.mutationStatementsPerMessage = distribution(counts);
        metrics.recipientReadMarkersAfterBurst = 0;
        metrics.sidebar50Ms = distribution(sidebar.slice(2));
        metrics.targetSidebarP95Below100 = distribution(sidebar.slice(2)).p95 < 100;
        metrics.database = await databaseMetrics(team.database);
      }),
    ),
  600000,
);

scenario(
  "team-link-crash-cuts",
  async () =>
    recordScenario("team-link-crash-cuts", async (metrics) =>
      usingTeam(async (team, owner) => {
        const members = await perfMembers(team, 99),
          all = [owner, ...members],
          [channelId] = await perfChannels(team, owner, 1, members);
        const asks: Awaited<ReturnType<typeof perfRequest>>[] = [];
        for (const member of all) asks.push(await perfRequest(team, member, channelId!));
        const times: number[] = [];
        for (const ask of asks) {
          await team.host.team.requests.accept(ask.linkId, ask.requestId);
          await team.host.team.requests.accept(ask.linkId, ask.requestId);
          const id = await measured(times, () =>
            team.host.team.requests.reply(ask.linkId, ask.requestId, {
              bodyMarkdown: "One response after lost acknowledgement",
              attachmentIds: [],
            }),
          );
          expect(await team.host.team.requests.receipt(ask.linkId, ask.requestId)).toBe(id);
          expect(
            await team.host.team.requests.reply(ask.linkId, ask.requestId, {
              bodyMarkdown: "One response after lost acknowledgement",
              attachmentIds: [],
            }),
          ).toBe(id);
        }
        expect(
          await team.database
            .selectFrom("teamMessages")
            .select("id")
            .where("authorKind", "=", "agent")
            .execute(),
        ).toHaveLength(100);
        const idle = Promise.withResolvers<void>();
        let pongs = 0,
          bytes = 0,
          idleStarted = 0;
        const connection = new TeamLinkConnection({
          teamId: team.host.deployment.id,
          open: async (signal) => {
            const socket = await openMachineSocket(team.origin, asks[0]!.secret, signal);
            socket.on("message", (data) => {
              if (JSON.parse(data.toString()).type === "pong") {
                bytes += Buffer.byteLength(data.toString()) + Buffer.byteLength('{"type":"ping"}');
                if (++pongs === 2) idle.resolve();
              }
            });
            return socket;
          },
          terminalRequests: async () => [],
          onReady: async () => {
            idleStarted = performance.now();
          },
          onState: async () => {},
          onFrame: async () => {},
        });
        connection.start();
        try {
          await deadline(
            idle.promise,
            "Idle link did not complete two heartbeat round trips",
            65000,
          );
          const perMinute = (bytes * 60000) / (performance.now() - idleStarted);
          metrics.idleWire = {
            pongs,
            bytes,
            bytesPerMinute: perMinute,
            excludesTransportOverhead: true,
          };
          expect(perMinute).toBeLessThan(1024);
        } finally {
          connection.stop();
        }
        metrics.owners = 100;
        metrics.teamReplyReceiptMs = distribution(times);
        metrics.scope =
          "Real team request/accept/reply/receipt persistence. Personal Host restart/local-input crash cuts are the separately failing production journey; not qualified by this team-store scenario.";
        metrics.qualified = false;
        metrics.database = await databaseMetrics(team.database);
      }),
    ),
  300000,
);

scenario(
  "team-knowledge-resource",
  async () =>
    recordScenario("team-knowledge-resource", async (metrics) => {
      const fixture = await createTeamKnowledgeFixture();
      const access = new TeamAccessStore(fixture.database);
      await access.initialize();
      const knowledge = await startTeamKnowledge({
        database: fixture.database,
        access,
        audit: appendTeamAudit,
      });
      try {
        const users = await Promise.all(
          Array.from({ length: 999 }, (_, n) => fixture.member(`resource${n}`)),
        );
        const channel = await fixture.channel({
          name: "resource",
          access: [
            { userId: fixture.owner, level: "post", manage: true },
            ...users.map((userId) => ({ userId, level: "post" as const })),
          ],
        });
        const ask = await fixture.request(fixture.owner, channel.channelId);
        const shared = await fixture.topic("shared", [
          { subject: { kind: "everyone" }, level: "write" },
        ]);
        const hidden = await fixture.topic("hidden", []);
        const seed = (topicId: string, prefix: string, count: number, body: string) =>
          sql`with notes as (
              insert into team_notes(id, topic_id, version, title, body)
              select 'knt_' || gen_random_uuid(), ${topicId}, 1, ${prefix} || '-' || n, ${body}
              from generate_series(1, ${count}) n returning id, title, body)
            insert into team_note_versions(note_id, version, title, body, deleted, writer_kind, writer_user_id)
            select id, 1, title, body, false, 'human', ${fixture.owner} from notes`.execute(
            fixture.database,
          );
        await seed(shared, "resource", 1000, "value ".repeat(640));
        await seed(hidden, "secret", 1, "HIDDEN_RESOURCE_SENTINEL");
        const agent = { linkId: ask.linkId, ownerUserId: fixture.owner, requestId: ask.requestId };
        const search = (query: string) => knowledge.readNotes(agent, { query });
        expect((await search("secret HIDDEN_RESOURCE_SENTINEL")).result.notes).toHaveLength(0);
        const keyed: number[] = [];
        const chat = new TeamChatStore(access, {
          teamId: fixture.deploymentId,
          teamName: "Acme",
        });
        for (let n = 0; n < 20; n++) {
          const [answer] = await Promise.all([
            measured(keyed, () => search("resource 1")),
            chat.send(human(fixture.owner), {
              channelId: channel.channelId,
              threadRootId: null,
              bodyMarkdown: `Concurrent chat ${n}`,
              clientMessageId: crypto.randomUUID(),
              mentions: [],
              attachmentIds: [],
            }),
          ]);
          expect(answer.result.notes.length).toBeGreaterThan(0);
        }
        // The broadest reads an agent can ask for stay bounded in rows and bytes.
        const outcomes = [];
        for (const input of [{ query: "value" }, { topicId: shared }] as const) {
          const started = performance.now();
          const { result } = await knowledge.readNotes(agent, input);
          outcomes.push({
            input: Object.keys(input)[0],
            notes: result.notes.length,
            truncated: result.truncated,
            milliseconds: performance.now() - started,
            bytes: JSON.stringify(result).length,
          });
        }
        const concurrent = await Promise.allSettled(
          Array.from({ length: 40 }, () => search("value")),
        );
        const rejected = concurrent.filter((row) => row.status === "rejected");
        metrics.members = 1000;
        metrics.notes = { readable: 1000, hidden: 1 };
        metrics.keyedReadMs = distribution(keyed);
        metrics.broadReads = outcomes;
        metrics.concurrent = { calls: 40, rejected: rejected.length };
        metrics.caps =
          process.env.OPENSTEER_TEAM_PERF_CAPS ??
          "Host-side limits only; container cap not supplied";
        metrics.hostSurvived = true;
        metrics.postgresqlRestarts =
          "No process restart observed; no claim of hard per-query memory isolation.";
        metrics.database = await databaseMetrics(fixture.database).catch(() => ({
          status: "unavailable after resource corpus",
        }));
      } finally {
        await fixture.close();
      }
    }),
  300000,
);
