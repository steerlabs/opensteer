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
import { createDatabase, admitTeamTaskRequest, OpensteerStore } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
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
      origin: {
        teamId: team.deploymentId,
        channelId: team.channel.id,
        threadRootId: request.threadRootId,
      },
      requestId: request.id,
      triggerMessageId: request.triggerMessageId,
      folder: personal.agentHome,
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
      requests: new PersonalTeamRequestsStore(database),
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
    const uploaded = await transfers.uploadPath(runId, "/tmp/screenshot.png");
    expect(uploaded.file.preview?.sizeBytes).toBeGreaterThan(0);
    expect(uploaded.file.preview!.sizeBytes).toBeLessThanOrEqual(teamPreviewMaxBytes);
    const replied = await team.machine.endpoint.call(team.linkId, {
      type: "reply",
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
