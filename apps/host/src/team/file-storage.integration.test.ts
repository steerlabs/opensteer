import { TeamIdentityAdmission } from "@opensteer/identity";
import { TeamInvitesStore } from "@opensteer/database/team-invites";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamFileService } from "./file-service.js";
import { LocalTeamFileStore } from "./file-store.js";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { HostAccountAdoptionBundleSchema } from "@opensteer/control-plane-protocol";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamFilesStore } from "@opensteer/database/team-files";
import { TeamInstallationStore } from "@opensteer/database/team-installation";
import { ensureTeamStarterTopic } from "@opensteer/database";

it("fences a paused upload after lease reclamation and keeps GC from releasing a writer's row", async () => {
  const f = await createTeamKnowledgeFixture();
  try {
    const access = new TeamAccessStore(f.database);
    await access.initialize();
    const store = new TeamFilesStore(access);
    const { channelId: channel } = await f.channel({
      name: "files",
      kind: "public",
      peopleOnly: false,
      access: [{ userId: f.userId, level: "post" }],
    });
    const actor = { kind: "human" as const, userId: f.userId };
    const sha256 = createHash("sha256").update("hello").digest("hex");
    const row = await store.begin(actor, channel, {
      clientUploadId: randomUUID(),
      filename: "hello.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      sha256,
      previewSizeBytes: 0,
    });
    const first = await store.claimUpload(row.id, async () => {});
    await expect(store.claimUpload(row.id, async () => {})).rejects.toThrow("in progress");
    await f.database
      .updateTable("teamBlobs")
      .set({ uploadLeaseExpiresAt: new Date(0) })
      .where("id", "=", row.id)
      .execute();
    const removed: string[] = [];
    const second = await store.claimUpload(row.id, async (old) => {
      removed.push(old.storageKey);
    });
    expect(removed).toEqual([first.storageKey]);
    expect(second.storageKey).not.toBe(first.storageKey);
    const input = {
      receivedBytes: 5,
      sha256,
      verifiedType: "text/plain",
      previewMediaType: null,
      previewSizeBytes: 0,
      previewStorageKey: null,
      generation: "123",
    };
    await expect(
      store.complete(actor, row.id, { ...input, uploadLease: first.uploadLease! }),
    ).rejects.toThrow("lease expired");
    await store.complete(actor, row.id, { ...input, uploadLease: second.uploadLease! });
    await expect(
      store.complete(actor, row.id, { ...input, uploadLease: first.uploadLease! }),
    ).rejects.toThrow("lease expired");
    await f.database
      .updateTable("teamBlobs")
      .set({ state: "deleting" })
      .where("id", "=", row.id)
      .execute();
    await f.database.transaction().execute(async (t) => {
      await t
        .selectFrom("teamBlobs")
        .select("id")
        .where("id", "=", row.id)
        .forNoKeyUpdate()
        .execute();
      expect(
        await store.collectDeleting(async () => {
          throw new Error("GC claimed locked writer");
        }),
      ).toBe(0);
    });
    const collected: string[] = [];
    expect(
      await store.collectDeleting(async (old) => {
        collected.push(old.storageKey);
      }),
    ).toBe(1);
    expect(collected).toEqual([second.storageKey]);
    await expect(
      store.complete(actor, row.id, { ...input, uploadLease: second.uploadLease! }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
it("seals the account bundle transactionally and binds it to the secret and deployment", async () => {
  const f = await createTeamKnowledgeFixture();
  try {
    const bundle = HostAccountAdoptionBundleSchema.parse({
      provisioningMode: "adoption",
      controlApiOrigin: "https://accounts.example.invalid",
      deployment: {
        canonicalOrigin: "https://team.example.invalid",
        deploymentId: f.deploymentId,
        hostInstanceId: f.hostInstanceId,
        hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
        reachability: "canonical",
      },
      hostCredential: `osc_${"a".repeat(43)}`,
      oidc: {
        clientId: "opensteer-host",
        issuer: "https://accounts.example.invalid",
        redirectUri: "https://team.example.invalid/v1/auth/oidc/callback",
        requirePkce: true,
        scopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      oidcClientSecret: `ocs_${"b".repeat(43)}`,
    });
    const store = new TeamInstallationStore("s".repeat(40), f.deploymentId);
    await expect(
      f.database.transaction().execute(async (t) => {
        await store.install(t, bundle);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.load(f.database)).toBeUndefined();
    await f.database.transaction().execute((t) => store.install(t, bundle));
    expect(await store.load(f.database)).toEqual(bundle);
    await f.database.deleteFrom("teamInstallation").execute();
    const now = new Date();
    const admissionId = createId("authAdmission");
    const proofId = randomUUID();
    const authority = {
      canonicalOrigin: bundle.deployment.canonicalOrigin,
      deploymentId: bundle.deployment.deploymentId,
      hostInstanceId: bundle.deployment.hostInstanceId,
      hostKeyFingerprint: bundle.deployment.hostKeyFingerprint,
    };
    const account = { issuer: bundle.controlApiOrigin, subject: "account-subject" };
    await f.database
      .insertInto("authAdmissions")
      .values({
        id: admissionId,
        purpose: "setup",
        subjectSelector: "setup",
        browserNonceHash: "nonce",
        reservedEmail: null,
        reservedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
        consumedBy: null,
        createdAt: now,
      })
      .execute();
    await f.database
      .insertInto("authVerifications")
      .values({
        id: createId("authVerification"),
        identifier: `team-account-adoption:${proofId}`,
        value: JSON.stringify({
          admissionId,
          credentialHash: "credential",
          account,
          authority,
          consumedAt: now.toISOString(),
          completed: false,
        }),
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const access = new TeamAccessStore(f.database);
    await access.initialize();
    const admission = new TeamIdentityAdmission({
      access,
      invites: new TeamInvitesStore(access, authority.canonicalOrigin),
      authority,
      grantVerifier: {
        verify: async () => ({
          proofId,
          account,
          deployment: authority,
          authorizedBy: { admissionId },
          consumedAt: now,
          issuedAt: now,
          expiresAt: new Date(Date.now() + 60_000),
          grantId: `hag_${randomUUID()}`,
        }),
      },
      installAccountBundle: (value, t) => store.install(t, value),
    });
    await admission.completeAdoption(null, "verified-grant", bundle);
    expect(await store.load(f.database)).toEqual(bundle);

    const row = await f.database
      .selectFrom("teamInstallation")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.sealedAccountBundle.includes(Buffer.from(bundle.hostCredential))).toBe(false);
    await expect(
      new TeamInstallationStore("x".repeat(40), f.deploymentId).load(f.database),
    ).rejects.toThrow();
    await expect(
      new TeamInstallationStore("s".repeat(40), createId("deployment")).load(f.database),
    ).rejects.toThrow();
    await Promise.all([
      ensureTeamStarterTopic(f.database, createId("knowledgeTopic")),
      ensureTeamStarterTopic(f.database, createId("knowledgeTopic")),
    ]);
    expect(await f.database.selectFrom("teamTopics").select("id").execute()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("reclaims expired upload leases and removes their uncommitted objects", async () => {
  const f = await createTeamKnowledgeFixture();
  const directory = await mkdtemp(join(tmpdir(), "expired-team-upload-"));
  const access = new TeamAccessStore(f.database);
  await access.initialize();
  const store = new TeamFilesStore(access);
  const files = new LocalTeamFileStore(join(directory, "team-files"));
  const service = new TeamFileService(store, access, directory, files);
  try {
    const { channelId } = await f.channel({
      name: "expired",
      access: [{ userId: f.userId, level: "post" }],
    });
    const actor = { kind: "human" as const, userId: f.userId };
    const sha256 = createHash("sha256").update("hello").digest("hex");
    const row = await store.begin(actor, channelId, {
      clientUploadId: randomUUID(),
      filename: "hello.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      sha256,
      previewSizeBytes: 0,
    });
    const claimed = await store.claimUpload(row.id, async () => {});
    const staged = join(directory, "staged");
    await writeFile(staged, "hello");
    await files.put(claimed.storageKey, staged);
    await f.database
      .updateTable("teamBlobs")
      .set({ uploadLeaseExpiresAt: new Date(0) })
      .where("id", "=", row.id)
      .execute();
    await service.collectGarbage();
    // A fenced writer can finish putting bytes after reclamation, then crash before cleanup.
    await files.put(claimed.storageKey, staged);
    await service.collectGarbage();
    const objects = [];
    for await (const object of files.list(claimed.storageKey)) objects.push(object);
    expect(objects).toEqual([]);
    expect(
      await f.database
        .selectFrom("teamBlobs")
        .select("id")
        .where("id", "=", row.id)
        .executeTakeFirst(),
    ).toBeUndefined();
  } finally {
    await service.close();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
