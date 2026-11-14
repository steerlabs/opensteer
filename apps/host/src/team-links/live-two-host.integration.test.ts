import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { linkedPersonalHost } from "./personal-host.test-support.js";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { expect, it } from "vitest";
import { AesGcmCredentialVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import {
  createId,
  ModelSelectionSchema,
  HarnessIdSchema,
  type ArtifactContentPart,
} from "@opensteer/core";
import {
  createDatabase,
  admitTeamTaskRequest,
  OpensteerStore,
  needsYouPage,
  NotificationStore,
} from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { teamPreviewMaxBytes } from "@opensteer/protocol";
import { createLiveTeamFixture } from "../team/live-team.test-support.js";
import { TeamRunFileTransfers } from "./files.js";
import { TeamLinkNetwork } from "./network.js";
import { PersonalTeamVault } from "./vault.js";

it("uploads a real image and bounded preview from the personal Host and binds it to the team reply", async () => {
  const team = await createLiveTeamFixture();
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, tmpdir());
    const vault = new PersonalTeamVault(
      new AesGcmCredentialVault(
        new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
      ),
      database,
      personal.userId,
    );
    const offer = {
      teamId: team.deploymentId,
      origin: "https://team.example.invalid",
      hostKeyFingerprint: "fixture",
      code: randomBytes(32).toString("base64url"),
    };
    const sealed = await vault.prepare(offer);
    await team.database
      .updateTable("teamLinks")
      .set({ credentialHash: createHash("sha256").update(sealed.secret).digest("hex") })
      .where("id", "=", team.linkId)
      .execute();
    const links = new PersonalTeamLinksStore(database);
    await links.begin(
      {
        teamDeploymentId: team.deploymentId,
        teamHostInstanceId: team.hostInstanceId,
        hostKeyFingerprint: "fixture",
        approvedOrigin: offer.origin,
        authorityEnvelope: { teamName: "Acme" },
        credentialReference: sealed.credential.id,
        remoteLinkId: team.linkId,
        remoteOwnerUserId: team.member.userId,
        state: "active",
        lastContactAt: null,
      },
      sealed.credential,
    );
    const request = await team.ask();
    await team.team.requests.accept(team.linkId, request.id);
    const context = await team.team.requests.context(team.linkId, request.id);
    const harnessInstanceId = createId("harnessInstance");
    await database
      .insertInto("harnessInstances")
      .values({
        id: harnessInstanceId,
        environmentId: personal.environmentId,
        driverKind: HarnessIdSchema.parse("codex"),
        sourceId: "fixture",
        name: "Fixture",
        config: {},
        runtimeRevision: 1,
        stateKind: "ambient",
        enabled: true,
        isDefault: true,
      })
      .execute();
    const admitted = await admitTeamTaskRequest(database, {
      bodyMarkdown: "Team ask",
      origin: {
        teamId: team.deploymentId,
        channelId: team.channel.id,
        threadRootId: request.threadRootId,
      },
      requestId: request.id,
      triggerMessageId: request.triggerMessageId,
      source: context.source,
      ownerId: personal.userId,
      execution: {
        environmentId: personal.environmentId,
        harnessInstanceId,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          options: {},
        }),
      },
    });
    const runId = admitted.receipt.runId!;
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await new OpensteerStore(database).claimCommand(command.id, "fixture");
    const pixels = Buffer.from(
      Array.from({ length: 1024 * 768 * 3 }, (_, i) => (i * 13 + (i >> 8)) % 256),
    );
    const bytes = await sharp(pixels, { raw: { width: 1024, height: 768, channels: 3 } })
      .png()
      .toBuffer();
    const attachment: ArtifactContentPart = {
      type: "artifact",
      artifactId: createId("attachment"),
      name: "screenshot.png",
      mediaType: "image/png",
      sizeBytes: bytes.length,
    };
    class LoopbackNetwork extends TeamLinkNetwork {
      override request(
        _origin: string,
        path: string,
        input: Parameters<TeamLinkNetwork["request"]>[2],
      ): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
          const outgoing = httpRequest(
            new URL(path, team.origin),
            { method: input.method, headers: input.headers, signal: input.signal },
            (incoming) => {
              if (incoming.statusCode !== 200) {
                incoming.resume();
                reject(new Error(`Team upload failed: ${incoming.statusCode}`));
                return;
              }
              resolve(incoming);
            },
          );
          outgoing.on("error", reject);
          if (input.body instanceof Readable) void pipeline(input.body, outgoing).catch(reject);
          else outgoing.end(input.body);
        });
      }
    }
    const transfers = new TeamRunFileTransfers({
      links,
      vault,
      network: new LoopbackNetwork(),
      attachments: {
        async admitPath() {
          return attachment;
        },
        async import() {
          throw new Error("Unexpected import");
        },
        async export() {
          return {
            bytes: Readable.from([bytes]),
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        },
      },
    });
    const uploaded = await transfers.uploadPath(
      { runId, operationId: "screenshot" },
      team.deploymentId,
      request.channelId,
      "/tmp/screenshot.png",
    );
    expect(uploaded.file.preview?.sizeBytes).toBeGreaterThan(0);
    expect(uploaded.file.preview!.sizeBytes).toBeLessThanOrEqual(teamPreviewMaxBytes);
    const replied = await team.machine.endpoint.call(team.linkId, {
      type: "post",
      runId,
      clientMessageId: randomUUID(),
      channelId: request.channelId,
      threadRootId: request.threadRootId,
      id: randomUUID(),
      requestId: request.id,
      bodyMarkdown: "Screenshot",
      attachmentIds: [uploaded.file.id],
    });
    expect(replied.kind).toBe("receipt");
    const page = await team.team.chat.page(
      team.member,
      team.channel.id,
      undefined,
      request.threadRootId,
    );
    expect(
      page.messages.find((message) => message.authorKind === "agent")?.attachments[0]?.id,
    ).toBe(uploaded.file.id);
    const preview = await team.team.files.download(team.member, uploaded.file.id, "preview");
    const chunks: Buffer[] = [];
    for await (const chunk of preview.body) chunks.push(Buffer.from(chunk));
    const info = await sharp(Buffer.concat(chunks)).metadata();
    expect(info.width).toBeLessThanOrEqual(256);
    expect(info.height).toBeLessThanOrEqual(256);
    const original = await team.team.files.download(team.member, uploaded.file.id, "original");
    const originals: Buffer[] = [];
    for await (const chunk of original.body) originals.push(Buffer.from(chunk));
    expect(Buffer.concat(originals)).toEqual(bytes);
  } finally {
    await database.destroy();
    await clone.drop();
    await team.close();
  }
});

it("round-trips an agent ask through owner consent and one private authored return, including decline and a human ask", async () => {
  const team = await createLiveTeamFixture();
  const peers: Awaited<ReturnType<typeof linkedPersonalHost>>[] = [];
  try {
    await team.database
      .updateTable("users")
      .set({ displayName: "Tim" })
      .where("id", "=", team.member.userId)
      .execute();
    await team.database
      .updateTable("teamMembers")
      .set({ handle: "tim" })
      .where("userId", "=", team.member.userId)
      .execute();
    const mayaLink = await team.link(team.owner.userId);
    const tim = await linkedPersonalHost(team, team.member.userId, team.linkId);
    peers.push(tim);
    const maya = await linkedPersonalHost(team, team.owner.userId, mayaLink);
    peers.push(maya);
    const asking = await tim.runs.startTask(tim.task.threadId, "Ask Maya about the launch.");
    expect(asking.run.replyTarget).toBeNull();
    const post = await tim.tools.post(
      { runId: asking.runId, operationId: "ask-maya" },
      team.deploymentId,
      {
        channelId: team.channel.id,
        bodyMarkdown: "@maya-agent Check the launch from your notes.",
        attachmentIds: [],
      },
    );
    const ask = (await team.team.requests.pending(mayaLink))[0]!;
    expect(post.askOutcomes).toEqual([
      {
        ownerUserId: team.owner.userId,
        handle: "maya",
        requestId: ask.request.id,
        outcome: "queued",
      },
    ]);
    expect(ask.request).toMatchObject({
      kind: "ask",
      state: "awaiting_approval",
      triggerMessageId: post.messageId,
    });
    await maya.deliver();
    await maya.deliver();
    const needs = await needsYouPage(maya.database, { userId: maya.owner.userId });
    expect(needs).toMatchObject({
      count: 1,
      entries: [
        { kind: "team-ask", presentation: { asker: { displayName: "Tim", actor: "agent" } } },
      ],
    });
    expect(
      await new NotificationStore(maya.database).teamAsk(team.deploymentId, ask.request.id),
    ).toMatchObject({ kind: "request-opened", threadId: null });
    expect(await maya.database.selectFrom("runs").selectAll().execute()).toHaveLength(0);
    await maya.publisher.decide(maya.owner.userId, team.deploymentId, ask.request.id, "approve");
    const admitted = (await maya.requests.get(team.deploymentId, ask.request.id))!;
    const context = await maya.tools.context(admitted.runId!);
    expect(context.asker).toEqual({ displayName: "Tim", actor: "agent" });
    expect((await needsYouPage(maya.database, { userId: maya.owner.userId })).count).toBe(0);
    await team.database
      .updateTable("teamMembers")
      .set({ handle: "renamed-maya" })
      .where("userId", "=", team.owner.userId)
      .execute();
    await maya.answer(ask.request.id, "@tim-agent The launch is ready.");
    const replyPage = await team.team.chat.page(
      team.member,
      team.channel.id,
      undefined,
      ask.request.threadRootId,
    );
    expect(
      replyPage.messages.filter(
        (message) => message.authorKind === "agent" && message.id !== post.messageId,
      ),
    ).toMatchObject([
      { bodyMarkdown: "@tim-agent The launch is ready.", authorUserId: team.owner.userId },
    ]);
    const returned = (await team.team.requests.pending(team.linkId))[0]!;
    expect(returned.returnPayload).toMatchObject({
      outcome: "answered",
      resumeRunId: asking.runId,
      author: {
        teamUserId: team.owner.userId,
        displayName: "Maya",
        actor: "agent",
        handle: "maya",
      },
    });
    await tim.deliver();
    await tim.publisher.deliver(team.deploymentId, returned);
    await tim.publisher.reconnect(team.deploymentId);
    const privateReturns = await tim.database
      .selectFrom("threadInputs as i")
      .innerJoin("messages as m", "m.id", "i.messageId")
      .select(["i.replyTarget", "i.state", "m.author", "m.content"])
      .where("i.idempotencyKey", "=", `team-return:${team.deploymentId}:${ask.request.id}`)
      .execute();
    expect(privateReturns).toHaveLength(1);
    expect(privateReturns[0]).toMatchObject({
      replyTarget: null,
      state: "pending",
      author: {
        kind: "team-member",
        teamId: team.deploymentId,
        teamUserId: team.owner.userId,
        displayName: "Maya",
        actor: "agent",
      },
    });
    expect(JSON.stringify(privateReturns[0]!.content)).toContain("The launch is ready");
    expect(await team.team.requests.pending(team.linkId)).toEqual([]);
    expect(await team.team.requests.pending(mayaLink)).toEqual([]);
    expect(
      await team.database
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("kind", "=", "return")
        .execute(),
    ).toHaveLength(1);

    await team.database
      .updateTable("teamMembers")
      .set({ handle: "maya" })
      .where("userId", "=", team.owner.userId)
      .execute();
    await tim.tools.post({ runId: asking.runId, operationId: "ask-decline" }, team.deploymentId, {
      channelId: team.channel.id,
      bodyMarkdown: "@maya-agent Another question.",
      attachmentIds: [],
    });
    const declined = (await team.team.requests.pending(mayaLink))[0]!;
    await maya.deliver();
    await maya.publisher.decide(
      maya.owner.userId,
      team.deploymentId,
      declined.request.id,
      "decline",
    );
    const declineReturn = (await team.team.requests.pending(team.linkId))[0]!;
    expect(declineReturn.returnPayload).toMatchObject({
      outcome: "declined",
      author: { displayName: "Maya", actor: "agent" },
    });
    await tim.deliver();
    const declineInput = await tim.database
      .selectFrom("messages as m")
      .innerJoin("threadInputs as i", "i.messageId", "m.id")
      .select(["m.author", "m.content", "i.replyTarget"])
      .where("i.idempotencyKey", "=", `team-return:${team.deploymentId}:${declined.request.id}`)
      .executeTakeFirstOrThrow();
    expect(declineInput).toMatchObject({
      author: { displayName: "Maya", actor: "agent" },
      replyTarget: null,
    });
    expect(JSON.stringify(declineInput.content)).toContain("declined");
    expect(await maya.database.selectFrom("runs").selectAll().execute()).toHaveLength(1);

    await team.team.chat.send(team.member, {
      channelId: team.channel.id,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@maya-agent A human question.",
      mentions: [],
      attachmentIds: [],
    });
    const humanAsk = (await team.team.requests.pending(mayaLink))[0]!;
    await maya.deliver();
    await maya.publisher.decide(
      maya.owner.userId,
      team.deploymentId,
      humanAsk.request.id,
      "approve",
    );
    await maya.answer(humanAsk.request.id, "Here is the human answer.");
    expect(await team.team.requests.pending(team.linkId)).toEqual([]);
    expect(
      await team.database
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("kind", "=", "return")
        .execute(),
    ).toHaveLength(2);
  } finally {
    for (const peer of peers.reverse()) await peer.close();
    await team.close();
  }
});
