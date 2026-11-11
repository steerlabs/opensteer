import { createDecipheriv, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createId, TeamMessageIdSchema } from "@opensteer/core";
import {
  HostNotificationPublicationSchema,
  teamNotificationDeepLink,
} from "@opensteer/control-plane-protocol";
import { notificationPreviewAad } from "../notifications/notification-preview.js";
import { createTeamPushPublisher } from "./push.js";

it("publishes team routing with sealed preview bytes authenticated to its deep link", async () => {
  const teamId = createId("deployment"),
    hostInstanceId = createId("hostInstance"),
    userId = createId("user"),
    notificationId = createId("notification");
  const key = randomBytes(32).toString("base64url"),
    keyId = randomBytes(16).toString("base64url");
  let sent = "";
  const publisher = createTeamPushPublisher({
    teamId,
    hostInstanceId,
    origin: "https://team.example.invalid",
    target: async () => ({
      controlApiOrigin: new URL("https://account.example.invalid"),
      hostCredential: "fixture-private-credential",
    }),
    keys: async () => [
      {
        accountId: "acct_00000000-0000-4000-8000-000000000001",
        installationId: "team-installation",
        key,
        keyId,
      },
    ],
    fetch: async (_url, init) => {
      sent = String(init!.body);
      return Response.json({ accepted: true, deliveries: 1, notificationId });
    },
  });
  await publisher({
    userId,
    accountId: "acct_00000000-0000-4000-8000-000000000001",
    kind: "team-message",
    notificationId,
    occurredAt: new Date(),
    channelId: createId("teamChannel"),
    messageId: TeamMessageIdSchema.parse("1"),
    noticeId: null,
    title: "Private team title",
    body: "Private team words",
  });
  expect(sent).not.toContain("Private team");
  expect(sent).not.toContain(key);
  expect(sent).not.toContain("fixture-private-credential");
  const publication = HostNotificationPublicationSchema.parse(JSON.parse(sent));
  expect(publication.threadId).toBeNull();
  const preview = publication.previews![0]!;
  const bytes = Buffer.from(preview.preview.ciphertext, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "base64url"),
    Buffer.from(preview.preview.nonce, "base64url"),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  decipher.setAAD(
    notificationPreviewAad({
      deploymentId: teamId,
      notificationId,
      installationId: preview.installationId,
      keyId,
      kind: publication.kind,
      deepLink: teamNotificationDeepLink(publication.teamTarget!),
      expiresAt: publication.expiresAt,
    }),
  );
  expect(
    JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(),
    ),
  ).toEqual({ version: 1, title: "Private team title", body: "Private team words" });
});
