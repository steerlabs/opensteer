import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import type { WebSocket } from "ws";
import { Readable } from "node:stream";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { teamApiVersion } from "@opensteer/deployment-authority";
import { TeamFilesStore } from "@opensteer/database/team-files";
import { TeamFileService } from "../team/file-service.js";
import { createTeamMachineAdapters } from "../team/machine-adapters.js";
import { TeamLinkBinary } from "./binary.js";
import { teamLinkMaxFrameBytes, type TeamLinkCall } from "./contracts.js";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createId } from "@opensteer/core";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamChatStore } from "@opensteer/database/team-chat";
import { TeamRequestsStore } from "@opensteer/database/team-requests";
import { TeamLinkEndpoint } from "./endpoint.js";
import { TeamEndpointLinks } from "./links.js";
import { TeamLinkLifetimes } from "./lifetimes.js";

it("accepts a queued request before exposing its wake context", async () => {
  const fixture = await createTeamKnowledgeFixture();
  try {
    const access = new TeamAccessStore(fixture.database);
    await access.initialize();
    const chat = new TeamChatStore(access, {
      teamId: fixture.deploymentId,
      teamName: "Acme",
    });
    const requests = new TeamRequestsStore(access, chat);
    const actor = { kind: "human" as const, userId: fixture.userId };
    const channel = await chat.create(actor, {
      id: createId("teamChannel"),
      name: "support",
      kind: "public",
      peopleOnly: false,
      access: [],
    });
    const linkId = createId("teamLink");
    await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash,code_expires_at) values(${linkId},${fixture.userId},${createId("deployment")},'active',${randomUUID()},${randomUUID()},now())`.execute(
      fixture.database,
    );
    await chat.send(actor, {
      channelId: channel.id,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@maya-agent help",
      mentions: [{ kind: "agent", userId: fixture.userId }],
      attachmentIds: [],
    });
    const request = (await requests.pending(linkId))[0]!.request;
    const knowledgeCalls: unknown[] = [];
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected data call");
    };
    const endpoint = new TeamLinkEndpoint({
      links: new TeamEndpointLinks(fixture.database, access, "Acme"),
      requests,
      access,
      resolver: access,
      lifetimes: new TeamLinkLifetimes(),
      data: {
        channels: unavailable,
        read: unavailable,
        search: unavailable,
        async knowledge(id, ownerUserId, frame) {
          knowledgeCalls.push({ linkId: id, ownerUserId, frame });
          return { result: { kind: "knowledge.topics", result: { topics: [] } } };
        },
      },
    });
    const context = () =>
      endpoint.call(linkId, { type: "context", id: randomUUID(), requestId: request.id });
    await expect(context()).rejects.toMatchObject({ code: "forbidden" });
    const accept = () =>
      endpoint.call(linkId, { type: "accept", id: randomUUID(), requestId: request.id });
    const accepted = await accept();
    expect(accepted).toMatchObject({ kind: "accepted", request: { state: "working" } });
    expect(await accept()).toEqual(accepted);
    expect(await context()).toMatchObject({
      kind: "context",
      context: { request: { id: request.id } },
    });
    await chat.update(actor, channel.id, { peopleOnly: true });
    await expect(accept()).rejects.toMatchObject({ code: "forbidden" });
    // Knowledge acts as the link's owner from any of their Runs: no live request is needed,
    // and one that is named only travels on as provenance.
    const topics = { type: "knowledge.topics" as const, id: randomUUID() };
    expect(await endpoint.call(linkId, topics)).toEqual({
      kind: "knowledge.topics",
      result: { topics: [] },
    });
    await endpoint.call(linkId, { ...topics, requestId: request.id });
    expect(knowledgeCalls).toEqual([
      { linkId, ownerUserId: fixture.userId, frame: topics },
      { linkId, ownerUserId: fixture.userId, frame: { ...topics, requestId: request.id } },
    ]);
    await sql`update team_links set state='revoked' where id=${linkId}`.execute(fixture.database);
    await expect(endpoint.call(linkId, topics)).rejects.toThrow();
    expect(knowledgeCalls).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

describe("standing team link authority", () => {
  let fixture: Awaited<ReturnType<typeof createTeamKnowledgeFixture>>;
  let access: TeamAccessStore;
  let chat: TeamChatStore;
  let requests: TeamRequestsStore;
  let endpoint: TeamLinkEndpoint;
  let files: TeamFileService;
  let binary: TeamLinkBinary;
  let directory: string;
  let linkId: ReturnType<typeof createId<"teamLink">>;
  let channelId: ReturnType<typeof createId<"teamChannel">>;
  let credential: string;
  const runId = createId("run");
  beforeEach(async () => {
    fixture = await createTeamKnowledgeFixture();
    access = new TeamAccessStore(fixture.database);
    await access.initialize();
    chat = new TeamChatStore(access, { teamId: fixture.deploymentId, teamName: "Acme" });
    requests = new TeamRequestsStore(access, chat);
    directory = await mkdtemp(join(tmpdir(), "opensteer-ws1-files-"));
    files = new TeamFileService(new TeamFilesStore(access), access, directory);
    credential = `ost_link_${"a".repeat(43)}`;
    linkId = createId("teamLink");
    await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash,code_expires_at)
      values(${linkId},${fixture.userId},${createId("deployment")},'active',${randomUUID()},${createHash("sha256").update(credential).digest("hex")},now())`.execute(
      fixture.database,
    );
    channelId = (
      await chat.create(
        { kind: "human", userId: fixture.userId },
        {
          id: createId("teamChannel"),
          name: "standing",
          kind: "private",
          peopleOnly: false,
          access: [],
        },
      )
    ).id;
    const adapters = createTeamMachineAdapters(
      { access, chat, files },
      {
        async topics() {
          throw new Error("Unexpected knowledge call");
        },
        async readNotes() {
          throw new Error("Unexpected knowledge call");
        },
        async write() {
          throw new Error("Unexpected knowledge call");
        },
      },
    );
    const lifetimes = new TeamLinkLifetimes();
    access.onRevoke((effects) => lifetimes.close(effects));
    endpoint = new TeamLinkEndpoint({
      links: new TeamEndpointLinks(fixture.database, access, "Acme"),
      requests,
      access,
      resolver: access,
      lifetimes,
      data: adapters.data,
    });
    binary = new TeamLinkBinary(endpoint, adapters.files, access);
  });
  afterEach(async () => {
    endpoint?.options.lifetimes.stop();
    files?.close();
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  function human() {
    return { kind: "human" as const, userId: fixture.userId };
  }
  function post(overrides: Partial<Extract<TeamLinkCall, { type: "post" }>> = {}) {
    return {
      type: "post" as const,
      id: randomUUID(),
      runId,
      channelId,
      clientMessageId: randomUUID(),
      bodyMarkdown: "standing answer",
      attachmentIds: [],
      ...overrides,
    };
  }
  async function wake() {
    const sent = await chat.send(human(), {
      channelId,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@maya-agent trigger words",
      attachmentIds: [],
      mentions: [{ kind: "agent", userId: fixture.userId }],
    });
    const pending = (await requests.pending(linkId)).find(
      (r) => r.request.triggerMessageId === sent.message.id,
    )!;
    expect(pending).toMatchObject({ bodyMarkdown: "@maya-agent trigger words", attachments: [] });
    await requests.accept(linkId, pending.request.id);
    const context = await requests.context(linkId, pending.request.id);
    expect(context).not.toHaveProperty("messages");
    return pending.request;
  }
  function headers() {
    return {
      authorization: `Bearer ${credential}`,
      "x-opensteer-team-api-version": String(teamApiVersion),
      "x-opensteer-team-run-id": runId,
      "x-opensteer-team-operation-id": randomUUID(),
    };
  }
  it("reads, searches and posts without a ticket, audits attribution, and refuses live access loss", async () => {
    const read = {
      type: "read" as const,
      id: randomUUID(),
      operationId: randomUUID(),
      runId,
      channelId,
    };
    expect(await endpoint.call(linkId, read)).toMatchObject({
      kind: "read",
      result: { page: { messages: [] } },
    });
    const frame = post();
    const first = await endpoint.call(linkId, frame);
    expect(await endpoint.call(linkId, { ...frame, id: randomUUID() })).toEqual(first);
    expect(await endpoint.call(linkId, read)).toMatchObject({
      kind: "read",
      result: { page: { messages: [{ bodyMarkdown: frame.bodyMarkdown }] } },
    });
    expect(
      await endpoint.call(linkId, {
        type: "search",
        id: randomUUID(),
        runId,
        input: { query: "standing", channelId },
      }),
    ).toMatchObject({
      kind: "search",
      result: { results: [{ message: { bodyMarkdown: frame.bodyMarkdown } }] },
    });
    expect(
      await fixture.database
        .selectFrom("teamMessages")
        .selectAll()
        .where("clientMessageId", "=", frame.clientMessageId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      agentLinkId: linkId,
      callerRunId: runId,
      operationId: frame.clientMessageId,
      personalDeploymentId: (
        await fixture.database
          .selectFrom("teamLinks")
          .select("personalDeploymentId")
          .where("id", "=", linkId)
          .executeTakeFirstOrThrow()
      ).personalDeploymentId,
    });
    const audit = await fixture.database
      .selectFrom("teamAudit")
      .selectAll()
      .where("operationId", "=", frame.clientMessageId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: fixture.userId,
      linkId,
      callerRunId: runId,
      outcome: "allowed",
      agentRequestId: null,
    });
    expect(audit[0]!.metadata).toHaveProperty("personalDeploymentId");
    expect(
      await fixture.database
        .selectFrom("teamAudit")
        .selectAll()
        .where("operationId", "=", read.operationId)
        .execute(),
    ).toEqual([
      expect.objectContaining({
        linkId,
        callerRunId: runId,
        action: "agent.read",
        outcome: "allowed",
      }),
      expect.objectContaining({
        linkId,
        callerRunId: runId,
        action: "agent.read",
        outcome: "allowed",
      }),
    ]);
    const rejected = post();
    await sql`create function reject_successful_agent_audit() returns trigger language plpgsql as $$
      begin if new.action='agent.post' and new.outcome='allowed' then raise exception 'audit unavailable'; end if; return new; end $$;
      create trigger reject_successful_agent_audit before insert on team_audit for each row execute function reject_successful_agent_audit()`.execute(
      fixture.database,
    );
    try {
      await expect(endpoint.call(linkId, rejected)).rejects.toThrow("audit unavailable");
      expect(
        await fixture.database
          .selectFrom("teamMessages")
          .select("id")
          .where("clientMessageId", "=", rejected.clientMessageId)
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`drop trigger reject_successful_agent_audit on team_audit; drop function reject_successful_agent_audit()`.execute(
        fixture.database,
      );
    }

    await chat.update(human(), channelId, { peopleOnly: true });
    await expect(endpoint.call(linkId, read)).rejects.toMatchObject({ code: "forbidden" });
    await expect(endpoint.call(linkId, post())).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      endpoint.call(linkId, {
        type: "search",
        id: randomUUID(),
        runId,
        input: { query: "standing", channelId },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await endpoint.call(linkId, { type: "channels", id: randomUUID(), runId }),
    ).toMatchObject({ kind: "channels", result: { channels: [] } });
    await endpoint.options.links.revoke(linkId);
    await expect(endpoint.call(linkId, read)).rejects.toThrow();
  });
  it("claims the designated reply atomically without ending the Run, suppresses publication and keeps later posts ordinary", async () => {
    const request = await wake();
    const target = { requestId: request.id, threadRootId: request.threadRootId };
    await expect(
      endpoint.call(linkId, post({ ...target, attachmentIds: [createId("teamBlob")] })),
    ).rejects.toThrow();
    expect(await requests.receipt(linkId, request.id)).toBeNull();
    const first = post(target);
    const second = post(target);
    const receipts = await Promise.all([
      endpoint.call(linkId, first),
      endpoint.call(linkId, second),
    ]);
    expect(receipts[0]).not.toEqual(receipts[1]);
    const claimed = await requests.receipt(linkId, request.id);
    expect(receipts).toContainEqual({ kind: "receipt", messageId: claimed });
    expect(await requests.authorize(linkId, request.id, "status")).toMatchObject({
      state: "working",
      finishedAt: null,
    });
    expect(await endpoint.call(linkId, first)).toEqual(receipts[0]);
    expect(await endpoint.call(linkId, post({ ...target, publication: true }))).toEqual({
      kind: "receipt",
      messageId: claimed,
    });
    expect(await requests.receipt(linkId, request.id)).toBe(claimed);
    const later = await endpoint.call(linkId, post(target));
    expect(later).not.toEqual({ kind: "receipt", messageId: claimed });
    const rows = await fixture.database
      .selectFrom("teamMessages")
      .select("id")
      .where("authorKind", "=", "agent")
      .execute();
    expect(rows).toHaveLength(3);
    await expect(endpoint.call(linkId, post({ requestId: request.id }))).rejects.toThrow();
    const cancelled = await wake();
    await requests.cancel(linkId, cancelled.id);
    await expect(
      endpoint.call(
        linkId,
        post({ requestId: cancelled.id, threadRootId: cancelled.threadRootId, publication: true }),
      ),
    ).rejects.toThrow();
  });
  it("discards a buffered standing read after access removal returns", async () => {
    await endpoint.call(linkId, post());
    const buffered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = endpoint.options.data.read;
    endpoint.options.data.read = async (...args) => {
      const page = await read(...args);
      buffered.resolve();
      await withTimeout(release.promise, 5000, {
        timeoutError: () => new Error("Standing read was not released"),
      });
      return page;
    };
    const outcome = endpoint
      .call(linkId, { type: "read", id: randomUUID(), runId, channelId })
      .then(
        () => "delivered",
        () => "denied",
      );
    await withTimeout(buffered.promise, 5000, {
      timeoutError: () => new Error("Standing read did not buffer"),
    });
    try {
      await chat.setAccess(human(), channelId, access.revision, []);
    } finally {
      release.resolve();
    }
    expect(await outcome).toBe("denied");
  });
  it("bounds trigger batches by encoded bytes and rejects an old hello before parsing its body", async () => {
    class Socket extends EventEmitter {
      bufferedAmount = 0;
      frames: string[] = [];
      send(frame: string) {
        this.frames.push(frame);
        this.emit("sent");
      }
      close() {
        queueMicrotask(() => this.emit("close"));
      }
      terminate() {
        this.emit("close");
      }
    }
    const old = new Socket();
    await endpoint.attach(old as unknown as WebSocket, linkId);
    const closed = once(old, "close");
    old.emit("message", Buffer.from(JSON.stringify({ type: "hello", teamApiVersion: 3 })), false);
    await withTimeout(closed, 5000, { timeoutError: () => new Error("Old link was not refused") });
    expect(old.frames).toEqual([]);
    for (let i = 0; i < 20; i++) {
      if (i === 10)
        await fixture.database
          .updateTable("teamAgentRequests")
          .set({ createdAt: new Date(Date.now() - 120000) })
          .execute();
      await chat.send(human(), {
        channelId,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "@maya-agent " + "x".repeat(16372),
        attachmentIds: [],
        mentions: [{ kind: "agent", userId: fixture.userId }],
      });
    }
    const socket = new Socket();
    await endpoint.attach(socket as unknown as WebSocket, linkId);
    const delivered = Promise.withResolvers<void>();
    socket.on("sent", () => {
      const count = socket.frames
        .map((frame) => JSON.parse(frame) as { type: string; requests?: unknown[] })
        .filter((frame) => frame.type === "requests")
        .reduce((sum, frame) => sum + frame.requests!.length, 0);
      if (count === 20) delivered.resolve();
    });
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "hello", teamApiVersion: teamApiVersion + 1, terminalRequests: [] }),
      ),
      false,
    );
    await withTimeout(delivered.promise, 5000, {
      timeoutError: () => new Error("Trigger batches were not delivered"),
    });
    expect(
      socket.frames.filter((frame) => JSON.parse(frame).type === "requests").length,
    ).toBeGreaterThan(1);
    expect(socket.frames.every((frame) => Buffer.byteLength(frame) <= teamLinkMaxFrameBytes)).toBe(
      true,
    );
    expect(endpoint.isOnline(fixture.userId)).toBe(true);
    socket.emit("close");
  });
  it("drains more than one page of returns after acknowledgements without resending consent", async () => {
    const sender = await fixture.member("Alex");
    await chat.setAccess(human(), channelId, access.revision, [
      { subject: { kind: "person", userId: fixture.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: sender }, level: "post", manage: false },
    ]);
    await chat.send(
      { kind: "human", userId: sender },
      {
        channelId,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "@maya-agent help",
        mentions: [],
        attachmentIds: [],
      },
    );
    const consent = (await requests.pending(linkId))[0]!;
    const returns = Array.from({ length: 205 }, () => ({
      id: createId("teamAgentRequest"),
      kind: "return" as const,
      ownerUserId: fixture.userId,
      channelId,
      threadRootId: consent.request.threadRootId,
      triggerMessageId: consent.request.triggerMessageId,
      linkId,
      state: "queued" as const,
      steps: sql<[]>`'[]'::jsonb`,
      changeSeq: "1",
      returnPayload: {
        originAskId: createId("teamAgentRequest"),
        resumeRunId: runId,
        outcome: "declined" as const,
        bodyMarkdown: null,
        attachments: [],
        author: { teamUserId: sender, displayName: "Alex", actor: "agent" as const },
      },
    }));
    // The origin rows need only supply the publication lookup; returns cannot recursively return.
    for (const row of returns) row.returnPayload.originAskId = row.id;
    await fixture.database.insertInto("teamAgentRequests").values(returns).execute();
    class Socket extends EventEmitter {
      bufferedAmount = 0;
      delivered = new Map<string, number>();
      completed = new Set<string>();
      pending: string[] = [];
      accepting = false;
      acceptNext() {
        if (this.accepting) return;
        const id = this.pending.shift();
        if (!id) return;
        this.accepting = true;
        this.emit(
          "message",
          Buffer.from(JSON.stringify({ type: "accept", id, requestId: id })),
          false,
        );
      }
      drained = Promise.withResolvers<void>();
      send(encoded: string) {
        const frame = JSON.parse(encoded);
        if (frame.type === "requests")
          for (const item of frame.requests) {
            const id = item.request.id as string;
            this.delivered.set(id, (this.delivered.get(id) ?? 0) + 1);
            if (item.request.kind === "return") {
              this.pending.push(id);
              queueMicrotask(() => this.acceptNext());
            }
          }
        if (frame.type === "result") {
          this.completed.add(frame.id);
          this.accepting = false;
          queueMicrotask(() => this.acceptNext());
          if (this.completed.size === returns.length) this.drained.resolve();
        }
      }
      close() {
        this.emit("close");
      }
      terminate() {
        this.emit("close");
      }
    }
    const socket = new Socket();
    await endpoint.attach(socket as unknown as WebSocket, linkId);
    try {
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "hello", teamApiVersion, terminalRequests: [] })),
        false,
      );
      await withTimeout(socket.drained.promise, 5000, {
        timeoutError: () =>
          new Error(`Only ${socket.completed.size} of 205 returns were acknowledged`),
      });
      expect(socket.delivered.get(consent.request.id)).toBe(1);
      expect([...socket.delivered.values()].every((count) => count === 1)).toBe(true);
      expect((await requests.pending(linkId)).map((item) => item.request.id)).toEqual([
        consent.request.id,
      ]);
    } finally {
      socket.close();
    }
  });

  it("uploads and downloads under standing authority, binds only the same uploader and channel, and closes revoked streams", async () => {
    const metadata = {
      channelId,
      clientUploadId: randomUUID(),
      filename: "notes.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      sha256: createHash("sha256").update("hello").digest("hex"),
      previewSizeBytes: 0,
    };
    const uploadHeaders = headers();
    const uploaded = await binary.upload(
      {
        ...uploadHeaders,
        "content-type": "multipart/form-data; boundary=b",
        "x-opensteer-team-upload": JSON.stringify(metadata),
      },
      Readable.from([
        '--b\r\nContent-Disposition: form-data; name="original"; filename="notes.txt"\r\n\r\nhello\r\n--b--\r\n',
      ]),
      new AbortController().signal,
    );
    expect(
      await fixture.database
        .selectFrom("teamBlobs")
        .selectAll()
        .where("id", "=", uploaded.file.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ agentLinkId: linkId, callerRunId: runId, agentRequestId: null });
    expect(
      await fixture.database
        .selectFrom("teamAudit")
        .selectAll()
        .where("operationId", "=", uploadHeaders["x-opensteer-team-operation-id"])
        .execute(),
    ).toEqual([
      expect.objectContaining({
        action: "file.upload",
        callerRunId: runId,
        linkId,
        outcome: "allowed",
      }),
    ]);
    const request = await wake();
    await endpoint.call(
      linkId,
      post({
        requestId: request.id,
        threadRootId: request.threadRootId,
        attachmentIds: [uploaded.file.id],
      }),
    );
    const otherChannel = await chat.create(human(), {
      id: createId("teamChannel"),
      name: "other",
      kind: "private",
      peopleOnly: false,
      access: [],
    });
    await expect(
      endpoint.call(
        linkId,
        post({ channelId: otherChannel.id, attachmentIds: [uploaded.file.id] }),
      ),
    ).rejects.toThrow();
    await expect(
      chat.send(human(), {
        channelId,
        threadRootId: null,
        clientMessageId: randomUUID(),
        bodyMarkdown: "wrong uploader kind",
        mentions: [],
        attachmentIds: [uploaded.file.id],
      }),
    ).rejects.toThrow();
    const otherUserId = await fixture.member("OtherUploader");
    const otherLinkId = createId("teamLink");
    await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash,code_expires_at)
      values(${otherLinkId},${otherUserId},${createId("deployment")},'active',${randomUUID()},${randomUUID()},now())`.execute(
      fixture.database,
    );
    await chat.setAccess(human(), channelId, access.revision, [
      { subject: { kind: "person", userId: fixture.userId }, level: "post", manage: true },
      { subject: { kind: "person", userId: otherUserId }, level: "post", manage: false },
    ]);
    await expect(
      endpoint.call(otherLinkId, post({ attachmentIds: [uploaded.file.id] })),
    ).rejects.toThrow();
    await expect(
      endpoint.call(
        otherLinkId,
        post({ requestId: request.id, threadRootId: request.threadRootId }),
      ),
    ).rejects.toThrow();
    const downloadHeaders = headers();
    const download = await binary.download(
      {
        ...downloadHeaders,
        "x-opensteer-team-blob-id": uploaded.file.id,
        "x-opensteer-team-file-part": "original",
      },
      new AbortController().signal,
    );
    expect(
      await fixture.database
        .selectFrom("teamAudit")
        .selectAll()
        .where("operationId", "=", downloadHeaders["x-opensteer-team-operation-id"])
        .execute(),
    ).toEqual([
      expect.objectContaining({
        action: "file.read",
        callerRunId: runId,
        linkId,
        outcome: "allowed",
      }),
    ]);
    download.bytes.on("error", () => {});
    const closed = once(download.bytes, "close").catch(() => undefined);
    await chat.update(human(), channelId, { peopleOnly: true });
    expect(download.bytes.destroyed).toBe(true);
    await withTimeout(closed, 5000, {
      timeoutError: () => new Error("Revoked standing download did not close"),
    });
    await chat.update(human(), channelId, { peopleOnly: false });
    const started = Promise.withResolvers<void>();
    const begin = files.store.begin.bind(files.store);
    vi.spyOn(files.store, "begin").mockImplementation(async (...args) => {
      const row = await begin(...args);
      started.resolve();
      return row;
    });
    const incoming = new Readable({ read() {} });
    incoming.push(
      '--b\r\nContent-Disposition: form-data; name="original"; filename="notes.txt"\r\n\r\nh',
    );
    const interrupted = binary
      .upload(
        {
          ...headers(),
          "content-type": "multipart/form-data; boundary=b",
          "x-opensteer-team-upload": JSON.stringify({ ...metadata, clientUploadId: randomUUID() }),
        },
        incoming,
        new AbortController().signal,
      )
      .then(
        () => "uploaded",
        () => "cancelled",
      );
    await withTimeout(started.promise, 5000, {
      timeoutError: () => new Error("Standing upload did not start"),
    });
    await endpoint.options.links.revoke(linkId);
    expect(incoming.destroyed).toBe(true);
    expect(
      await withTimeout(interrupted, 5000, {
        timeoutError: () => new Error("Revoked upload kept running"),
      }),
    ).toBe("cancelled");
  });
});
