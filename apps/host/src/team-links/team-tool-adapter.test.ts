import { describe, expect, it } from "vitest";
import { createId, TeamMessageIdSchema, TeamSourceSchema } from "@opensteer/core";
import { team_read, team_reply, team_search, sql } from "@opensteer/agent-tools/tools";
import {
  PersonalTeamRequestSchema,
  TeamMessagePageSchema,
  type TeamMessage,
} from "@opensteer/protocol";
import { PersonalTeamToolAdapter } from "./team-tool-adapter.js";

function fixture() {
  const source = TeamSourceSchema.parse({
    teamId: createId("deployment"),
    channelId: createId("teamChannel"),
    threadRootId: "1",
    messageId: "2",
    audience: {
      teamName: "Acme",
      channelName: "research",
      channelKind: "private",
      memberCount: 4,
      peopleOnly: false,
    },
  });
  const run = {
    teamId: source.teamId,
    requestId: createId("teamAgentRequest"),
    runId: createId("run"),
  };
  const request = PersonalTeamRequestSchema.parse({
    teamId: run.teamId,
    requestId: run.requestId,
    triggerMessageId: source.messageId,
    taskId: createId("thread"),
    inputId: createId("message"),
    runId: run.runId,
    source,
    terminalState: null,
    publicationState: "pending",
    replyMessageId: null,
  });
  const page = TeamMessagePageSchema.parse({
    messages: [],
    hasMore: false,
    throughSeq: "91",
    channel: {
      id: source.channelId,
      kind: "private",
      name: "research",
      peopleOnly: false,
      archivedAt: null,
      changeSeq: "91",
      latestMessageId: "50",
      instructionsMarkdown: "",
      instructionsRevision: "1",
      can: { read: true, post: true, manage: false, join: false, leave: false, wakeOwnAgent: true },
    },
  });
  const blobId = createId("teamBlob");
  const uploads: string[] = [];
  const wire: unknown[] = [];
  let replyId: ReturnType<typeof TeamMessageIdSchema.parse> | null = null;
  let lostAck = false;
  const messages = Array.from({ length: 50 }, (_, index) => ({
    id: TeamMessageIdSchema.parse(String(index + 1)),
    channelId: source.channelId,
    threadRootId: source.threadRootId,
    authorUserId: createId("user"),
    authorKind: "human" as const,
    agentRequestId: null,
    clientMessageId: crypto.randomUUID(),
    bodyMarkdown: "a".repeat(16_384),
    plainText: "a".repeat(16_384),
    createdAt: "2026-11-11T12:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    changeSeq: page.throughSeq,
    mentions: [],
    attachments: [],
    pinned: false,
    replySummary: { count: 0, latestMessageId: null, repliers: [] },
    requests: [],
  }));
  const tools: ConstructorParameters<typeof PersonalTeamToolAdapter>[0] = {
    async authority(id) {
      if (id !== run.runId) throw new Error("no team request in this turn");
      return request;
    },
    async receipt() {
      return replyId ? { messageId: replyId, source } : null;
    },
    async read(_id, input) {
      const selected =
        input.channelId === source.channelId && input.threadRootId === source.threadRootId
          ? messages.filter((m) => !input.before || BigInt(m.id) < BigInt(input.before))
          : [];
      return { page: { ...page, messages: selected }, source };
    },
    async search() {
      return { results: [], hasMore: false };
    },
    async sql(_id, input) {
      wire.push(input);
      return { columns: [], rows: [], truncated: false };
    },
    async reply(_id, bodyMarkdown, attachmentIds) {
      wire.push({ bodyMarkdown, attachmentIds });
      replyId = TeamMessageIdSchema.parse("99");
      if (lostAck) throw new Error("connection lost after commit");
      return { messageId: replyId, source };
    },
  };
  const adapter = new PersonalTeamToolAdapter(tools, {
    async fetch() {
      return {
        path: "/private/attachment-cache/public.txt",
        source,
        file: {
          id: blobId,
          channelId: source.channelId,
          filename: "public.txt",
          mediaType: "text/plain",
          sizeBytes: 5,
          sha256: "a".repeat(64),
          preview: null,
        },
        attachment: {
          type: "artifact",
          artifactId: "artifact",
          name: "public.txt",
          mediaType: "text/plain",
        },
      };
    },
    async uploadPath(_id, path) {
      uploads.push(path);
      if (path !== "/private/EXPLICIT_FILE") throw new Error("path not admitted for Run");
      return {
        source,
        file: {
          id: blobId,
          channelId: source.channelId,
          filename: "public.txt",
          mediaType: "text/plain",
          sizeBytes: 5,
          sha256: "a".repeat(64),
          preview: null,
        },
      };
    },
  });
  return {
    adapter,
    tools,
    run,
    source,
    messages,
    uploads,
    wire,
    loseAck() {
      lostAck = true;
    },
  };
}

describe("Run-bound team tool adapter", () => {
  it("keeps provenance on empty search/SQL and forwards write mode without widening Run authority", async () => {
    const f = fixture();
    const found = await f.adapter.search(f.run, team_search.input.parse({ query: "missing" }));
    expect(team_search.output.parse(found)).toMatchObject({ results: [], source: f.source });
    const input = sql.input.parse({
      mode: "write",
      sql: "select 1",
      operationId: crypto.randomUUID(),
    });
    expect(sql.output.parse(await f.adapter.sql(f.run, input))).toMatchObject({
      rows: [],
      source: f.source,
    });
    expect(f.wire).toEqual([input]);
    await expect(
      f.adapter.sql({ ...f.run, requestId: createId("teamAgentRequest") }, input),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.adapter.sql({ ...f.run, teamId: createId("deployment") }, input),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.adapter.sql({ ...f.run, runId: createId("run") }, input)).rejects.toThrow(
      "no team request in this turn",
    );
    expect(f.wire).toHaveLength(1);
  });

  it("paginates a byte-bounded asking-thread page without losing messages or its snapshot fence", async () => {
    const f = fixture();
    const seen: string[] = [];
    let before: ReturnType<typeof TeamMessageIdSchema.parse> | undefined;
    for (let index = 0; index < 50; index++) {
      const result = team_read.output.parse(await f.adapter.read(f.run, before ? { before } : {}));
      if (!("page" in result)) throw new Error("Expected page");
      expect(result.page.throughSeq).toBe("91");
      expect(result.source).toEqual(f.source);
      seen.unshift(...result.page.messages.map((m: TeamMessage) => m.id));
      if (!result.page.hasMore) break;
      expect(result.page.messages.length).toBeGreaterThan(0);
      before = result.page.messages[0]!.id;
    }
    expect(seen).toEqual(f.messages.map((m) => m.id));
    const file = await f.adapter.read(f.run, { fileId: createId("teamBlob") });
    expect(file).toEqual({ path: "/private/attachment-cache/public.txt", source: f.source });
    expect(JSON.stringify(file)).not.toMatch(/sha256|artifactId|Bearer|https:/);
  });

  it("uploads only explicit admitted paths and recovers an uncertain reply before any repeated upload", async () => {
    const f = fixture();
    f.loseAck();
    const input = team_reply.input.parse({
      bodyMarkdown: "The answer",
      attachmentPaths: ["/private/EXPLICIT_FILE"],
    });
    await expect(f.adapter.reply(f.run, input)).rejects.toThrow("connection lost after commit");
    expect(team_reply.output.parse(await f.adapter.reply(f.run, input))).toEqual({
      messageId: "99",
      source: f.source,
    });
    expect(f.uploads).toEqual(["/private/EXPLICIT_FILE"]);
    expect(f.wire).toHaveLength(1);
    expect(JSON.stringify(f.wire)).not.toMatch(/EXPLICIT_FILE|private|attachmentPaths|Bearer/);
    const rejected = fixture();
    await expect(
      rejected.adapter.reply(rejected.run, {
        bodyMarkdown: "answer",
        attachmentPaths: ["/not/admitted"],
      }),
    ).rejects.toThrow("path not admitted");
    expect(rejected.wire).toHaveLength(0);
  });

  it("preserves hit sources and the asking audience and obeys cancellation", async () => {
    const f = fixture();
    const other = {
      ...f.source,
      channelId: createId("teamChannel"),
      audience: { ...f.source.audience, channelName: "another" },
    };
    f.tools.search = async () => ({
      results: [{ message: f.messages[0]!, source: other }],
      hasMore: false,
    });
    f.tools.sql = async () => ({ columns: [], rows: [], truncated: false });
    expect(
      (await f.adapter.search(f.run, team_search.input.parse({ query: "a" }))).results[0]!.source,
    ).toEqual(other);
    expect(await f.adapter.sql(f.run, sql.input.parse({}))).toEqual({
      columns: [],
      rows: [],
      truncated: false,
      source: f.source,
    });
    await expect(
      f.adapter.reply(
        f.run,
        team_reply.input.parse({ bodyMarkdown: "answer" }),
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(f.wire).toHaveLength(0);
  });
});
