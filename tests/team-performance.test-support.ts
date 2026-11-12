import { createHash, randomBytes } from "node:crypto";
import { loadavg, cpus, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { createId, type UserId, type TeamChannelId } from "../packages/core/src/index.js";
import type { DatabaseSchema } from "../packages/database/src/schema.js";
import { startTeamSystem } from "./team-system.test-support.js";

export type PerfTeam = Awaited<ReturnType<typeof startTeamSystem>>;
export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (n: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(n * sorted.length) - 1)] ?? 0;
  return { count: sorted.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: sorted.at(-1) ?? 0 };
}
export async function atRate<T>(
  count: number,
  perSecond: number,
  work: (index: number) => Promise<T>,
) {
  const scheduled = Promise.withResolvers<void>();
  const pending: Promise<T>[] = [];
  let index = 0;
  const timer = setInterval(() => {
    const next = work(index++);
    void next.catch(() => undefined);
    pending.push(next);
    if (index === count) {
      clearInterval(timer);
      scheduled.resolve();
    }
  }, 1000 / perSecond);
  try {
    await scheduled.promise;
    return await Promise.all(pending);
  } finally {
    clearInterval(timer);
  }
}
export async function measured<T>(samples: number[], work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await work();
  } finally {
    samples.push(performance.now() - start);
  }
}
export async function perfMembers(team: PerfTeam, count: number) {
  const ids = Array.from({ length: count }, () => createId("user"));
  if (ids.length) {
    await team.database
      .insertInto("users")
      .values(
        ids.map((id, index) => ({
          id,
          displayName: `Perf ${index}`,
          email: `${id}@example.invalid`,
          emailVerified: true,
        })),
      )
      .execute();
    await team.database
      .insertInto("teamMembers")
      .values(
        ids.map((id, index) => ({
          userId: id,
          handle: `perf${index}`,
          role: "member" as const,
          state: "active" as const,
        })),
      )
      .execute();
  }
  return ids;
}
export async function perfChannels(
  team: PerfTeam,
  owner: UserId,
  count: number,
  readers: readonly UserId[] = [],
) {
  const ids = Array.from({ length: count }, () => createId("teamChannel"));
  await team.database
    .insertInto("teamChannels")
    .values(
      ids.map((id, index) => ({
        id,
        kind: "public" as const,
        name: `perf-${index}`,
        normalizedName: `perf-${index}`,
        createdBy: owner,
        peopleOnly: false,
        instructionsMarkdown: "",
      })),
    )
    .execute();
  const grants = ids.flatMap((channelId) =>
    [owner, ...readers].map((userId) => ({
      channelId,
      subjectKind: "person" as const,
      subjectId: userId,
      level: "post" as const,
      manage: userId === owner,
      addedBy: owner,
    })),
  );
  for (let offset = 0; offset < grants.length; offset += 4000)
    await team.database
      .insertInto("teamChannelMembers")
      .values(grants.slice(offset, offset + 4000))
      .execute();
  return ids;
}
export async function perfHistory(
  team: PerfTeam,
  owner: UserId,
  channels: readonly TeamChannelId[],
  count: number,
) {
  await sql`insert into team_messages(channel_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq)
    select (array[${sql.join(channels)}]::text[])[1+(n-1)%${channels.length}],${owner},'human',gen_random_uuid(),
      case when n%1000=0 then 'selectiveneedle ' else 'common ' end || repeat('payload ',32),
      case when n%1000=0 then 'selectiveneedle ' else 'common ' end || repeat('payload ',32), n
    from generate_series(1,${count}) n`.execute(team.database);
  await sql`update team_channels c set change_seq=${count}, latest_message_id=(select max(id) from team_messages m where m.channel_id=c.id) where c.id in (${sql.join(channels)})`.execute(
    team.database,
  );
  await sql`analyze team_messages; analyze team_channel_members`.execute(team.database);
}
export async function perfRequest(team: PerfTeam, owner: UserId, channelId: TeamChannelId) {
  const linkId = createId("teamLink");
  const secret = `ost_link_${randomBytes(32).toString("base64url")}`;
  await team.database
    .insertInto("teamLinks")
    .values({
      id: linkId,
      ownerUserId: owner,
      state: "active",
      personalDeploymentId: createId("deployment"),
      credentialHash: createHash("sha256").update(secret).digest("hex"),
      installationLabel: "Perf computer",
      codeHash: createHash("sha256").update(`code-${linkId}`).digest("hex"),
      codeExpiresAt: new Date(Date.now() + 600000),
      lastSeenAt: null,
      revokedAt: null,
    })
    .execute();
  const sent = await team.host.team.chat.send(
    { kind: "human", userId: owner },
    {
      channelId,
      clientMessageId: crypto.randomUUID(),
      threadRootId: null,
      bodyMarkdown: "Perf own-agent ask",
      mentions: [{ kind: "agent", userId: owner }],
      attachmentIds: [],
    },
  );
  const request = await team.database
    .selectFrom("teamAgentRequests")
    .selectAll()
    .where("triggerMessageId", "=", sent.message.id)
    .executeTakeFirstOrThrow();
  await team.host.team.requests.accept(linkId, request.id);
  return { linkId, secret, requestId: request.id, rootId: sent.message.id };
}
export async function databaseMetrics(database: Kysely<DatabaseSchema>) {
  return (
    await sql`select version(),pg_database_size(current_database()) as bytes,
    (select row_to_json(s) from (select blks_read,blks_hit,temp_bytes,deadlocks from pg_stat_database where datname=current_database()) s) as stats`.execute(
      database,
    )
  ).rows[0];
}
export async function recordScenario(
  name: string,
  work: (metrics: Record<string, unknown>) => Promise<void>,
) {
  const metrics: Record<string, unknown> = {};
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const cpu = process.cpuUsage(),
    started = performance.now();
  const before = { loadAverage: loadavg(), memory: process.memoryUsage() };
  let error: unknown;
  try {
    await work(metrics);
  } catch (caught) {
    error = caught;
  }
  histogram.disable();
  const row = {
    lockOrderMode: process.env.OPENSTEER_LOCK_ORDER_MODE ?? "off",
    name,
    status: error ? "failed" : "complete",
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    measuredAt: new Date().toISOString(),
    machine: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
      shared: true,
    },
    elapsedMs: performance.now() - started,
    cpuMicroseconds: process.cpuUsage(cpu),
    before,
    after: { loadAverage: loadavg(), memory: process.memoryUsage() },
    eventLoopMs: { p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 },
    metrics,
  };
  const path = process.env.OPENSTEER_TEAM_PERF_REPORT ?? "/tmp/z4-team-performance.jsonl";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(row) + "\n", { flag: "a" });
  console.info(`TEAM_PERF ${JSON.stringify(row)}`);
  if (error) throw error;
}
