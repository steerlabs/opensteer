import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
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

it("serves bidirectional attachments and previews to people and agents through their own Host, with no remote cache", async () => {
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
    expect(await readdir(join(f.a.directory, "team-files"))).toEqual([]);
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
      const service = f.b.host.team.shares!.files!;
      const original = service.receive.bind(service),
        entered = Promise.withResolvers<void>();
      vi.spyOn(service, "receive").mockImplementation(async (link, op) => {
        if (op.offset) {
          entered.resolve();
          await withTimeout(release.promise, 3000, {
            timeoutError: () => new Error("Peer transfer gate never released"),
          });
        }
        return original(link, op);
      });
      const fetching = f.a.host.team.files.download(actor, remote.id, "original");
      const settled = fetching.then(
        () => "delivered",
        () => "aborted",
      );
      await withTimeout(entered.promise, 2000, {
        timeoutError: () => new Error("Partner never read the second chunk"),
      });
      await expect(
        f.a.host.team.files.download(actor, remote.id, "original"),
      ).rejects.toMatchObject({
        code: "resource_exhausted",
        reason: "shared-channel-file-limit",
      });
      await command(side === "receiver" ? f.aSession : f.bSession, {
        type: "team.share.end",
        shareId: f.shareId,
      });
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
    const { TeamFilesStore } = await import("../packages/database/src/team-files-store.js");
    const quota = new TeamFilesStore(f.b.host.team.access, { storageLimitBytes: bytes.length + 1 });
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
