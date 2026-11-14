import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { sharedFixture } from "./team-shares.test-support.js";
import { command } from "./team-partners.test-support.js";
import {
  createId,
  SequenceSchema,
  type TeamBlobId,
  type TeamChannelId,
} from "../packages/core/src/index.js";
import {
  TeamFileSchema,
  teamBinaryRoutes,
  teamShareFileChunkBytes,
} from "../packages/protocol/src/index.js";
import {
  teamApiVersion,
  teamApiVersionHeader,
} from "../packages/deployment-authority/src/index.js";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { TeamFilesStore } from "../packages/database/src/team-files-store.js";
import { TeamFileService } from "../apps/host/src/team/file-service.js";

type Fixture = Awaited<ReturnType<typeof sharedFixture>>;
type Host = Fixture["a"];
type Session = Fixture["aSession"];
const version = { [teamApiVersionHeader]: String(teamApiVersion) };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function upload(
  host: Host,
  session: Session,
  channelId: TeamChannelId,
  bytes: Buffer,
  preview?: Buffer,
) {
  const response = await fetch(new URL(`/v1/team/files/upload/${channelId}`, host.origin), {
    method: "POST",
    headers: {
      ...session.headers,
      ...version,
      "content-type": "application/octet-stream",
      "x-opensteer-team-upload": JSON.stringify({
        clientUploadId: randomUUID(),
        filename: preview ? "picture.png" : "file.txt",
        mediaType: preview ? "image/png" : "text/plain",
        sizeBytes: bytes.length,
        sha256: hash(bytes),
        previewSizeBytes: preview?.length ?? 0,
      }),
    },
    body: new Uint8Array(preview ? Buffer.concat([bytes, preview]) : bytes),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return TeamFileSchema.parse(await response.json());
}
async function post(session: Session, channelId: TeamChannelId, attachmentIds: TeamBlobId[]) {
  const sent = await command(session, {
    type: "team.message.send",
    channelId,
    threadRootId: null,
    clientMessageId: randomUUID(),
    bodyMarkdown: "",
    mentions: [],
    attachmentIds,
  });
  if (sent.type !== "team.message.send") throw new Error("Missing relayed message");
  return sent.message;
}
async function page(session: Session, channelId: TeamChannelId) {
  const result = await session.rpc["team.messages.page"]({
    channelId,
    page: { direction: "newest" },
  });
  if (!result.ok) throw new Error("Missing messages");
  return result.data.messages;
}
function download(host: Host, session: Session, id: TeamBlobId, part = "original") {
  return fetch(new URL(`/v1/team/files/${id}/${part}`, host.origin), {
    headers: { ...session.headers, ...version },
  });
}
async function sync(f: Fixture) {
  const shares = f.b.host.team.shares!;
  await shares.sync(await shares.store.get(f.shareId));
}
async function agent(host: Host, owner: Fixture["aUser"]) {
  const linkId = createId("teamLink"),
    credential = `ost_link_${randomBytes(32).toString("base64url")}`;
  await sql`insert into team_links(id,owner_user_id,personal_deployment_id,state,code_hash,credential_hash)
    values(${linkId},${owner},${createId("deployment")},'active',${randomUUID()},${hash(credential)})`.execute(
    host.database,
  );
  return {
    linkId,
    headers: {
      ...version,
      authorization: `Bearer ${credential}`,
      "x-opensteer-team-run-id": createId("run"),
      "x-opensteer-team-operation-id": randomUUID(),
    },
  };
}

it("pipelines a bounded chunk window, coalesces first downloads, and serves verified cached bytes without partner requests", async () => {
  const f = await sharedFixture();
  const release = Promise.withResolvers<void>();
  const downloads: Promise<unknown>[] = [];
  try {
    const bytes = Buffer.alloc(teamShareFileChunkBytes * 9 + 7, 42);
    const file = await upload(f.b, f.bSession, f.bid, bytes);
    await post(f.bSession, f.bid, [file.id]);
    const remote = (await page(f.aSession, f.aid))[0]!.attachments[0]!;
    const actor = { kind: "human" as const, userId: f.aUser };
    const service = f.b.host.team.shares!.files!;
    const receive = service.receive.bind(service);
    const entered = Promise.withResolvers<void>();
    let active = 0,
      peak = 0;
    vi.spyOn(service, "receive").mockImplementation(async (link, op) => {
      active++;
      peak = Math.max(peak, active);
      if (active === 2) entered.resolve();
      try {
        await withTimeout(release.promise, 3000, {
          timeoutError: () => new Error("Chunk window never released"),
        });
        return await receive(link, op);
      } finally {
        active--;
      }
    });
    const request = vi.spyOn(f.a.host.team.partners!, "request");
    const allocated = vi.spyOn(Buffer, "alloc");
    const first = f.a.host.team.files.download(actor, remote.id, "original");
    const second = f.a.host.team.files.download(actor, remote.id, "original");
    downloads.push(first, second);
    const results = Promise.all([first, second]);
    void results.catch(() => {});
    await withTimeout(entered.promise, 2000, {
      timeoutError: () => new Error("File transfer never pipelined two chunks"),
    });
    expect(allocated.mock.calls.every(([size]) => size < bytes.length)).toBe(true);
    release.resolve();
    for (const result of await results) {
      const chunks = [];
      for await (const chunk of result.body) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(bytes);
    }
    expect(peak).toBe(2);
    expect(request.mock.calls.filter(([, op]) => op.op === "file")).toHaveLength(10);
    request.mockClear();
    expect(Buffer.from(await (await download(f.a, f.aSession, remote.id)).arrayBuffer())).toEqual(
      bytes,
    );
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(join(f.a.directory, "team-files"))).toEqual([remote.id]);
  } finally {
    release.resolve();
    await Promise.allSettled(downloads);
    vi.restoreAllMocks();
    await f.close();
  }
});

it("reserves cache space before fetching, charges cached bytes to local uploads, and frees the reservation on disconnect", async () => {
  const f = await sharedFixture();
  const release = Promise.withResolvers<void>();
  const quota = new TeamFilesStore(f.a.host.team.access, { storageLimitBytes: 64 });
  const files = new TeamFileService(quota, f.a.host.team.access, f.a.directory);
  files.remote = f.a.host.team.shares!.files;
  const transfers: Promise<unknown>[] = [];
  try {
    const bytes = Buffer.alloc(64, 42);
    const uploaded = await upload(f.b, f.bSession, f.bid, bytes);
    const another = await upload(f.b, f.bSession, f.bid, bytes);
    await post(f.bSession, f.bid, [uploaded.id, another.id]);
    const attachments = (await page(f.aSession, f.aid))[0]!.attachments;
    const remote = attachments[0]!;
    const peer = f.b.host.team.shares!.files!;
    const receive = peer.receive.bind(peer),
      entered = Promise.withResolvers<void>();
    vi.spyOn(peer, "receive").mockImplementation(async (link, op) => {
      entered.resolve();
      await withTimeout(release.promise, 3000, {
        timeoutError: () => new Error("Cache quota transfer gate never released"),
      });
      return receive(link, op);
    });
    const actor = { kind: "human" as const, userId: f.aUser };
    const metadata = {
      clientUploadId: randomUUID(),
      filename: "one.txt",
      mediaType: "text/plain",
      sizeBytes: 1,
      sha256: hash("x"),
      previewSizeBytes: 0,
    };
    const fetching = files.download(actor, remote.id, "original");
    transfers.push(fetching);
    void fetching.catch(() => {});
    await withTimeout(entered.promise, 1000, {
      timeoutError: () => new Error("Cache never reserved space and requested bytes"),
    });
    await expect(quota.begin(actor, f.aid, metadata)).rejects.toMatchObject({
      reason: "team-storage-full",
    });
    await expect(files.download(actor, attachments[1]!.id, "original")).rejects.toMatchObject({
      reason: "team-storage-full",
    });
    expect(peer.receive).toHaveBeenCalledTimes(1);
    release.resolve();
    const result = await fetching;
    const chunks = [];
    for await (const chunk of result.body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await expect(quota.begin(actor, f.aid, metadata)).rejects.toMatchObject({
      reason: "team-storage-full",
    });
    await command(f.aSession, { type: "team.share.end", shareId: f.shareId });
    expect(await readdir(join(f.a.directory, "team-files"))).toEqual([]);
    await expect(quota.begin(actor, f.aid, metadata)).resolves.toBeDefined();
  } finally {
    release.resolve();
    await Promise.allSettled(transfers);
    await files.close();
    vi.restoreAllMocks();
    await f.close();
  }
});

it("serves bidirectional attachments and previews to people and agents through their own Host", async () => {
  const f = await sharedFixture();
  try {
    const wire = vi.spyOn(f.b.host.team.partners!, "request");
    const bytes = Buffer.from("Bravo owns these file bytes");
    const file = await upload(f.b, f.bSession, f.bid, bytes);
    const sent = await post(f.bSession, f.bid, [file.id]);
    expect(sent.attachments).toEqual([file]);
    const remote = (await page(f.aSession, f.aid))[0]!.attachments[0]!;
    expect(remote).toMatchObject({ filename: "file.txt", sizeBytes: bytes.length });
    expect(remote.id).not.toBe(file.id);
    const response = await download(f.a, f.aSession, remote.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(await readdir(join(f.a.directory, "team-files"))).toEqual([remote.id]);
    const aAgent = await agent(f.a, f.aUser);
    const agentResponse = await fetch(new URL(teamBinaryRoutes.download, f.a.origin), {
      headers: {
        ...aAgent.headers,
        "x-opensteer-team-blob-id": remote.id,
        "x-opensteer-team-file-part": "original",
      },
    });
    expect(agentResponse.status, await agentResponse.clone().text()).toBe(200);
    expect(Buffer.from(await agentResponse.arrayBuffer())).toEqual(bytes);
    const originalBatch = await f.a.host.team.shares!.store.pull(f.aLink, {
      op: "pull",
      shareId: f.shareId,
      generation: 1,
      cursor: {
        created: SequenceSchema.parse("0"),
        sequence: SequenceSchema.parse("0"),
        publicId: "",
      },
    });
    for (const forgedFile of [
      { ...originalBatch.rows[0]!.attachments[0]!, publicId: randomUUID() },
      { ...originalBatch.rows[0]!.attachments[0]!, filename: "forged.txt" },
    ]) {
      await expect(
        f.b.host.team.shares!.store.apply(
          f.bLink,
          f.shareId,
          1,
          {
            ...originalBatch,
            rows: [
              {
                ...originalBatch.rows[0]!,
                sequence: SequenceSchema.parse("100"),
                attachments: [forgedFile],
              },
            ],
          },
          false,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    const preview = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    );
    const picture = await upload(f.a, f.aSession, f.aid, preview, preview);
    await post(f.aSession, f.aid, [picture.id]);
    await sync(f);
    const imported = (await page(f.bSession, f.bid)).find(
      (m) => m.attachments[0]?.sha256 === hash(preview),
    )!.attachments[0]!;
    for (const part of ["original", "preview"]) {
      const image = await download(f.b, f.bSession, imported.id, part);
      expect(image.status, await image.clone().text()).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(preview);
    }
    const bAgent = await agent(f.b, f.bUser);
    const agentImage = await fetch(new URL(teamBinaryRoutes.download, f.b.origin), {
      headers: {
        ...bAgent.headers,
        "x-opensteer-team-blob-id": imported.id,
        "x-opensteer-team-file-part": "preview",
      },
    });
    expect(agentImage.status, await agentImage.clone().text()).toBe(200);
    expect(Buffer.from(await agentImage.arrayBuffer())).toEqual(preview);
    const agentBytes = Buffer.from("Bravo agent owns this attachment");
    const agentFile = await f.b.host.team.files.upload(
      { kind: "agent", userId: f.bUser },
      f.bid,
      {
        clientUploadId: randomUUID(),
        filename: "agent.txt",
        mediaType: "text/plain",
        sizeBytes: agentBytes.length,
        sha256: hash(agentBytes),
        previewSizeBytes: 0,
      },
      { original: Readable.from([agentBytes]) },
      undefined,
      undefined,
      { linkId: bAgent.linkId, runId: createId("run"), operationId: randomUUID() },
    );
    const agentPost = await f.b.host.team.requests.post(bAgent.linkId, {
      channelId: f.bid,
      clientMessageId: randomUUID(),
      runId: createId("run"),
      bodyMarkdown: "Agent attachment",
      attachmentIds: [agentFile.id],
    });
    expect(agentPost.messageId).toBeDefined();
    const aAgentFile = (await page(f.aSession, f.aid)).find(
      (m) => m.bodyMarkdown === "Agent attachment",
    )!.attachments[0]!;
    expect(
      Buffer.from(await (await download(f.a, f.aSession, aAgentFile.id)).arrayBuffer()),
    ).toEqual(agentBytes);
    const sentWire = JSON.stringify(wire.mock.calls);
    for (const secret of [file.id, f.bid, f.b.directory, "storageKey", "previewStorageKey"])
      expect(sentWire).not.toContain(secret);
    const filesPage = await f.bSession.rpc["team.files.page"]({ channelId: f.bid });
    expect(filesPage.ok && filesPage.data.files.some((r) => r.file.id === imported.id)).toBe(true);
  } finally {
    await f.close();
  }
});

it("refuses internal, guessed, other-channel, deleted and disconnected files without exposing identifiers", async () => {
  const f = await sharedFixture();
  try {
    const bytes = Buffer.from("Uploader retains this after disconnect");
    const file = await upload(f.b, f.bSession, f.bid, bytes);
    const sent = await post(f.bSession, f.bid, [file.id]);
    const remote = (await page(f.aSession, f.aid))[0]!.attachments[0]!;
    const peerRow = await f.b.database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("id", "=", file.id)
      .executeTakeFirstOrThrow();
    const other = createId("teamChannel");
    await command(f.bSession, {
      type: "team.channel.create",
      id: other,
      kind: "private",
      name: "unshared",
      peopleOnly: false,
      access: [],
    });
    const privateFile = await upload(f.b, f.bSession, other, bytes);
    await post(f.bSession, other, [privateFile.id]);
    const privateRow = await f.b.database
      .selectFrom("teamBlobs")
      .selectAll()
      .where("id", "=", privateFile.id)
      .executeTakeFirstOrThrow();
    const otherShare = await command(f.bSession, {
      type: "team.share.offer",
      channelId: other,
      linkId: f.bLink,
      historyVisibleConfirmed: true,
    });
    if (otherShare.type !== "team.share.offer") throw new Error("Missing other share");
    await command(f.aSession, {
      type: "team.share.accept",
      shareId: otherShare.shareId,
      id: createId("teamChannel"),
      kind: "private",
      name: "other-shared-files",
      peopleOnly: false,
      access: [],
    });
    const request = (publicId: string) =>
      f.a.host.team.partners!.request(f.aLink, {
        op: "file",
        shareId: f.shareId,
        generation: 1,
        publicId,
        part: "original",
        offset: 0,
      });
    const refused = await Promise.allSettled([
      request(randomUUID()),
      request(file.id),
      request(privateRow.publicId),
    ]);
    expect(refused.every((r) => r.status === "rejected")).toBe(true);
    expect(
      refused.map((r) =>
        r.status === "rejected"
          ? { code: r.reason.code, reason: r.reason.reason, message: r.reason.message }
          : null,
      ),
    ).toEqual(
      Array(3).fill({
        code: "forbidden",
        reason: "not-found",
        message: "Team partner connection refused",
      }),
    );
    await (await download(f.a, f.aSession, remote.id)).arrayBuffer();
    expect(await readdir(join(f.a.directory, "team-files"))).toEqual([remote.id]);
    await command(f.bSession, {
      type: "team.message.delete",
      channelId: f.bid,
      messageId: sent.id,
    });
    for (const [host, session, id] of [
      [f.a, f.aSession, remote.id],
      [f.b, f.bSession, file.id],
    ] as const)
      expect((await download(host, session, id)).status).toBe(404);
    await expect(request(peerRow.publicId)).rejects.toMatchObject({ reason: "not-found" });
    expect(await readdir(join(f.a.directory, "team-files"))).toEqual([]);
    const keep = await upload(f.b, f.bSession, f.bid, bytes);
    await post(f.bSession, f.bid, [keep.id]);
    const keepRemote = (await page(f.aSession, f.aid)).find((m) => !m.deletedAt)!.attachments[0]!;
    await (await download(f.a, f.aSession, keepRemote.id)).arrayBuffer();
    await command(f.aSession, { type: "team.share.end", shareId: f.shareId });
    expect((await download(f.a, f.aSession, keepRemote.id)).status).toBe(404);
    expect(Buffer.from(await (await download(f.b, f.bSession, keep.id)).arrayBuffer())).toEqual(
      bytes,
    );
    expect(await readdir(join(f.a.directory, "team-files"))).toEqual([]);
  } finally {
    await f.close();
  }
});

it("verifies size and digest before delivering partner bytes and reports peer outages", async () => {
  const f = await sharedFixture();
  try {
    const bytes = Buffer.alloc(teamShareFileChunkBytes + 7, 42);
    const file = await upload(f.b, f.bSession, f.bid, bytes);
    await post(f.bSession, f.bid, [file.id]);
    const remote = (await page(f.aSession, f.aid))[0]!.attachments[0]!;
    const service = f.b.host.team.shares!.files!;
    const original = service.receive.bind(service);
    const spy = vi.spyOn(service, "receive");
    for (const mode of ["short", "long", "digest"] as const) {
      spy.mockImplementation(async (link, op) => {
        const result = await original(link, op);
        const chunk = Buffer.from(result.bytes, "base64");
        if (mode === "digest") chunk[0] = chunk[0]! ^ 255;
        return {
          bytes: (mode === "short"
            ? chunk.subarray(1)
            : mode === "long"
              ? Buffer.concat([chunk, Buffer.from([1])])
              : chunk
          ).toString("base64"),
        };
      });
      const response = await download(f.a, f.aSession, remote.id);
      expect(response.status).toBe(404);
      expect(await readdir(join(f.a.directory, "team-files"))).toEqual([]);
      expect(
        await f.a.database
          .selectFrom("teamBlobs")
          .select(["cacheOriginalReserved", "cachePreviewReserved"])
          .where("id", "=", remote.id)
          .executeTakeFirst(),
      ).toEqual({ cacheOriginalReserved: false, cachePreviewReserved: false });
    }
    spy.mockRestore();
    const request = vi.spyOn(f.a.host.team.partners!, "request");
    request.mockRejectedValue(new Error("offline"));
    const offline = await download(f.a, f.aSession, remote.id);
    expect(offline.status).toBe(409);
    expect(await offline.json()).toMatchObject({ reason: "partner-unreachable", retryable: true });
    request.mockRestore();
    expect(Buffer.from(await (await download(f.a, f.aSession, remote.id)).arrayBuffer())).toEqual(
      bytes,
    );
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it.each(["receiver", "uploader"] as const)(
  "aborts an in-flight fetch and paused delivery before the %s disconnect returns, and bounds concurrency",
  async (side) => {
    const f = await sharedFixture();
    const release = Promise.withResolvers<void>();
    try {
      const bytes = Buffer.alloc(teamShareFileChunkBytes + 7, 42);
      const file = await upload(f.b, f.bSession, f.bid, bytes);
      await post(f.bSession, f.bid, [file.id]);
      const remote = (await page(f.aSession, f.aid))[0]!.attachments[0]!;
      const actor = { kind: "human" as const, userId: f.aUser };
      const paused = await f.a.host.team.files.download(actor, remote.id, "original");
      paused.body.on("error", () => {});
      const incoming: TeamBlobId[] = [];
      for (let index = 0; index < 3; index++) {
        const next = await upload(f.b, f.bSession, f.bid, bytes);
        const message = await post(f.bSession, f.bid, [next.id]);
        const attachment = (await page(f.aSession, f.aid)).find(
          (m) => m.clientMessageId === message.clientMessageId,
        )!.attachments[0]!;
        incoming.push(attachment.id);
      }
      const service = f.b.host.team.shares!.files!;
      const original = service.receive.bind(service),
        entered = Promise.withResolvers<void>(),
        secondEntered = Promise.withResolvers<void>();
      const secondRow = await f.a.database
        .selectFrom("teamBlobs")
        .select("publicId")
        .where("id", "=", incoming[1]!)
        .executeTakeFirstOrThrow();
      vi.spyOn(service, "receive").mockImplementation(async (link, op) => {
        if (op.publicId === secondRow.publicId) secondEntered.resolve();
        if (op.offset) {
          entered.resolve();
          await withTimeout(release.promise, 3000, {
            timeoutError: () => new Error("Peer transfer gate never released"),
          });
        }
        return original(link, op);
      });
      const fetching = Promise.all([
        f.a.host.team.files.download(actor, incoming[0]!, "original"),
        f.a.host.team.files.download(actor, incoming[0]!, "original"),
      ]);
      const settled = fetching.then(
        () => "delivered",
        () => "aborted",
      );
      await withTimeout(entered.promise, 2000, {
        timeoutError: () => new Error("Partner never read the second chunk"),
      });
      await vi.waitFor(
        async () => {
          const pending = (await readdir(join(f.a.directory, "team-files"))).find((name) =>
            name.startsWith("pending-"),
          );
          expect(pending, "Transfer never wrote a partial file").toBeDefined();
          expect(
            (await stat(join(f.a.directory, "team-files", pending!))).size,
            "First chunk never reached the temporary file",
          ).toBeGreaterThanOrEqual(teamShareFileChunkBytes);
        },
        { timeout: 1000 },
      );
      const second = f.a.host.team.files.download(actor, incoming[1]!, "original").catch(() => {});
      await withTimeout(secondEntered.promise, 1000, {
        timeoutError: () => new Error("Second transfer never occupied its concurrency slot"),
      });
      await expect(
        f.a.host.team.files.download(actor, incoming[2]!, "original"),
      ).rejects.toMatchObject({
        code: "resource_exhausted",
        reason: "shared-channel-file-limit",
      });
      await command(side === "receiver" ? f.aSession : f.bSession, {
        type: "team.share.end",
        shareId: f.shareId,
      });
      await second;
      expect(paused.body.destroyed).toBe(true);
      expect(
        await withTimeout(settled, 1000, {
          timeoutError: () => new Error("Revoked download did not abort"),
        }),
      ).toBe("aborted");
      expect(await readdir(join(f.a.directory, "team-files"))).toEqual([]);
    } finally {
      release.resolve();
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("re-shares files into a fresh follower channel while preserving uploader ownership and reclaiming shared storage safely", async () => {
  const f = await sharedFixture();
  try {
    const bytes = Buffer.from("Bravo keeps one physical file across its archive and re-share");
    const file = await upload(f.b, f.bSession, f.bid, bytes);
    await post(f.bSession, f.bid, [file.id]);
    const aBytes = Buffer.from("Alpha's file survives re-sharing too");
    const aFile = await upload(f.a, f.aSession, f.aid, aBytes);
    await post(f.aSession, f.aid, [aFile.id]);
    await sync(f);
    await command(f.aSession, { type: "team.share.end", shareId: f.shareId });
    const offered = await command(f.aSession, {
      type: "team.share.offer",
      channelId: f.aid,
      linkId: f.aLink,
      historyVisibleConfirmed: true,
    });
    if (offered.type !== "team.share.offer") throw new Error("Missing new share");
    const newChannel = createId("teamChannel");
    await command(f.bSession, {
      type: "team.share.accept",
      shareId: offered.shareId,
      id: newChannel,
      kind: "private",
      name: "new-shared-files",
      peopleOnly: false,
      access: [],
    });
    const messages = await page(f.bSession, newChannel);
    const local = messages.find((m) => m.attachments[0]?.sha256 === hash(bytes))!.attachments[0]!;
    const remote = messages.find((m) => m.attachments[0]?.sha256 === hash(aBytes))!.attachments[0]!;
    expect(local.id).not.toBe(file.id);
    expect(Buffer.from(await (await download(f.b, f.bSession, local.id)).arrayBuffer())).toEqual(
      bytes,
    );
    expect(Buffer.from(await (await download(f.b, f.bSession, remote.id)).arrayBuffer())).toEqual(
      aBytes,
    );
    const ownerRemote = (await page(f.aSession, f.aid)).find(
      (m) => m.attachments[0]?.sha256 === hash(bytes),
    )!.attachments[0]!;
    expect(
      Buffer.from(await (await download(f.a, f.aSession, ownerRemote.id)).arrayBuffer()),
    ).toEqual(bytes);
    const quota = new TeamFilesStore(f.b.host.team.access, {
      storageLimitBytes: bytes.length + aBytes.length + 1,
    });
    await expect(
      quota.begin({ kind: "human", userId: f.bUser }, newChannel, {
        clientUploadId: randomUUID(),
        filename: "one-byte.txt",
        mediaType: "text/plain",
        sizeBytes: 1,
        sha256: hash(Buffer.from([0])),
        previewSizeBytes: 0,
      }),
    ).resolves.toBeDefined();
    await command(f.bSession, {
      type: "team.message.delete",
      channelId: newChannel,
      messageId: messages.find((m) => m.attachments[0]?.id === local.id)!.id,
    });
    expect(Buffer.from(await (await download(f.b, f.bSession, file.id)).arrayBuffer())).toEqual(
      bytes,
    );
  } finally {
    await f.close();
  }
});
