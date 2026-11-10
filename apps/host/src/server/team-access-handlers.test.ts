import { generateKeyPairSync } from "node:crypto";
import { createId, OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { type HostApiClient } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { advertisedCapabilities, createHostServer } from "../server.js";
import { hostServerTestDependencies } from "./host-server-test-harness.js";
import { injectRpcRequest } from "./test-host-api-request.js";

const workspaceId = createId("workspace");
const userId = createId("user");
const uuid = "00000000-0000-4000-8000-000000000001";
const changes = [{ kind: "revoke", entryId: uuid }];
const base = { idempotencyKey: "dormant-team", expectedRevision: 1 };
const procedures = {
  "team.summary.get": {},
  "team.people.list": {},
  "team.invitations.list": {},
  "team.member.get": { userId },
  "team.directory.search": { workspaceId, query: "Maya" },
  "team.groups.list": {},
  "team.group.get": { groupId: uuid },
  "team.project.access.get": { workspaceId },
  "team.access.explain": { workspaceId, subject: { kind: "person", userId } },
  "team.access.preview": { expectedRevision: 1, changes },
  "team.member.preview": { userId, change: { kind: "set-state", value: "suspended" } },
  "team.audit.list": {},
  "team.project.settings.get": { workspaceId },
  "team.project.runtimeChoices": { workspaceId },
  "team.invitation.preview": { selector: "s".repeat(24) },
  "team.invitation.exchange": { selector: "s".repeat(24), verifier: "v".repeat(43) },
  "team.invitation.accept": {},
};
const commands = [
  { ...base, type: "team.project.create", name: "Support", color: "blue" },
  { ...base, type: "team.access.apply", changes },
  { ...base, type: "team.access.selfGrant", workspaceId },
  {
    ...base,
    type: "team.member.change",
    userId,
    change: { kind: "set-administrator", value: false },
  },
  { ...base, type: "team.connection.revoke", connectionId: `mcn_${uuid}` },
  {
    ...base,
    type: "team.project.settings.set",
    workspaceId,
    expectedSettingsRevision: null,
    settings: {
      harnessInstanceId: createId("harnessInstance"),
      accessMode: "approval-required",
      modelSelection: { providerId: "openai", modelId: "gpt-5.6-sol", options: {} },
      instructions: "",
      timeZone: "UTC",
    },
  },
  {
    ...base,
    type: "team.invitation.create",
    id: uuid,
    selector: "s".repeat(24),
    tokenHash: "a".repeat(64),
    intendedEmail: "maya@example.test",
    memberKind: "full",
    validFor: "1d",
  },
  { ...base, type: "team.invitation.revoke", invitationId: uuid },
];

describe("dormant team Host boundary", () => {
  it.each(["personal", "server"] as const)(
    "refuses every %s call before domain lookups and rejects non-human credentials",
    async (kind) => {
      const origin = "http://127.0.0.1:4310";
      const session: AuthenticatedSession = {
        id: createId("authSession"),
        createdAt: "2026-11-10T00:00:00.000Z",
        expiresAt: "2026-11-11T00:00:00.000Z",
        absoluteExpiresAt: "2026-12-10T00:00:00.000Z",
        user: {
          id: userId,
          displayName: "Maya",
          email: "maya@example.test",
          emailVerified: true,
          disabledAt: null,
          image: null,
          instanceRole: "administrator",
        },
      };
      const authenticator = new HostAuthenticator({
        publicUrl: new URL(origin),
        identity: {
          nativeOpenIdConfiguration: () => undefined,
          requireSession: async () => session,
          userSessionProfile: async () => session.user,
          authenticateNativeAccessToken: async (token: string) => {
            if (token !== "native-human")
              throw new OpensteerError({ code: "unauthorized", message: "Not a human session" });
            return {
              sessionId: session.id,
              subject: userId,
              createdAt: new Date(session.createdAt),
              expiresAt: new Date(session.expiresAt),
              absoluteExpiresAt: new Date(session.absoluteExpiresAt),
            };
          },
        } as never,
      });
      const dependencies = hostServerTestDependencies({
        authenticator,
        discovery: signHostDiscovery(generateKeyPairSync("ed25519"), {
          canonicalOrigin: origin,
          deploymentId: createId("deployment"),
          hostInstanceId: createId("hostInstance"),
          hostKey: { algorithm: "Ed25519" },
          deploymentShape: { kind, defaultWorkspaceBacking: "local-directory" },
        }),
      });
      const app = await createHostServer(dependencies);
      try {
        expect(hostApiVersion).toBe(51);
        expect(
          advertisedCapabilities(dependencies).some((capability) => capability.startsWith("team")),
        ).toBe(false);
        const calls: [keyof HostApiClient, Record<string, unknown>][] = [
          ...Object.entries(procedures).map(
            ([procedure, input]): [keyof typeof procedures, Record<string, unknown>] => [
              procedure as keyof typeof procedures,
              input,
            ],
          ),
          ...commands.map((command): ["commands.dispatch", Record<string, unknown>] => [
            "commands.dispatch",
            command,
          ]),
        ];
        for (const [procedure, input] of calls) {
          const response = await injectRpcRequest(app, procedure, input, {
            authorization: "Bearer native-human",
            origin,
          });
          expect(response.statusCode, `${procedure}: ${response.body}`).toBe(403);
          expect(response.json()).toMatchObject({
            ok: false,
            error: { code: "forbidden", reason: "team-unavailable", retryable: false },
          });
          for (const token of [
            "ost_mcp_connected-agent",
            "run-token",
            "program-token",
            "runner-token",
          ]) {
            const refused = await injectRpcRequest(app, procedure, input, {
              authorization: `Bearer ${token}`,
              cookie: "human=ambient",
              origin,
            });
            expect(refused.statusCode, `${procedure} (${token}): ${refused.body}`).toBe(401);
            expect(refused.json()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
          }
        }
        for (const procedure of ["team.invitation.preview", "team.invitation.exchange"] as const) {
          const response = await injectRpcRequest(app, procedure, procedures[procedure], {
            origin,
          });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({
            ok: false,
            error: { reason: "team-unavailable" },
          });
        }
        const wrongOrigin = await injectRpcRequest(
          app,
          "team.invitation.exchange",
          procedures["team.invitation.exchange"],
          { origin: "https://hostile.test" },
        );
        expect(wrongOrigin.statusCode).toBe(403);
        expect(wrongOrigin.json()).not.toMatchObject({ error: { reason: "team-unavailable" } });
      } finally {
        await app.close();
      }
    },
  );
});
